#!/usr/bin/env node
// pre-review.mjs — every check before review, at the same time, on the repository you are in, with
// one summary.
//
// 2026-11-06: five checks ran one after another (3.5 minutes on a one-line fix), and the project's
// mechanical check read another folder and called the wrong code clean. This runs them in parallel,
// always on the git top level of --repo (default: the current folder):
//   lint        ESLint on the changed script files of each package that has it
//   types       tsc --noEmit on each package with a changed .ts/.tsx file (tsconfig.app.json first)
//               Both run here when the package's node_modules is here. A task's own folder (a new git
//               worktree) has none: they then run in the clone on the test machine (git config
//               sanad.remoteHost, sanad.remoteRepo), after a sync of this folder's exact code, and with
//               no test machine they show as NOT RUN and fail the run. Never left out silently.
//   format      `dotnet csharpier check` on the changed .cs files, from the folder whose tool manifest
//               (.config/dotnet-tools.json) lists CSharpier: the project's own version, CI's command
//   ticket      check-ticket-lines.mjs, when --lines is given
//   asserts     check-test-asserts.mjs: new test lines — a range where the exact value is known, a "nothing
//               happens" check no break run proved, and (with --check) a check line with no [Cn] test
//   commits     check-commits.mjs: one commit, a Conventional subject that ends with the ticket ID
//   size        size-check.mjs on the real change (--was <size> fails when it grew)
//   mechanical  the project's own script, when `git config sanad.mechanical <path>` is set
// A .NET change is built and tested by the test step, not here.
//
// Usage: node pre-review.mjs [--repo <path>] [--base <ref>] [--was <size>] [--lines <file>] [--check <file>] [--node <path>]
//   --base defaults to origin/<sanad.integration | staging>; --node (or `git config sanad.node`)
//   is the Node that runs the package tools.
// Exit 0: every check passed. 1: a check failed. 2: usage error.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
export function planChecks({ repo, base, was, lines, check, node, remote }) {
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
    const eslint = path.join(pkg, 'node_modules', 'eslint', 'bin', 'eslint.js');
    if (fs.existsSync(eslint)) checks.push({ name: `lint ${name} (${count})`, cmd: node, args: [eslint, ...list], cwd: pkg });
    else if (lists(pkg, 'eslint')) owed('lint', count, ['node_modules/eslint/bin/eslint.js', ...list]);
    const tsc = path.join(pkg, 'node_modules', 'typescript', 'bin', 'tsc');
    const config = ['tsconfig.app.json', 'tsconfig.json'].find(c => fs.existsSync(path.join(pkg, c)));
    if (config && list.some(f => /\.tsx?$/i.test(f))) {
      // Incremental, with its build info outside the repo: a repeat run reads only what changed.
      const infoName = 'sanad-tsc-' + crypto.createHash('sha1').update((remote && !fs.existsSync(tsc) ? remote.repo + '/' + name : pkg).toLowerCase() + config).digest('hex').slice(0, 12) + '.tsbuildinfo';
      if (fs.existsSync(tsc)) checks.push({ name: `types ${name}`, cmd: node, args: [tsc, '-p', config, '--noEmit', '--incremental', '--tsBuildInfoFile', path.join(os.tmpdir(), infoName)], cwd: pkg });
      else if (lists(pkg, 'typescript')) owed('types', '', ['node_modules/typescript/bin/tsc', '-p', config, '--noEmit', '--incremental', '--tsBuildInfoFile', (remote && /^[A-Za-z]:\//.test(remote.repo) ? '%TEMP%\\' : '/tmp/') + infoName]);
    }
  }
  // 2026-11-10 (PR #767): CI's format check failed on two C# files that came in an earlier commit. The commit
  // guard checks only the files staged right then, and the user's own push runs no hook. Every changed .cs
  // file is checked here, with the same command CI runs.
  const byTool = new Map();
  for (const f of files.filter(f => /\.cs$/i.test(f))) {
    const dir = csharpierRootOf(repo, f);
    if (!dir) continue;
    if (!byTool.has(dir)) byTool.set(dir, []);
    byTool.get(dir).push(path.relative(dir, path.join(repo, f)).replace(/\\/g, '/'));
  }
  for (const [dir, list] of byTool) {
    const name = path.relative(repo, dir).replace(/\\/g, '/') || '.';
    checks.push({ name: `format ${name} (${list.length} C# file${list.length === 1 ? '' : 's'})`, cmd: 'dotnet', args: ['csharpier', 'check', ...list], cwd: dir });
  }
  if (lines) checks.push({ name: 'ticket lines', cmd: process.execPath, args: [path.join(here, 'check-ticket-lines.mjs'), '--lines', lines, '--repo', repo, '--base', base], cwd: repo });
  checks.push({ name: 'test asserts', cmd: process.execPath, args: [path.join(here, 'check-test-asserts.mjs'), '--repo', repo, '--base', base, ...(check ? ['--check', check] : [])], cwd: repo });
  checks.push({ name: 'commits', cmd: process.execPath, args: [path.join(here, 'check-commits.mjs'), '--repo', repo, '--base', base], cwd: repo });
  checks.push({ name: 'size', cmd: process.execPath, args: [path.join(here, 'size-check.mjs'), '--repo', repo, '--base', base, ...(was ? ['--was', was] : [])], cwd: repo, show: true });
  const mechanical = git(repo, ['config', '--get', 'sanad.mechanical']);
  if (mechanical) checks.push({ name: 'mechanical', cmd: process.execPath, args: [mechanical, '--repo', repo, '--base', base], cwd: repo, show: true });
  return { files, checks, remote };
}

// Same folder as checkLockDir() in evidence.mjs: a lock per source-bound check that runs right now.
export function otherTaskOnRemote(repo, remote) {
  const dir = process.env.SANAD_CHECK_LOCK_DIR || path.join(os.homedir(), '.claude', 'state', 'check-locks');
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => n.endsWith('.json')); } catch { return ''; }
  for (const n of names) {
    try {
      const lock = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (!(Date.parse(lock.expiresAt) > Date.now()) || same(String(lock.toplevel || ''), repo)) continue;
      try { process.kill(lock.pid, 0); } catch (e) { if (e.code !== 'EPERM') continue; }
      if (new RegExp(`(?:^|[\\s@])${remote.host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`).test(String(lock.command || ''))) return String(lock.toplevel);
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

// opts.sync: tests only (in place of the real sync to the test machine).
export async function preReview(opts) {
  const { files, checks, remote } = planChecks(opts);
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
  const lines = [`PRE-REVIEW: ${results.filter(r => r.code === 0).length} of ${results.length} checks passed · ${files.length} changed file(s) · ${opts.repo}`];
  if (synced) lines.push(synced);
  for (const r of results) {
    lines.push(`  ${r.code === 0 ? '✓' : '✗'} ${r.name}${r.notRun ? ' — NOT RUN' : ` (${(r.ms / 1000).toFixed(1)} s)`}`);
    const text = r.out.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).filter(l => l.trim());
    if (r.code !== 0) lines.push(...text.slice(-12).map(l => '      ' + l));
    else if (r.show) lines.push(...text.filter(l => /^(?:SIZE|SIZE GREW|MECHANICAL|  callers|  roles)/.test(l)).map(l => '      ' + l.trim()));
  }
  return { ok: results.every(r => r.code === 0), text: lines.join('\n') };
}

function parse(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!['--repo', '--base', '--was', '--lines', '--check', '--node'].includes(k) || argv[i + 1] === undefined) throw new Error('Unknown or empty option: ' + k);
    o[k.slice(2)] = argv[++i];
  }
  return o;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const o = parse(process.argv.slice(2));
    const repo = git(path.resolve(o.repo || process.cwd()), ['rev-parse', '--show-toplevel']);
    if (!repo) throw new Error('not inside a git repository: ' + (o.repo || process.cwd()));
    const integration = git(repo, ['config', '--get', 'sanad.integration']) || 'staging';
    const node = o.node || git(repo, ['config', '--get', 'sanad.node']) || process.execPath;
    const { ok, text } = await preReview({ repo: path.resolve(repo), base: o.base || 'origin/' + integration, was: o.was, lines: o.lines && path.resolve(o.lines), check: o.check && path.resolve(o.check), node });
    process.stdout.write(text + '\n');
    process.exitCode = ok ? 0 : 1;
  } catch (error) {
    process.stderr.write('PRE-REVIEW: ' + error.message + '\nUsage: node pre-review.mjs [--repo <path>] [--base <ref>] [--was <size>] [--lines <file>] [--check <file>] [--node <path>]\n');
    process.exitCode = 2;
  }
}
