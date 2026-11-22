import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// guard-score.mjs reads saved session logs and counts refusals per rule and per day. The line shapes below
// are cut from real host logs: a stop block is a user line "Stop hook feedback:\n<reason>"; a push denial is a
// tool_result with is_error and the text "PreToolUse:Bash hook error: <reason>".
const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, '..', 'scripts', 'guard-score.mjs');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-score-')));
const projects = path.join(root, 'projects', 'p1');
fs.mkdirSync(projects, { recursive: true });
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

let state = path.join(root, 'state0');
const run = (args) => spawnSync(process.execPath, [script, '--dir', path.join(root, 'projects'), ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, SANAD_STATE_DIR: state } });
const stop = (reason, ts) => JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: 'Stop hook feedback:\n' + reason }, timestamp: ts });
const deny = (reason, ts) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', is_error: true, content: 'PreToolUse:Bash hook error: ' + reason }] }, timestamp: ts });
const lines = (r) => r.stdout.split(/\r?\n/).filter(Boolean);
const log = path.join(projects, 'a.jsonl');

test('3 stop blocks of two rules and 2 push denials give 5, by rule and by day', () => {
  fs.writeFileSync(log, [
    stop('Nothing was verified. (SG-UNVERIFIED)', '2026-11-18T10:00:00Z'),
    stop('Nothing was verified. (SG-UNVERIFIED)', '2026-11-18T11:00:00Z'),
    stop('A check failed. (SG-FAILED)', '2026-11-19T10:00:00Z'),
    deny('Blocked by policy-guard: `git add .` is not allowed.', '2026-11-19T12:00:00Z'),
    deny('Blocked by policy-guard: `gh pr merge` — CLAUDE.md: never merge a PR.', '2026-11-19T13:00:00Z'),
    // A block text inside an assistant message is never counted.
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Stop hook feedback: x (SG-FAILED)' }] }, timestamp: '2026-11-19T14:00:00Z' }),
  ].join('\n') + '\n');
  const r = run([]);
  assert.equal(r.status, 0, r.stderr);
  const out = lines(r);
  assert.equal(out[0], 'GUARD SCORE: 5 refusal(s) over 2 day(s)');
  assert.ok(out.includes('  SG-UNVERIFIED: 2'));
  assert.ok(out.includes('  SG-FAILED: 1'));
  assert.ok(out.includes('  PG-GIT-ADD: 1'));
  assert.ok(out.includes('  PG-MERGE: 1'));
  assert.ok(out.includes('  2026-11-18: SG-UNVERIFIED x2'));
});

test('a text not in the table is counted under unknown rule, and a joined block counts each id', () => {
  fs.writeFileSync(log, [stop('Something new and odd.', '2026-11-19T10:00:00Z'), stop('a (SG-NOTES)\nb (SG-FAILED)', '2026-11-19T10:01:00Z')].join('\n') + '\n');
  const out = lines(run([]));
  assert.ok(out.includes('  unknown rule: 1'));
  assert.ok(out.includes('  SG-NOTES: 1') && out.includes('  SG-FAILED: 1'));
});

test('a cut last line and a missing folder give a message, not a crash', () => {
  fs.writeFileSync(log, stop('x (SG-CLAIM)', '2026-11-19T10:00:00Z') + '\n{"type":"user","message":{"cont');
  const r = run([]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(lines(r).includes('  SG-CLAIM: 1'));
  const none = spawnSync(process.execPath, [script, '--dir', path.join(root, 'nope')], { encoding: 'utf8', windowsHide: true, env: { ...process.env, SANAD_STATE_DIR: path.join(root, 'state2') } });
  assert.equal(none.status, 0);
  assert.match(none.stdout, /no session log found/);
});

test('two runs over the same day do not double the count; --mark wrong changes the rate and is kept', () => {
  fs.writeFileSync(log, [stop('x (SG-CLAIM)', '2026-11-19T10:00:00Z'), stop('y (SG-CLAIM)', '2026-11-19T10:05:00Z')].join('\n') + '\n');
  run([]);
  const again = lines(run([]));
  assert.ok(again.includes('  SG-CLAIM: 2'), again.join('\n'));
  const marked = lines(run(['--mark', 'wrong', 'SG-CLAIM']));
  assert.ok(marked.includes('  SG-CLAIM: 2 (1 marked wrong, 50% wrong)'), marked.join('\n'));
  assert.ok(lines(run([])).includes('  SG-CLAIM: 2 (1 marked wrong, 50% wrong)'));
});

test('the saved daily counts outlive a deleted log, and the only file written is guard-score.json', () => {
  state = path.join(root, 'state-keep');
  fs.writeFileSync(log, stop('x (SG-CLAIM)', '2026-11-19T10:00:00Z') + '\n');
  run([]);
  fs.rmSync(log);
  const r = run([]);
  assert.ok(lines(r).includes('  SG-CLAIM: 1'), r.stdout);
  assert.deepEqual(fs.readdirSync(state), ['guard-score.json']);
});

test('escape hatches are counted; a bad option exits 2', () => {
  fs.writeFileSync(log, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'CHECK RETIRED: {}' }, { type: 'tool_use', input: { command: 'node evidence.mjs --local --no-cache' } }] }, timestamp: '2026-11-19T10:00:00Z' }) + '\n');
  const out = lines(run([])).join('\n');
  assert.match(out, /ESCAPE HATCHES: .*--local x1/);
  assert.match(out, /CHECK RETIRED x1/);
  assert.equal(run(['--bogus']).status, 2);
});
