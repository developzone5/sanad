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
