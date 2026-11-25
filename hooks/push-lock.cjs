#!/usr/bin/env node
'use strict';
/*
 * push-lock.cjs — the push guard's answer for a push typed outside Claude (2026-11-25, owner, batch x task 3).
 *
 * THE PROBLEM: the push guard (policy-guard.js) is a Claude hook. A push the owner types in a terminal, or a push from
 * a Codex task, passed no check at all.
 *
 * THE PROMISE:
 *  1. A git pre-push hook, put in ONE repository by one explicit command and taken out by one command:
 *       node ~/.claude/hooks/push-lock.cjs install --repo <path>
 *       node ~/.claude/hooks/push-lock.cjs remove --repo <path>
 *     A repository where it was never installed is not touched. It refuses to install over a pre-push hook it did not
 *     write, and into a hooks folder set by core.hooksPath (that folder may serve other repositories).
 *  2. A push passes only when the records the push guard already trusts say yes for the exact commits being pushed:
 *     the push guard itself (policy-guard.js, unchanged) is asked about this very push, with the transcript of a Claude
 *     session on this PC, and must allow it (a passing evidence.mjs receipt of this tree, the reviewer run, REVIEW: PASS,
 *     GATE: PASS, no open note); and the review record (lib/review-store.cjs, the guard's own code) must hold these
 *     exact commits. In the workflow lane (git config sanad.lane workflow) the guard needs no reviewer, so no review
 *     record is asked for either. No second set of rules lives here.
 *  3. It never accepts what the push guard would refuse: a guard answer of "ask" (a direct push to the integration
 *     branch, a force push, a delete, a tag) is a refusal here, because a hook cannot ask the human.
 *  4. The repository settings are the guard's own: it runs in this repository, so it reads sanad.lane and
 *     sanad.integration itself.
 *  5. A refusal is one line: what is missing, and the command that makes the push pass.
 *  6. A record it cannot read (a damaged review record file, a transcript the guard cannot scan, a guard that crashed or
 *     ran out of time) is a refusal, never a pass.
 *
 * A Codex-only task leaves no Claude transcript, so its push is refused until a Claude session on this PC has checked
 * and reviewed that tree (owner, 2026-11-25: "yes, refuse").
 *
 * The transcripts searched: the newest .jsonl files (at most 12, changed in the last 7 days) under the session roots
 * that lib/session-root.cjs trusts (~/.claude/projects, the projects folder of CLAUDE_CONFIG_DIR, and Orca's
 * <APPDATA>/orca/claude-profiles/<id>/home/projects) whose text names this repository's folder. The guard is asked with
 * each in turn, newest first, until one allows; 150 s in all.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const HERE = __dirname;
const MARK = '# sanad-push-lock';
const ZERO = /^0+$/;
const MAX_TRANSCRIPTS = 12, MAX_AGE_MS = 7 * 24 * 3600 * 1000, BUDGET_MS = 150000;
const slash = (p) => String(p).replace(/\\/g, '/');

function git(cwd, args) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000, windowsHide: true }).trim(); } catch (e) { return null; }
}
const NEXT = (repo) => `in a Claude session on this branch run \`node ~/.claude/skills/gate/scripts/sanad.mjs next --repo ${slash(repo)}\` and follow it to a passing check, REVIEW: PASS and GATE: PASS, then push again`;

// ---- install / remove --------------------------------------------------------------------------------------------

// The repository's own hooks folder, or { error }.
function hooksDir(repo) {
  const top = git(repo, ['rev-parse', '--show-toplevel']);
  if (!top) return { error: `${slash(repo)} is not a git repository` };
  const set = git(top, ['config', '--get', 'core.hooksPath']);
  if (set) return { error: `this repository reads its hooks from core.hooksPath (${slash(set)}), a folder other repositories may share; the push lock installs only into the repository's own hooks folder` };
  const dir = git(top, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']);
  return dir ? { top, dir } : { error: 'the hooks folder of this repository cannot be found' };
}
function shim() {
  const q = (s) => "'" + slash(s).replace(/'/g, "'\\''") + "'";
  return ['#!/bin/sh', MARK, `# Written by push-lock.cjs install. Remove it with: node ${q(path.join(HERE, 'push-lock.cjs'))} remove --repo <this repository>`,
    `exec ${q(process.execPath)} ${q(path.join(HERE, 'push-lock.cjs'))} check "$@"`, ''].join('\n');
}
function install(repo) {
  const h = hooksDir(repo);
  if (h.error) return { code: 1, line: `PUSH LOCK: not installed — ${h.error}.` };
  const file = path.join(h.dir, 'pre-push');
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes(MARK)) return { code: 1, line: `PUSH LOCK: not installed — ${slash(file)} is another pre-push hook; nothing was changed.` };
  }
  fs.mkdirSync(h.dir, { recursive: true });
  fs.writeFileSync(file, shim(), { mode: 0o755 });
  try { fs.chmodSync(file, 0o755); } catch (e) { /* Windows */ }
  return { code: 0, line: `PUSH LOCK: installed in ${slash(file)} — every push from ${slash(h.top)} now needs the push guard's yes.` };
}
function remove(repo) {
  const h = hooksDir(repo);
  if (h.error) return { code: 1, line: `PUSH LOCK: not removed — ${h.error}.` };
  const file = path.join(h.dir, 'pre-push');
  if (!fs.existsSync(file)) return { code: 0, line: `PUSH LOCK: none in ${slash(h.top)}; nothing to remove.` };
  if (!fs.readFileSync(file, 'utf8').includes(MARK)) return { code: 1, line: `PUSH LOCK: not removed — ${slash(file)} is another pre-push hook, not the push lock.` };
  fs.rmSync(file);
  return { code: 0, line: `PUSH LOCK: removed from ${slash(h.top)}.` };
}

