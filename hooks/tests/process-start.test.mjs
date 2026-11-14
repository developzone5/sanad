// hooks/lib/process-start.cjs: is the process that now holds a lock's id the one that wrote the lock?
// 2026-11-14: moved out of check-lock-guard.js, so remote-busy.mjs and pre-review.mjs use the same check
// (they trusted the id alone, and a reused id kept a stale lock alive there).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const hooks = process.env.WORKFLOW_HOOKS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { GONE, LATER_MS, systemStart, sameProcess } = createRequire(import.meta.url)(path.join(hooks, 'lib', 'process-start.cjs'));
// When this process started, as evidence.mjs records its own start in a lock.
const ownStart = () => Date.now() - process.uptime() * 1000;
const iso = (ms) => new Date(ms).toISOString();
// A process id no system hands out (above Linux's pid_max limit, macOS's 99999 and any Windows id in use).
const NO_PROCESS = 2147483644;

test('this process: the system start is a time no later than the start a lock notes', () => {
  const start = systemStart(process.pid);
  assert.equal(typeof start, 'number', String(start));
  assert.ok(start <= ownStart() + LATER_MS, `system ${iso(start)} vs noted ${iso(ownStart())}`);
  assert.equal(sameProcess({ pid: process.pid, pidStartedAt: iso(ownStart()) }), true);
});

test('same id, later start: another process holds the id', () => {
  assert.equal(sameProcess({ pid: process.pid, pidStartedAt: iso(ownStart() - 3600000) }), false);
});

test('an id no process holds is gone', () => {
  assert.equal(systemStart(NO_PROCESS), GONE);
  assert.equal(sameProcess({ pid: NO_PROCESS, pidStartedAt: iso(Date.now()) }), false);
});

test('a lock in the old format (no start time) is never asked about: the id check alone decides', () => {
  // Asked, the system would answer "gone" for this id; unasked, the answer stays "same process".
  assert.equal(sameProcess({ pid: NO_PROCESS }), true);
  assert.equal(sameProcess({ pid: NO_PROCESS, pidStartedAt: 'not a time' }), true);
});

// The id goes into a PowerShell command on Windows: an id that is not a whole number would run as code there.
test('an id that is not a whole number never reaches the system: its start is unknown', () => {
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'process-start-')), 'ran.txt');
  try {
    // Valid PowerShell once placed in the command: the module's own `-ErrorAction …` ends the last call.
    const bad = `1; New-Item -ItemType File -Path '${marker}' | Out-Null; Get-Process -Id 1`;
    assert.equal(systemStart(bad), null);
    assert.equal(sameProcess({ pid: bad, pidStartedAt: iso(Date.now()) }), true, 'unknown start: the id check alone, as before');
    assert.equal(fs.existsSync(marker), false, 'the text in the id was run as a command');
  } finally { fs.rmSync(path.dirname(marker), { recursive: true, force: true }); }
});

// The guard is installed with its helper; if the helper is ever missing, the lock keeps the id check alone
// (the rule for a start the system does not tell), and the hook still answers instead of crashing.
test('check-lock-guard without the helper: the id check alone, as for an unknown start', () => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'process-start-guard-')));
  try {
    const repo = path.join(root, 'repo'), copy = path.join(root, 'hooks'), locks = path.join(root, 'locks');
    for (const d of [repo, copy, locks]) fs.mkdirSync(d);
    fs.copyFileSync(path.join(hooks, 'check-lock-guard.js'), path.join(copy, 'check-lock-guard.js'));
    execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true, stdio: 'ignore' });
    fs.writeFileSync(path.join(locks, 'reused.json'), JSON.stringify({ toplevel: repo, pid: process.pid, pidStartedAt: iso(ownStart() - 3600000),
      runId: 'reused', startedAt: iso(Date.now()), expiresAt: iso(Date.now() + 600000), command: 'node vitest.mjs run' }));
    const run = spawnSync(process.execPath, [path.join(copy, 'check-lock-guard.js')], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'a.js') }, cwd: repo }),
      encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...process.env, SANAD_CHECK_LOCK_DIR: locks },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /"permissionDecision":"deny"/, run.stdout + run.stderr);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
