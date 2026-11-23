// test-machine-lock.mjs: a proof and a test run never use the test machine at the same time (2026-11-22, owner).
// A re-run of a small task ran the proof (8 copies) and the full suite on the test machine together: three suite
// tests timed out and two breaks were not seen. The proof takes the 'proof' side before its sync; the evidence helper
// takes the 'check' side before it reads the clone there.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const lockUrl = pathToFileURL(path.join(scripts, 'test-machine-lock.mjs')).href;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'machine-lock-'));
process.env.SANAD_STATE_DIR = path.join(root, 'state');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const { holdTestMachine, lockDir } = await import(lockUrl);

// Another process that holds `side` on `host` for `ms`, then ends. Resolves once it holds the machine.
function holder(host, side, ms) {
  const code = `const { holdTestMachine } = await import(${JSON.stringify(lockUrl)});
    await holdTestMachine(${JSON.stringify(host)}, ${JSON.stringify(side)}, 'other-${side}', { say: () => {} });
    process.stdout.write('HELD\\n'); setTimeout(() => process.exit(0), ${ms});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env }, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  const held = new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('HELD')) resolve(); });
    child.on('exit', (c) => reject(new Error('holder ended before it held the machine: exit ' + c)));
  });
  const ended = new Promise((resolve) => child.on('exit', () => resolve(Date.now())));
  return { held, ended };
}

test('a test run waits while a proof holds the machine, and goes on when the proof ends', async () => {
  const proof = holder('pc2', 'proof', 1500);
  await proof.held;
  const said = [];
  const start = Date.now();
  const release = await holdTestMachine('pc2', 'check', 'evidence', { stepMs: 100, say: (l) => said.push(l) });
  const endedAt = await proof.ended;
  assert.ok(Date.now() >= endedAt - 50, 'the check went on before the proof ended');
  assert.ok(Date.now() - start >= 1000, 'the check did not wait');
  assert.equal(said.length, 1);
  assert.match(said[0], /^TEST MACHINE: waiting for the other-proof run \(pid \d+\) on pc2 to end/);
  release();
  assert.deepEqual(fs.readdirSync(lockDir('pc2')), []);
});

test('a proof waits while a test run holds the machine', async () => {
  const check = holder('pc2b', 'check', 1200);
  await check.held;
  const start = Date.now();
  const release = await holdTestMachine('pc2b', 'proof', 'red-proof', { stepMs: 100, say: () => {} });
  assert.ok(Date.now() - start >= 800, 'the proof did not wait');
  release();
});

test('two proofs share the machine (the server\'s and the page\'s), and another host is never waited for', async () => {
  const proof = holder('pc2c', 'proof', 3000);
  await proof.held;
  let start = Date.now();
  const second = await holdTestMachine('pc2c', 'proof', 'red-proof', { stepMs: 100, say: () => {} });
  assert.ok(Date.now() - start < 1000, 'a second proof waited');
  second();
  start = Date.now();
  const other = await holdTestMachine('other-host', 'check', 'evidence', { stepMs: 100, say: () => {} });
  assert.ok(Date.now() - start < 1000, 'a check on another host waited');
  other();
  await proof.ended;
});

test('the file of a process that has ended is taken over at once, and an old broken file too', async () => {
  const dir = lockDir('pc2d');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'proof-999999.json'), JSON.stringify({ pid: 999999, side: 'proof', tool: 'red-proof', at: 1 }));
  fs.writeFileSync(path.join(dir, 'proof-1.json'), '{ not json');
  const old = new Date(Date.now() - 5 * 60 * 1000);
  fs.utimesSync(path.join(dir, 'proof-1.json'), old, old);
  const start = Date.now();
  const release = await holdTestMachine('pc2d', 'check', 'evidence', { stepMs: 100, say: () => {} });
  assert.ok(Date.now() - start < 1000);
  assert.deepEqual(fs.readdirSync(dir), [`check-${process.pid}.json`]);
  release();
});

test('a wait past its limit stops the run (null) and says so: it never runs beside the other side', async () => {
  const proof = holder('pc2e', 'proof', 4000);
  await proof.held;
  const said = [];
  const got = await holdTestMachine('pc2e', 'check', 'evidence', { waitMs: 300, stepMs: 100, say: (l) => said.push(l) });
  assert.equal(got, null);
  assert.match(said[said.length - 1], /^TEST MACHINE: still busy with other-proof .* this run stops and does not run beside it/);
  assert.deepEqual(fs.readdirSync(lockDir('pc2e')).filter((n) => n.startsWith('check-')), [], 'the stopped run left no file');
  await proof.ended;
});

test('a lock file being written (not readable yet) is waited for, never removed; an old broken one is removed', async () => {
  const dir = lockDir('pc2f');
  fs.mkdirSync(dir, { recursive: true });
  const half = path.join(dir, 'proof-424242.json');
  fs.writeFileSync(half, '{"pid": 42');
  const said = [];
  const got = await holdTestMachine('pc2f', 'check', 'evidence', { waitMs: 400, stepMs: 100, say: (l) => said.push(l) });
  assert.equal(got, null, 'the check did not go on beside a run whose lock is being written');
  assert.ok(fs.existsSync(half), 'a fresh unreadable file is not removed');
  const old = new Date(Date.now() - 5 * 60 * 1000);
  fs.utimesSync(half, old, old);
  const release = await holdTestMachine('pc2f', 'check', 'evidence', { stepMs: 100, say: () => {} });
  assert.equal(fs.existsSync(half), false, 'an old unreadable file is removed');
  release();
});

test('the proof holds the machine before its sync, and the evidence helper before it reads the clone there', () => {
  // The source as text, with one line ending: a Windows checkout has CRLF (CI, 2026-11-22).
  const source = (name) => fs.readFileSync(path.join(scripts, name), 'utf8').replace(/\r\n/g, '\n');
  const proof = source('red-proof.mjs');
  const hold = proof.indexOf("await holdTestMachine(remoteHost, 'proof'");
  assert.ok(hold > 0, 'red-proof.mjs does not hold the machine');
  assert.ok(hold < proof.indexOf("'remote-sync.sh'"), 'the proof syncs before it holds the machine');
  assert.ok(hold < proof.indexOf("dbPreflight = new Promise"), 'the proof starts its database check before it holds the machine');
  const evidence = source('evidence.mjs');
  const take = evidence.indexOf("await holdTestMachine(remote.host, 'check'");
  assert.ok(take > 0, 'evidence.mjs does not hold the machine');
  assert.ok(take < evidence.indexOf('const there = await askRemote();'), 'the check reads the clone before it holds the machine');
  assert.ok(evidence.indexOf('freeMachine();\n    failure ||= sourceFailure;') > evidence.lastIndexOf('const there = await askRemote();'), 'the machine is freed before the last look at the clone');
});
