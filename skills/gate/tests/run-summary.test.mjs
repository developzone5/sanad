import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summarize, summaryLines, timeoutFailures } from '../scripts/run-summary.mjs';

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

// 2026-11-14: the only failure of a 1759-test Vitest suite was a 5000 ms timeout in a test file the task
// never touched. Vitest 3 writes the "Failed Tests" section to stderr and the totals to stdout; evidence.mjs
// reads both logs. Identical errors share one error under several FAIL lines.
const vitestTotals = (failedFiles, failedTests) => [
  ' ✓ src/a.test.tsx (3 tests) 40ms',
  ' ❯ src/utils/exam-results-export.test.ts (12 tests | 1 failed) 5123ms',
  '   × exportExamResults > builds the sheet 5003ms',
  '     → Test timed out in 5000ms.',
  ` Test Files  ${failedFiles} failed | ${112 - failedFiles} passed (112)`,
  `      Tests  ${failedTests} failed | ${1759 - failedTests} passed (1759)`,
  '   Start at  10:41:07',
  '   Duration  412.80s (transform 9.1s, setup 60.2s, collect 101.3s, tests 380.0s)',
].join('\n');
const timeoutError = (ms = 5000) => [`Error: Test timed out in ${ms}ms.`,
  'If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".',
  ' ❯ src/utils/exam-results-export.test.ts:41:3', "     40|   it('builds the sheet', async () => {", '       |   ^'].join('\n');
const assertionError = ["AssertionError: expected 'Part 1' to be null", ' ❯ src/pages/Exam.test.tsx:12:5'].join('\n');
const failedTests = (groups, banner = 'Failed Tests ' + groups.reduce((n, g) => n + g.names.length, 0)) => ['',
  `⎯⎯⎯⎯⎯⎯⎯ ${banner} ⎯⎯⎯⎯⎯⎯⎯`, '',
  ...groups.flatMap((g, i) => [...g.names.map(n => `\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m ${n}`), g.error, '', `⎯⎯⎯⎯⎯⎯[${i + 1}/${groups.length}]⎯`, '']),
].join('\n');
const realCase = vitestTotals(1, 1) + '\n' + failedTests([{ names: ['src/utils/exam-results-export.test.ts > exportExamResults > builds the sheet'], error: timeoutError() }]);

test('timeoutFailures: a Vitest run that failed only by test timeouts names their files (the 2026-11-14 case)', () => {
  assert.deepEqual(timeoutFailures(realCase), { runner: 'vitest', files: ['src/utils/exam-results-export.test.ts'] });
  // Two tests with the same timeout error (one error under two FAIL lines), in two files; CRLF logs.
  const grouped = vitestTotals(2, 2) + '\n' + failedTests([{ names: ['src/a.test.ts > slow one', 'src/b/c.test.tsx > slow two'], error: timeoutError() }]);
  assert.deepEqual(timeoutFailures(grouped.replace(/\n/g, '\r\n')), { runner: 'vitest', files: ['src/a.test.ts', 'src/b/c.test.tsx'] });
  // A workspace project's label before the file name is not part of the file.
  const labelled = vitestTotals(1, 1) + '\n' + failedTests([{ names: ['|web| src/a.test.ts > slow one'], error: timeoutError() }]);
  assert.deepEqual(timeoutFailures(labelled), { runner: 'vitest', files: ['src/a.test.ts'] });
});

test('timeoutFailures: an assertion, a hook timeout, a failed suite, an unhandled error or uneven counts give nothing', () => {
  const two = (error) => vitestTotals(2, 2) + '\n' + failedTests([
    { names: ['src/utils/exam-results-export.test.ts > exportExamResults > builds the sheet'], error: timeoutError() },
    { names: ['src/pages/Exam.test.tsx > notice > names no old section'], error }]);
  assert.deepEqual(timeoutFailures(two(timeoutError())), { runner: 'vitest', files: ['src/utils/exam-results-export.test.ts', 'src/pages/Exam.test.tsx'] }, 'control: two timeouts');
  assert.equal(timeoutFailures(two(assertionError)), null, 'a timeout and an assertion');
  assert.equal(timeoutFailures(two(timeoutError(5000).replace('Test timed out', 'Hook timed out'))), null, 'a hook timeout: --testTimeout does not change it');
  assert.equal(timeoutFailures(realCase + '\n⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯\n FAIL  src/x.test.ts [ src/x.test.ts ]\nError: Cannot find module "./x"'), null, 'a suite that failed to load');
  assert.equal(timeoutFailures(realCase + '\n⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯\nVitest caught 1 unhandled error during the test run.'), null, 'an unhandled error');
  assert.equal(timeoutFailures(realCase.replace('Tests  1 failed | 1758 passed', 'Tests  2 failed | 1757 passed')), null, 'a failing test the section does not name');
  assert.equal(timeoutFailures(realCase.replace(' Test Files  1 failed | 111 passed', ' Test Files  2 failed | 110 passed')), null, 'a failing file the section does not name');
  assert.equal(timeoutFailures(realCase + '\n      Errors  1 error'), null, 'an error total');
  assert.equal(timeoutFailures(vitestTotals(1, 1)), null, 'totals with no Failed Tests section');
  assert.equal(timeoutFailures(' Test Files  112 passed (112)\n      Tests  1759 passed (1759)'), null, 'a passing run');
  assert.equal(timeoutFailures('Failed!  - Failed: 1, Passed: 654\nError: Test timed out in 5000ms.'), null, 'another runner');
  assert.equal(timeoutFailures(''), null);
});

