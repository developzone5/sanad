#!/usr/bin/env node
// remote-busy.mjs — is another task using the test machine's clone right now?
//
// Usage: node remote-busy.mjs <this folder's toplevel> <host> <remote repo>
//   Prints one line that names who holds the clone, or nothing when it is free. Always exits 0.
//
// 2026-11-12: every worktree of a repository shares the ONE clone on the test machine
// (git config sanad.remoteRepo is per repository). A sync changes the code in that clone, so a sync
// while another task's check runs there, or while another task's browser-check app is served from it,
// gave that task results for mixed code. remote-sync.sh asks this script first and refuses.
//   - a check: a live lock of evidence.mjs (state/check-locks) of ANOTHER folder whose command runs in the clone;
//   - the app: remote-web.sh's owner file names ANOTHER folder and its link is still up.
// This folder's own check or app never counts: the check's own guard refuses edits, and a new
// `remote-web.sh start` replaces its own app on purpose.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [top, host, remoteRepo] = process.argv.slice(2);
if (!top || !host || !remoteRepo) process.exit(0);
const flat = (text) => String(text || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
// Two names of one folder are the same folder: the 8.3 short name of a temp folder (C:\Users\RUNNER~1\…,
// seen on the CI machine the day this shipped), a link, another letter case. The real path decides; a
// folder that is gone keeps its written name.
const real = (p) => { try { return fs.realpathSync.native(String(p)); } catch { return path.resolve(String(p)); } };
const same = (a, b) => flat(real(a)) === flat(real(b));
const alive = (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const state = process.env.SANAD_STATE_DIR || path.join(os.homedir(), '.claude', 'state');
const lockDir = process.env.SANAD_CHECK_LOCK_DIR || path.join(state, 'check-locks');

let names = [];
try { names = fs.readdirSync(lockDir).filter((n) => n.endsWith('.json')); } catch { /* no check has run yet */ }
for (const name of names) {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(lockDir, name), 'utf8'));
    if (!(Date.parse(lock.expiresAt) > Date.now()) || !lock.toplevel || same(lock.toplevel, top) || !alive(lock.pid)) continue;
    if (!flat(lock.command).includes(flat(remoteRepo))) continue;
    console.log(`a check of ${flat(lock.toplevel) === flat(path.resolve(lock.toplevel)) ? lock.toplevel : String(lock.toplevel).replace(/\\/g, '/')} is running in ${host}:${remoteRepo} (since ${lock.startedAt}), and a sync would change the code under it. Wait for it to end, then run this again.`);
    process.exit(0);
  } catch { /* a lock being written: not a running check yet */ }
}

try {
  const owner = fs.readFileSync(path.join(state, `remote-web-${host}.owner`), 'utf8').trim();
  const [pid, winpid] = fs.readFileSync(path.join(state, `remote-web-${host}.link`), 'utf8').trim().split(/\s+/);
  const link = /^\d+$/.test(winpid || '') ? Number(winpid) : Number(pid);
  if (owner && !same(owner, top) && alive(link)) {
    console.log(`the browser-check app of ${owner.replace(/\\/g, '/')} is served from ${host}:${remoteRepo}, and a sync would change the code under it. Stop it first: (cd "${owner.replace(/\\/g, '/')}" && bash ~/.claude/scripts/remote/remote-web.sh stop)`);
  }
} catch { /* no app was started from this machine */ }
