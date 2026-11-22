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
// Evidence for every new test (2026-11-19: on day 3 check line 16 went to review with a tagged test that no
// run had ever seen fail; only "nothing happens" lines were asked for a proof):
//   new tests    every test this change adds needs evidence on the code as it is now: it was seen failing on
//                the old code, or a caught break names it. One with neither is NOT PROVEN TEST. A "nothing
//                happens" line still needs the caught break; the old code never counts for it, as before.
//   check lines  with --check <file>, every check line Cn needs a tagged test that has such evidence. One
//                with none is NO EVIDENCE: its tagged tests have none, are skipped, or the tag is on no test
//                (a describe block, a helper, a loose comment).
// These two rows fail the check by default. Only `git config sanad.strictEvidence false` (the owner's way to step
// back) makes them warnings; a tag on no test or on a skipped test always fails. --before-proof leaves it to the run after the proof, and that
// run accepts only a proof of the code as it is then.
//
// The new lines and the "nothing happens" test live in new-lines.mjs (2026-11-15): red-proof.mjs reads the same
// lines the same way before any run, and refuses a proof that would leave one of them unproven here.
//
// Usage: node check-test-asserts.mjs --repo <path> [--base <ref>] [--check <file>] [--before-proof] [--strict-evidence]
//   The evidence rows (NOT PROVEN TEST, NO EVIDENCE) fail by default; `git config sanad.strictEvidence false` makes
//   them warnings. --strict-evidence fails them even then.
//   --before-proof: skip the proof part (pre-review.mjs --before-proof, run before red-proof.mjs): the
//                   "nothing happens" proof and the evidence of new tests and check lines.
// Exit 0: all clear. 1: found (each printed). 2: usage error.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { TEST_FILE } from './check-ticket-lines.mjs';
import { changedTestFiles, declaredTests, enclosingTest, evidenceOf, helperCallers, proofHint, provenHas, provenTests, recordNotes, skippedLines, testSpans } from './proof-record.mjs';
import { checkLines } from './review-brief.mjs';
import { markNewTests } from './red-proof.mjs';
import { addedLines, baseTexts, newLines, nothingChecks } from './new-lines.mjs';
import { isMain } from './is-main.mjs';
import { sizeTask } from './size-check.mjs';

export { addedLines, newLines, nothingChecks };

// ---- Evidence for new tests and check lines (2026-11-19) ----

// The tests this change adds, as { file, line, titles }. New as red-proof.mjs reads it (markNewTests): the base
// did not declare a test with the same titles, in the same file or in the file git says it was renamed from.
// So an older test whose body changed is not asked for evidence, and a test whose title changed is. A skipped
// test and a file that declares no test (helpers only) give none.
export function newTests(top, base, files = changedTestFiles(top, base) || []) {
  const before = baseTexts(top, base);
  if (!before) return [];
  const found = [];
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(path.join(top, file), 'utf8'); } catch { continue; /* a file gone since */ }
    const declared = declaredTests(text, file);
    // markNewTests gives one item per declared test, in the same order: the line comes from the declared test.
    markNewTests(text, before(file), file).forEach((t, i) => { if (t.isNew && declared[i]) found.push({ file, line: declared[i].line, titles: t.titles }); });
  }
  return found;
}

// Whether a test (a testSpans or newTests item) has evidence in the rows evidenceOf (proof-record.mjs) gave for
// it. A row is { file, line, title, evidence }, and its evidence is 'old code' (seen failing on the old code),
// 'break <name>' (caught by that break) or 'none', all for the code as it is now. Read strictly: the same file,
// line and title as provenHas matches, and any other word is no evidence. A skipped test never has any: it does
// not run. A row of another test file never counts, so a server proof gives a page test nothing, and the reverse.
const EVIDENCE = /^(?:old code$|break \S)/;
export function hasEvidence(rows, test) {
  if (!test || test.skipped || !Array.isArray(rows)) return false;
  return rows.some(r => r && r.file === test.file && r.line === test.line && test.titles.includes(r.title) && EVIDENCE.test(String(r.evidence)));
}

const TAG = /\[(C\d+(?:\s*,\s*C?\d+)*)\]/g;