test('timeoutFailures: Jest timeouts by file; a suite that failed to run or a second error gives nothing', () => {
  const block = (name, first = 'thrown: "Exceeded timeout of 5000 ms for a test.', more = []) => [`  ● ${name}`, '', `    ${first}`,
    '    Add a timeout value to this test to increase the timeout, if this is a long-running test. See https://jestjs.io/docs/api#testname-fn-timeout."',
    '', '      40 |', "    > 41 |   test('slow', async () => {", '         |   ^', ...more, '      at Object.<anonymous> (src/utils/x.test.js:41:3)', ''];
  const jest = (blocks, failed = 1, suites = 1) => [' PASS  src/a.test.js', ' FAIL  src\\utils\\x.test.js (6.12 s)', ...blocks, '',
    `Test Suites: ${suites} failed, 111 passed, 112 total`, `Tests:       ${failed} failed, 1758 passed, 1759 total`, 'Snapshots:   0 total', 'Time:        412.8 s'].join('\n');
  assert.deepEqual(timeoutFailures(jest(block('exportExamResults › builds the sheet'))), { runner: 'jest', files: ['src/utils/x.test.js'] });
  // The "Summary of all failing tests" repeats the same block: still one failing test.
  const repeated = jest(block('exportExamResults › builds the sheet')).replace('Test Suites:', 'Summary of all failing tests\n FAIL  src\\utils\\x.test.js (6.12 s)\n' + block('exportExamResults › builds the sheet').join('\n') + '\nTest Suites:');
  assert.deepEqual(timeoutFailures(repeated), { runner: 'jest', files: ['src/utils/x.test.js'] });
  assert.equal(timeoutFailures(jest(block('x › y', 'expect(received).toBe(expected)'))), null, 'an assertion');
  assert.equal(timeoutFailures(jest(block('x › y', undefined, ['    Expected: 1', '    Received: 2']))), null, 'a timeout and a second error in one block');
  assert.equal(timeoutFailures(jest([...block('x › y'), '  ● Test suite failed to run', '', '    Cannot find module'])), null, 'a suite that failed to run');
  assert.equal(timeoutFailures(jest(block('x › y'), 2)), null, 'a failing test the output does not name');
  // A project's display name may stand before the file; a path piece before it means a space in the path.
  assert.deepEqual(timeoutFailures(jest(block('x › y')).replace(' FAIL  src\\utils', ' FAIL  web  src\\utils')), { runner: 'jest', files: ['src/utils/x.test.js'] });
  assert.equal(timeoutFailures(jest(block('x › y')).replace(' FAIL  src\\utils\\x', ' FAIL  src\\my utils\\x')), null, 'a path with a space');
});

// 2026-11-14: a run stopped early (bail, a cancel) never ran some tests; a rerun of only the timed-out file
// would retire it as if the rest had passed. Vitest counts the files it never ran in the total only; Jest
// says "N of M total".
test('timeoutFailures: a run that did not run every test gives nothing', () => {
  const withFiles = (line) => realCase.replace(/ Test Files {2}1 failed \| 111 passed \(112\)/, line);
  assert.equal(timeoutFailures(withFiles(' Test Files  1 failed | 50 passed (112)')), null, 'Vitest: 61 files never ran');
  assert.equal(timeoutFailures(realCase.replace('1 failed | 1758 passed (1759)', '1 failed | 900 passed (1759)')), null, 'Vitest: tests never ran');
  assert.deepEqual(timeoutFailures(withFiles(' Test Files  1 failed | 100 passed | 11 skipped (112)')), { runner: 'vitest', files: ['src/utils/exam-results-export.test.ts'] }, 'skipped files are counted');
  const jest = (suites) => [' FAIL  src/x.test.js (6.12 s)', '  ● x › y', '', '    thrown: "Exceeded timeout of 5000 ms for a test.', '',
    `Test Suites: ${suites}`, 'Tests:       1 failed, 40 passed, 41 total'].join('\n');
  assert.deepEqual(timeoutFailures(jest('1 failed, 4 passed, 5 total')), { runner: 'jest', files: ['src/x.test.js'] }, 'control');
  assert.equal(timeoutFailures(jest('1 failed, 4 passed, 5 of 112 total')), null, 'Jest: a bail left suites unrun');
});

// 2026-11-14: a file name with a space, read as its last word only, names a shorter path; next to a changed
// file of that full name it read as untouched. Unsure names give nothing.
test('timeoutFailures: a Vitest file name with a space gives nothing', () => {
  const spaced = vitestTotals(1, 1) + '\n' + failedTests([{ names: ['src/my utils/x.test.ts > slow one'], error: timeoutError() }]);
  assert.equal(timeoutFailures(spaced), null);
  const labelled = vitestTotals(1, 1) + '\n' + failedTests([{ names: ['|web (chromium)| src/a.test.ts > slow one'], error: timeoutError() }]);
  assert.deepEqual(timeoutFailures(labelled), { runner: 'vitest', files: ['src/a.test.ts'] }, 'a project label with a space is not the path');
});
