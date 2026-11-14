#!/usr/bin/env node
// pre-review.mjs — every check before review, at the same time, on the repository you are in, with
// one summary.
//
// 2026-11-06: five checks ran one after another (3.5 minutes on a one-line fix), and the project's
// mechanical check read another folder and called the wrong code clean. This runs them in parallel,
// always on the git top level of --repo (default: the current folder):
//   lint        ESLint on the changed script files of each package that has it
//   types       tsc --noEmit on each package with a changed .ts/.tsx file: once per project the root
//               tsconfig.json references (tsconfig.app.json and tsconfig.node.json, as `tsc -b` does),
//               else tsconfig.app.json or tsconfig.json
//               Both run here when the package's node_modules is here. A task's own folder (a new git
//               worktree) has none: they then run in the clone on the test machine (git config
//               sanad.remoteHost, sanad.remoteRepo), after a sync of this folder's exact code, and with
//               no test machine they show as NOT RUN and fail the run. Never left out silently.
//   format      `dotnet csharpier check` on the changed .cs, .csproj, .props and .targets files, from the
//               folder whose tool manifest (.config/dotnet-tools.json) lists CSharpier: the project's own
//               version, CI's command
//   ticket      check-ticket-lines.mjs, when --lines is given
//   asserts     check-test-asserts.mjs: new test lines — a range where the exact value is known, a "nothing
//               happens" check no break run proved, and (with --check) a check line with no [Cn] test
//   commits     check-commits.mjs: one commit, a Conventional subject that ends with the ticket ID
//   size        size-check.mjs on the real change (--was <size> fails when it grew)
//   places      places.mjs: the list of every place that uses what the change touches (--places), searched
//               again first, then every place needs `C<n>` or `none: <reason>` (with --check, n is one of
//               its lines). With no --places: skipped for a text-only change (size tiny), else NOT RUN, a
//               failure (2026-11-12: the rule "list every place by search" was text and was skipped)
//   mechanical  the project's own script, when `git config sanad.mechanical <path>` is set
// A part left out because its option is missing (--lines, --check, --was) is printed as skipped.
// A .NET change is built and tested by the test step, not here.
//
// Usage: node pre-review.mjs [--repo <path>] [--base <ref>] [--was <size>] [--lines <file>] [--check <file>] [--places <file>] [--node <path>] [--before-proof]
//   --before-proof (2026-11-13): run right before red-proof.mjs. Everything runs except the proof part of
//   the test asserts check. A label, quote or commit fixed now does not void a proof; run it again after the
//   proof (Step 3.5), where every part runs.
//   --base defaults to origin/<sanad.integration | staging>; --node (or `git config sanad.node`)
//   is the Node that runs the package tools.
// Exit 0: every check passed. 1: a check failed. 2: usage error.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { isMain } from './is-main.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = /\.(?:[cm]?[jt]sx?)$/i;

function git(cwd, args) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

export function changedFiles(repo, base) {
  const from = git(repo, ['merge-base', base, 'HEAD']);
  if (!from) throw new Error(`no merge base with ${base}`);
  const tracked = git(repo, ['diff', '--name-only', '--diff-filter=d', from]).split(/\r?\n/);
  const untracked = git(repo, ['ls-files', '--others', '--exclude-standard']).split(/\r?\n/);
  return [...new Set([...tracked, ...untracked].filter(Boolean))].filter(f => fs.existsSync(path.join(repo, f)));
}

// The nearest folder above a file that holds a package.json, up to the repo root.
function packageOf(repo, file) {
  for (let dir = path.dirname(path.join(repo, file)); dir.length >= repo.length; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    if (dir === repo) break;
  }
  return null;
}

// The nearest folder above a file whose .config/dotnet-tools.json lists CSharpier, up to the repo root.
function csharpierRootOf(repo, file) {
  for (let dir = path.dirname(path.join(repo, file)); dir.length >= repo.length; dir = path.dirname(dir)) {
    try {
      const manifest = path.join(dir, '.config', 'dotnet-tools.json');
      if (fs.existsSync(manifest) && /csharpier/i.test(fs.readFileSync(manifest, 'utf8'))) return dir;
    } catch { /* unreadable manifest: keep looking up */ }
    if (dir === repo) break;
  }
  return null;
}

// A tsconfig file is JSON with comments and trailing commas: both are dropped (outside strings) before
// JSON.parse. null when the file is missing or still not JSON.
export function readJsonc(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); } catch { return null; }
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1); i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else if (c === ',' && /^\s*(?:\/\/[^\n]*\s*|\/\*[\s\S]*?\*\/\s*)*[}\]]/.test(text.slice(i + 1))) {
      // a trailing comma: dropped
    } else out += c;
  }
  try { return JSON.parse(out); } catch { return null; }
}

