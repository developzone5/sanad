#!/usr/bin/env node
// check-ticket-lines.mjs — every verbatim ticket line has a test that quotes it.
//
// Sanad's rule (loop.md "Ticket words → tests"): every requirement line of the ticket is copied
// verbatim into Done means, each with the test that proves it. Seen 2026-11-05: the line
// "selecting it again clears it" was lost when the ticket was summarized, and QA found the bug.
// This check makes the link mechanical: the test that proves a line quotes it, in its name or in
// a comment just above it.
//
// Usage: node check-ticket-lines.mjs --lines <file> --repo <path> [--base <ref>]
//   <file>   one ticket line per line, copied verbatim from the ticket. Blank lines and lines that
//            start with # are skipped; a leading list marker (-, *, •, 1.) is dropped; "T1. text"
//            reads as "T1: text".
//   --repo   the repository whose test files are searched (tracked and untracked, not ignored).
//   --base   optional: only a test file changed or new since <base>...HEAD (or in the work tree) covers
//            a line; a line quoted only in an unchanged test fails and names it.
// A line is covered when a test file quotes it — the whole line, or each of its sentences — in a
// test name or in a comment that ends at most 12 lines above a test declaration. Quotes, case,
// comment markers and line breaks do not matter.
// Exit 0: every line is covered. 1: a line has no test. 2: usage error.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isMain } from './is-main.mjs';

