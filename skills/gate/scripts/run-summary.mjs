// run-summary.mjs — the totals and the failing tests of a finished test run, read from its saved output.
//
// 2026-11-13: a full page suite run straight over ssh printed 600 lines; the tool showing it cut the middle,
// the run said "exit 1", and the failing test could not be seen, so the whole suite ran again. evidence.mjs
// saves the full output to its log files and, when a check fails, prints this short summary above its
// CHECK_COMPLETED line: the runner's own total lines and every line that names a failing test, with the path
// of the full log. A passing check prints nothing more (its receipt says passed).
//
// Runners read: Vitest/Jest (Test Files / Tests totals, FAIL and × lines), dotnet test (Passed!/Failed! total,
// "  Failed <name> [..]" and [FAIL] lines), node --test (ℹ tests/pass/fail, ✖ lines). Anything else still gets
// its last lines, so a failure is never shown as nothing.
import fs from 'node:fs';

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const TOTALS = [
  /^\s*Test Files\s+\d/,                    // vitest
  /^\s*Tests\s+\d+\s+(?:failed|passed)/,    // vitest / jest
  /^\s*(?:Passed|Failed)!\s+-\s/,           // dotnet test
  /^\s*Total tests:\s*\d/,                  // dotnet (older output)
  /^ℹ (?:tests|pass|fail) \d+$/,            // node --test
];
const FAILS = [
  /^\s*FAIL\s+\S/,                          // vitest / jest: FAIL  src/a.test.ts > name
  /^\s*[×✗]\s+\S/,                          // vitest: × name
  /^\s*Failed\s+\S.*\[[^\]]*\]\s*$/,        // dotnet: Failed Ns.Class.Test [12 ms]
  /\[FAIL\]/,                               // xunit console
  /^\s*✖\s+\S/,                             // node --test
  /^\s*(?:Error|AssertionError|TestingLibraryElementError|Expected|Received|expected)\b.{0,200}$/, // the first reason lines
];
const MAX_FAILS = 30;
const TAIL = 8;

export function summarize(text) {
  const lines = String(text || '').replace(ANSI, '').split(/\r?\n/).map(l => l.replace(/\s+$/, '')).filter(l => l.trim());
  const totals = [...new Set(lines.filter(l => TOTALS.some(re => re.test(l))).map(l => l.trim()))];
  const fails = [];
  for (const l of lines) {
    if (!FAILS.some(re => re.test(l))) continue;
    const t = l.trim();
    if (!fails.includes(t)) fails.push(t);
    if (fails.length >= MAX_FAILS) break;
  }
  const tail = totals.length || fails.length ? [] : lines.slice(-TAIL).map(l => l.trim());
  return { totals, fails, tail };
}

// The lines evidence.mjs prints for a failed check; [] for a passed one.
export function summaryLines(receipt) {
  if (!receipt || receipt.status === 'passed') return [];
  const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
  const { totals, fails, tail } = summarize(read(receipt.stdout) + '\n' + read(receipt.stderr));
  const out = [`CHECK_SUMMARY — full output: ${receipt.stdout || '(no log)'}`];
  if (receipt.reason) out.push(`  reason: ${receipt.reason}`);
  for (const l of totals) out.push('  ' + l);
  for (const l of fails) out.push('  ' + l);
  if (fails.length >= MAX_FAILS) out.push(`  … more failing lines in the full output`);
  for (const l of tail) out.push('  ' + l);
  return out;
}

