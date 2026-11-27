// 2026-11-28 (owner, batch b task 3): the start of a task runs side by side. While the builder reads the ticket and the
// code, a helper runs the places search, and the second look starts as soon as places.md exists; the plan waits for
// both. The tests are written by a helper beside the fix, from the ticket and check lines, never from the fix's code.
// Text and printed steps only: no guard changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STEPS, due, render } from '../scripts/steps.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const reference = path.join(here, '..', '..', 'sanad', 'reference');
const lf = (file) => fs.readFileSync(path.join(reference, file), 'utf8').replace(/\r\n/g, '\n');
const step = (id) => STEPS.find((s) => s.id === id);
const ctx = { gate: 'G', lane: 'small', repo: 'R', notes: 'N', base: 'origin/x', engine: 'claude', size: 'small', textProof: false, ticket: '', sides: [] };
// The facts of a task that was just started: no lines file yet.
const facts = (has = {}) => ({
  lane: 'small', size: '', textProof: false, testsOnly: false, pins: [], lastPin: null, decisions: [], suite: {}, proof: {}, checks: {}, notes: { known: false, all: [], open: [] },
  switches: { remoteHost: '', testsOnlyLane: false, designChoice: false, lateCheckLines: true },
  has: { lines: false, places: false, siblings: false, check: false, size: false, breaks: false, ...has },
  open: { places: 0, siblings: 0 }, git: { ahead: 0, changed: false, clean: true, tree: '', head: '' },
});

test('the start prints the places search beside it, with the side-by-side line', () => {
  const steps = due(facts());
  assert.deepEqual(steps.map((s) => s.id), ['start', 'places']);
  const text = render(steps, ctx, facts()).join('\n');
  assert.match(text, /side by side: while you read the ticket and the code, a sonnet-worker runs the places search below/);
  assert.match(text, /when places\.md exists, launch the second look at once; the check lines and the plan wait for both answers, before any code/);
  // Once the places list exists, the check lines and the second look are printed together.
  assert.deepEqual(due(facts({ lines: true, places: true })).map((s) => s.id), ['check-lines', 'second-look']);
});

test('the tests-and-fix step prints the test helper beside the fix', () => {
  const lines = step('tests-fix').lines(ctx, facts()).map((l) => l.text).join('\n');
  assert.match(lines, /side by side: a sonnet-worker writes the tests from the ticket lines and the check lines \(with the planned breaks in words\), never from the fix's code, while you write the fix; read and own its diff before the commit/);
});

test('loop.md says it in Step 1 and Step 3, stays under 14,000 bytes, and keeps its two fixed lines', () => {
  const loop = lf('loop.md');
  assert.ok(Buffer.byteLength(loop) < 14000, `loop.md is ${Buffer.byteLength(loop)} bytes`);
  assert.match(loop, /3\. \*\*Read the code\.\*\* .*Meanwhile a `sonnet-worker` runs item 4; item 6 starts once `places\.md` exists; the plan waits for both\./);
  assert.match(loop, /1\. \*\*Tests\.\*\* A `sonnet-worker` writes them beside the fix, from the ticket and check lines and the planned breaks, never from the fix's code; I own its diff\./);
  for (const fixed of ['Never reword a line to pass a lock.', 'Nothing else becomes a check line.']) assert.ok(loop.includes(fixed), fixed);
});

test('every line cut from loop.md keeps its twin in loop-rare-cases.md, word for word', () => {
  const loop = lf('loop.md'), rare = lf('loop-rare-cases.md');
  for (const cut of [
    'A server change: also warm the proof copies in the background.',
    'Create the test data yourself; give a direct link, the account and at most three actions, each with its exact value and expected result. `remote-web.sh stop` when the user reports.',
    'A set-aside note (separate PR, known limit) keeps its cause and file:line; a later fix that calls or copies that code checks the fault there.',
  ]) {
    assert.ok(rare.includes(cut), 'twin missing: ' + cut);
    assert.ok(!loop.includes(cut), 'still in loop.md: ' + cut);
  }
  // The loop points at the twins.
  assert.match(loop, /Server proofs: Warm copies in \[loop-rare-cases\.md\]\(loop-rare-cases\.md\)\./);
  assert.match(loop, /the rest: Browser check in \[loop-rare-cases\.md\]\(loop-rare-cases\.md\)\./);
});
