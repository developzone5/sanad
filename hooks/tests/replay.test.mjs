// Tests for scripts/replay/replay.mjs: two fake readers (a base and a candidate) over a small corpus.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const replay = path.resolve(here, '../../scripts/replay/replay.mjs');

// A reader as a tree: claude/hooks/lib/transcript-scan.js. `edits` says what it thinks of a command.
function reader(root, name, { editWord = '', notes = [], throwOn = '' } = {}) {
  const dir = path.join(root, name, 'claude/hooks/lib');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'transcript-scan.js'), [
    "const fs = require('node:fs');",
    'exports.splitSegments = (c) => [c];',
    'exports.segmentIsVerify = () => false;',
    `exports.shellEditPaths = (c) => (${JSON.stringify(editWord)} && c.includes(${JSON.stringify(editWord)}) ? ['x.cs'] : []);`,
    `exports.reportNotes = () => ${JSON.stringify(notes)};`,
    'exports.scanTranscript = (f) => {',
    `  if (${JSON.stringify(throwOn)} && fs.readFileSync(f, 'utf8').includes(${JSON.stringify(throwOn)})) throw new Error('reader crash');`,
    "  const since = fs.readFileSync(require('node:path').join(process.env.SANAD_STATE_DIR, 'review-notes-since'), 'utf8');",
    `  return { lastEdit: 1, lastVerify: 2, openReviewNotes: ${JSON.stringify(notes.map((n, i) => ({ n: i + 1 })))}, since };`,
    '};',
    ''
  ].join('\n'));
  return path.join(root, name);
}

function world(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanad-replay-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function corpus(root, commands = [], reports = []) {
  for (const [kind, list] of [['commands', commands], ['reports', reports]]) {
    fs.mkdirSync(path.join(root, 'corpus', kind), { recursive: true });
    list.forEach((s, i) => fs.writeFileSync(path.join(root, 'corpus', kind, i + '.txt'), s));
  }
  return path.join(root, 'corpus');
}
function run(root, base, cand, ...extra) {
  const env = { ...process.env, SANAD_STATE_DIR: path.join(root, 'live-state') };
  delete env.SANAD_REPLAY;
  const r = spawnSync(process.execPath, [replay, 'run', '--base', base, '--cand', cand, '--logs', path.join(root, 'nologs'), ...extra], { encoding: 'utf8', env });
  return { status: r.status, out: r.stdout + r.stderr };
}
const session = (root, name, text) => {
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'logs', name), text);
  return path.join(root, 'logs');
};

test('a candidate that calls one honest command an edit prints that command once', t => {
  const root = world(t);
  const base = reader(root, 'base'), cand = reader(root, 'cand', { editWord: 'honest' });
  const c = corpus(root, ['echo honest', 'ls']);
  const r = run(root, base, cand, '--corpus', c);
  assert.equal(r.status, 4);
  assert.equal(r.out.split('REPLAY DIFF command').length, 2);
  assert.match(r.out, /REPLAY DIFF command "echo honest"/);
  assert.match(r.out, /1 differences \(1 not approved\)/);
});

test('the same reader twice prints no difference and the live state folder is untouched', t => {
  const root = world(t);
  const base = reader(root, 'base'), cand = reader(root, 'cand');
  const r = run(root, base, cand, '--corpus', corpus(root, ['echo honest'], ['a report long enough to be kept as one']));
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.out, /REPLAY DIFF/);
  assert.match(r.out, /0 differences/);
  assert.ok(!fs.existsSync(path.join(root, 'live-state')), 'the live state folder was not made');
});

test('a changed open-note list of a saved session is printed with the session name', t => {
  const root = world(t);
  const base = reader(root, 'base'), cand = reader(root, 'cand', { notes: [{ n: 1 }] });
  const logs = session(root, 'fixture-session.jsonl', '{}\n');
  const r = spawnSync(process.execPath, [replay, 'run', '--base', base, '--cand', cand, '--logs', logs], { encoding: 'utf8', env: { ...process.env, SANAD_STATE_DIR: path.join(root, 'live-state') } });
  assert.equal(r.status, 4);
  assert.match(r.stdout, /REPLAY DIFF session .*fixture-session\.jsonl/);
  assert.match(r.stdout, /"openNotes":\[1\]/);
});

test('both readers get an old notes start time, so notes are not hidden', t => {
  const root = world(t);
  const base = reader(root, 'base'), cand = reader(root, 'cand', { notes: [{ n: 1 }] });
  const logs = session(root, 's.jsonl', '{}\n');
  const state = path.join(root, 'kept-state');
  const r = spawnSync(process.execPath, [replay, 'run', '--base', base, '--cand', cand, '--logs', logs, '--state', state], { encoding: 'utf8' });
  assert.equal(r.status, 4);
  const runs = fs.readdirSync(state);
  assert.equal(runs.length, 1, 'one private folder for this run');
  assert.equal(fs.readFileSync(path.join(state, runs[0], 'cand', 'review-notes-since'), 'utf8').trim(), '2000-01-01T00:00:00.000Z');
});

