#!/usr/bin/env node
/*
 * precommit-guard.js — PreToolUse(Bash|PowerShell) hook.
 * Blocks a `git commit` / `git push` that carries hardcoded secrets,
 * AI attribution, or a credential file. Deterministic, no LLM.
 *
 * Fail contract (ON_UNKNOWN):
 *   - Not a git commit/push → allow instantly.
 *   - Commit whose repository cannot be resolved, or whose scan cannot finish
 *     → ASK: a commit is local and recoverable, and every push is scanned again.
 *   - Push whose repository/remote cannot be resolved or read, or whose scan
 *     hits the time/size bound → DENY: a push is the one irreversible act.
 *   - Confirmed secret, credential file or attribution → DENY.
 * The whole hook finishes within DEADLINE_MS, well below its settings timeout:
 * a timed-out hook does not block the tool call.
 *
 * Author: Eng. Mohammed Almutairi - Developzone.net
 */
'use strict';

// Registered in settings.json for both the Bash and PowerShell tools — both
// deliver the command line as tool_input.command, so one code path covers both.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DEADLINE_MS = 10000;
const DEADLINE = Date.now() + DEADLINE_MS;
const MAX_SCAN_BYTES = 32 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Hook plumbing
// ---------------------------------------------------------------------------

function allow() { process.exit(0); }

function emit(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}
function deny(reason) { emit('deny', reason); }

function readStdin() {
  try {
    let s = fs.readFileSync(0, 'utf8');
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1); // strip a UTF-8 BOM if present
    return s;
  } catch (e) { return ''; }
}

// Git runs WITHOUT a shell (no quoting or metacharacter surprises), in the
// resolved repository, with an inherited GIT_* environment removed so nothing
// but the resolved directory decides which repository is read. Returns
// { ok, out } or { ok: false, why, partial, bounded }; never throws.
const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
GIT_ENV.GIT_OPTIONAL_LOCKS = '0';
GIT_ENV.GIT_TERMINAL_PROMPT = '0';
GIT_ENV.GCM_INTERACTIVE = 'never';
GIT_ENV.GIT_SSH_COMMAND = process.env.GIT_SSH_COMMAND || 'ssh -oBatchMode=yes';

