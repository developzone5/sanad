// proof-record.mjs — what red-proof.mjs proved, kept so pre-review can tell whether the current
// tests were ever seen failing under a break of the rule they test (2026-11-07: three rounds in a
// row, a "nothing happens" check passed review that no run had ever seen fail).
//
// One record file per repository, one entry per proof (2026-11-12): an entry is keyed by the proof's
// test command and folder, and a new proof adds or replaces only its own entry. Before, one record
// held every changed test file of both stacks and each proof overwrote it: a frontend break proof
// marked every backend "nothing happens" check proven (and the reverse), a single --break did the
// same, and a later --old-only run (no break) erased a proved record. Now an entry names only the
// test files that hold a test a caught break named (with their hashes), and the hashes of the files
// its breaks changed: when one of those changed since, the entry no longer counts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { TEST_FILE } from './check-ticket-lines.mjs';

export function proofDir() { return process.env.SANAD_STATE_DIR ? path.join(process.env.SANAD_STATE_DIR, 'proof') : path.join(os.homedir(), '.claude', 'state', 'proof'); }

function git(cwd, args) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

export function toplevelOf(dir) { return git(dir, ['rev-parse', '--show-toplevel']); }
export function defaultBase(top) { return 'origin/' + (git(top, ['config', '--get', 'sanad.integration']) || 'staging'); }

// Changed and new test files since the merge base with <base>, or null when there is none.
export function changedTestFiles(top, base) {
  const from = git(top, ['merge-base', base, 'HEAD']);
  if (!from) return null;
  const tracked = git(top, ['diff', '--name-only', '--diff-filter=d', from]).split(/\r?\n/);
  const untracked = git(top, ['ls-files', '--others', '--exclude-standard']).split(/\r?\n/);
  return [...new Set([...tracked, ...untracked].filter(f => f && TEST_FILE.test(f) && fs.existsSync(path.join(top, f))))].sort();
}

// Hashed with line endings made the same, so a rebase or checkout that rewrites LF as CRLF does not
// make a proven test look new (2026-11-08: after a rebase, pre-review called proven checks unproven).
// Product files (a break's target) are hashed the same way.
export function testFileHashes(top, files) {
  return Object.fromEntries(files.map(f => [f, crypto.createHash('sha256').update(fs.readFileSync(path.join(top, f), 'utf8').replace(/\r\n/g, '\n')).digest('hex')]));
}
function hashOrNull(top, file) {
  try { return testFileHashes(top, [file])[file]; } catch { return null; }
}

// One folder can have several spellings (a short 8.3 name such as RUNNER~1 on a CI machine, a link,
// another case): the writer and the reader must name it the same, so both ask git for the top level
// and the system for the real path (2026-11-07: CI saved a record under one name and read another).
export function canonicalTop(top) {
  let p = git(top, ['rev-parse', '--show-toplevel']) || path.resolve(top);
  try { p = fs.realpathSync.native(p); } catch { /* keep the git answer */ }
  return path.resolve(p).replace(/\\/g, '/').toLowerCase();
}
function recordPath(top) {
  return path.join(proofDir(), crypto.createHash('sha1').update(canonicalTop(top)).digest('hex').slice(0, 16) + '.json');
}

// The key of a proof's entry: its test command and the folder it ran in (relative to the repository).
export function recordKey(command, cwd = '') {
  return crypto.createHash('sha1').update(JSON.stringify([String(cwd).replace(/\\/g, '/'), ...command.map(String)])).digest('hex').slice(0, 16);
}

// The record: { top, entries: { <key>: { ok, breaks, files, targets, ... } } }. A file in the format
// before 2026-11-12 (one proof, no entries) reads as no entry: it may credit the other stack's tests.
export function readRecord(top) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(recordPath(top), 'utf8')); } catch { return null; }
  return raw && typeof raw.entries === 'object' && raw.entries ? raw : { top: raw?.top, entries: {} };
}

// Adds or replaces one proof's entry; every other entry stays. Two proofs that end at once (the
// server's and the page's) each read, merge and write under a short lock, so neither loses the other.
export function writeEntry(top, key, entry) {
  fs.mkdirSync(proofDir(), { recursive: true });
  const file = recordPath(top), lock = file + '.lock';
  const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  let locked = false;
  for (let i = 0; i < 200 && !locked; i++) {
    try { fs.mkdirSync(lock); locked = true; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // A lock left by a stopped writer (older than 30 s) is taken over.
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 30000) { fs.rmSync(lock, { recursive: true, force: true }); continue; } } catch { continue; }
      pause(25);
    }
  }
  try {
    const record = readRecord(top) || { entries: {} };
    record.top = path.resolve(top);
    record.entries[key] = { ...entry, at: new Date().toISOString() };
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(record, null, 2));
    try { fs.renameSync(temp, file); }
    catch { fs.writeFileSync(file, JSON.stringify(record, null, 2)); fs.rmSync(temp, { force: true }); }
  } finally {
    if (locked) fs.rmSync(lock, { recursive: true, force: true });
  }
}

