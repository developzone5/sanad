// 2026-11-12: the proof part of the reviewers' brief. Two proofs (server and page) give two logs and only
// one reached the reviewers; a stopped proof was filtered out; nothing said which code a log was for.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { proofLines } from '../scripts/review-brief.mjs';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'review-brief.mjs');
const A = 'a'.repeat(40), B = 'b'.repeat(40);
const done = { name: 'proof-be.log', text: `RED-PROOF-LOG: tree ${A} at 2026-11-12T05:00:00.000Z\nnoise\nRED-PROOF: RED ✓ — x\n  BREAK ✓ one: all 1 named test(s) fail\n  GREEN ✓ the tests pass on the fixed tree\nRED-PROOF: PROVED ✓ — y\n` };
const stopped = { name: 'proof-fe.log', text: `RED-PROOF-LOG: tree ${B} at 2026-11-12T05:01:00.000Z\nRED-PROOF: ENVIRONMENT ✗ — the test machine failed (database or host), not the tests\n` };

test('every proof log is carried, a stopped proof is shown, and a proof of other code is named', () => {
  const lines = proofLines([done, stopped], A);
  assert.ok(lines.includes('RED-PROOF: PROVED ✓ — y'));
  assert.ok(lines.includes('BREAK ✓ one: all 1 named test(s) fail'));
  assert.ok(lines.includes('GREEN ✓ the tests pass on the fixed tree'));
  assert.ok(lines.some(l => /^RED-PROOF: ENVIRONMENT ✗/.test(l)), 'a stopped proof is not filtered out');
  assert.ok(lines.includes('proof-be.log — ran 2026-11-12T05:00:00.000Z on tree aaaaaaaaaaaa:'));
  const at = lines.indexOf('proof-fe.log — ran 2026-11-12T05:01:00.000Z on tree bbbbbbbbbbbb:');
  assert.ok(at > 0, lines.join('\n'));
  assert.match(lines[at + 1], /^NOTE: the code under review is tree aaaaaaaaaaaa; it changed after this proof ran/);
  assert.equal(lines.filter(l => l.startsWith('NOTE:')).length, 1, 'only the proof of other code gets the note');
  assert.equal(lines.includes('noise'), false);
});

test('a log with no result line says the proof did not finish; an older log with no first line reads as before', () => {
  const empty = proofLines([{ name: 'empty.log', text: `RED-PROOF-LOG: tree ${A} at 2026-11-12T05:02:00.000Z\n` }], A);
  assert.deepEqual(empty.slice(-1), ['(no result line in this log: the proof did not finish)']);
  assert.deepEqual(proofLines([{ name: 'old.log', text: 'RED-PROOF: PROVED ✓ — z\n' }], A), ['RED-PROOF: PROVED ✓ — z']);
  assert.deepEqual(proofLines([], A), []);
});

// 2026-11-16: a fix-round proof (red-proof --changed-since) runs only some breaks; its PARTIAL lines reach the
// brief, so a reviewer never reads it as a full proof.
test('a partial proof log keeps its PARTIAL lines', () => {
  const partial = { name: 'proof.log', text: `RED-PROOF-LOG: tree ${A} at 2026-11-16T05:00:00.000Z\nRED-PROOF: PARTIAL — 1 of 3 break(s) changed since abc: two; the others are not run.\n  BREAK ✓ two: all 1 named test(s) fail\n  GREEN ✓ the tests pass on the fixed tree\nRED-PROOF: PARTIAL ✓ — 1 of 3 break(s) caught, green on the fix; files restored; run the full proof (without --changed-since) once before the final review.\n` };
  const lines = proofLines([partial], A);
  assert.ok(lines.some(l => /^RED-PROOF: PARTIAL — 1 of 3 break\(s\) changed since abc/.test(l)), lines.join('\n'));
  assert.ok(lines.some(l => /^RED-PROOF: PARTIAL ✓ — 1 of 3 break\(s\) caught/.test(l)), lines.join('\n'));
});