function git(args, cwd, { input, maxBytes = 8 * 1024 * 1024, okStatus = [0] } = {}) {
  const remaining = DEADLINE - Date.now();
  if (remaining <= 0) return { ok: false, why: 'the ' + DEADLINE_MS / 1000 + ' s scan limit was reached', bounded: true, partial: '' };
  const r = spawnSync('git', args, {
    cwd, input, env: GIT_ENV, encoding: 'utf8', windowsHide: true,
    timeout: remaining, maxBuffer: maxBytes, stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (r.error) {
    const code = r.error.code;
    if (code === 'ENOBUFS') return { ok: false, why: 'the output passed the ' + Math.round(maxBytes / 1048576) + ' MiB scan limit', bounded: true, partial: r.stdout || '' };
    if (code === 'ETIMEDOUT') return { ok: false, why: 'the ' + DEADLINE_MS / 1000 + ' s scan limit was reached', bounded: true, partial: r.stdout || '' };
    return { ok: false, why: 'git could not run (' + code + ')', partial: '' };
  }
  if (!okStatus.includes(r.status)) {
    const first = String(r.stderr || '').trim().split(/\r?\n/)[0] || 'git exited with status ' + r.status;
    return { ok: false, why: first.slice(0, 200), notRepo: /not a git repository/i.test(String(r.stderr || '')), partial: '' };
  }
  return { ok: true, out: r.stdout || '', status: r.status };
}

// ---------------------------------------------------------------------------
// Parse the tool call and self-gate
// ---------------------------------------------------------------------------

let data = {};
try { data = JSON.parse((readStdin().replace(/^﻿/, '').trim()) || '{}'); } catch (e) { allow(); }
let cmd = (data.tool_input && data.tool_input.command) || '';
if (typeof cmd !== 'string') cmd = String(cmd);
const cwd = data.cwd || process.cwd();

let shell = null;
try { shell = require(path.join(__dirname, 'lib', 'shell-command.cjs')); } catch (e) { shell = null; }
if (!shell) {
  if (/\bgit(?:\.exe|\.cmd|\.bat)?["']?\s[^\n]*\b(?:commit|push)\b/i.test(cmd))
    deny('Blocked: precommit-guard could not load hooks/lib/shell-command.cjs, so this commit/push cannot be scanned for secrets. Restore the library, then retry.');
  allow();
}

const records = shell.parseCommand(cmd, { cwd, tool: data.tool_name === 'Bash' ? 'Bash' : 'PowerShell', home: os.homedir(), tmp: os.tmpdir() });
const actions = records.filter((r) => r.git && (r.git.sub === 'commit' || r.git.sub === 'push'));
if (!actions.length) {
  const hits = shell.tripwire(cmd);
  if (!hits.has('commit') && !hits.has('push')) allow();
  if (!shell.opaque(cmd)) allow();   // only text (an echo, a PR body): nothing is committed or pushed
  if (hits.has('push')) deny('Blocked: this command may push, but its shape (substitution or wrapper) cannot be scanned for secrets. Run `git push` as its own command from the repository directory.');
  emit('ask', 'precommit-guard: this command may commit, but its shape cannot be scanned for secrets. Run `git commit` as its own command, or confirm you know the staged changes hold no secrets.');
}

// ---------------------------------------------------------------------------
// What each action introduces
// ---------------------------------------------------------------------------

// `--raw` lines name every file (binary ones too): ":old new sha sha STATUS\tpath[\tpath2]".
function rawEntry(line) {
  const tab = line.indexOf('\t');
  if (tab < 0) return null;
  const status = line.slice(0, tab).trim().split(/\s+/).pop() || '';
  const paths = line.slice(tab + 1).split('\t').map((p) => p.replace(/^"(.*)"$/, '$1'));
  return { status, paths };
}

// Added lines, file entries and commit messages from `git diff`/`git log -p --raw --cc`
// output. A combined (merge) diff line counts as added only when it is new
// against EVERY parent ('+' in all N parent columns).
function parsePatch(text) {
  const added = [], entries = [], messages = [];
  let commits = 0;
  for (const chunk of String(text).split('\0C')) {
    if (!chunk) continue;
    let body = chunk;
    const end = chunk.indexOf('\0E');
    if (end >= 0) { commits++; messages.push(chunk.slice(chunk.indexOf('\n') + 1, end)); body = chunk.slice(end + 2); }
    let parents = 1, inHunk = false;
    for (const line of body.split('\n')) {
      if (line.startsWith(':')) { const e = rawEntry(line); if (e) entries.push(e); inHunk = false; continue; }
      if (line.startsWith('diff --')) { inHunk = false; continue; }
      const hunk = /^(@{2,}) /.exec(line);
      if (hunk) { parents = hunk[1].length - 1; inHunk = true; continue; }
      if (inHunk && line.length >= parents && line.slice(0, parents) === '+'.repeat(parents)) added.push(line.slice(parents));
    }
  }
  return { added: added.join('\n'), entries, messages: messages.join('\n'), commits };
}

const DIFF_ARGS = ['--no-ext-diff', '--no-textconv', '--no-color', '--unified=0', '--raw', '-M'];

// `git commit` option letters that take a value (rest of the cluster or next word).
const COMMIT_VALUE_SHORT = new Set(['m', 'F', 'C', 'c', 't']);
const COMMIT_VALUE_LONG = /^--(?:message|file|reuse-message|reedit-message|author|date|fixup|squash|trailer|template|cleanup|pathspec-from-file)$/;
function commitShape(args) {
  let all = false, pathspec = false;
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (a === '--') { pathspec = i + 1 < args.length; break; }
    if (/^--(?:all)$/.test(a)) { all = true; continue; }
    if (/^--(?:include|only|pathspec-from-file)(?:=|$)/.test(a)) { pathspec = true; if (a === '--pathspec-from-file') i++; continue; }
    if (a.startsWith('--')) { if (COMMIT_VALUE_LONG.test(a)) i++; continue; }
    if (/^-[A-Za-z]/.test(a)) {
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        if (c === 'a') all = true;
        if (c === 'i' || c === 'o') pathspec = true;
        if (COMMIT_VALUE_SHORT.has(c)) { if (j === a.length - 1) i++; break; }
      }
      continue;
    }
    pathspec = true;                     // a bare word after the options is a pathspec
  }
  return { all, pathspec };
}

// Outside a repository `git diff` silently switches to --no-index mode, so ask
// git directly whether the resolved directory is a repository at all.
function repository(g) { return git(['rev-parse', '--show-toplevel'], g.cwd); }

function commitContent(action, index) {
  const g = action.git;
  const top = repository(g);
  if (!top.ok) return top;
  const staged = git(['diff', '--cached', ...DIFF_ARGS], g.cwd);
  if (!staged.ok) return staged;
  let text = staged.out;
  const untracked = [];
  // Changes staged by the commit itself (-a, pathspec, -i/-o) or by a `git add`
  // earlier in the same command are not in the index yet: read the working tree.
  const shape = commitShape(g.args);
  const addedBefore = records.slice(0, index).some((r) => r.git && r.git.sub === 'add' && r.git.cwd && g.cwd && path.resolve(r.git.cwd).toLowerCase() === path.resolve(g.cwd).toLowerCase());
  if (shape.all || shape.pathspec || addedBefore) {
    const work = git(['diff', ...DIFF_ARGS], g.cwd);
    if (!work.ok) return work;
    text += '\n' + work.out;
    if (shape.pathspec || addedBefore) {
      const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], g.cwd);
      if (!status.ok) return status;
      for (const entry of status.out.split('\0')) if (entry.startsWith('?? ')) untracked.push(entry.slice(3));
    }
  }
  const parsed = parsePatch(text);
  for (const p of untracked) parsed.entries.push({ status: 'A', paths: [p] });
  // A new file is in no diff yet, so its contents would otherwise go unscanned:
  // read each untracked text file as added lines. Porcelain paths are relative
  // to the top level; a binary file is still checked by name above.
  let budget = MAX_SCAN_BYTES;
  const fresh = [];
  for (const p of untracked) {
    let body;
    try {
      const file = path.join(top.out.trim(), p);
      if (!fs.statSync(file).isFile()) continue;
      body = fs.readFileSync(file);
    } catch (e) { return { ok: false, why: 'a new file could not be read (' + p + ')' }; }
    budget -= body.length;
    if (budget < 0) return { ok: false, why: 'new files passed the ' + Math.round(MAX_SCAN_BYTES / 1048576) + ' MiB scan limit', bounded: true };
    if (!body.includes(0)) fresh.push(body.toString('utf8'));
  }
  if (fresh.length) parsed.added += '\n' + fresh.join('\n');
  return { ok: true, ...parsed };
}

