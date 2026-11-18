import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// 2026-11-18, audit finding 7 (Medium): the review store read one JSON file, changed it and replaced it with no
// coordination, so eight processes writing at once left only two records readable.
// THE PROMISE: every review record acknowledged as written is still readable afterwards, whatever other sessions
// write at the same moment. The read-change-save step runs under one lock across processes.
const hooks = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lib = process.env.REVIEW_STORE_LIB || path.join(hooks, 'lib', 'review-store.cjs');
const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'review-lock-')));
const stateDir = path.join(scratch, 'state');
fs.mkdirSync(stateDir, {recursive: true});
process.env.SANAD_STATE_DIR = stateDir;
test.after(() => { delete process.env.SANAD_STATE_DIR; fs.rmSync(scratch, {recursive: true, force: true}); });

const store = (await import('node:module')).createRequire(import.meta.url)(lib);
const recordsFile = path.join(stateDir, store.FILE);
const lockFile = recordsFile + '.lock';
const h = i => String(i).padStart(2, '0').repeat(20);
const snapOf = i => ({repo: 'url:example.com/r' + i, head: h(i), tree: h(i + 50), base: h(99), commits: [h(i)]});

// A child process: writes one record, prints what write() answered.
const child = i => new Promise(resolve => {
  const code = `const s=require(${JSON.stringify(lib)});process.stdout.write(String(s.write('x.jsonl',${JSON.stringify(snapOf(i))},'s${i}')));`;
  const p = spawn(process.execPath, ['-e', code], {env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']});
  let out = ''; p.stdout.on('data', d => { out += d; });
  p.on('close', () => resolve(out));
});

test('eight processes write eight records at once: every acknowledged one is readable', async () => {
  fs.rmSync(recordsFile, {force: true});
  const answers = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(child));
  const readable = new Set(store.load().map(r => r.head));
  const acknowledged = answers.map((a, i) => a === 'true' ? h(i + 1) : null).filter(Boolean);
  for (const head of acknowledged) assert.ok(readable.has(head), 'acknowledged but lost: ' + head);
  assert.equal(acknowledged.length, 8, 'all eight get the lock within the wait: ' + answers.join());
  assert.equal(readable.size, 8);
  assert.equal(fs.existsSync(lockFile), false, 'the lock is released');
});

test('a lock held by a live process makes write report false after the wait, never success', () => {
  fs.rmSync(recordsFile, {force: true});
  fs.writeFileSync(lockFile, process.pid + ' ' + Date.now());
  const t = Date.now();
  assert.equal(store.write('x.jsonl', snapOf(1), 's'), false);
  assert.ok(Date.now() - t >= 2000, 'it waited for the lock');
  assert.equal(store.load().length, 0);
  fs.rmSync(lockFile, {force: true});
});

test('a stale lock (old) is taken over', () => {
  fs.rmSync(recordsFile, {force: true});
  fs.writeFileSync(lockFile, process.pid + ' 0');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lockFile, old, old);
  assert.equal(store.write('x.jsonl', snapOf(2), 's'), true);
  assert.equal(store.load().length, 1);
  assert.equal(fs.existsSync(lockFile), false);
});

test('a lock whose owner is gone is taken over at once', () => {
  fs.rmSync(recordsFile, {force: true});
  fs.writeFileSync(lockFile, '2147483646 ' + Date.now());
  assert.equal(store.write('x.jsonl', snapOf(3), 's'), true);
  assert.equal(store.load().length, 1);
});

test('must not change: sequential writes, repeats and withdrawal-free reads still work', () => {
  fs.rmSync(recordsFile, {force: true});
  assert.equal(store.write('x.jsonl', snapOf(4), 's'), true);
  assert.equal(store.write('x.jsonl', snapOf(4), 's'), true);
  assert.equal(store.write('x.jsonl', snapOf(5), 's'), true);
  assert.equal(store.load().length, 2);
  assert.equal(store.write('x.jsonl', null, 's'), false);
});