// The test files a current entry proved: an entry counts when it caught at least one break and each
// file its breaks changed is as it was then; a test file counts when its hash is still the one proved.
export function provenTestFiles(top, record = readRecord(top)) {
  const proven = new Set();
  for (const entry of Object.values(record?.entries || {})) {
    if (!entry || !entry.ok || !(entry.breaks >= 1) || !entry.files || !entry.targets || !Object.keys(entry.targets).length) continue;
    if (!Object.entries(entry.targets).every(([f, h]) => hashOrNull(top, f) === h)) continue;
    for (const [f, h] of Object.entries(entry.files)) if (hashOrNull(top, f) === h) proven.add(f);
  }
  return proven;
}

// ---- Test titles and skipped tests (shared by red-proof.mjs and check-test-asserts.mjs) ----

// The index of the bracket that closes the one at text[open] ('(', '{' or '['), past strings and
// comments; -1 when there is none. A rough reader: enough for test files, not a parser.
export function closeOf(text, open) {
  const want = { '(': ')', '{': '}', '[': ']' };
  const stack = [];
  for (let i = open; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (c === '/' && n === '/') { const e = text.indexOf('\n', i); if (e < 0) return -1; i = e; continue; }
    if (c === '/' && n === '*') { const e = text.indexOf('*/', i + 2); if (e < 0) return -1; i = e + 1; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) { if (text[j] === '\\') j++; else if (c !== '`' && text[j] === '\n') break; j++; }
      i = j; continue;
    }
    if (want[c]) stack.push(want[c]);
    else if (c === ')' || c === '}' || c === ']') { if (stack.pop() !== c) return -1; if (!stack.length) return i; }
  }
  return -1;
}

const lineAt = (text, index) => text.slice(0, index).split('\n').length;
const isCs = (file) => /\.cs$/i.test(file);
const CS_METHOD = /\b(?:void|Task|ValueTask)(?:<[^>]*>)?\s+(\w+)\s*\(/g;

// The lines (1-based) that belong to a skipped test (2026-11-12: a [Cn] tag or a ticket quote on
// it.skip, it.todo, describe.skip, xit or [Fact(Skip = ...)] counted as a tested check line, though the
// test never runs): the skipped call or method, and the comment lines right above it.
export function skippedLines(text, file = '') {
  const src = String(text);
  const lines = src.split('\n');
  const skipped = new Set();
  const mark = (from, to) => {
    for (let l = from; l <= to; l++) skipped.add(l);
    // The comment (and, in C#, attribute) lines right above, where a test's tag often sits.
    for (let l = from - 1; l >= 1; l--) {
      const t = lines[l - 1].trim();
      if (/^(?:\/\/|\/\*|\*)/.test(t) || (isCs(file) && /^\[/.test(t))) skipped.add(l); else break;
    }
  };
  if (isCs(file)) {
    for (const m of src.matchAll(/\[\s*(?:Fact|Theory)\b/g)) {
      const end = closeOf(src, m.index);
      if (end < 0 || !/\bSkip\s*=/.test(src.slice(m.index, end))) continue;
      CS_METHOD.lastIndex = end;
      const method = CS_METHOD.exec(src);
      let last = end;
      if (method) {
        const params = closeOf(src, method.index + method[0].length - 1);
        const body = params < 0 ? -1 : src.slice(params).search(/[{;]|=>/);
        if (body >= 0) {
          const at = params + body;
          last = src[at] === '{' ? closeOf(src, at) : src.indexOf(';', at);
          if (last < 0) last = method.index;
        }
      }
      mark(lineAt(src, m.index), lineAt(src, last));
    }
    return skipped;
  }
  for (const m of src.matchAll(/(?<![\w$.])(?:(?:describe|it|test|suite)\.(?:skip|todo)\b|x(?:describe|it|test)\b)/g)) {
    const open = src.indexOf('(', m.index + m[0].length);
    if (open < 0 || src.slice(m.index + m[0].length, open).trim()) continue;
    const end = closeOf(src, open);
    mark(lineAt(src, m.index), lineAt(src, end < 0 ? open : end));
  }
  return skipped;
}

// The tests a test file declares, each with its own titles: a vitest/jest it() or test() title, or a C#
// [Fact]/[Theory] method name and its DisplayName. Skipped tests are left out (they never fail), and so
// are .each tables (their titles are filled in at run time).
export function declaredTests(text, file = '') {
  const src = String(text);
  const skip = skippedLines(src, file);
  const tests = [];
  if (isCs(file)) {
    for (const m of src.matchAll(/\[\s*(?:Fact|Theory)\b/g)) {
      const end = closeOf(src, m.index);
      if (end < 0) continue;
      const attr = src.slice(m.index, end + 1);
      if (/\bSkip\s*=/.test(attr) || skip.has(lineAt(src, m.index))) continue;
      CS_METHOD.lastIndex = end;
      const method = CS_METHOD.exec(src);
      if (!method) continue;
      const display = /DisplayName\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(attr);
      tests.push({ line: lineAt(src, m.index), titles: [method[1], ...(display ? [display[1].replace(/\\(.)/g, '$1')] : [])] });
    }
    return tests;
  }
  for (const m of src.matchAll(/(?<![\w$.])(x?)(?:it|test)((?:\.(?:only|concurrent|sequential|fails|skip|todo))*)\s*\(\s*(['"`])((?:\\.|(?!\3)[^\\])*)\3/g)) {
    const line = lineAt(src, m.index);
    if (m[1] || /skip|todo/.test(m[2]) || skip.has(line)) continue;
    tests.push({ line, titles: [m[4].replace(/\\(.)/g, '$1')] });
  }
  return tests;
}