// 2026-11-14: the only failure of a 1759-test Vitest suite was a 5000 ms timeout in a test file the task never
// touched, and its rerun was written by hand. timeoutFailures says when EVERY failing test of a Vitest or Jest
// run failed by its test timeout, and in which test files; evidence.mjs then offers a rerun of only those files
// with a longer timeout. Anything it cannot account for (an assertion, a hook timeout in Vitest, a suite that
// failed to load, an unhandled error, counts that do not add up, another runner) gives null: no rerun offer.
const VITEST_TIMEOUT = /^Error: Test timed out in \d+ms\b/;   // "Hook timed out" is not raised by --testTimeout
// Jest hooks without a timeout of their own use the test timeout, so a hook timeout counts there.
const JEST_TIMEOUT = /^(?:thrown: "|\w*Error: )?Exceeded timeout of [\d.]+ ?m?s for a (?:test|hook)\b/;
const JEST_OTHER_ERROR = /^(?:thrown:|\w*Error\b|expect\(|Expected\b|Received\b)/;

export function timeoutFailures(text) {
  const lines = String(text || '').replace(ANSI, '').split(/\r?\n/).map(l => l.replace(/\s+$/, ''));
  const vitest = lines.some(l => /^\s*Test Files\s+\d/.test(l)), jest = lines.some(l => /^\s*Test Suites:\s/.test(l));
  if (vitest === jest) return null;
  return vitest ? vitestTimeouts(lines) : jestTimeouts(lines);
}

// One count from the run's own total line (the same number wherever that line repeats), else null.
function total(lines, re) {
  const found = new Set(lines.map(l => (re.exec(l) || [])[1]).filter(Boolean));
  return found.size === 1 ? Number([...found][0]) : null;
}
// Every test ran (2026-11-14): a run stopped early by a bail or a cancel never ran some tests, and a rerun of
// the timed-out files alone cannot stand for them. Vitest keeps a file it never ran in the "(N)" total only,
// with no state, so the states stop adding up to it.
function vitestComplete(lines, title) {
  const found = lines.map(l => new RegExp('^\\s*' + title + '\\s+(.*)\\((\\d+)\\)\\s*$').exec(l)).filter(Boolean);
  return found.length > 0 && found.every(m => {
    const parts = m[1].split('|').map(p => /^\s*(\d+) (?:failed|passed|skipped|todo)\s*$/.exec(p));
    return parts.every(Boolean) && parts.reduce((n, p) => n + Number(p[1]), 0) === Number(m[2]);
  });
}
// The file a FAIL line names, or null when unsure (2026-11-14): a path with a space, read as its last word,
// named a shorter path that looked untouched next to the changed one. Vitest puts a project's label in
// |bars| before the path; Jest a display name, which holds no path sign.
function vitestFile(text) {
  const file = text.trim().replace(/^\|[^|]*\|\s+/, '');
  return /\s/.test(file) ? null : file.replace(/\\/g, '/');
}
function jestFile(text) {
  const words = text.trim().split(/\s+/);
  return words.length > 2 || (words.length === 2 && /[\\/]/.test(words[0])) ? null : words[words.length - 1].replace(/\\/g, '/');
}

// Vitest 3 writes the "Failed Tests N" section to stderr: one or more " FAIL  <file> > <test>" lines, then
// their one shared error. Any other section (Failed Suites, Unhandled Errors) means another kind of failure.
function vitestTimeouts(lines) {
  const tests = total(lines, /^\s*Tests\s+(\d+) failed\b/), files = total(lines, /^\s*Test Files\s+(\d+) failed\b/);
  if (!tests || !files || !vitestComplete(lines, 'Test Files') || !vitestComplete(lines, 'Tests')) return null;
  if (lines.some(l => /^\s*(?:Type )?Errors\s+\d+ (?:errors?|failed)\b/.test(l) || /unhandled errors? during the test run/i.test(l))) return null;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('⎯')) continue;
    const label = lines[i].replace(/⎯/g, '').trim();
    if (label === '' || /^\[\d+\/\d+\]$/.test(label)) continue;   // the dividers between errors
    const banner = /^Failed Tests (\d+)$/.exec(label);
    if (!banner || start !== -1 || Number(banner[1]) !== tests) return null;
    start = i + 1;
  }
  if (start === -1) return null;
  const groups = [];
  let group = null;
  for (const l of lines.slice(start)) {
    if (/^\s*(?:Test Files|Tests)\s+\d/.test(l)) break;
    const fail = /^\s*FAIL\s+(\S.*)$/.exec(l);
    if (fail) {
      if (!group || group.reason !== undefined) groups.push(group = { names: [], reason: undefined });
      group.names.push(fail[1].trim());
    } else if (group && group.reason === undefined && l.trim()) group.reason = l.trim();
  }
  const names = new Set(groups.flatMap(g => g.names));
  const failing = [...new Set([...names].map(n => vitestFile(n.split(' > ')[0])))];
  if (!groups.length || groups.some(g => !VITEST_TIMEOUT.test(g.reason || '')) || names.size !== tests || failing.includes(null) || failing.length !== files) return null;
  return { runner: 'vitest', files: failing };
}

// Jest: " FAIL  <file> (6.1 s)", then a "  ● <describe> › <test>" block per failing test, its first line the
// error. "Summary of all failing tests" repeats the blocks; each test counts once.
function jestTimeouts(lines) {
  const tests = total(lines, /^\s*Tests:\s+(\d+) failed\b/), files = total(lines, /^\s*Test Suites:\s+(\d+) failed\b/);
  // Jest names a run that stopped early "N of M total" (a bail): some suites never ran.
  if (!tests || !files || lines.some(l => /^\s*(?:Test Suites|Tests):\s.*\b\d+ of \d+ total\b/.test(l))) return null;
  const seen = new Map();
  let file = null, block = null;
  for (const l of lines) {
    const head = /^\s*(FAIL|PASS)\s+(\S.*)$/.exec(l);
    if (head) {
      file = head[1] === 'FAIL' ? jestFile(head[2].replace(/\s+\(\d+(?:\.\d+)?\s*m?s\)$/, '')) : null;
      if (head[1] === 'FAIL' && !file) return null;
      block = null; continue;
    }
    if (/^\s*(?:Test Suites|Tests|Snapshots|Time):\s/.test(l) || /^\s*Summary of all failing tests\b/.test(l)) { file = null; block = null; continue; }
    const title = /^\s*●\s+(.+)$/.exec(l);
    if (title) {
      if (!file || /^Test suite failed to run\b/.test(title[1].trim())) return null;
      block = { key: file + '\n' + title[1].trim(), first: true };
      if (!seen.has(block.key)) seen.set(block.key, { file, ok: true });
      continue;
    }
    if (!block || !l.trim()) continue;
    const entry = seen.get(block.key);
    if (block.first) { block.first = false; if (!JEST_TIMEOUT.test(l.trim())) entry.ok = false; }
    else if (JEST_OTHER_ERROR.test(l.trim())) entry.ok = false;   // a second error in the same test
  }
  const failing = [...new Set([...seen.values()].map(e => e.file))];
  if (!seen.size || [...seen.values()].some(e => !e.ok) || seen.size !== tests || failing.length !== files) return null;
  return { runner: 'jest', files: failing };
}