// ---- the check ---------------------------------------------------------------------------------------------------

// git's pre-push lines: "<local ref> <local sha> <remote ref> <remote sha>".
function pushLines(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [localRef, localSha, remoteRef, remoteSha] = l.split(/\s+/);
    return { localRef, localSha, remoteRef, remoteSha };
  });
}
// The push as the guard reads it: one git push command with every ref of this push. HEAD stands for the checked-out
// commit (the guard verifies HEAD only); a delete is `:<ref>`; a remote ref the local commit does not contain is a
// force push.
function pushCommand(top, remote, lines) {
  const head = git(top, ['rev-parse', 'HEAD']);
  let force = false;
  const specs = lines.map((l) => {
    if (ZERO.test(l.localSha)) return ':' + l.remoteRef;
    if (l.remoteSha && !ZERO.test(l.remoteSha) && git(top, ['merge-base', '--is-ancestor', l.remoteSha, l.localSha]) === null) force = true;
    return (l.localSha === head ? 'HEAD' : l.localRef) + ':' + l.remoteRef;
  });
  const word = (s) => (/^[\w@%+=:,./~-]+$/.test(s) ? s : "'" + String(s).replace(/'/g, "'\\''") + "'");
  return `git push ${force ? '--force ' : ''}${word(remote)} ${specs.map(word).join(' ')}`;
}

function sessionRoots(env) {
  const roots = [];
  let home = '';
  try { home = os.homedir(); } catch (e) { home = ''; }
  if (home) roots.push(path.join(home, '.claude', 'projects'));
  if (env.CLAUDE_CONFIG_DIR) roots.push(path.join(env.CLAUDE_CONFIG_DIR, 'projects'));
  const profiles = path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'orca', 'claude-profiles');
  try { for (const p of fs.readdirSync(profiles)) roots.push(path.join(profiles, p, 'home', 'projects')); } catch (e) { /* no Orca */ }
  return roots;
}
// The newest transcripts of trusted sessions that name this repository's folder.
function transcripts(top, env = process.env, now = Date.now()) {
  const { inSessionRoot } = require(path.join(HERE, 'lib', 'session-root.cjs'));
  const found = [];
  for (const root of sessionRoots(env)) {
    let dirs = [];
    try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch (e) { continue; }
    for (const d of dirs) {
      let files = [];
      try { files = fs.readdirSync(path.join(root, d.name)).filter((f) => f.endsWith('.jsonl')); } catch (e) { continue; }
      for (const f of files) {
        const file = path.join(root, d.name, f);
        try { const st = fs.statSync(file); if (now - st.mtimeMs <= MAX_AGE_MS && inSessionRoot(file, env)) found.push({ file, at: st.mtimeMs }); } catch (e) { /* gone */ }
      }
    }
  }
  found.sort((a, b) => b.at - a.at);
  const spellings = [slash(top), top.replace(/\//g, '\\'), top.replace(/[\\/]/g, '\\\\')].map((s) => s.toLowerCase());
  const out = [];
  for (const t of found) {
    if (out.length >= MAX_TRANSCRIPTS) break;
    let text = '';
    try { text = fs.readFileSync(t.file, 'utf8').toLowerCase(); } catch (e) { continue; }
    if (spellings.some((s) => text.includes(s))) out.push(t.file);
  }
  return out;
}

// The guard's answer for this push with one transcript: { decision: allow|deny|ask, reason }.
function askGuard(top, command, transcript, timeoutMs) {
  const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: top, transcript_path: transcript, session_id: path.basename(transcript, '.jsonl'), tool_input: { command } };
  const r = spawnSync(process.execPath, [path.join(HERE, 'policy-guard.js')], { cwd: top, input: JSON.stringify(input), encoding: 'utf8', timeout: Math.max(1000, timeoutMs), windowsHide: true });
  if (r.error || r.status !== 0) return { decision: 'deny', reason: `the push guard could not finish (${r.error ? r.error.code || r.error.message : 'exit ' + r.status})` };
  const out = String(r.stdout || '').trim();
  if (!out) return { decision: 'allow', reason: '' };
  try {
    const o = JSON.parse(out).hookSpecificOutput || {};
    return { decision: o.permissionDecision === 'ask' ? 'ask' : o.permissionDecision === 'deny' ? 'deny' : 'deny', reason: String(o.permissionDecisionReason || 'no reason given') };
  } catch (e) { return { decision: 'deny', reason: 'the push guard gave an answer that cannot be read' }; }
}

// The review record of the exact commits being pushed, read with the guard's own code: { ok, why }.
function reviewRecord(top) {
  const store = require(path.join(HERE, 'lib', 'review-store.cjs'));
  const scan = require(path.join(HERE, 'lib', 'transcript-scan.js'));
  const file = path.join(scan.stateFolder(), store.FILE);
  if (fs.existsSync(file)) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!data || !Array.isArray(data.records)) return { ok: false, why: `the review record file ${slash(file)} cannot be read` };
    } catch (e) { return { ok: false, why: `the review record file ${slash(file)} cannot be read` }; }
  }
  const snap = store.snapshot(top, store.defaultBase(top));
  if (!snap) return { ok: false, why: 'the commits being pushed cannot be listed (no push base, or changed files of these commits are not committed)' };
  const hit = store.load().some((x) => x.repo === snap.repo && x.head === snap.head && Array.isArray(x.commits) && x.commits.join() === snap.commits.join());
  return hit ? { ok: true, why: '' } : { ok: false, why: `no review record holds these ${snap.commits.length} commit(s) (HEAD ${snap.head.slice(0, 12)})` };
}