export const TEST_FILE = /(?:[._](?:test|spec)\.[cm]?[jt]sx?$|Tests?\.cs$|(?:^|\/)[\w-]*\.Tests?\/.+\.cs$|(?:^|\/)tests?\/.+\.(?:[cm]?[jt]sx?|cs|py|go)$|_test\.(?:go|py)$|(?:^|\/)test_[^/]*\.py$)/i;
export const TEST_DECL = /(?:^|[^\w.])(?:it|test|describe)(?:\.\w+)*\s*\(|\[(?:Fact|Theory)\b|\bdef test_|\bfunc Test|@Test\b/;
// A test that never runs: a quote above it proves nothing (2026-11-12, audit C10).
const SKIPPED_DECL = /(?:^|[^\w.])(?:it|test|describe)\.(?:skip|todo)\b|(?:^|[^\w.])x(?:it|describe|test)\s*\(|\[(?:Fact|Theory)\s*\([^\]]*\bSkip\s*=/;
const COMMENT_MARK = /^\s*(?:\/\/+|\/\*+|\*+\/?|#+|<!--)\s?/;
const WINDOW = 12;

export function normalize(text) {
  return String(text).toLowerCase().replace(/[«»“”"'‘’`]/g, '').replace(/\s+/g, ' ').trim();
}

// A ticket line's sentences, each without its final stop, so "clears it." matches "clears it".
export function sentences(line) {
  return normalize(line).split(/(?<=[.!?؟])\s+/).map(s => s.replace(/[.!?؟:;,]+$/, '').trim()).filter(s => s.split(' ').length >= 3);
}

// 2026-11-12 (audit C21): a lines file written as "T1. text" kept "T1." in the line, so a test quoting
// only the words never matched. It reads as "T1: text".
export function readLines(text) {
  return String(text).split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    .map(l => l.replace(/^(?:[-*•]|\d+[.)])\s+/, '').replace(/^["“«]+|["”»]+$/g, '').replace(/^(T\d+)\.\s+/i, '$1: ').trim()).filter(Boolean);
}

// One file as a single normalized string, with each source line's start offset in it.
export function flatten(source) {
  const raw = String(source).split(/\r?\n/);
  const starts = []; let flat = '';
  for (const line of raw) {
    const text = normalize(line.replace(COMMENT_MARK, ''));
    starts.push(flat.length + (flat ? 1 : 0));
    flat += (flat ? ' ' : '') + text;
  }
  return { raw, starts, flat };
}

function lineAt(starts, offset) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
  return lo;
}

// The 1-based line of a quote of `needle` that sits on or above a test declaration, or 0.
// 2026-11-12 (audit C21): the 12 lines are counted from the quote's LAST line; counted from its first,
// a long quote wrapped over many comment lines never reached its test.
export function findQuote(file, needle) {
  if (!needle) return 0;
  for (let at = file.flat.indexOf(needle); at !== -1; at = file.flat.indexOf(needle, at + 1)) {
    const first = lineAt(file.starts, at);
    const last = Math.min(file.raw.length - 1, lineAt(file.starts, at + needle.length - 1) + WINDOW);
    // The first test declaration at or under the quote decides: a skipped one does not count.
    for (let i = first; i <= last; i++) {
      if (SKIPPED_DECL.test(file.raw[i])) break;
      if (TEST_DECL.test(file.raw[i])) return first + 1;
    }
  }
  return 0;
}

export function cover(line, files) {
  // The line as written ("T6: The options …"), or without its number (a test quoting only the text, 2026-11-09).
  const wholes = [...new Set([line, String(line).replace(/^\s*T\d+\s*[:.]\s*/i, '')])].map(l => normalize(l).replace(/[.!?؟:;,]+$/, ''));
  for (const whole of wholes) {
    for (const f of files) { const at = findQuote(f, whole); if (at) return [{ file: f.name, line: at, changed: f.changed }]; }
  }
  const parts = sentences(line);
  if (parts.length < 2) return null;
  const hits = [];
  for (const part of parts) {
    const hit = files.map(f => ({ f, at: findQuote(f, part) })).find(h => h.at);
    if (!hit) return null;
    hits.push({ file: hit.f.name, line: hit.at, changed: hit.f.changed });
  }
  return hits;
}

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
}

export function testFiles(repo, base) {
  const names = git(repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(n => n && TEST_FILE.test(n));
  let changed = null;
  if (base) {
    changed = new Set([...git(repo, ['diff', '--name-only', '-z', base + '...HEAD']).split('\0'), ...git(repo, ['diff', '--name-only', '-z', 'HEAD']).split('\0'),
      ...git(repo, ['ls-files', '-z', '--others', '--exclude-standard']).split('\0')].filter(Boolean));
  }
  const out = [];
  for (const name of [...new Set(names)]) {
    let text;
    try { text = fs.readFileSync(path.join(repo, name), 'utf8'); } catch { continue; } // deleted in the work tree
    out.push({ name, changed: changed ? changed.has(name) : null, ...flatten(text) });
  }
  // Changed files first, so a line quoted in both is credited to the PR's own test.
  return out.sort((a, b) => Number(b.changed === true) - Number(a.changed === true));
}

// 2026-11-12 (audit C11): with a base, only a test file the branch changed or added covers a line. An
// old test of an earlier ticket that happens to quote it proves nothing about this change: the line
// fails and names that test, so the author writes the new test or shows why the old one is enough.
export function report(lines, files) {
  const withBase = files.some(f => f.changed !== null);
  const fresh = withBase ? files.filter(f => f.changed) : files;
  const rows = lines.map((line, i) => {
    const hits = cover(line, fresh);
    return { n: i + 1, line, hits, older: !hits && withBase ? cover(line, files) : null };
  });
  const covered = rows.filter(r => r.hits).length;
  const out = [`TICKET LINES: ${covered} of ${rows.length} covered`];
  for (const r of rows) {
    const shown = r.line.length > 110 ? r.line.slice(0, 107) + '…' : r.line;
    if (!r.hits && r.older) {
      const where = r.older.filter(h => !h.changed).map(h => `${h.file}:${h.line}`).join(', ');
      out.push(`  ✗ L${r.n} "${shown}" — quoted only in an older test (unchanged): ${where}`);
      continue;
    }
    if (!r.hits) { out.push(`  ✗ L${r.n} "${shown}" — no test quotes it (in its name or a comment above it)`); continue; }
    const where = r.hits.map(h => `${h.file}:${h.line}${h.changed ? ' (changed)' : ''}`).join(', ');
    out.push(`  ✓ L${r.n} "${shown}" → ${where}`);
  }
  return { text: out.join('\n'), missing: rows.length - covered };
}

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!['--lines', '--repo', '--base'].includes(k) || argv[i + 1] === undefined) throw new Error('Unknown or empty option: ' + k);
    o[k.slice(2)] = argv[++i];
  }
  if (!o.lines || !o.repo) throw new Error('--lines and --repo are required.');
  return o;
}

if (isMain(import.meta.url)) {
  try {
    const o = args(process.argv.slice(2));
    const lines = readLines(fs.readFileSync(o.lines, 'utf8'));
    if (!lines.length) throw new Error('The lines file holds no ticket line.');
    const { text, missing } = report(lines, testFiles(path.resolve(o.repo), o.base));
    process.stdout.write(text + '\n');
    process.exitCode = missing ? 1 : 0;
  } catch (error) {
    process.stderr.write('TICKET LINES: ' + error.message + '\nUsage: node check-ticket-lines.mjs --lines <file> --repo <path> [--base <ref>]\n');
    process.exitCode = 2;
  }
}