// 2026-11-12 (audit C15): types ran only tsconfig.app.json, so vite.config.ts and vitest.config.ts (in
// tsconfig.node.json) were never type checked here, while `tsc -b` in the build checks both. Each project
// the root tsconfig.json references is its own check; a package with no references keeps the one config.
export function tsProjects(pkg) {
  const root = readJsonc(path.join(pkg, 'tsconfig.json'));
  const refs = root && Array.isArray(root.references) ? root.references.map(r => (r && typeof r.path === 'string' ? r.path : '')).filter(Boolean) : [];
  if (refs.length) {
    return refs.map(ref => {
      const config = ref.replace(/\\/g, '/').replace(/^\.\//, '');
      const label = /\.json$/i.test(config) ? path.posix.basename(config).replace(/^tsconfig\.?/i, '').replace(/\.json$/i, '') : '';
      return { config, label: label || config };
    });
  }
  const config = ['tsconfig.app.json', 'tsconfig.json'].find(c => fs.existsSync(path.join(pkg, c)));
  return config ? [{ config, label: '' }] : [];
}

// Does the package's own package.json list this tool? Then its check is owed, installed here or not.
function lists(pkg, tool) {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'));
    return Boolean((json.devDependencies && json.devDependencies[tool]) || (json.dependencies && json.dependencies[tool]));
  } catch { return false; }
}

// The test machine and this repository's clone there (git config sanad.remoteHost, sanad.remoteRepo,
// sanad.remoteNode), or null when one of the two is not set.
export function remoteOf(repo) {
  const host = git(repo, ['config', '--get', 'sanad.remoteHost']);
  const there = git(repo, ['config', '--get', 'sanad.remoteRepo']).replace(/\\/g, '/').replace(/\/$/, '');
  return host && there ? { host, repo: there, node: git(repo, ['config', '--get', 'sanad.remoteNode']) || 'node' } : null;
}

