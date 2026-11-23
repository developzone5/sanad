// hooks/lib/transcript-scan.js reportNotes: a finding line that only says there is none is no open note (2026-11-22,
// owner). A re-run of a small task: three reviewers ended with "EXTRA TEST: none.", the scanner read each as an open
// EXTRA TEST note, and the gate stayed FAIL on notes nobody could fix. The line keeps its place in the list (marked
// `none`, closed by the scanner), so every later note keeps its number (attack, 2026-11-22).
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const hooks = process.env.WORKFLOW_HOOKS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { reportNotes } = createRequire(import.meta.url)(path.join(hooks, 'lib', 'transcript-scan.js'));
// The notes a report leaves to answer: every note not marked as a "none" line.
const open = (report) => reportNotes(report).filter((n) => !n.none).map((n) => `${n.kind}: ${n.text}`);

test('"EXTRA TEST: none." and its other ways of saying none leave no note to answer', () => {
  for (const line of ['EXTRA TEST: none.', 'EXTRA TEST: none', '- EXTRA TEST: None — the tests cover every line', '**EXTRA TEST:** none.',
    'EXTRA TEST (optional): n/a', 'Gap: none.', 'Bug — none', 'Question: nothing.', '2. Blocker: not applicable']) {
    assert.deepEqual(open(`RECOMMEND: PASS\n\n${line}\n`), [], line);
  }
});

test('a finding that starts with "no" or "none" but says more is still a note', () => {
  assert.deepEqual(open('Bug — no Retry after a failed load (GroupMembersModal.tsx:266)'), ['Bug: Bug — no Retry after a failed load (GroupMembersModal.tsx:266)']);
  assert.equal(open('Gap: none of the tests removes the 51st student').length, 1);
  assert.equal(open('EXTRA TEST: nothing checks the Arabic labels').length, 1);
  assert.equal(open('Bug: n/a values crash the export (export.ts:40)').length, 1);
  // A reason after "none" is allowed on an EXTRA TEST line only, and never one that names a defect or a file:line.
  for (const line of ['Bug: none — the save drops page 2 (save.ts:12)', 'Blocker — none — two saves at once both write', 'Gap: None - the tests cover it',
    'EXTRA TEST: none — but the 51-student removal is untested', 'EXTRA TEST: none — see members.ts:40', 'EXTRA TEST: none — retries duplicate invoices']) {
    assert.equal(open(line).length, 1, line);
  }
});

test('a "none" line keeps its place, so the notes after it keep their numbers', () => {
  const notes = reportNotes('EXTRA TEST: none.\nBug — a.ts:3 — empty list → crash\nGap: none.\nGap — b.ts:9 — no test for 51 rows\n');
  assert.deepEqual(notes.map((n) => [n.kind, Boolean(n.none)]), [['EXTRA TEST', true], ['Bug', false], ['Gap', true], ['Gap', false]]);
});

test('"EXTRA TEST:" over a list still takes the list, and "none" under it is part of that note', () => {
  const notes = reportNotes('EXTRA TEST:\n  - a 51-student section, remove one\n  - Arabic keyboard paging\n');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].none, undefined);
  assert.match(notes[0].text, /51-student section/);
});

test('a "none" line inside a fenced code block stays an example, and real notes around it still count', () => {
  const report = 'Bug — a.ts:3 — empty list → crash\n```\nEXTRA TEST: none.\n```\nEXTRA TEST: none.\nGap — b.ts:9 — no test for 51 rows\n';
  assert.deepEqual(reportNotes(report).filter((n) => !n.none).map((n) => n.kind), ['Bug', 'Gap']);
});
