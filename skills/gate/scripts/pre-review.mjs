#!/usr/bin/env node
// pre-review.mjs — every check before review, at the same time, on the repository you are in, with
// one summary.
//
// 2026-11-06: five checks ran one after another (3.5 minutes on a one-line fix), and the project's
// mechanical check read another folder and called the wrong code clean. This runs them in parallel,
// always on the git top level of --repo (default: the current folder):
//   lint        ESLint on the changed script files of each package that has it
//   types       tsc --noEmit on each package with a changed .ts/.tsx file (tsconfig.app.json first)
//   ticket      check-ticket-lines.mjs, when --lines is given
//   asserts     check-test-asserts.mjs: new test lines — a range where the exact value is known, a "nothing
//               happens" check no break run proved, and (with --check) a check line with no [Cn] test
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

export function planChecks({ repo, base, was, lines, check, node }) {
  const files = changedFiles(repo, base);
  const checks = [];
  const byPackage = new Map();
  for (const f of files.filter(f => SCRIPT.test(f))) {
    const pkg = packageOf(repo, f);
    if (!pkg) continue;
    if (!byPackage.has(pkg)) byPackage.set(pkg, []);
    byPackage.get(pkg).push(path.relative(pkg, path.join(repo, f)).replace(/\\/g, '/'));
  }
  for (const [pkg, list] of byPackage) {
    const name = path.relative(repo, pkg).replace(/\\/g, '/') || '.';
    const eslint = path.join(pkg, 'node_modules', 'eslint', 'bin', 'eslint.js');
    if (fs.existsSync(eslint)) checks.push({ name: `lint ${name} (${list.length} file${list.length === 1 ? '' : 's'})`, cmd: node, args: [eslint, ...list], cwd: pkg });
    const tsc = path.join(pkg, 'node_modules', 'typescript', 'bin', 'tsc');
    const config = ['tsconfig.app.json', 'tsconfig.json'].find(c => fs.existsSync(path.join(pkg, c)));
    if (fs.existsSync(tsc) && config && list.some(f => /\.tsx?$/i.test(f))) {
      // Incremental, with its build info outside the repo: a repeat run reads only what changed.
      const info = path.join(os.tmpdir(), 'sanad-tsc-' + crypto.createHash('sha1').update(pkg.toLowerCase() + config).digest('hex').slice(0, 12) + '.tsbuildinfo');
      checks.push({ name: `types ${name}`, cmd: node, args: [tsc, '-p', config, '--noEmit', '--incremental', '--tsBuildInfoFile', info], cwd: pkg });
    }
  }
  if (lines) checks.push({ name: 'ticket lines', cmd: process.execPath, args: [path.join(here, 'check-ticket-lines.mjs'), '--lines', lines, '--repo', repo, '--base', base], cwd: repo });
  checks.push({ name: 'test asserts', cmd: process.execPath, args: [path.join(here, 'check-test-asserts.mjs'), '--repo', repo, '--base', base, ...(check ? ['--check', check] : [])], cwd: repo });
  checks.push({ name: 'size', cmd: process.execPath, args: [path.join(here, 'size-check.mjs'), '--repo', repo, '--base', base, ...(was ? ['--was', was] : [])], cwd: repo, show: true });
  const mechanical = git(repo, ['config', '--get', 'sanad.mechanical']);
  if (mechanical) checks.push({ name: 'mechanical', cmd: process.execPath, args: [mechanical, '--repo', repo, '--base', base], cwd: repo, show: true });
  return { files, checks };
}

function runOne(check) {
  return new Promise(resolve => {
    const started = Date.now();
    let out = '';
    let child;
    try { child = spawn(check.cmd, check.args, { cwd: check.cwd, windowsHide: true, shell: false }); }
    catch (e) { resolve({ ...check, code: -1, out: String(e.message), ms: 0 }); return; }
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('error', e => resolve({ ...check, code: -1, out: out + String(e.message), ms: Date.now() - started }));
    child.on('close', code => resolve({ ...check, code, out, ms: Date.now() - started }));
  });
}

export async function preReview(opts) {
  const { files, checks } = planChecks(opts);
  const results = await Promise.all(checks.map(runOne));
  const lines = [`PRE-REVIEW: ${results.filter(r => r.code === 0).length} of ${results.length} checks passed · ${files.length} changed file(s) · ${opts.repo}`];
  for (const r of results) {
    lines.push(`  ${r.code === 0 ? '✓' : '✗'} ${r.name} (${(r.ms / 1000).toFixed(1)} s)`);
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
