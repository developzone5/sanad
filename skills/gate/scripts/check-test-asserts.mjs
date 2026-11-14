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
//          `red-proof.mjs --breaks` run that named a test in the check's own test file, with that
//          file and the broken product files as they are now: three rounds in a row such a check
//          passed review that no run had ever seen fail.
//   tags   with --check <file>, every check line Cn (numbered in order, as review-brief.mjs prints
//          them) has a test that carries `[Cn]` in its name or a comment; not a skipped one.
//
// Usage: node check-test-asserts.mjs --repo <path> [--base <ref>] [--check <file>] [--before-proof]
//   --before-proof: skip the proof part (pre-review.mjs --before-proof, run before red-proof.mjs).
// Exit 0: all clear. 1: found (each printed). 2: usage error.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { TEST_FILE } from './check-ticket-lines.mjs';
import { provenTestFiles, skippedLines } from './proof-record.mjs';
import { checkLines } from './review-brief.mjs';
import { isMain } from './is-main.mjs';

// FluentAssertions forms too (2026-11-12: the backend asserts with .Should(); 36 of its range checks
// were never flagged).
const RANGE = /\.(?:toBeLessThan|toBeLessThanOrEqual|toBeGreaterThan|toBeGreaterThanOrEqual)\s*\(|\bAssert\.InRange\s*\(|\bShould\(\)[^;]*?\.(?:Be(?:Greater|Less)Than(?:OrEqualTo)?|Be(?:Greater|Less)OrEqualTo|BeInRange)\s*\(/;
const REASON = /(?:\/\/|#)\s*range:\s*\S/;
// "Nothing happens" checks: a call that did not happen, an element or value that is absent, zero.
const NOTHING = /\.not\.toHaveBeenCalled|\.toHaveBeenCalledTimes\(\s*0\s*\)|\.not\.toBeInTheDocument\(|\.toBeNull\(\)|\.toBeUndefined\(\)|\.toHaveLength\(\s*0\s*\)|\.toBe\(\s*0\s*\)|\.toEqual\(\s*\[\s*\]\s*\)|\bTimes\.Never\b|\bAssert\.(?:Null|Empty)\s*\(|\.Should\(\)\.(?:BeNull|BeEmpty|BeFalse|NotContain)\s*\(|\.Should\(\)\.(?:Be|HaveCount)\(\s*0[mMdDfFlLuU]?\s*\)|\.DidNotReceive\(/;

export function nothingChecks(lines) {
  return lines.filter(l => TEST_FILE.test(l.file) && NOTHING.test(l.text));
}

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

// Added lines of a unified diff with -U0, as { file, line, text }.
export function addedLines(diff) {
  const found = [];
  let file = null, line = 0;
  for (const raw of String(diff).split(/\r?\n/)) {
    if (raw.startsWith('+++ ')) { file = raw === '+++ /dev/null' ? null : raw.slice(4).replace(/^b\//, ''); continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (file && raw.startsWith('+')) { found.push({ file, line, text: raw.slice(1) }); line++; }
  }
  return found;
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
  const from = (git(top, ['merge-base', base, 'HEAD']) || '').trim();
  if (!from) { console.error('check-test-asserts: no merge base with ' + base); process.exit(2); }
  const lines = addedLines(git(top, ['diff', '-U0', '--no-color', '--no-ext-diff', from]) || '');
  for (const f of (git(top, ['ls-files', '--others', '--exclude-standard']) || '').split(/\r?\n/).filter(Boolean)) {
    if (!TEST_FILE.test(f)) continue;
    fs.readFileSync(path.join(top, f), 'utf8').split(/\r?\n/).forEach((text, i) => lines.push({ file: f, line: i + 1, text }));
  }
  const found = rangeAsserts(lines);
  for (const f of found) console.log(`RANGE ASSERT: ${f.file}:${f.line} — ${f.text.trim()} → assert the exact value, or say why on the line: // range: <why>`);
  // Proof: a new "nothing happens" check needs a passing break run that named a test in its own file,
  // with that file as it is now (2026-11-12: one proof of the page cleared every server check too).
  const nothing = nothingChecks(lines);
  let unproven = [];
  // --before-proof (2026-11-13): the cheap checks run before the proof, so a label or quote fixed in a test
  // file does not void a proof already run. The proof part is judged by the run after the proof.
  const beforeProof = argv.includes('--before-proof');
  if (nothing.length && !beforeProof) {
    const proven = provenTestFiles(top);
    unproven = nothing.filter(l => !proven.has(l.file));
  }
  for (const f of unproven.slice(0, 8)) console.log(`UNPROVEN: ${f.file}:${f.line} — ${f.text.trim()}`);
  if (unproven.length) console.log(`  → ${unproven.length} new "nothing happens" check(s) never seen failing on these test files: run red-proof.mjs --breaks (a break of the rule under test) after the last test edit`);
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