// The destination's own refs are the only boundary a local command cannot forge
// (remote-tracking refs can be rewritten by an allowed `git fetch .`).
function pushPlan(g) {
  let remote = null, all = false, mirror = false, tags = false, deleteMode = false;
  const refspecs = [];
  for (let i = 0; i < g.args.length; i++) {
    const t = String(g.args[i]);
    if (/^(?:-o|--push-option|--receive-pack|--exec)$/.test(t)) { i++; continue; }
    if (t === '--repo') { remote = g.args[++i] || remote; continue; }
    if (t.startsWith('--repo=')) { remote = t.slice(7); continue; }
    if (/^--(?:all|branches)$/.test(t)) { all = true; continue; }
    if (t === '--mirror') { mirror = true; continue; }
    if (/^--(?:tags|follow-tags)$/.test(t)) { tags = true; continue; }
    if (/^(?:--delete|-d)$/.test(t)) { deleteMode = true; continue; }
    if (/^(\d*>>?|&>>?|\d*<)$/.test(t)) { i++; continue; }            // shell redirection, not a refspec
    if (/^(\d*>>?|&>>?|\d*<)\S/.test(t) || /^\d*>&\d+$/.test(t) || t.startsWith('-')) continue;
    if (remote === null) remote = t; else refspecs.push(t);
  }
  const tips = [];
  if (mirror) tips.push('--all');
  if (all) tips.push('--branches');
  if (tags) tips.push('--tags');
  for (const spec of refspecs) {
    const r = spec.replace(/^\+/, '');
    if (deleteMode || r.startsWith(':')) continue;                     // deletions publish no content
    const src = r.includes(':') ? r.slice(0, r.indexOf(':')) : r;
    if (src) tips.push(src);
  }
  if (!refspecs.length && !all && !mirror && !tags && !deleteMode) tips.push('HEAD');
  return { remote, tips };
}

