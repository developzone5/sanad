import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summarize, summaryLines } from '../scripts/run-summary.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-summary-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

// 2026-11-13: a suite's 600 lines were cut in the middle, and the failing test could not be seen.
test('vitest: the totals and each failing test line, colours dropped, each line once', () => {
  const text = [
    '\x1b[32m✓\x1b[39m src/a.test.tsx (3 tests) 40ms', ...Array.from({ length: 500 }, (_, i) => `  ✓ passing ${i}`),
    '\x1b[31m FAIL \x1b[39m src/pages/student/ExamRunnerModal.test.tsx > notice > [C1] names no old section',
    'AssertionError: expected \'Part 1 → Part 3\' to be null',
    ' FAIL  src/pages/student/ExamRunnerModal.test.tsx > notice > [C1] names no old section',
    '   × [C2] names the section that ran out 120ms',
    ' Test Files  1 failed | 111 passed (112)',
    '      Tests  2 failed | 1759 passed (1761)',
  ].join('\n');
  const s = summarize(text);
  assert.deepEqual(s.totals, ['Test Files  1 failed | 111 passed (112)', 'Tests  2 failed | 1759 passed (1761)']);
  assert.deepEqual(s.fails, [
    'FAIL  src/pages/student/ExamRunnerModal.test.tsx > notice > [C1] names no old section',
    "AssertionError: expected 'Part 1 → Part 3' to be null",
    '× [C2] names the section that ran out 120ms',
  ]);
  assert.deepEqual(s.tail, [], 'a known runner needs no tail');
});

test('dotnet and node --test lines are read; an unknown runner still shows its last lines', () => {
  const dotnet = summarize('  Failed EduQuest.Tests.ExamTests.Locks [12 ms]\n  Error Message:\n   Expected 409 but was 200\nFailed!  - Failed:     1, Passed:   654, Skipped:     3, Total:   658\n');
  assert.deepEqual(dotnet.totals, ['Failed!  - Failed:     1, Passed:   654, Skipped:     3, Total:   658']);
  assert.ok(dotnet.fails.includes('Failed EduQuest.Tests.ExamTests.Locks [12 ms]'));
  const node = summarize('✖ F1: a new file is scanned (35475ms)\nℹ tests 272\nℹ pass 271\nℹ fail 1\n');
  assert.deepEqual(node.totals, ['ℹ tests 272', 'ℹ pass 271', 'ℹ fail 1']);
  assert.deepEqual(node.fails, ['✖ F1: a new file is scanned (35475ms)']);
  const other = summarize(Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n'));
  assert.deepEqual(other.tail, Array.from({ length: 8 }, (_, i) => `line ${i + 12}`));
});

test('summaryLines: nothing for a passed check; the full log path, the reason and the summary for a failed one', () => {
  const out = path.join(root, 'stdout.log'), err = path.join(root, 'stderr.log');
  fs.writeFileSync(out, ' FAIL  src/a.test.ts > x\n Test Files  1 failed (1)\n');
  fs.writeFileSync(err, '');
  assert.deepEqual(summaryLines({ status: 'passed', stdout: out, stderr: err }), []);
  const lines = summaryLines({ status: 'failed', stdout: out, stderr: err, reason: null });
  assert.equal(lines[0], `CHECK_SUMMARY — full output: ${out}`);
  assert.deepEqual(lines.slice(1), ['  Test Files  1 failed (1)', '  FAIL  src/a.test.ts > x']);
  const gone = summaryLines({ status: 'failed', stdout: path.join(root, 'none.log'), stderr: '', reason: 'Timed out' });
  assert.deepEqual(gone.slice(1), ['  reason: Timed out'], 'a missing log is not an error');
});
