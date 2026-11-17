#!/usr/bin/env node
// check-test-asserts.mjs — new test lines that assert a range where the exact value is known.
//
// 2026-11-07: a test said "at most one message" (`toBeLessThanOrEqual(1)`) where the screen always
// shows exactly one, so a change that showed none would still pass; two reviewers each spent a
// finding on it. This finds such lines before review: Vitest/Jest `toBeLessThan(OrEqual)`,
// `toBeGreaterThan(OrEqual)` and xUnit `Assert.InRange`, on lines added in changed test files.
// A real bound (a time limit, a random value) stays when the same line says why: `// range: <why>`.
//
// Two more checks on the same new test lines (2026-11-07):
//   proof  a new "nothing happens" check (not called, null, empty, zero, never) needs a passing
//          `red-proof.mjs --breaks` run that made the check's own test fail, with the code as it is
//          now: three rounds in a row such a check passed review that no run had ever seen fail.
//          2026-11-17 (audit): by test, not by test file (one caught test certified another rule's
//          vacuous check in the same file), and with all the code unchanged since, not only the test
//          file and the broken product files (an edit to code a test depends on left the proof valid).
//          A check line in no test (a helper, a hook) can be proven by no break: it is UNPROVEN.
//   tags   with --check <file>, every check line Cn (numbered in order, as review-brief.mjs prints
//          them) has a test that carries `[Cn]` in its name or a comment; not a skipped one.
//
// The new lines and the "nothing happens" test live in new-lines.mjs (2026-11-15): red-proof.mjs reads the same
// lines the same way before any run, and refuses a proof that would leave one of them unproven here.
//
// Usage: node check-test-asserts.mjs --repo <path> [--base <ref>] [--check <file>] [--before-proof]
//   --before-proof: skip the proof part (pre-review.mjs --before-proof, run before red-proof.mjs).
// Exit 0: all clear. 1: found (each printed). 2: usage error.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { TEST_FILE } from './check-ticket-lines.mjs';
import { enclosingTest, helperCallers, proofHint, provenHas, provenTests, recordNotes, skippedLines, testSpans } from './proof-record.mjs';
import { checkLines } from './review-brief.mjs';
import { addedLines, newLines, nothingChecks } from './new-lines.mjs';
import { isMain } from './is-main.mjs';

export { addedLines, newLines, nothingChecks };

// FluentAssertions forms too (2026-11-12: the backend asserts with .Should(); 36 of its range checks
// were never flagged).
const RANGE = /\.(?:toBeLessThan|toBeLessThanOrEqual|toBeGreaterThan|toBeGreaterThanOrEqual)\s*\(|\bAssert\.InRange\s*\(|\bShould\(\)[^;]*?\.(?:Be(?:Greater|Less)Than(?:OrEqualTo)?|Be(?:Greater|Less)OrEqualTo|BeInRange)\s*\(/;
const REASON = /(?:\/\/|#)\s*range:\s*\S/;

// A value read inside an assertion with `!` (2026-11-07: when a break removed the element, the
// `!` made a type error, the proof called it a broken test, and the whole proof ran twice). With
// `?.` a missing element fails as an assertion.
const NON_NULL = /\bexpect\([^;]*[)\]]!\./;
export function nonNullReads(lines) {
  return lines.filter(l => TEST_FILE.test(l.file) && NON_NULL.test(l.text));
}

// The check line numbers (1-based) that no added test line tags as [Cn] (or [C2, C5]). `skipped(line)`
// says whether a line belongs to a skipped test (skippedLines): a tag there does not count (2026-11-12).
export function untagged(count, lines, skipped = () => false) {
  const seen = new Set();
  for (const l of lines) {
    if (!TEST_FILE.test(l.file) || skipped(l)) continue;
    for (const tag of l.text.matchAll(/\[(C\d+(?:\s*,\s*C?\d+)*)\]/g)) for (const n of tag[1].match(/\d+/g)) seen.add(Number(n));
  }
  return Array.from({ length: count }, (_, i) => i + 1).filter(n => !seen.has(n));
}

function git(cwd, args) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }); }
  catch { return null; }
}

