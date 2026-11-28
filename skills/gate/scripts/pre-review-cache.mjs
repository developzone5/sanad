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
//
// 2026-11-19: the commit (HEAD) was in every key, so committing a checked tree ran lint and types again on the
// very same files. Now a pass is kept by the tree, not by the commit:
//   - HEAD stays only in the key of the commits check (a reworded message is a new answer there);
//   - the whole tree, the base and the merge base stay in every key, and keys are not narrowed per check;
//   - what the tree does not hold joins every key: the Node version that runs the check, the package's lock
//     file, and the version of each tool the check runs from node_modules (an upgrade there changes no tracked
//     file, and must not read an old pass).
// A check that runs right now has a marker file per key (claim / release). A second run with the same key waits
// for the first and reads its answer; it never starts the same lint or type check twice.
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
  return { head: git(repo, ['rev-parse', 'HEAD']), tree: workTree(repo), base: git(repo, ['rev-parse', base]), mergeBase: git(repo, ['merge-base', base, 'HEAD']) };
}

// The one check whose answer depends on the commit itself (its message, how many commits there are).
export const HEAD_CHECKS = new Set(['commits']);

// The version of the Node that runs a check: this one, or the one the command names (asked once per command).
// '' for a command that is not Node (ssh, dotnet): its own arguments and the tree are its key.
const nodeVersions = new Map();
export function nodeVersionOf(cmd) {
  if (!cmd || cmd === process.execPath) return process.version;
  if (!/(?:^|[\\/])node(?:\.exe)?$/i.test(String(cmd))) return '';
  if (!nodeVersions.has(cmd)) {
    let v = '';
    try { v = execFileSync(cmd, ['--version'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }).trim(); } catch { v = 'unknown'; }
    nodeVersions.set(cmd, v);
  }
  return nodeVersions.get(cmd);
}

// The lock file of the package a check runs in: the nearest one at or above its folder, up to the repository's
// top. It is hashed by itself, because a project may keep it out of git.
const LOCKS = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml'];
export function lockFileOf(cwd) {
  let dir = path.resolve(cwd || '.');
  for (let i = 0; i < 40; i++) {
    for (const name of LOCKS) {
      const file = path.join(dir, name);
      try { if (fs.statSync(file).isFile()) return { [name]: sha(fs.readFileSync(file)) }; } catch { /* not here */ }
    }
    const up = path.dirname(dir);
    if (up === dir || fs.existsSync(path.join(dir, '.git'))) break;
    dir = up;
  }
  return {};
}

