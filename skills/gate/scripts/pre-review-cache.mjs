// pre-review-cache.mjs — pre-review remembers each check that passed on the exact same code, and does not run it again.
//
// 2026-11-16 (timed small test on release 6): "checks before review" took 13 of 25 working minutes. After every
// fix, pre-review runs twice (before the proof and after it), and each run checked lint and types again on the
// test machine (about 30 s each) and the size, the commits and the project check, though nothing had changed in
// between. A check that PASSED is kept with a key of everything its answer depends on:
//   - the check itself: its name, command, arguments and folder;
//   - the code: the commit (HEAD) and the tree of the working folder, uncommitted and untracked files included;
//   - the base commit the change is compared with;
//   - the content of every file named in its arguments (the notes files, the scripts, the tools), except the
//     type checker's own build-info file, which it rewrites on every run. Notes folders live in the temp folder
//     too, so a file there counts like any other.
// The same key on a later run reads the kept answer instead of running the check. A failed check is never kept.
// Checks that read state outside these inputs are never kept: the test asserts check (the proof record), the
// one-job check (the user's answer in git config), the places and siblings checks (cheap, and the places check
// rewrites its own list).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const NEVER = new Set(['test asserts', 'one job', 'places', 'siblings']);
const KEEP = 200;

const sha = (data) => crypto.createHash('sha256').update(data).digest('hex');
function git(cwd, args, env) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: env ? { ...process.env, ...env } : process.env }).trim(); }
  catch { return ''; }
}

// The working folder as one tree id: HEAD's files plus every uncommitted and untracked (not ignored) change,
// written through a copy of the index, so the real index is never touched and unchanged files are not hashed again.
export function workTree(repo) {
  const real = git(repo, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
  const tmp = path.join(os.tmpdir(), `sanad-pre-review-index-${process.pid}-${Date.now()}`);
  try {
    if (real && fs.existsSync(real)) fs.copyFileSync(real, tmp);
    const env = { GIT_INDEX_FILE: tmp };
    if (!real || !fs.existsSync(real)) git(repo, ['read-tree', 'HEAD'], env);
    git(repo, ['add', '-A'], env);
    return git(repo, ['write-tree'], env);
  } finally { try { fs.rmSync(tmp, { force: true }); } catch { /* gone */ } }
}

// What every check of this run shares: the code and the base. Empty fields: no key at all (nothing is kept or read).
export function runIdentity(repo, base) {
  return { head: git(repo, ['rev-parse', 'HEAD']), tree: workTree(repo), base: git(repo, ['rev-parse', base]) };
}

// The content of each argument that is a file, so a changed notes file or tool means another key.
function argFiles(args = []) {
  const out = {};
  for (const a of args) {
    if (typeof a !== 'string' || a.length > 1000 || /[\r\n]/.test(a)) continue;
    let st;
    try { st = fs.statSync(a); } catch { continue; }
    if (!st.isFile() || /\.tsbuildinfo$/i.test(a)) continue;
    try { out[path.resolve(a)] = sha(fs.readFileSync(a)); } catch { /* unreadable: no key part */ }
  }
  return out;
}

export function checkKey(check, ident) {
  if (!ident || !ident.head || !ident.tree || !ident.base || NEVER.has(check.name) || check.notRun) return '';
  return sha(JSON.stringify({ name: check.name, cmd: check.cmd, args: check.args, cwd: path.resolve(check.cwd || '.').toLowerCase(), ...ident, files: argFiles(check.args) }));
}

export function cacheFile() {
  return path.join(process.env.SANAD_STATE_DIR || path.join(os.homedir(), '.claude', 'state'), 'pre-review-cache.json');
}
function readAll() {
  try { const j = JSON.parse(fs.readFileSync(cacheFile(), 'utf8')); return j && typeof j.entries === 'object' ? j : { entries: {} }; }
  catch { return { entries: {} }; }
}
export function lookup(key) {
  if (!key) return null;
  return readAll().entries[key] || null;
}
// Keeps the passed results of this run; the oldest go first past KEEP entries.
export function remember(results) {
  const kept = results.filter(r => r.key && r.code === 0 && !r.cached);
  if (!kept.length) return;
  const all = readAll();
  for (const r of kept) all.entries[r.key] = { at: new Date().toISOString(), name: r.name, out: String(r.out || '').slice(-20000), ms: r.ms };
  const keys = Object.keys(all.entries).sort((a, b) => Date.parse(all.entries[a].at) - Date.parse(all.entries[b].at));
  for (const k of keys.slice(0, Math.max(0, keys.length - KEEP))) delete all.entries[k];
  try {
    fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
    const tmp = cacheFile() + '.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(all));
    fs.renameSync(tmp, cacheFile());
  } catch { /* no cache this time: the next run checks again */ }
}