export function rangeAsserts(lines) {
  return lines.filter(l => TEST_FILE.test(l.file) && RANGE.test(l.text) && !REASON.test(l.text));
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const repo = path.resolve(opt('--repo') || process.cwd());
  const top = (git(repo, ['rev-parse', '--show-toplevel']) || '').trim();
  if (!top) { console.error('check-test-asserts: not inside a git repository: ' + repo); process.exit(2); }
  const base = opt('--base') || 'origin/' + ((git(top, ['config', '--get', 'sanad.integration']) || '').trim() || 'staging');
  const lines = newLines(top, base);
  if (!lines) { console.error('check-test-asserts: no merge base with ' + base); process.exit(2); }
  const found = rangeAsserts(lines);
  for (const f of found) console.log(`RANGE ASSERT: ${f.file}:${f.line} — ${f.text.trim()} → assert the exact value, or say why on the line: // range: <why>`);
  // Proof: a new "nothing happens" check needs a passing break run that named a test in its own file,
  // with that file as it is now (2026-11-12: one proof of the page cleared every server check too).
  // 2026-11-17 (audit "one caught test certifies another rule's vacuous negative check"): the test that holds
  // the check's line must itself be one a break made fail (provenTests names them); a line in no test, or in a
  // test no break caught, is unproven, and its line says which test and which mustFail name would prove it.
  const nothing = nothingChecks(lines);
  const unproven = [];
  // --before-proof (2026-11-13): the cheap checks run before the proof, so a label or quote fixed in a test
  // file does not void a proof already run. The proof part is judged by the run after the proof.
  const beforeProof = argv.includes('--before-proof');
  if (nothing.length && !beforeProof) {
    const proven = provenTests(top);
    const spans = new Map();
    for (const l of nothing) {
      if (!spans.has(l.file)) { let text = ''; try { text = fs.readFileSync(path.join(top, l.file), 'utf8'); } catch { /* a deleted file */ } spans.set(l.file, { text, list: testSpans(text, l.file) }); }
      const { text, list } = spans.get(l.file);
      const own = enclosingTest(list, l.line);
      if (provenHas(proven.get(l.file), own)) continue;
      // A line in a helper counts when a proven test of the file calls that helper (2026-11-17, audit).
      if (!own && helperCallers(text, list, l.line).some(c => provenHas(proven.get(l.file), c))) continue;
      unproven.push({ ...l, own });
    }
  }
  for (const f of unproven.slice(0, 8)) console.log(`UNPROVEN: ${f.file}:${f.line} — ${f.text.trim()} → ${proofHint(f.own)}`);
  if (unproven.length) {
    console.log(`  → ${unproven.length} new "nothing happens" check(s) whose own test no break run made fail on the code as it is now: run red-proof.mjs --breaks (a break of each such test's rule, naming that test) after the last edit`);
    for (const note of recordNotes(top)) console.log(`  → ${note}`);
  }
  // Tags: every check line has a tagged test.
  let missing = [];
  if (opt('--check')) {
    const count = checkLines(fs.readFileSync(opt('--check'), 'utf8')).length;
    const skips = new Map();
    const skipped = (l) => {
      if (!skips.has(l.file)) { let text = ''; try { text = fs.readFileSync(path.join(top, l.file), 'utf8'); } catch { /* a deleted file */ } skips.set(l.file, skippedLines(text, l.file)); }
      return skips.get(l.file).has(l.line);
    };
    missing = untagged(count, lines, skipped);
    for (const n of missing) console.log(`UNTAGGED: check line C${n} has no new test tagged [C${n}]`);
  }
  const nonNull = nonNullReads(lines);
  for (const f of nonNull.slice(0, 8)) console.log(`NON-NULL: ${f.file}:${f.line} — ${f.text.trim()} → read with ?. so a missing element fails as an assertion`);
  const problems = found.length + unproven.length + missing.length + nonNull.length;
  const proofNote = !nothing.length ? '' : beforeProof
    ? ` (${nothing.length} "nothing happens" check(s): proof judged after the proof run)`
    : ` (${nothing.length} "nothing happens" check(s) proven by a break run)`;
  console.log(problems ? `TEST ASSERTS: ${found.length} range, ${unproven.length} unproven, ${missing.length} untagged, ${nonNull.length} non-null` : `TEST ASSERTS: none${proofNote}`);
  process.exitCode = problems ? 1 : 0;
}