// The version of each tool a check runs from node_modules (its own package.json), by package name.
export function toolVersions(args = []) {
  const out = {};
  for (const a of args) {
    if (typeof a !== 'string' || a.length > 1000) continue;
    const m = /^(.*[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/.exec(a);
    if (!m) continue;
    try { const json = JSON.parse(fs.readFileSync(path.join(m[1], 'package.json'), 'utf8')); out[String(json.name || path.basename(m[1]))] = String(json.version || ''); } catch { /* no package.json: the file's own content is in the key */ }
  }
  return out;
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

// `ident.node`: tests only (in place of the real Node version).
export function checkKey(check, ident) {
  if (!ident || !ident.head || !ident.tree || !ident.base || NEVER.has(check.name) || check.notRun) return '';
  const { head, node, ...code } = ident;
  return sha(JSON.stringify({
    name: check.name, cmd: check.cmd, args: check.args, cwd: path.resolve(check.cwd || '.').toLowerCase(), ...code,
    ...(HEAD_CHECKS.has(check.name) ? { head } : {}),
    node: node || nodeVersionOf(check.cmd), lock: lockFileOf(check.cwd), tools: toolVersions(check.args), files: argFiles(check.args),
  }));
}

export function cacheFile() {
  return path.join(process.env.SANAD_STATE_DIR || path.join(os.homedir(), '.claude', 'state'), 'pre-review-cache.json');
}

// 2026-11-23 (owner, one proof per round): a whole `pre-review --before-proof` run (every part) and its answer, by the
// work tree it ran on, so the printed steps offer the proof only after those checks passed on this very code. Run 3 of
// the small task started the proof beside them, and the fixes they asked for voided two proofs. The step printer reads
// it (sanad.mjs); no guard does.
function beforeProofFile(repo) {
  let top = git(repo, ['rev-parse', '--show-toplevel']) || path.resolve(repo);
  try { top = fs.realpathSync.native(top); } catch { /* keep git's answer */ }
  return path.join(path.dirname(cacheFile()), 'before-proof', sha(path.resolve(top).replace(/\\/g, '/').toLowerCase()).slice(0, 16) + '.json');
}
// The task's list files the checks read, as one id: each file by its name, with its text (attack, 2026-11-23: a break
// list changed after the pass, in the notes folder outside the repository, and the old pass still matched). A file
// that is not there counts as empty.
export const BEFORE_PROOF_FILES = ['lines.md', 'check.md', 'places.md', 'siblings.md', 'breaks.json', 'task.json'];
// Each file's name and hash, read once (re-check 2: two reads at the end let an edit between them get the pass).
export function notesParts(paths) {
  return (paths || []).filter(Boolean).map((p) => {
    let text = '';
    try { text = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); } catch { /* not there: empty */ }
    return [path.basename(p), sha(text)];
  });
}
export function inputsOf(parts) { return sha(JSON.stringify([...parts].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)))); }
export function notesInputs(paths) { return inputsOf(notesParts(paths)); }
// The pass is for one commit too (re-check 3, 2026-11-23: the commits check reads the commit message, and an amended
// message kept the pass of the files alone). `head`: the commit the run began on; HEAD now by default.
// And for one base (re-check 4, 2026-11-23: checks run against another base were taken for the task's): `base` is the
// ref the checks compared with, kept as the commit it named then.
const baseRev = (repo, base) => (base ? git(repo, ['rev-parse', '--verify', '--quiet', String(base) + '^{commit}']) : '');
export function rememberBeforeProof(repo, tree, ok, inputs = '', head = git(repo, ['rev-parse', 'HEAD']), base = '') {
  if (!tree) return;
  const file = beforeProofFile(repo);
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ tree, head: String(head || ''), base: baseRev(repo, base), inputs, ok: ok === true, at: new Date().toISOString() })); } catch { /* not kept: the step stays due */ }
}
/** True when the last whole before-proof run passed on `tree` (the work tree now, by default), HEAD and `base`, with these list files. */
export function beforeProofPassed(repo, tree = workTree(repo), inputs = '', base = '') {
  try {
    const r = JSON.parse(fs.readFileSync(beforeProofFile(repo), 'utf8'));
    const head = git(repo, ['rev-parse', 'HEAD']);
    return Boolean(tree) && Boolean(head) && r.ok === true && r.tree === tree && r.head === head && String(r.base || '') === baseRev(repo, base) && String(r.inputs || '') === String(inputs || '');
  } catch { return false; }
}
// 2026-11-28 (owner, batch b task 1): a whole `pre-review` run (no --before-proof, no --part, with --notes) that passed,
// by the tree, HEAD, base and list files it ran on. "ready" counts the ticket lines and places as checked only on this
// record, and only when the session shows the run that wrote it (trusted.mjs seenRecord: the run prints its line).
function fullRunFile(repo) { const f = beforeProofFile(repo); return path.join(path.dirname(path.dirname(f)), 'pre-review-full', path.basename(f)); }
/** Saves a passed whole run and returns the record (null when nothing was saved). */
export function rememberFullRun(repo, { tree, head, base, inputs }) {
  if (!tree || !head) return null;
  const record = { kind: 'pre-review', tree, head: String(head), base: baseRev(repo, base), inputs: String(inputs || ''), ok: true };
  const file = fullRunFile(repo);
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ ...record, at: new Date().toISOString() })); return record; } catch { return null; }
}
/** The saved whole run as written (its `at` left out, as recordId hashes it), or null. */
export function readFullRun(repo) {
  try {
    const r = JSON.parse(fs.readFileSync(fullRunFile(repo), 'utf8'));
    if (!r || typeof r !== 'object') return null;
    return { kind: r.kind, tree: r.tree, head: r.head, base: r.base, inputs: r.inputs, ok: r.ok };
  } catch { return null; }
}
/** Whether the saved whole run is for this tree, HEAD, base and these list files. */
export function fullRunFits(repo, record, { tree, inputs, base }) {
  const head = git(repo, ['rev-parse', 'HEAD']);
  return Boolean(record && tree && head) && record.ok === true && record.tree === tree && record.head === head && String(record.base || '') === baseRev(repo, base) && String(record.inputs || '') === String(inputs || '');
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
  // An answer that is data (the size check's JSON) is kept whole or not at all: a cut one could not be read.
  const isData = (r) => /^\s*\{/.test(String(r.out || ''));
  const kept = results.filter(r => r && r.key && r.code === 0 && !r.cached && !(isData(r) && String(r.out).length > 2000000));
  if (!kept.length) return;
  // Two runs remember at the same time: a short lock folder keeps one from erasing the other's entry.
  const lock = cacheFile() + '.lock';
  let locked = false;
  try { fs.mkdirSync(path.dirname(cacheFile()), { recursive: true }); } catch { /* the write below says nothing either */ }
  for (let i = 0; i < 200 && !locked; i++) {
    try { fs.mkdirSync(lock); locked = true; }
    catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10000) fs.rmSync(lock, { recursive: true, force: true }); } catch { /* gone */ }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { writeKept(kept); } finally { if (locked) { try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* gone */ } } }
}
function writeKept(kept) {
  const isData = (r) => /^\s*\{/.test(String(r.out || ''));
  const all = readAll();
  for (const r of kept) all.entries[r.key] = { at: new Date().toISOString(), name: r.name, out: isData(r) ? String(r.out) : String(r.out || '').slice(-20000), ms: r.ms };
  const keys = Object.keys(all.entries).sort((a, b) => Date.parse(all.entries[a].at) - Date.parse(all.entries[b].at));
  for (const k of keys.slice(0, Math.max(0, keys.length - KEEP))) delete all.entries[k];
  try {
    fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
    const tmp = cacheFile() + '.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(all));
    fs.renameSync(tmp, cacheFile());
  } catch { /* no cache this time: the next run checks again */ }
}

// --- a check that runs right now ---
// One marker file per key while its check runs: { pid, at }. It counts while that process lives and the marker
// is younger than the limit (a remote check is stopped after 10 minutes).
const RUNNING_LIMIT_MS = 15 * 60 * 1000;
const runningFile = (key) => path.join(path.dirname(cacheFile()), 'pre-review-running', key + '.json');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// Who runs this key now: its marker, or null (none, a dead process, or too old; a dead marker is removed).
export function runningNow(key) {
  if (!key) return null;
  const file = runningFile(key);
  let mark;
  try { mark = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch {
    // Being written right now, or broken: it counts only while it is fresh.
    try { if (Date.now() - fs.statSync(file).mtimeMs < 5000) return { pid: 0, at: '' }; fs.rmSync(file, { force: true }); } catch { /* gone */ }
    return null;
  }
  if (mark && Number.isInteger(mark.pid) && alive(mark.pid) && Date.now() - Date.parse(mark.at) < RUNNING_LIMIT_MS) return mark;
  try { fs.rmSync(file, { force: true }); } catch { /* gone */ }
  return null;
}
// Takes the key for this process. false: another process holds it, and the caller waits for it.
export function claim(key) {
  if (!key) return true;
  const file = runningFile(key);
  for (let i = 0; i < 2; i++) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return true; // no marker can be written: run the check, as before
      if (runningNow(key)) return false;
    }
  }
  return false;
}
export function release(key) {
  if (!key) return;
  try {
    const file = runningFile(key);
    if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.rmSync(file, { force: true });
  } catch { /* gone, or not ours */ }
}
