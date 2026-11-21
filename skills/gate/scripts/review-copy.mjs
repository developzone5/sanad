// review-copy.mjs — one read-only folder that holds a pinned commit, for the reviewers of a Big round.
//
// 2026-11-19: reviewers read the work folder, so the author could not fix an early note while five of them
// were still reading (loop.md: no source edit while they read). On a Big round review-brief.mjs --pin asks
// for this copy and names it on the Repo line and in the Codex -C path: the reviewers read commit A in the
// copy, and the work folder is free.
//
// The copy is a clone that reads the repository's own objects (git clone --shared, then a detached checkout
// of the commit), made the way red-proof.mjs makes a proof copy. It is not a work tree of the repository, so
// `git worktree list` stays clean. Its files are set read-only. It lives under the state folder
// (<state>/review-copy/<task>/<round>), never inside the repository: there it would show as an untracked
// folder that is its own repository.
//
// makeCopy throws with one plain reason when the folder cannot be made (full disk, long path, a locked
// folder). The caller keeps the pinned diff then and prints one NOTE line; nothing else changes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function copyRoot() {
  return path.join(process.env.SANAD_STATE_DIR || path.join(os.homedir(), '.claude', 'state'), 'review-copy');
}

function git(cwd, args) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim(); }
  catch (error) {
    const said = String(error.stderr || '').trim().split(/\r?\n/)[0] || error.code || '';
    throw new Error(`git ${args[0]} failed${said ? ': ' + said : ''}`);
  }
}

// Every file of the copy outside its .git folder.
function walk(dir, each) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;   // a link is never followed: chmod would change its target
    if (entry.isDirectory()) walk(full, each); else each(full);
  }
}
function setMode(dir, mode) {
  try { walk(dir, (f) => { try { fs.chmodSync(f, mode); } catch { /* a link or a file that left */ } }); } catch { /* no such folder */ }
}

// Removes one copy. Its files are read-only, and Windows does not delete a read-only file.
export function dropCopy(dir) {
  let st;
  try { st = fs.lstatSync(dir); } catch { return; }
  if (st.isSymbolicLink()) { fs.unlinkSync(dir); return; }   // only the link goes, never its target
  setMode(dir, 0o666);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

// The folder of one round's copy.
export function copyDir(task, round, root = copyRoot()) {
  return path.join(root, String(task), String(round));
}

// A linked task folder (root/<task>) is unlinked here, so the removal below never goes through it.
function unlinkLinkedParents(dir, root) {
  const rel = path.relative(root, dir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
  let cur = root;
  const parts = rel.split(path.sep);
  for (const part of parts.slice(0, -1)) {
    cur = path.join(cur, part);
    let st;
    try { st = fs.lstatSync(cur); } catch { return; }
    if (st.isSymbolicLink()) { fs.unlinkSync(cur); return; }
  }
}

// Makes (or finds again) the copy of `commit` for this task and round. Returns its folder, `/` between
// folders. A folder that already holds this commit with no changed file is used as it is.
export function makeCopy({ repo, commit, task, round, root = copyRoot() }) {
  if (!/^[0-9a-f]{40,64}$/.test(String(commit))) throw new Error(`the copy needs a full commit id, not ${JSON.stringify(commit)}`);
  const dir = copyDir(task, round, root);
  const shown = dir.replace(/\\/g, '/');
  if (fs.existsSync(path.join(dir, '.git'))) {
    try {
      if (git(dir, ['rev-parse', 'HEAD']) === commit && git(dir, ['status', '--porcelain']) === '') return shown;
    } catch { /* not a usable copy: made again below */ }
  }
  // Every folder above the round is checked with lstat first: a link is unlinked, never followed.
  unlinkLinkedParents(dir, root);
  dropCopy(dir);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const commonDir = path.resolve(repo, git(repo, ['rev-parse', '--git-common-dir']));
  try {
    execFileSync('git', ['clone', '-q', '--shared', '--no-checkout', commonDir, dir], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, encoding: 'utf8' });
    // The same line endings and long paths as the work folder, so a file reads the same in both.
    for (const key of ['core.autocrlf', 'core.eol', 'core.longpaths']) {
      let value = '';
      try { value = git(repo, ['config', '--get', key]); } catch { /* not set */ }
      if (value) git(dir, ['config', key, value]);
    }
    git(dir, ['checkout', '-q', '--force', '--detach', commit]);
    if (git(dir, ['rev-parse', 'HEAD']) !== commit) throw new Error('the copy is not at the pinned commit');
  } catch (error) {
    try { dropCopy(dir); } catch { /* the reason below is the one that counts */ }
    const said = String(error.stderr || '').trim().split(/\r?\n/)[0] || String(error.message || error).split(/\r?\n/)[0];
    throw new Error(said || 'the copy could not be made');
  }
  setMode(dir, 0o444);
  return shown;
}

// Removes every copy of a task (review-brief.mjs --drop-pins). Returns how many were removed.
export function dropCopies(task, root = copyRoot()) {
  const dir = path.join(root, String(task));
  let tst;
  try { tst = fs.lstatSync(dir); } catch { return 0; }
  if (tst.isSymbolicLink()) { fs.unlinkSync(dir); return 0; }   // a linked task folder goes as a link, never followed
  let rounds = [];
  try { rounds = fs.readdirSync(dir); } catch { return 0; }
  for (const name of rounds) dropCopy(path.join(dir, name));
  try { fs.rmdirSync(dir); } catch { /* something else is in it */ }
  return rounds.length;
}
