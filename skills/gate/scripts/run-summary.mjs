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
