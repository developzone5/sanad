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
//
// 2026-11-17 (audit: "one caught test certifies another rule's vacuous negative check" and "stale mutation
// proof survives dependency edits and even a failed re-proof"): an entry also names the TESTS its breaks made
// fail (`caught`: per test file, each test's line and title, and the full name the runner printed), and one id
// of the code under test (`code`: the working tree as git sees it, prose left out). A "nothing happens" check
// counts only when the test that holds its line is one of those tests, and only while today's code id is the
// entry's. A proof that starts and does not end PROVED leaves its entry as { ok: false, reason }, so an older
// success never outlives a newer failure. An entry in the format before (no `caught`, no `code`) proves nothing.
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

// The code under test as one id (2026-11-17, audit "stale mutation proof survives dependency edits"): an entry
// was accepted while its break targets and its test files were unchanged, so an edit to any other code a test
// depends on left the old proof valid. The id is the tree of the working folder as git sees it: HEAD's files plus
// every uncommitted and untracked (not ignored) change, with prose (*.md, in any case) left out; a .txt may be data the product reads, so it counts. So a
// commit of the same files, a reworded commit and a prose edit keep it; any other edit changes it. Built through
// a copy of the index, the way pre-review-cache.mjs builds its tree, so the real index is never touched.
// '' when git cannot say (no repository, a failed add or write-tree): nothing is recorded or proven then.
export function codeFingerprint(top) {
  let dir = '';
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanad-proof-index-'));
    const index = path.join(dir, 'index');
    const run = (args) => execFileSync('git', args, { cwd: top, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_INDEX_FILE: index } }).trim();
    const real = git(top, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    if (real && fs.existsSync(real)) fs.copyFileSync(real, index); else run(['read-tree', 'HEAD']);
    run(['add', '--all']);
    run(['rm', '--cached', '-r', '-q', '-f', '--ignore-unmatch', '--', ':(icase)*.md']);
    const tree = run(['write-tree']);
    return /^[0-9a-f]{40,64}$/.test(tree) ? tree : '';
  } catch { return ''; }
  finally { try { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } }
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

// The record: { top, entries: { <key>: { ok, breaks, files, targets, caught, code, ... } } }, or for a proof
// that did not end PROVED { ok: false, reason, ... } (2026-11-17). A file in the format
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

// The tests a current entry proved, by test file: Map { <test file> → [{ line, title, ... }] }. An entry counts
// when it caught at least one break and each file its breaks changed is as it was then; a test file counts when
// its hash is still the one proved. 2026-11-17 (audit): the entry must also name the tests its breaks made fail
// (a whole file is no longer proven by one caught test in it), and today's code id must be the one it holds (an
// edit to code outside the break targets left the proof valid). The id is asked of git once, and only when an
// entry gets that far.
export function provenTests(top, record = readRecord(top)) {
  const proven = new Map();
  let today;
  for (const entry of Object.values(record?.entries || {})) {
    if (!entry || !entry.ok || !(entry.breaks >= 1) || !entry.files || !entry.targets || !Object.keys(entry.targets).length) continue;
    if (!entry.code || !entry.caught || typeof entry.caught !== 'object') continue;
    if (!Object.entries(entry.targets).every(([f, h]) => hashOrNull(top, f) === h)) continue;
    if (today === undefined) today = codeFingerprint(top);
    if (!today || entry.code !== today) continue;
    for (const [f, h] of Object.entries(entry.files)) {
      if (hashOrNull(top, f) !== h) continue;
      const tests = (Array.isArray(entry.caught[f]) ? entry.caught[f] : []).filter(t => t && Number.isInteger(t.line) && typeof t.title === 'string');
      if (tests.length) proven.set(f, [...(proven.get(f) || []), ...tests]);
    }
  }
  return proven;
}
// The test files that hold a test a current entry proved.
export function provenTestFiles(top, record = readRecord(top)) {
  return new Set(provenTests(top, record).keys());
}
// Whether the tests proved for a file (a provenTests value) hold this test (a testSpans item): the same line and
// title. The file's hash is the one proved, so its lines are where they were.
export function provenHas(tests, own) {
  return Boolean(own) && (tests || []).some(t => t.line === own.line && own.titles.includes(t.title));
}

