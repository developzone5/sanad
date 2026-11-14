// pre-review.mjs otherTaskOnRemote: another task's check lock counts only while the process that wrote it
// still holds its id. 2026-11-14: the id alone was asked here, so an id handed to a later process kept a
// stale lock "alive", and the sync (and with it lint and types on the test machine) was skipped. The
// start-time check of check-lock-guard.js (hooks/lib/process-start.cjs) now decides here too.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, '..', 'scripts', 'pre-review.mjs');
const remote = { host: 'pc2', repo: 'C:/r/App', node: 'node' };
// When this process started, as evidence.mjs records its own start in a lock.
const ownStart = () => Date.now() - process.uptime() * 1000;
const iso = (ms) => new Date(ms).toISOString();
// A process id no system hands out (above Linux's pid_max limit, macOS's 99999 and any Windows id in use).
const NO_PROCESS = 2147483644;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-review-lock-start-'));
const mine = path.join(root, 'mine'), other = path.join(root, 'other');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

// One lock of another task whose check runs on pc2, in a fresh lock folder; `pidStartedAt` left out writes
// the old lock format (no start time). Returns what otherTaskOnRemote of `file` says for this task.
async function ask(over = {}, file = script) {
  const { otherTaskOnRemote } = await import(pathToFileURL(file).href);
  const dir = fs.mkdtempSync(path.join(root, 'locks-'));
  fs.writeFileSync(path.join(dir, 'run-1.json'), JSON.stringify({ toplevel: other, pid: process.pid, startedAt: iso(Date.now()),
    expiresAt: iso(Date.now() + 600000), command: 'C:/Windows/System32/OpenSSH/ssh.exe -o BatchMode=yes pc2 cd /d C:\\r\\App && dotnet test', ...over }));
  const before = process.env.SANAD_CHECK_LOCK_DIR;
  process.env.SANAD_CHECK_LOCK_DIR = dir;
  try { return otherTaskOnRemote(mine, remote); } finally {
    if (before === undefined) delete process.env.SANAD_CHECK_LOCK_DIR; else process.env.SANAD_CHECK_LOCK_DIR = before;
  }
}

test('same id, later start: the lock is stale and no other task runs on the test machine', async () => {
  assert.equal(await ask({ pidStartedAt: iso(ownStart() - 3600000) }), '');
});

test('same id, same start: the other task still runs and is named', async () => {
  assert.equal(await ask({ pidStartedAt: iso(ownStart()) }), other);
});

test('a lock in the old format (no start time) keeps the id check alone', async () => {
  assert.equal(await ask(), other, 'a live id counts, as before');
  assert.equal(await ask({ pid: NO_PROCESS }), '', 'a gone id does not, as before');
});

// Without its helper (an install that missed hooks/lib), the check keeps the id alone and still answers:
// the sync is never let through over a check that may still run.
test('without the helper: the id check alone, never a crash', async () => {
  const copy = path.join(root, 'copy', 'skills', 'gate', 'scripts', 'pre-review.mjs');
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.copyFileSync(script, copy);
  fs.copyFileSync(path.join(path.dirname(script), 'is-main.mjs'), path.join(path.dirname(copy), 'is-main.mjs'));
  assert.equal(await ask({ pidStartedAt: iso(ownStart() - 3600000) }, copy), other);
});