// The test right below a line that sits in the comment lines (in C# also attribute lines) above it, as
// skippedLines reads "the lines right above a test"; null when code or a blank line comes first.
function testBelow(rows, spans, line, file) {
  const lead = (t) => /^(?:\/\/|\/\*|\*)/.test(t) || (/\.cs$/i.test(file) && /^\[/.test(t));
  for (let l = line; l <= rows.length; l++) {
    const at = l > line && spans.find(s => s.line === l);
    if (at) return at;
    if (!lead((rows[l - 1] || '').trim())) return null;
  }
  return null;
}

// The tests that carry each check line's tag on an added line: Map { n → { tests, loose } }. A tag belongs to the
// test whose lines hold it, or to the test right below the comment it sits in. A tag anywhere else (a describe
// title, a helper, a comment with code or a blank line under it) is on no test: its line goes to `loose`, so a
// group's tag never passes for the tests inside it. `fileOf(file)` gives { rows, spans }: the file's lines and
// its testSpans.
export function taggedTests(lines, fileOf) {
  const tagged = new Map();
  const slot = (n) => { if (!tagged.has(n)) tagged.set(n, { tests: [], loose: [] }); return tagged.get(n); };
  for (const l of lines) {
    if (!TEST_FILE.test(l.file)) continue;
    const numbers = [...l.text.matchAll(TAG)].flatMap(tag => tag[1].match(/\d+/g).map(Number));
    if (!numbers.length) continue;
    const { rows, spans } = fileOf(l.file);
    const own = enclosingTest(spans, l.line) || testBelow(rows, spans, l.line, l.file);
    for (const n of numbers) {
      const s = slot(n);
      if (!own) s.loose.push(l); else if (!s.tests.includes(own)) s.tests.push(own);
    }
  }
  return tagged;
}

// The check lines (1-based) with no tagged test that has evidence, each with why: { n, why, byProof }. byProof:
// a proof run can still give the evidence (a running tagged test); for a skipped test or a tag on no test only
// an edit of the test file can. A check line with no tag at all is not listed: UNTAGGED says it. `has(test)`
// says whether a test has evidence.
export function checkLinesWithoutEvidence(count, tagged, has) {
  const shown = (s) => `${s.file}:${s.line} "${s.titles[s.titles.length - 1] ?? ''}"`;
  const found = [];
  for (let n = 1; n <= count; n++) {
    const t = tagged.get(n);
    if (!t) continue;
    const running = t.tests.filter(s => !s.skipped);
    if (running.some(has)) continue;
    const more = (list) => (list.length > 1 ? ` (and ${list.length - 1} more tagged test(s))` : '');
    if (running.length) found.push({ n, byProof: true, why: `${shown(running[0])}${more(running)}: no run has seen it fail on the code as it is now` });
    else if (t.tests.length) found.push({ n, byProof: false, why: `${shown(t.tests[0])}${more(t.tests)} is skipped: it never runs` });
    else found.push({ n, byProof: false, why: `the tag at ${t.loose[0].file}:${t.loose[0].line} is on no test (a describe block, a helper or a loose comment): put [C${n}] in the title of the test that checks it, or in the comment right above that test` });
  }
  return found;
}

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
    for (const tag of l.text.matchAll(TAG)) for (const n of tag[1].match(/\d+/g)) seen.add(Number(n));
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
  // Each test file read once, for the three parts below: its text, its lines and its tests.
  const spans = new Map();
  const fileOf = (file) => {
    if (!spans.has(file)) { let text = ''; try { text = fs.readFileSync(path.join(top, file), 'utf8'); } catch { /* a deleted file */ } spans.set(file, { text, rows: text.split('\n'), list: testSpans(text, file) }); }
    return spans.get(file);
  };
  // The tests a caught break made fail on the code as it is now: asked once, and only when a part needs it.
  let provenNow;
  const proven = () => (provenNow ??= provenTests(top));
  if (nothing.length && !beforeProof) {
    for (const l of nothing) {
      const { text, list } = fileOf(l.file);
      const own = enclosingTest(list, l.line);
      if (provenHas(proven().get(l.file), own)) continue;
      // A line in a helper counts when a proven test of the file calls that helper (2026-11-17, audit).
      if (!own && helperCallers(text, list, l.line).some(c => provenHas(proven().get(l.file), c))) continue;
      unproven.push({ ...l, own });
    }
  }
  for (const f of unproven.slice(0, 8)) console.log(`UNPROVEN: ${f.file}:${f.line} — ${f.text.trim()} → ${proofHint(f.own)}`);
  if (unproven.length) {
    console.log(`  → ${unproven.length} new "nothing happens" check(s) whose own test no break run made fail on the code as it is now: run red-proof.mjs --breaks (a break of each such test's rule, naming that test) after the last edit`);
  }
  // Evidence (2026-11-19): every new test was seen failing on the old code, or a caught break names it, on the
  // code as it is now. Part of the proof part: --before-proof leaves it to the run after the proof.
  const fresh = newTests(top, base);
  const count = opt('--check') ? checkLines(fs.readFileSync(opt('--check'), 'utf8')).length : 0;
  const tagged = count ? taggedTests(lines, (file) => { const f = fileOf(file); return { rows: f.rows, spans: f.list }; }) : new Map();
  // One question to the proof record for every test asked about: the new tests and the tagged ones (a tag in a
  // new comment can sit on an older test, which then needs a caught break like any other).
  // 2026-11-19 (release fix list W2): the evidence rows are warnings unless --strict-evidence or
  // `git config sanad.strictEvidence true`: the proof starts to record "red on the old code" in this same release.
  // 2026-11-19 (fix list 3, Y2): only MISSING RUN EVIDENCE is a warning. A tag on no test or on skipped tests only
  // fails always. The tests-only skip is checked here: `git config sanad.testsOnlyLane` is true AND size-check
  // says the change is tests only. The flag --tests-only-lane alone skips nothing.
  // 2026-11-20 (fix list 5, V5): the default is turned around. The rows fail unless the owner steps back with
  // `git config sanad.strictEvidence false`. The flag --strict-evidence forces them to fail either way.
  const strict = argv.includes('--strict-evidence') || (git(top, ['config', '--get', 'sanad.strictEvidence']) || '').trim().toLowerCase() !== 'false';
  let skipEvidence = false;
  if ((git(top, ['config', '--get', 'sanad.testsOnlyLane']) || '').trim().toLowerCase() === 'true') {
    try { skipEvidence = sizeTask({ repo: top, base }).testsOnly === true; } catch { skipEvidence = false; }
  }
  if (skipEvidence) console.log('EVIDENCE SKIPPED: the change is tests only and sanad.testsOnlyLane is on, so new tests are not asked for proof evidence');
  const asked = beforeProof || skipEvidence ? [] : [...fresh, ...[...tagged.values()].flatMap(t => t.tests.filter(s => !s.skipped))];
  const evidence = asked.length ? evidenceOf(top, { base, tests: asked }) : [];
  const has = (test) => hasEvidence(evidence, test);
  const notProven = beforeProof || skipEvidence ? [] : fresh.filter(t => !has(t));
  for (const t of notProven.slice(0, 40)) console.log(`NOT PROVEN TEST: ${t.file}:${t.line} ${t.titles[t.titles.length - 1]}`);
  if (notProven.length > 40) console.log(`  → and ${notProven.length - 40} more new test(s) with no evidence`);
  // Tags: every check line has a tagged test, and one of its tagged tests has evidence.
  let missing = [];
  let noEvidence = [];
  if (opt('--check')) {
    const skips = new Map();
    const skipped = (l) => {
      if (!skips.has(l.file)) skips.set(l.file, skippedLines(fileOf(l.file).text, l.file));
      return skips.get(l.file).has(l.line);
    };
    missing = untagged(count, lines, skipped);
    for (const n of missing) console.log(`UNTAGGED: check line C${n} has no new test tagged [C${n}]`);
    // Before the proof a running tagged test is taken as it is: only what no proof can change is said now (a tag
    // on no test, a tag on skipped tests only), so a whole proof is not spent to learn it.
    noEvidence = checkLinesWithoutEvidence(count, tagged, beforeProof || skipEvidence ? () => true : has);
    for (const c of noEvidence) console.log(`NO EVIDENCE: C${c.n} — ${c.why}`);
  }
  // The two ways to give evidence, said once, and only when a proof run can still give it.
  const owed = noEvidence.filter(c => c.byProof).length;
  if (notProven.length || owed) {
    console.log(`  → ${notProven.length} new test(s) and ${owed} check line(s) with no evidence on the code as it is now. A test has evidence in two ways: it failed on the old code (red-proof.mjs --old <ref> --files <fix files>), or a caught break names it (red-proof.mjs --breaks, a mustFail part holds its title). Run the proof after the last edit`);
  }
  if (unproven.length || notProven.length || owed) for (const note of recordNotes(top)) console.log(`  → ${note}`);
  // A tag on no test or on skipped tests only can never get run evidence: it is an error, strict or not.
  const hardNo = noEvidence.filter(c => !c.byProof).length;
  const warned = notProven.length + (noEvidence.length - hardNo);
  if (warned && !strict) console.log('  → the missing-run-evidence rows (NOT PROVEN TEST, NO EVIDENCE) are warnings only because `git config sanad.strictEvidence false` is set: they do not fail this check');
  const nonNull = nonNullReads(lines);
  for (const f of nonNull.slice(0, 8)) console.log(`NON-NULL: ${f.file}:${f.line} — ${f.text.trim()} → read with ?. so a missing element fails as an assertion`);
  const problems = found.length + unproven.length + missing.length + nonNull.length + hardNo + (strict ? warned : 0);
  const shownProblems = problems || warned;
  const proofNote = (!nothing.length ? '' : beforeProof
    ? ` (${nothing.length} "nothing happens" check(s): proof judged after the proof run)`
    : ` (${nothing.length} "nothing happens" check(s) proven by a break run)`)
    + (!fresh.length ? '' : beforeProof
      ? ` (${fresh.length} new test(s): evidence judged after the proof run)`
      : ` (${fresh.length} new test(s) with evidence)`);
  console.log(shownProblems ? `TEST ASSERTS: ${found.length} range, ${unproven.length} unproven, ${missing.length} untagged, ${nonNull.length} non-null, ${notProven.length} not proven test(s), ${noEvidence.length} no evidence${problems ? '' : ' (warnings only)'}` : `TEST ASSERTS: none${proofNote}`);
  process.exitCode = problems ? 1 : 0;
}