test('the command takes --proof-log more than once and puts both proofs in the brief', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-brief-proof-'));
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(repo, 'a.js'), 'export const a = 1;\n');
    git('add', 'a.js'); git('commit', '-qm', 'one');
    git('checkout', '-q', '-b', 'task');
    fs.writeFileSync(path.join(repo, 'a.js'), 'export const a = 2;\n');
    const file = (name, text) => { const p = path.join(root, name); fs.writeFileSync(p, text); return p; };
    const out = path.join(root, 'brief.md');
    // 2026-11-12: a change that is not text only needs its places list (places.mjs), every place closed.
    const places = path.join(root, 'places.md');
    const made = spawnSync(process.execPath, [path.join(path.dirname(script), 'places.mjs'), '--repo', repo, '--names', 'a', '--out', places], { encoding: 'utf8', windowsHide: true });
    assert.equal(made.status, 0, made.stdout + made.stderr);
    fs.writeFileSync(places, fs.readFileSync(places, 'utf8').replace(/→ $/gm, '→ C1'));
    const r = spawnSync(process.execPath, [script, '--out', out, '--ticket', file('ticket.md', 'The value is 2.\n'), '--lines', file('lines.md', '- The value is 2.\n'),
      '--check', file('check.md', '- [T1] the value is 2\n'), '--repo', repo, '--base', 'main',
      '--proof-log', file(done.name, done.text), '--proof-log', file(stopped.name, stopped.text), '--places', places], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const brief = fs.readFileSync(out, 'utf8');
    assert.match(brief, /RED-PROOF: PROVED ✓ — y/);
    assert.match(brief, /RED-PROOF: ENVIRONMENT ✗/);
    assert.match(brief, /proof-be\.log — ran/);
    assert.equal((brief.match(/NOTE: the code under review is tree/g) || []).length, 2, 'neither stamped tree is this repository\'s: both are named');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// 2026-11-20 (Z4): on the tests-only light path the brief does not ask for a proof log; one line says why.
import { buildBrief, onLightLane, LIGHT_LANE_LINE } from '../scripts/review-brief.mjs';
const briefArgs = { repo: '.', branch: 'b', base: 'origin/staging', mergeBase: 'abc', ticket: 't', checks: ['[change] x'], outside: { other: [], touched: [], decided: [], decisions: [] }, facts: { stack: 'S', size: 'SIZE', callers: '', signals: {} }, size: 'small', changed: [] };
test('light lane: the brief says the light path has no breaks instead of a proof log', () => {
  const light = buildBrief({ ...briefArgs, lightLane: true });
  assert.ok(light.includes(LIGHT_LANE_LINE));
  assert.ok(!buildBrief({ ...briefArgs }).includes(LIGHT_LANE_LINE), 'off the lane the line is not there');
  assert.ok(!buildBrief({ ...briefArgs, lightLane: true, proof: ['RED-PROOF: PROVED ✓ — y'] }).includes(LIGHT_LANE_LINE), 'a real proof wins');
});
test('onLightLane is false when the switch is not set', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-'));
  try { execFileSync('git', ['init', '-q', d]); assert.equal(onLightLane(d, 'origin/staging'), false); }
  finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// 2026-11-20 (timed task): the printed command passes every proof log of the folder as one comma list.
test('--proof-log takes a comma list of logs and reads each one; a missing log in the list is still a usage error', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-brief-proof-'));
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(repo, 'a.js'), 'export const a = 1;\n');
    git('add', 'a.js'); git('commit', '-qm', 'one');
    git('checkout', '-q', '-b', 'task');
    fs.writeFileSync(path.join(repo, 'a.js'), 'export const a = 2;\n');
    const file = (name, text) => { const p = path.join(root, name); fs.writeFileSync(p, text); return p; };
    const places = path.join(root, 'places.md');
    const made = spawnSync(process.execPath, [path.join(path.dirname(script), 'places.mjs'), '--repo', repo, '--names', 'a', '--out', places], { encoding: 'utf8', windowsHide: true });
    assert.equal(made.status, 0, made.stdout + made.stderr);
    fs.writeFileSync(places, fs.readFileSync(places, 'utf8').replace(/→ $/gm, '→ C1'));
    const args = (logs) => [script, '--out', path.join(root, 'brief.md'), '--ticket', file('ticket.md', 'The value is 2.\n'), '--lines', file('lines.md', '- The value is 2.\n'),
      '--check', file('check.md', '- [T1] the value is 2\n'), '--repo', repo, '--base', 'main', '--proof-log', logs, '--places', places];
    const a = file(done.name, done.text), b = file(stopped.name, stopped.text);
    let r = spawnSync(process.execPath, args(`${a},${b}`), { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const brief = fs.readFileSync(path.join(root, 'brief.md'), 'utf8');
    assert.match(brief, /proof-be\.log — ran/);
    assert.match(brief, /proof-fe\.log — ran/);
    // A folder name with a comma: the one existing file wins over the comma list.
    fs.mkdirSync(path.join(root, 'x,y'));
    const comma = path.join(root, 'x,y', 'proof.log');
    fs.writeFileSync(comma, done.text);
    r = spawnSync(process.execPath, args(comma), { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    r = spawnSync(process.execPath, args(`${a},${path.join(root, 'gone.log')}`), { encoding: 'utf8', windowsHide: true });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--proof-log file not found: .*gone\.log/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
