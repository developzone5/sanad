// remote-busy.mjs: a check lock counts only while the process that wrote it still holds its id.
// 2026-11-14: the id alone was asked here, so an id handed to a later process kept a stale lock "alive"
// and a sync was refused with a false REMOTE-BUSY. The start-time check of check-lock-guard.js
// (hooks/lib/process-start.cjs) now decides here too.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'remote', 'remote-busy.mjs');
const REMOTE = 'C:/repos/App';
// When this process started, as evidence.mjs records its own start in a lock.
const ownStart = () => Date.now() - process.uptime() * 1000;
const iso = (ms) => new Date(ms).toISOString();
// A process id no system hands out (above Linux's pid_max limit, macOS's 99999 and any Windows id in use).
const NO_PROCESS = 2147483644;

function setup(scriptPath = script) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-busy-start-'));
  const state = path.join(root, 'state'), mine = path.join(root, 'mine'), other = path.join(root, 'other');
  for (const d of [state, mine, other]) fs.mkdirSync(d);
  const ask = () => spawnSync(process.execPath, [scriptPath, mine, 'pc2', REMOTE], { encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...process.env, SANAD_STATE_DIR: state, SANAD_CHECK_LOCK_DIR: '' } }).stdout.trim();
  // `pidStartedAt` left out writes the old lock format (no start time).
  const lock = (over = {}) => {
    const dir = path.join(state, 'check-locks');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'run-1.json'), JSON.stringify({ toplevel: other, pid: process.pid, startedAt: iso(Date.now()),
      expiresAt: iso(Date.now() + 600000), command: 'ssh.exe -o BatchMode=yes pc2 cd /d C:\\repos\\App\\Server && dotnet test', ...over }));
  };
  return { root, ask, lock };
}
const BUSY = /^a check of .*other is running in pc2:C:\/repos\/App/;

test('same id, later start: the lock is stale and the clone is free', () => {
  const { root, ask, lock } = setup();
  try {
    lock({ pidStartedAt: iso(ownStart() - 3600000) });
    assert.equal(ask(), '');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('same id, same start: the check is still running and is named', () => {
  const { root, ask, lock } = setup();
  try {
    lock({ pidStartedAt: iso(ownStart()) });
    assert.match(ask(), BUSY);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a lock in the old format (no start time) keeps the id check alone', () => {
  const { root, ask, lock } = setup();
  try {
    lock();
    assert.match(ask(), BUSY, 'a live id holds the clone, as before');
    lock({ pid: NO_PROCESS });
    assert.equal(ask(), '', 'a gone id holds nothing, as before');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Without its helper (an install that missed hooks/lib), the script keeps the id check alone and still
// answers: a sync is never let through over a check that may still run.
test('without the helper: the id check alone, never a crash', () => {
  const copyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-busy-copy-'));
  const copy = path.join(copyRoot, 'scripts', 'remote', 'remote-busy.mjs');
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.copyFileSync(script, copy);
  const { root, ask, lock } = setup(copy);
  try {
    lock({ pidStartedAt: iso(ownStart() - 3600000) });
    assert.match(ask(), BUSY);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(copyRoot, { recursive: true, force: true });
  }
});