test('a base or cand folder the caller already keeps in --state is not deleted', t => {
  const root = world(t);
  const base = reader(root, 'base'), cand = reader(root, 'cand');
  const logs = session(root, 's.jsonl', '{}\n');
  const state = path.join(root, 'kept-state');
  fs.mkdirSync(path.join(state, 'base'), { recursive: true });
  fs.writeFileSync(path.join(state, 'base', 'mine.txt'), 'keep');
  spawnSync(process.execPath, [replay, 'run', '--base', base, '--cand', cand, '--logs', logs, '--state', state], { encoding: 'utf8' });
  assert.equal(fs.readFileSync(path.join(state, 'base', 'mine.txt'), 'utf8'), 'keep');
});

test('relative release paths work, and a crash exits 5 with one line', t => {
  const root = world(t);
  const base = reader(root, 'base'), cand = reader(root, 'cand');
  const rel = p => path.relative(process.cwd(), p);
  const logs = session(root, 's.jsonl', '{}\n');
  const ok = spawnSync(process.execPath, [replay, 'run', '--base', rel(base), '--cand', rel(cand), '--logs', logs], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  fs.writeFileSync(path.join(cand, 'claude/hooks/lib/transcript-scan.js'), 'this is not javascript (\n');
  const bad = spawnSync(process.execPath, [replay, 'run', '--base', base, '--cand', cand, '--logs', logs], { encoding: 'utf8' });
  assert.equal(bad.status, 5, bad.stdout + bad.stderr);
  assert.match(bad.stdout, /^REPLAY: crashed: /m);
});

test('a candidate that throws on one session is printed as a difference', t => {
  const root = world(t);
  const base = reader(root, 'base'), cand = reader(root, 'cand', { throwOn: 'BOOM' });
  const logs = session(root, 'bad.jsonl', 'BOOM\n');
  session(root, 'good.jsonl', '{}\n');
  const r = spawnSync(process.execPath, [replay, 'run', '--base', base, '--cand', cand, '--logs', logs], { encoding: 'utf8' });
  assert.equal(r.status, 4);
  assert.match(r.stdout, /REPLAY DIFF session .*bad\.jsonl/);
  assert.match(r.stdout, /cand: CRASH: reader crash/);
  assert.doesNotMatch(r.stdout, /REPLAY DIFF session .*good\.jsonl/);
});

test('no corpus and no logs: one skipped line', t => {
  const root = world(t);
  const base = reader(root, 'base'), cand = reader(root, 'cand');
  const r = run(root, base, cand, '--corpus', path.join(root, 'none'));
  assert.equal(r.status, 0);
  assert.equal(r.out.trim(), 'REPLAY: skipped (no corpus and no logs)');
});

test('a session over the size cap is named as left out', t => {
  const root = world(t);
  const base = reader(root, 'base'), cand = reader(root, 'cand');
  const logs = session(root, 'big.jsonl', 'x'.repeat(2 * 1048576));
  const r = spawnSync(process.execPath, [replay, 'run', '--base', base, '--cand', cand, '--logs', logs, '--max-session-mb', '1'], { encoding: 'utf8' });
  assert.match(r.stdout, /REPLAY: left out .*big\.jsonl \(2 MB over the cap\)/);
});

test('an approved line turns a difference into an approved one; a cut last log line is fine', t => {
  const root = world(t);
  const base = reader(root, 'base'), cand = reader(root, 'cand', { editWord: 'honest' });
  const approved = path.join(root, 'approved.txt');
  fs.writeFileSync(approved, '# why\necho honest\n');
  const logs = session(root, 'cut.jsonl', JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo honest' } }] } }) + '\n{"message":{"con');
  const r = spawnSync(process.execPath, [replay, 'run', '--base', base, '--cand', cand, '--logs', logs, '--approved', approved], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\(approved\)/);
  assert.match(r.stdout, /1 differences \(0 not approved\)/);
});

test('collect keeps distinct commands and reports once', t => {
  const root = world(t);
  const line = (command) => JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } });
  const logs = session(root, 'a.jsonl', [line('ls'), line('ls'), line('pwd')].join('\n') + '\n');
  const r = spawnSync(process.execPath, [replay, 'collect', '--logs', logs, '--corpus', path.join(root, 'kept')], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /collected 2 commands and 0 reports/);
  assert.equal(fs.readdirSync(path.join(root, 'kept', 'commands')).length, 2);
});

test('SANAD_REPLAY=none skips the replay', t => {
  const root = world(t);
  const r = spawnSync(process.execPath, [replay, 'run', '--base', 'x', '--cand', 'y'], { encoding: 'utf8', env: { ...process.env, SANAD_REPLAY: 'none' } });
  assert.equal(r.stdout.trim(), 'REPLAY: skipped (SANAD_REPLAY=none)');
  void root;
});