// Why "nothing happens" checks read unproven although a proof ran (2026-11-17): one line per reason, for the
// test check's summary. An entry whose code id is not today's: the code changed after the proof. An entry that
// is not ok: the last run of that proof did not end PROVED.
export function recordNotes(top, record = readRecord(top)) {
  const entries = Object.values(record?.entries || {}).filter(Boolean);
  const notes = [];
  const failed = entries.filter(e => e.ok === false);
  for (const e of failed.slice(0, 3)) notes.push(`the last run of the proof \`${(e.command || []).join(' ').slice(0, 80)}\` did not end PROVED (${String(e.reason || 'no reason kept').slice(0, 160)})`);
  const kept = entries.filter(e => e.ok && e.code);
  if (kept.length) {
    const today = codeFingerprint(top);
    if (kept.some(e => e.code !== today)) notes.push('the code changed after a proof ran (any edit but *.md voids it): run that proof again');
  }
  if (entries.some(e => e.ok && !e.code)) notes.push('a proof record written before 2026-11-17 names no test: run that proof again');
  return notes;
}

// ---- Test titles and skipped tests (shared by red-proof.mjs and check-test-asserts.mjs) ----

// The index of the bracket that closes the one at text[open] ('(', '{' or '['), past strings and
// comments; -1 when there is none. A rough reader: enough for test files, not a parser.
function regexAllowedAt(text, i) {
  let k = i - 1;
  while (k >= 0 && (text[k] === ' ' || text[k] === '\t')) k--;
  return k < 0 || text[k] === '\n' || '(,=:!&|?{;['.includes(text[k]) || (text[k] === '>' && text[k - 1] === '=');
}
export function closeOf(text, open) {
  const want = { '(': ')', '{': '}', '[': ']' };
  const stack = [];
  for (let i = open; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (c === '/' && n === '/') { const e = text.indexOf('\n', i); if (e < 0) return -1; i = e; continue; }
    if (c === '/' && n === '*') { const e = text.indexOf('*/', i + 2); if (e < 0) return -1; i = e + 1; continue; }
    // A regex literal (a `/` right after `(`, `,`, `=`, `:`, `!`, `&`, `|`, `?`, `{`, `;`, `[` or a line start, closed on
    // the same line): its quotes and brackets are not the file's (2026-11-17, audit: a CSS-rule regex lost its test).
    if (c === '/' && regexAllowedAt(text, i)) {
      let j = i + 1, cls = false, closed = false;
      for (; j < text.length && text[j] !== '\n'; j++) {
        if (text[j] === '\\') j++;
        else if (text[j] === '[') cls = true;
        else if (text[j] === ']') cls = false;
        else if (text[j] === '/' && !cls) { closed = true; break; }
      }
      if (closed) { i = j; continue; }
    }
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

// ---- The test that holds a line (2026-11-17, audit "one caught test certifies another rule's vacuous negative
// check") ----

// Every test a test file declares, with the lines it spans: { file, line, end, titles, skipped }. `line` and
// `titles` are as declaredTests gives them (a C# test starts at its [Fact]/[Theory] attribute; its titles are
// the method and its DisplayName). Unlike declaredTests, a .each/.for table test is here too (its title keeps its
// placeholders, which a row's printed name fills in), and so is a skipped test, marked: a check line needs its
// test even when no break can make that test fail. A test with no title written as text has no titles.
export function testSpans(text, file = '') {
  const src = String(text);
  const skip = skippedLines(src, file);
  const spans = [];
  if (isCs(file)) {
    for (const m of src.matchAll(/\[\s*(?:Fact|Theory)\b/g)) {
      const end = closeOf(src, m.index);
      if (end < 0) continue;
      const attr = src.slice(m.index, end + 1);
      CS_METHOD.lastIndex = end;
      const method = CS_METHOD.exec(src);
      if (!method) continue;
      // The method's body: its block, or an expression body up to its `;` (as skippedLines reads it).
      const params = closeOf(src, method.index + method[0].length - 1);
      const body = params < 0 ? -1 : src.slice(params).search(/[{;]|=>/);
      if (body < 0) continue;
      const at = params + body;
      const last = src[at] === '{' ? closeOf(src, at) : src.indexOf(';', at);
      if (last < 0) continue;
      const display = /DisplayName\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(attr);
      const line = lineAt(src, m.index);
      // The class that holds the method: the last `class X` above it (caughtTests matches a printed class to it).
      const klass = [...src.slice(0, m.index).matchAll(/\bclass\s+(\w+)/g)].pop()?.[1];
      spans.push({ file, line, end: lineAt(src, last), titles: [method[1], ...(display ? [display[1].replace(/\\(.)/g, '$1')] : [])],
        skipped: /\bSkip\s*=/.test(attr) || skip.has(line), ...(klass ? { klass } : {}) });
    }
    return spans;
  }
  for (const m of src.matchAll(/(?<![\w$.])(x?)(?:it|test)((?:\.(?:only|concurrent|sequential|fails|skip|todo|each|for|skipIf|runIf))*)\s*(?=[(`])/g)) {
    let at = m.index + m[0].length;
    // it.each(table)(title, fn), it.each`table`(title, fn), it.skipIf(when)(title, fn): the first bracket is not the test's.
    if (/\.(?:each|for|skipIf|runIf)$/.test(m[2])) {
      const close = src[at] === '`' ? src.indexOf('`', at + 1) : closeOf(src, at);
      if (close < 0) continue;
      at = close + 1;
      while (/\s/.test(src[at] || '')) at++;
    }
    if (src[at] !== '(') continue;
    let close = closeOf(src, at);
    // The reader lost the call's end (a quote or a bracket it misread): the test ends where the next one starts, or
    // at the end of the file, so its lines still have a test (2026-11-17, audit: such a test was dropped and every
    // check in it refused).
    if (close < 0) {
      const next = /(?<![\w$.])x?(?:it|test)(?:\.\w+)*\s*[(`]/g;
      next.lastIndex = at + 1;
      const n = next.exec(src);
      close = n ? n.index - 1 : src.length - 1;
    }
    const title = /^\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/.exec(src.slice(at + 1, close));
    const line = lineAt(src, m.index);
    spans.push({ file, line, end: Math.max(line, lineAt(src, close)), titles: title ? [title[2].replace(/\\(.)/g, '$1')] : [],
      skipped: Boolean(m[1]) || /\.(?:skip|todo)(?![A-Za-z])/.test(m[2]) || skip.has(line) });
  }
  return spans;
}

// The test that holds a line (1-based): the innermost span around it, or null when the line is in no test (a
// helper, a hook, the top of the file).
export function enclosingTest(spans, line) {
  let own = null;
  for (const s of spans) if (s.line <= line && line <= s.end && (!own || s.line >= own.line)) own = s;
  return own;
}

// The tests that call the helper a line is in (2026-11-17, audit: a check in an arrange/assert helper sat in no
// test and could never be proven). The helper is the nearest function declaration that encloses the line (a hook,
// a describe or a test on the way up means no helper); a test calls it when its name appears in the test's lines
// as a call. Skipped tests are left out. [] when the line is in no helper or no test calls it.
const NOT_A_METHOD = /^(?:if|for|foreach|while|switch|using|lock|catch|return|new|await|else|do|throw|var)$/;
export function helperCallers(text, spans, line) {
  const rows = String(text).split('\n');
  const indent = (s) => /^\s*/.exec(s)[0].replace(/\t/g, '    ').length;
  let cur = indent(rows[line - 1] || '');
  let name = null;
  for (let i = line - 2; i >= 0 && !name; i--) {
    const r = rows[i];
    if (!r.trim() || indent(r) >= cur) continue;
    if (/^\s*(?:beforeEach|afterEach|beforeAll|afterAll|describe|it|test|suite)\b/.test(r)) return [];
    const js = /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*(\w+)/.exec(r)
      || /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|\w+\s*=>)/.exec(r);
    const cs = /^\s*(?:(?:public|private|protected|internal|static|async|override|virtual|sealed)\s+)*[\w<>\[\],.?]+(?:<[^>]*>)?\s+(\w+)\s*\(/.exec(r);
    const found = (js || cs || [])[1];
    if (found && !NOT_A_METHOD.test(found)) name = found; else cur = indent(r);
  }
  if (!name) return [];
  const call = new RegExp('\\b' + name.replace(/[$]/g, '\\$') + '\\s*(?:<[^>()]*>)?\\s*\\(');
  return spans.filter(s => !s.skipped && call.test(rows.slice(s.line - 1, s.end).join('\n')));
}

// Whether a mustFail part names a test: the part, in lower case, inside one of the test's titles, as red-proof's
// survivors() matches a part to the declared tests. A skipped test is never named: it cannot fail.
export function namedBy(parts, own) {
  return Boolean(own) && !own.skipped && own.titles.some(t => parts.some(p => String(t).toLowerCase().includes(String(p).toLowerCase())));
}

// What to tell the author of an unproven "nothing happens" check: the test that holds the line, and the mustFail
// name that would prove it. `own` is that test (a testSpans item) or null.
export function proofHint(own) {
  if (!own || !own.titles.length) return 'the test that holds this line cannot be worked out (it is in no it()/test() call or [Fact]/[Theory] method with a written title), so no break can prove it: move the check into its test';
  const names = own.titles.map(t => `"${t}"`).join(' / ');
  if (own.skipped) return `test ${names} is skipped: it never runs, so no break can make it fail`;
  return `its test ${names} is named by no caught break: a break of that test's rule whose mustFail names it (${JSON.stringify(own.titles[0])}) would prove it`;
}