function destination(g, explicit) {
  if (explicit) return { ok: true, dest: explicit };
  const branch = git(['symbolic-ref', '-q', '--short', 'HEAD'], g.cwd, { okStatus: [0, 1] });
  if (!branch.ok) return branch;
  const name = branch.out.trim();
  const config = git(['config', '--get-regexp', '^(remote\\.pushdefault|branch\\..*\\.(pushremote|remote))$'], g.cwd, { okStatus: [0, 1] });
  if (!config.ok) return config;
  const values = {};
  for (const line of config.out.split(/\r?\n/)) {
    const sp = line.indexOf(' ');
    if (sp > 0) values[line.slice(0, sp).toLowerCase()] = line.slice(sp + 1).trim();
  }
  const key = (k) => values[('branch.' + name + '.' + k).toLowerCase()];
  return { ok: true, dest: (name && key('pushremote')) || values['remote.pushdefault'] || (name && key('remote')) || 'origin' };
}

function pushContent(action) {
  const g = action.git;
  const plan = pushPlan(g);
  if (!plan.tips.length) return { ok: true, added: '', entries: [], messages: '', commits: 0 };
  const top = repository(g);
  if (!top.ok) return top;
  const where = destination(g, plan.remote);
  if (!where.ok) return where;
  const listed = git(['ls-remote', '--heads', '--tags', where.dest], g.cwd, { maxBytes: 16 * 1024 * 1024 });
  if (!listed.ok) return { ...listed, why: 'could not read what `' + where.dest + '` already has (' + listed.why + ')' };
  const remoteShas = [...new Set(listed.out.split(/\r?\n/).map((l) => l.split('\t')[0]).filter((s) => /^[0-9a-f]{40,64}$/.test(s)))];
  let boundaries = [];
  if (remoteShas.length) {
    const known = git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], g.cwd, { input: remoteShas.join('\n') + '\n', maxBytes: 16 * 1024 * 1024 });
    if (!known.ok) return known;
    boundaries = known.out.split(/\r?\n/).filter((l) => /^[0-9a-f]{40,64} (?:commit|tag)$/.test(l)).map((l) => l.split(' ')[0]);
  }
  const revs = [...plan.tips, ...(boundaries.length ? ['--not', ...boundaries] : [])].join('\n') + '\n';
  const log = git(['-c', 'core.quotePath=false', 'log', '--stdin', '-p', '--cc', ...DIFF_ARGS, '--format=%x00C%H%n%B%x00E'],
    g.cwd, { input: revs, maxBytes: MAX_SCAN_BYTES });
  if (!log.ok) {
    const done = (String(log.partial || '').match(/\0E/g) || []).length;
    return { ...log, why: log.why + (log.bounded ? '; scanned ' + done + ' commit(s) before stopping' : ''), dest: where.dest };
  }
  return { ok: true, ...parsePatch(log.out), dest: where.dest };
}

// ---------------------------------------------------------------------------
// Checks (patterns unchanged)
// ---------------------------------------------------------------------------

