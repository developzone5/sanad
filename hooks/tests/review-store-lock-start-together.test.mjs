import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// 2026-11-18, audit finding 7, repair round: writers that truly start together. A waiter judged a lock stale
// (owner gone) from one read, then moved away the live lock of a NEW owner. Here every child busy-waits for one
// shared start instant, and the rounds repeat, so the old code loses records almost every run.
// THE PROMISE: every review record acknowledged as written is still readable afterwards.
const hooks = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lib = process.env.REVIEW_STORE_LIB || path.join(hooks, 'lib', 'review-store.cjs');
const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'review-lock-together-')));
test.after(() => { fs.rmSync(scratch, {recursive: true, force: true}); });

const h = i => String(i).padStart(2, '0').repeat(20);
const snapOf = i => ({repo: 'url:example.com/r' + i, head: h(i), tree: h(i + 50), base: h(99), commits: [h(i)]});

const child = (i, dir, startAt) => new Promise(resolve => {
  const code = `const s=require(${JSON.stringify(lib)});while(Date.now()<${startAt});process.stdout.write(String(s.write('x.jsonl',${JSON.stringify(snapOf(i))},'s${i}')));`;
  const p = spawn(process.execPath, ['-e', code], {env: {...process.env, SANAD_STATE_DIR: dir}, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore']});
  let out = ''; p.stdout.on('data', d => { out += d; });
  p.on('close', () => resolve(out));
});

async function round(n, preLock) {
  const dir = path.join(scratch, 'r' + n);
  fs.mkdirSync(dir, {recursive: true});
  const file = path.join(dir, 'review-records.json');
  if (preLock) fs.writeFileSync(file + '.lock', preLock);
  const startAt = Date.now() + 2500; // wide: node start-up on a busy machine must not be later than the shared instant
  const answers = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(i => child(i, dir, startAt)));
  const readable = new Set(JSON.parse(fs.readFileSync(file, 'utf8')).records.map(r => r.head));
  const lost = answers.map((a, i) => a === 'true' && !readable.has(h(i + 1)) ? h(i + 1) : null).filter(Boolean);
  return {answers, lost, left: fs.existsSync(file + '.lock')};
}

test('eight processes starting at the same instant, several rounds: no acknowledged record is lost, none refused early', async () => {
  for (let n = 0; n < 6; n++) {
    const r = await round(n);
    assert.deepEqual(r.lost, [], 'round ' + n + ' lost: ' + r.answers.join());
    assert.equal(r.answers.filter(a => a === 'true').length, 8, 'round ' + n + ' answers: ' + r.answers.join());
    assert.equal(r.left, false, 'the lock is released');
  }
});

test('same start with a lock left by a dead owner: taken over once, nothing lost', async () => {
  for (let n = 10; n < 14; n++) {
    const r = await round(n, '2147483646 ' + Date.now());
    assert.deepEqual(r.lost, [], 'round ' + n + ' lost: ' + r.answers.join());
    assert.equal(r.answers.filter(a => a === 'true').length, 8, 'round ' + n + ' answers: ' + r.answers.join());
  }
});