// The decision for one push: { code: 0|1, line }.
function check(top, remote, stdinText, env = process.env) {
  const refuse = (what, how) => ({ code: 1, line: `PUSH LOCK: refused — ${what}. To make it pass: ${how}.` });
  const lines = pushLines(stdinText);
  if (!lines.length) return { code: 0, line: '' };   // git sends no line when nothing is pushed
  if (lines.some((l) => !l.localRef || !/^[0-9a-f]{40,64}$/i.test(l.localSha || '') || !l.remoteRef)) return refuse('git sent a push line that cannot be read', NEXT(top));
  const command = pushCommand(top, remote || 'origin', lines);
  const lane = String(git(top, ['config', '--get', 'sanad.lane']) || '').toLowerCase();
  if (lane !== 'workflow' && !lines.every((l) => ZERO.test(l.localSha))) {
    let rec;
    try { rec = reviewRecord(top); } catch (e) { rec = { ok: false, why: 'the review record cannot be read' }; }
    if (!rec.ok) return refuse(rec.why, NEXT(top));
  }
  const start = Date.now();
  const list = transcripts(top, env);
  if (!list.length) return refuse('no Claude session on this PC checked and reviewed this tree (a push from a Codex task or a terminal needs one)', NEXT(top));
  let first = null;
  for (const t of list) {
    const left = BUDGET_MS - (Date.now() - start);
    if (left <= 1000) break;
    const a = askGuard(top, command, t, Math.min(left, 40000));
    if (a.decision === 'allow') return { code: 0, line: `PUSH LOCK: the push guard allows this push (session ${path.basename(t, '.jsonl')}).` };
    if (!first || (first.decision === 'deny' && a.decision === 'ask')) first = a;
  }
  if (!first) return refuse('the push guard could not be asked in time', 'push again');
  const reason = first.reason.replace(/^Blocked by policy-guard:\s*|^policy-guard:\s*/, '').replace(/\s+/g, ' ').slice(0, 300);
  return first.decision === 'ask'
    ? refuse(`the push guard would ask the human first (${reason}), and a hook cannot ask`, 'push from a Claude session, where the guard asks you, or push the feature branch to its PR instead')
    : refuse(`the push guard refuses it (${reason})`, NEXT(top));
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const opt = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
  if (cmd === 'install' || cmd === 'remove') {
    const repo = opt('--repo');
    if (!repo) { process.stdout.write(`usage: node push-lock.cjs ${cmd} --repo <path>\n`); return 2; }
    const r = cmd === 'install' ? install(path.resolve(repo)) : remove(path.resolve(repo));
    process.stdout.write(r.line + '\n');
    return r.code;
  }
  if (cmd === 'check') {
    let stdin = '';
    try { stdin = fs.readFileSync(0, 'utf8'); } catch (e) { stdin = ''; }
    const top = git(process.cwd(), ['rev-parse', '--show-toplevel']);
    if (!top) { process.stderr.write('PUSH LOCK: refused — the repository of this push cannot be found. To make it pass: push from inside the repository.\n'); return 1; }
    let r;
    try { r = check(top, rest[0], stdin); } catch (e) { r = { code: 1, line: `PUSH LOCK: refused — the check failed (${String(e && e.message || e).slice(0, 160)}). To make it pass: ${NEXT(top)}.` }; }
    if (r.line) process.stderr.write(r.line + '\n');
    return r.code;
  }
  process.stdout.write('usage: node push-lock.cjs install --repo <path> | remove --repo <path>\n');
  return 2;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { MARK, install, remove, check, pushLines, pushCommand, transcripts, reviewRecord };