// Deny texts below deliberately avoid spelling out the matchable markers,
// so committing this hook file itself is never self-blocked.
const attribution = /Co-Authored-By:\s*Claude|Generated with \[?Claude Code|noreply@anthropic\.com/i;

const patterns = [
  [/-----BEGIN (?:RSA |EC |OPENSSL |PGP |DSA )?PRIVATE KEY-----/, 'a private key block'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, 'an AWS access key id'],
  [/(?:server|data source|host)\b[^\n]{0,80}?\b(?:password|pwd)\s*=\s*[^;\s"'){}<]{4,}/i, 'a connection string with an inline password'],
  [/(?:secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|apikey)["']?\s*[:=]\s*["'][A-Za-z0-9_\-.]{20,}["']/i, 'a hardcoded secret / API key'],
  // Vendor-fixed token prefixes with long random tails — effectively zero
  // false-positive rate on legitimate code:
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, 'a GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}\b/, 'a GitHub fine-grained token'],
  [/\bxox[baprs]-\d{10,}\b/, 'a Slack token'],
  [/\b[sr]k_live_[A-Za-z0-9]{20,}\b/, 'a Stripe live key'],
  [/\bsk-ant-[A-Za-z0-9_-]{32,}\b/, 'an Anthropic API key'],
];

// Credential files: .env variants (not .example/.template/.sample) and binary
// key stores, whose content a text scan never sees. A rename or copy carries the
// content forward, so the old name counts too; a deletion does not.
function credentialFile(entries) {
  for (const e of entries) {
    if (/^D+$/.test(e.status)) continue;
    const names = /^[RC]/.test(e.status) ? e.paths : [e.paths[e.paths.length - 1]];
    const hit = names.find((f) => f && ((/(^|\/)\.env(\.|$)/.test(f) && !/\.env\.(example|template|sample)$/.test(f)) || /\.(?:pfx|p12|jks|keystore)$|(^|\/)id_(?:rsa|ed25519|ecdsa|dsa)$/i.test(f)));
    if (hit) return hit;
  }
  return '';
}

function check(verb, content) {
  const scope = verb === 'commit' ? 'the staged changes' : 'the commits this push would publish';
  if (attribution.test(cmd) || attribution.test(content.added)) {
    deny('Blocked: AI attribution detected (a Claude co-author trailer or a Claude Code generation footer). Remove it before ' + (verb === 'commit' ? 'committing' : 'pushing') + '.');
  }
  if (content.messages && attribution.test(content.messages)) {
    deny('Blocked: AI attribution found in a commit message this push would publish. Amend/rebase the offending commit to remove it before pushing.');
  }
  const envFile = credentialFile(content.entries);
  if (envFile) {
    deny('Blocked: a credential file is in ' + scope + ' (' + envFile + '). Add it to .gitignore and keep secrets out of git; if it holds real values, rotate them.' +
      (verb === 'push' ? ' Removing it in a later commit does not remove it from the history this push would publish.' : ''));
  }
  for (let i = 0; i < patterns.length; i++) {
    if (patterns[i][0].test(content.added)) {
      deny('Blocked: ' + patterns[i][1] + ' appears in ' + scope + '. Move it to user-secrets / a secret store and remove the literal value.' +
        (verb === 'push' ? ' It is in the outgoing history even if a later commit replaced it — rewrite that commit and rotate the value.' : ''));
    }
    // Also the command itself — catches a secret pasted into a -m commit message.
    if (patterns[i][0].test(cmd)) {
      deny('Blocked: ' + patterns[i][1] + ' appears in the git command itself (e.g. the commit message). Remove it — commit messages are permanent history.');
    }
    // And the messages of commits a push would publish — covers -F message
    // files and commits made outside this hook.
    if (content.messages && patterns[i][0].test(content.messages)) {
      deny('Blocked: ' + patterns[i][1] + ' appears in a commit message this push would publish. Rewrite the message (amend/rebase) and rotate the value — it is already in local history.');
    }
  }
}

// ---------------------------------------------------------------------------
// Each commit/push in the command, in order; the first deny wins.
// ---------------------------------------------------------------------------

let pendingAsk = '';
for (const action of actions) {
  const g = action.git;
  const verb = g.sub;
  if (!g.certain) {
    if (verb === 'push') deny('Blocked: this push cannot be scanned for secrets (' + g.why + '). Run plain `git push` from the repository directory, as its own command.');
    pendingAsk = pendingAsk || 'precommit-guard: this commit cannot be scanned for secrets (' + g.why + '). Run plain `git commit` from the repository directory, or confirm you know the changes hold no secrets.';
    continue;
  }
  const content = verb === 'commit' ? commitContent(action, records.indexOf(action)) : pushContent(action);
  if (!content.ok) {
    if (content.notRepo) continue;       // not a repository: git itself refuses the commit/push
    if (verb === 'push') {
      deny('Blocked: the outgoing commits could not be fully scanned for secrets — ' + content.why + '. Nothing was verified. ' +
        'Check the remote (git fetch' + (content.dest ? ' ' + content.dest : '') + '), push a smaller range, or review the outgoing history yourself ' +
        '(git log -p --cc --no-textconv <remote>/<branch>..HEAD) and push from your own terminal.');
    }
    pendingAsk = pendingAsk || 'precommit-guard: the staged changes could not be scanned for secrets (' + content.why + '). Confirm only if you know they hold none.';
    continue;
  }
  check(verb, content);
}
if (pendingAsk) emit('ask', pendingAsk);
allow();