// One command in a folder of the clone on the test machine, as the line its shell runs.
function remoteLine(remote, rel, words) {
  const windows = /^[A-Za-z]:\//.test(remote.repo);
  const dir = remote.repo + (rel && rel !== '.' ? '/' + rel : '');
  const q = (a) => (/[\s"&|<>^()]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a);
  return windows ? `cd /d ${q(dir.replace(/\//g, '\\'))} && ${words.map(q).join(' ')}` : `cd '${dir}' && ${words.map(q).join(' ')}`;
}
const sshArgs = (remote, line) => ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30', remote.host, line];

// `remote`: the test machine (remoteOf); undefined reads it from git config, null means none.
export function planChecks({ repo, base, was, lines, check, places, node, remote, beforeProof }) {
  const files = changedFiles(repo, base);
  const checks = [];
  if (remote === undefined) remote = remoteOf(repo);
  const byPackage = new Map();
  for (const f of files.filter(f => SCRIPT.test(f))) {
    const pkg = packageOf(repo, f);
    if (!pkg) continue;
    if (!byPackage.has(pkg)) byPackage.set(pkg, []);
    byPackage.get(pkg).push(path.relative(pkg, path.join(repo, f)).replace(/\\/g, '/'));
  }
  for (const [pkg, list] of byPackage) {
    const name = path.relative(repo, pkg).replace(/\\/g, '/') || '.';
    const count = `${list.length} file${list.length === 1 ? '' : 's'}`;
    // 2026-11-11 (TUW-242, TUW-243): a task's own folder (a new git worktree) has no node_modules, so lint
    // and types were left out without a word, and the summary still read "6 of 6 checks passed". A check
    // the package lists is owed: it runs here, or in the clone on the test machine, or shows as NOT RUN.
    const owed = (kind, detail, words) => {
      const extra = [detail, remote ? `on ${remote.host}` : ''].filter(Boolean).join(', ');
      const label = `${kind} ${name}${extra ? ` (${extra})` : ''}`;
      if (remote) checks.push({ name: label, cmd: 'ssh', args: sshArgs(remote, remoteLine(remote, name, [remote.node, ...words])), cwd: repo, remote: true });
      else checks.push({ name: label, notRun: `no node_modules in ${name}, and no test machine is set (git config sanad.remoteHost and sanad.remoteRepo): run \`npm ci\` in ${name}, then pre-review again.` });
    };
    // Warnings do not fail this check (2026-11-12): 14 of the project's 757 script files carry old warnings, and
    // a task that edits one of them would go red for lines it did not write.
    const eslint = path.join(pkg, 'node_modules', 'eslint', 'bin', 'eslint.js');
    if (fs.existsSync(eslint)) checks.push({ name: `lint ${name} (${count})`, cmd: node, args: [eslint, ...list], cwd: pkg });
    else if (lists(pkg, 'eslint')) owed('lint', count, ['node_modules/eslint/bin/eslint.js', ...list]);
    const tsc = path.join(pkg, 'node_modules', 'typescript', 'bin', 'tsc');
    if (list.some(f => /\.tsx?$/i.test(f))) {
      for (const { config, label } of tsProjects(pkg)) {
        // Incremental, with its build info outside the repo: a repeat run reads only what changed.
        const infoName = 'sanad-tsc-' + crypto.createHash('sha1').update((remote && !fs.existsSync(tsc) ? remote.repo + '/' + name : pkg).toLowerCase() + config).digest('hex').slice(0, 12) + '.tsbuildinfo';
        if (fs.existsSync(tsc)) checks.push({ name: `types ${name}${label ? ` (${label})` : ''}`, cmd: node, args: [tsc, '-p', config, '--noEmit', '--incremental', '--tsBuildInfoFile', path.join(os.tmpdir(), infoName)], cwd: pkg });
        else if (lists(pkg, 'typescript')) owed('types', label, ['node_modules/typescript/bin/tsc', '-p', config, '--noEmit', '--incremental', '--tsBuildInfoFile', (remote && /^[A-Za-z]:\//.test(remote.repo) ? '%TEMP%\\' : '/tmp/') + infoName]);
      }
    }
  }
  // 2026-11-10 (PR #767): CI's format check failed on two C# files that came in an earlier commit. The commit
  // guard checks only the files staged right then, and the user's own push runs no hook. Every changed .cs
  // file is checked here, with the same command CI runs. 2026-11-12 (audit C15): CSharpier 1.x also formats
  // .csproj, .props and .targets files, and CI runs it on the whole folder: changed ones are checked too.
  const byTool = new Map();
  for (const f of files.filter(f => /\.(?:cs|csproj|props|targets)$/i.test(f))) {
    const dir = csharpierRootOf(repo, f);
    if (!dir) continue;
    if (!byTool.has(dir)) byTool.set(dir, []);
    byTool.get(dir).push(path.relative(dir, path.join(repo, f)).replace(/\\/g, '/'));
  }
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  for (const [dir, list] of byTool) {
    const name = path.relative(repo, dir).replace(/\\/g, '/') || '.';
    const cs = list.filter(f => /\.cs$/i.test(f)).length;
    const what = [cs ? plural(cs, 'C# file') : '', list.length - cs ? plural(list.length - cs, 'project file') : ''].filter(Boolean).join(', ');
    checks.push({ name: `format ${name} (${what})`, cmd: 'dotnet', args: ['csharpier', 'check', ...list], cwd: dir });
  }
  if (lines) checks.push({ name: 'ticket lines', cmd: process.execPath, args: [path.join(here, 'check-ticket-lines.mjs'), '--lines', lines, '--repo', repo, '--base', base], cwd: repo });
  checks.push({ name: 'test asserts', cmd: process.execPath, args: [path.join(here, 'check-test-asserts.mjs'), '--repo', repo, '--base', base, ...(check ? ['--check', check] : []), ...(beforeProof ? ['--before-proof'] : [])], cwd: repo });
  checks.push({ name: 'commits', cmd: process.execPath, args: [path.join(here, 'check-commits.mjs'), '--repo', repo, '--base', base], cwd: repo });
  checks.push({ name: 'size', cmd: process.execPath, args: [path.join(here, 'size-check.mjs'), '--repo', repo, '--base', base, ...(was ? ['--was', was] : [])], cwd: repo, show: true });
  // 2026-11-12: the list is searched again in this folder before the check, so a place that appeared after
  // it was written (a new caller, a sibling path) shows as open and cannot be missed.
  if (places) checks.push({ name: 'places', cmd: process.execPath, args: [path.join(here, 'places.mjs'), '--refresh', places, '--repo', repo, '--check', places, ...(check ? ['--check-lines', check] : [])], cwd: repo, show: true });
  const mechanical = git(repo, ['config', '--get', 'sanad.mechanical']);
  if (mechanical) checks.push({ name: 'mechanical', cmd: process.execPath, args: [mechanical, '--repo', repo, '--base', base], cwd: repo, show: true });
  // 2026-11-12 (audit C14): with no --lines, --check or --was those parts were left out without a word, and
  // the summary still read "N of N checks passed". Each is named as skipped (not a failure).
  const skipped = [
    lines ? null : { name: 'ticket lines', why: 'no --lines' },
    check ? null : { name: 'test labels', why: 'no --check' },
    was ? null : { name: 'size growth', why: 'no --was' },
  ].filter(Boolean);
  return { files, checks, remote, skipped, placesOwed: !places };
}

// With no --places, the size check's answer decides (preReview): a text-only change (size tiny) skips the
// list; any other change owes it, and the run fails with the command that makes it (2026-11-12).
export function placesWithout(sizeOut, repo) {
  if (/^SIZE: tiny\b/m.test(String(sizeOut || ''))) return { skipped: { name: 'places', why: 'a text-only change' } };
  const cmd = `node ${path.join(here, 'places.mjs')} --repo ${repo} --names <names> --out <notes>/places.md`.replace(/\\/g, '/');
  return { result: { name: 'places', notRun: true, code: 1, ms: 0, out: `list every place that uses what you change: ${cmd}` } };
}

// Same folder as checkLockDir() in evidence.mjs: a lock per source-bound check that runs right now.
export function otherTaskOnRemote(repo, remote) {
  const dir = process.env.SANAD_CHECK_LOCK_DIR || path.join(os.homedir(), '.claude', 'state', 'check-locks');
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  // 2026-11-14: an id handed to a later process kept a stale lock "alive" here, and the sync (with lint and
  // types on the test machine) was skipped. The lock counts only while the process that wrote it holds the id
  // (hooks/lib/process-start.cjs, as in check-lock-guard.js), asked last, for a lock that would count. No
  // helper: the id check alone, as before.
  const sameProcess = (lock) => { try { return createRequire(import.meta.url)('../../../hooks/lib/process-start.cjs').sameProcess(lock); } catch { return true; } };
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => n.endsWith('.json')); } catch { return ''; }
  for (const n of names) {
    try {
      const lock = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (!(Date.parse(lock.expiresAt) > Date.now()) || same(String(lock.toplevel || ''), repo)) continue;
      try { process.kill(lock.pid, 0); } catch (e) { if (e.code !== 'EPERM') continue; }
      if (new RegExp(`(?:^|[\\s@])${remote.host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`).test(String(lock.command || '')) && sameProcess(lock)) return String(lock.toplevel);
    } catch { /* a lock being written: not a running check yet */ }
  }
  return '';
}

// Puts this folder's exact code on the test machine (scripts/remote/remote-sync.sh), unless another task's
// check runs there now: the clone is one folder, and a sync would change the code under that check.
function syncRemote(repo, remote) {
  const other = otherTaskOnRemote(repo, remote);
  if (other) return { ok: false, text: `another task's check runs on ${remote.host} now (${other}), and a sync would change the code under it. Run pre-review again when it ends.` };
  let out = '';
  try {
    out = execFileSync('bash', [path.join(os.homedir(), '.claude', 'scripts', 'remote', 'remote-sync.sh')], { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 10 * 60 * 1000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { out = String(e.stdout || '') + String(e.stderr || '') || String(e.message); }
  const synced = /^SYNCED \S+ \S+ tree (\S+)/m.exec(out);
  const via = /^VIA (\S+)/m.exec(out);
  return synced ? { ok: true, tree: synced[1], via: via ? via[1] : '' } : { ok: false, text: (out.split(/\r?\n/).find(l => l.trim()) || 'the sync printed nothing').trim() };
}

function runOne(check) {
  return new Promise(resolve => {
    const started = Date.now();
    let out = '';
    let child;
    // A check that could not run is a failed check with its reason, never a missing line.
    if (check.notRun) { resolve({ ...check, code: 1, out: check.notRun, ms: 0 }); return; }
    try { child = spawn(check.cmd, check.args, { cwd: check.cwd, windowsHide: true, shell: false, ...(check.remote ? { timeout: 10 * 60 * 1000 } : {}) }); }
    catch (e) { resolve({ ...check, code: -1, out: String(e.message), ms: 0 }); return; }
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('error', e => resolve({ ...check, code: -1, out: out + String(e.message), ms: Date.now() - started }));
    child.on('close', code => resolve({ ...check, code, out, ms: Date.now() - started }));
  });
}

// 2026-11-12 (audit C14): a failing check showed only its last 12 lines, so a ✗ or GAP line above them was
// lost. Every line that names a problem is shown, plus the last 12 lines, each once, in their own order.
const PROBLEM = /^(?:✗|GAP|BUG|UNTAGGED|UNPROVEN|NOT RUN|OPEN)/;
export function failureLines(text) {
  const keep = new Set(text.flatMap((l, i) => (PROBLEM.test(l.trim()) ? [i] : [])));
  for (let i = Math.max(0, text.length - 12); i < text.length; i++) keep.add(i);
  return [...keep].sort((a, b) => a - b).map(i => text[i]);
}

// opts.sync: tests only (in place of the real sync to the test machine).
export async function preReview(opts) {
  const { files, checks, remote, skipped, placesOwed } = planChecks(opts);
  let synced = '';
  if (checks.some(c => c.remote)) {
    const sync = (opts.sync || syncRemote)(opts.repo, remote);
    for (const c of checks.filter(c => c.remote)) {
      if (!sync.ok) c.notRun = `not run on ${remote.host}: ${sync.text}`;
      else if (sync.via) c.args = ['-o', 'HostName=' + sync.via, ...c.args];
    }
    if (sync.ok) synced = `  (no node_modules here: lint and types run on ${remote.host}, on this folder's code${sync.tree ? ', tree ' + String(sync.tree).slice(0, 12) : ''})`;
  }
  const results = await Promise.all(checks.map(runOne));
  if (placesOwed) {
    const size = results.find(r => r.name === 'size');
    const owed = placesWithout(size && size.out, opts.repo);
    if (owed.skipped) skipped.push(owed.skipped); else results.push(owed.result);
  }
  const skippedText = skipped.length ? ` · ${skipped.length} skipped: ${skipped.map(s => s.name).join(', ')}` : '';
  const label = opts.beforeProof ? 'PRE-REVIEW (before the proof)' : 'PRE-REVIEW';
  const lines = [`${label}: ${results.filter(r => r.code === 0).length} of ${results.length} checks passed${skippedText} · ${files.length} changed file(s) · ${opts.repo}`];
  if (synced) lines.push(synced);
  for (const r of results) {
    lines.push(`  ${r.code === 0 ? '✓' : '✗'} ${r.name}${r.notRun ? ' — NOT RUN' : ` (${(r.ms / 1000).toFixed(1)} s)`}`);
    const text = r.out.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).filter(l => l.trim());
    if (r.code !== 0) lines.push(...failureLines(text).map(l => '      ' + l));
    // The project check's GAP and NOTE lines are leads for the review: shown also when it passes (2026-11-12).
    else if (r.show) lines.push(...text.filter(l => /^(?:SIZE|SIZE GREW|MECHANICAL|GAP|NOTE|PLACES|  callers|  roles)/.test(l)).map(l => '      ' + l.trim()));
  }
  for (const s of skipped) lines.push(`  – ${s.name}: skipped (${s.why})`);
  return { ok: results.every(r => r.code === 0), text: lines.join('\n') };
}

function parse(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--before-proof') { o.beforeProof = true; continue; }
    if (!['--repo', '--base', '--was', '--lines', '--check', '--places', '--node'].includes(k) || argv[i + 1] === undefined) throw new Error('Unknown or empty option: ' + k);
    o[k.slice(2)] = argv[++i];
  }
  return o;
}

if (isMain(import.meta.url)) {
  try {
    const o = parse(process.argv.slice(2));
    const repo = git(path.resolve(o.repo || process.cwd()), ['rev-parse', '--show-toplevel']);
    if (!repo) throw new Error('not inside a git repository: ' + (o.repo || process.cwd()));
    const integration = git(repo, ['config', '--get', 'sanad.integration']) || 'staging';
    const node = o.node || git(repo, ['config', '--get', 'sanad.node']) || process.execPath;
    const { ok, text } = await preReview({ repo: path.resolve(repo), base: o.base || 'origin/' + integration, was: o.was, lines: o.lines && path.resolve(o.lines), check: o.check && path.resolve(o.check), places: o.places && path.resolve(o.places), node, beforeProof: !!o.beforeProof });
    process.stdout.write(text + '\n');
    process.exitCode = ok ? 0 : 1;
  } catch (error) {
    process.stderr.write('PRE-REVIEW: ' + error.message + '\nUsage: node pre-review.mjs [--repo <path>] [--base <ref>] [--was <size>] [--lines <file>] [--check <file>] [--places <file>] [--node <path>] [--before-proof]\n');
    process.exitCode = 2;
  }
}
