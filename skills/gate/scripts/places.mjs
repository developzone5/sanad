#!/usr/bin/env node
// places.mjs — every place that uses what a change touches, found by search, each with an outcome.
//
// 2026-11-12: Sanad's rule 1 ("before code, list every place that uses the rule or data you change, by
// search") was text, and it was skipped. A date rule was fixed on the "schedule" path and missed on the
// "publish now" path; a teammate found it. The list is now made by this script, and pre-review.mjs and
// review-brief.mjs refuse to go on while a place on it has no outcome.
//
//   node places.mjs --repo <path> --names <n1,n2,...> --out <places.md>
//       Searches the repository for whole-word uses of each name (a function, a rule or helper name, a
//       constant, an error code, a text key, a field) in tracked and untracked, not ignored, text files.
//       One PLACE per (name, product file, function): `P<n> · <name> · <file> · <function> · lines 12, 40 →
//       <outcome>`. In C#, JS and TS files the function is the one each hit sits in (or defines), named as
//       size-check.mjs names it; a hit outside any function, and every hit in another kind of file (locale
//       data, JSON, Markdown, CSS, SQL), belongs to the file's own place, `(file)`. Test files are listed
//       apart under each name, with no outcome. Run again on an existing list: every place keeps its number
//       and outcome, a place found now gets the next number and `(new)`, a place no longer found gets
//       `(gone)`, and line numbers are refreshed. The names add to the stored ones.
//       2026-11-12: one place per FILE let one outcome close all four calls of a rule in one service file,
//       the same shape as the original miss (the schedule path and the publish-now path of one file). A line
//       in the older shape (no function part) reads as its file's `(file)` place.
//       2026-11-17 (audit, "distinct methods collapse into a single place"): one place per function NAME let
//       one outcome close Schedule.Apply() and PublishNow.Apply() of one file, and two overloads. A place is
//       one DECLARATION now. A name its file declares once reads as before. Declared more than once, each
//       declaration is `<scope>.<function>` (the scope: the function it sits in or, outside any function, its
//       type), with its parameter list after it when another declaration has the same scope (overloads):
//       `Rules.Apply(int id)`; `(line N)` follows only when two have the same parameter list too. A line
//       label is never followed to another line: a place with one is kept only while nothing moved. A place of an older list keeps its number and outcome while it
//       is still exactly one declaration; when it was two, it is `(gone)` with its outcome left on its line,
//       both declarations are new and open, and each OPEN line says so.
//   node places.mjs --refresh <places.md> [--repo <path>]
//       The stored search again, in the stored repo (or in --repo: a task's worktree of it), as above.
//   node places.mjs --check <places.md> [--check-lines <check.md>]
//       Every place that is not gone needs `C<n>` (a check line covers it; with --check-lines, n is one of
//       its lines, numbered as review-brief.mjs numbers them) or `none: <reason>` (at least 12 characters:
//       why the place needs no change and no test). Prints `OPEN: P3 · <name> · <file> · <function>` per open place and
//       `PLACES: <k> place(s), <m> open`. --refresh and --check may be given together: refresh, then check.
//   node places.mjs --close <places.md> --set "<which>=<outcome>" [--set ...]
//       Writes one outcome on many places at once (2026-11-13: 14 places in other components took a hand-made
//       script). <which>: `P3,P7` (those places; an outcome already written is replaced), `file:<path>` (every
//       place in that file; `*` matches within a folder, `**` across folders) or `name:<name>` (every place of
//       that name); file: and name: fill only places with no outcome yet. <outcome> is `C<n>[, C<m>]` or
//       `none: <reason>`, checked as --check checks it. Prints how many places each --set closed; a --set that
//       matches no place is a usage error (a typo would otherwise close nothing without a word).
// Exit 0: written, or no open place. 1: an open place. 2: usage error, a missing file, a name too wide
// (more than 40 product files) or with no hit at all.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { TEST_FILE } from './check-ticket-lines.mjs';
import { enclosingFunction, codeOnly } from './size-check.mjs';
import { isMain } from './is-main.mjs';

// More product files than this and nobody can judge each one (2026-11-12): name the rule, not the word.
export const MAX_FILES = 40;
const MIN_REASON = 12;
const SHOWN_LINES = 12;
// The files whose functions can be named (size-check.mjs reads C-style code); any other file is one place.
const NAMED_FUNCTIONS = /\.(?:cs|[cm]?[jt]sx?)$/i;
export const FILE_PART = '(file)';

class UsageError extends Error {}
const usage = (message) => new UsageError(message);

function toplevel(dir) {
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

// One folder can have two names (a junction, or Windows' short RUNNER~1 spelling of CI's temp folder),
// so files are compared by their real path (2026-11-13: the same trap broke Sanad's CI in PR #43).
const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
const same = (a, b) => real(a).toLowerCase() === real(b).toLowerCase();

// One name's whole-word uses: product files with their line numbers, and test files. `skip` is a file the
// search never counts (the list itself, when it sits inside the repository).
export function searchName(repo, name, { skip = '' } = {}) {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', 'grep', '-n', '-w', '-I', '-F', '--untracked', '-z', '-e', name],
    { cwd: repo, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw usage(`git grep failed in ${repo}: ${r.error.message}`);
  // git grep exits 1 when nothing matches; 2 or more is a real error.
  if (r.status !== 0 && r.status !== 1) throw usage(`git grep failed in ${repo}: ${String(r.stderr).trim() || 'exit ' + r.status}`);
  const product = new Map(), tests = new Set();
  for (const row of String(r.stdout).split('\n')) {
    const a = row.indexOf('\0'), b = a < 0 ? -1 : row.indexOf('\0', a + 1);
    if (b < 0) continue;
    const file = row.slice(0, a), line = Number(row.slice(a + 1, b));
    if (skip && same(path.join(repo, file), skip)) continue;
    if (TEST_FILE.test(file)) { tests.add(file); continue; }
    if (!product.has(file)) product.set(file, []);
    product.get(file).push(line);
  }
  return { product, tests: [...tests].sort() };
}

// 2026-11-17 (audit, "distinct methods collapse into a single place"): hits were grouped by the bare name
// size-check.mjs gives, so Schedule.Apply() and PublishNow.Apply() of one file, and two overloads, were ONE
// place and one outcome closed two entry paths. A place is one declaration: the line it starts on and the type
// or function it sits in. size-check.mjs returns the name only, so the line and the scope are found here.

// What each line of a file defines ('' = nothing), as size-check.mjs reads it: a line alone has no function
// to sit in, so the name that comes back for it is the one it defines. Read once per file text.
const definedBy = new WeakMap();
function definedNames(lines) {
  if (!definedBy.has(lines)) definedBy.set(lines, lines.map(l => enclosingFunction([l], 0)));
  return definedBy.get(lines);
}

// The declaration a hit line (0-based) belongs to: `{ bare, at }`, at = the line it starts on; null outside any
// function. It is the nearest line, the hit's own or one above, that defines the name size-check.mjs gives the
// hit and, read as the top of the file, still holds the hit: a same-named function that ended before the hit
// is passed over. A name with no such line is no declaration found: the hit is the file's own.
function declarationOf(lines, hit) {
  const bare = enclosingFunction(lines, hit);
  if (!bare) return null;
  const defs = definedNames(lines);
  for (let i = hit; i >= 0; i--) {
    if (defs[i] === bare && (i === hit || enclosingFunction(lines.slice(i), hit - i) === bare)) return { bare, at: i };
  }
  return null;
}

// `class X`, `record X`, `struct X` or `interface X`, with the C# or TS words that may stand before it.
const TYPE_LINE = /^\s*(?:(?:export|default|declare|public|private|protected|internal|static|sealed|abstract|partial|readonly|ref|unsafe|file|new)\s+)*(?:class|record(?:\s+(?:class|struct))?|struct|interface)\s+(?!extends\b)([A-Za-z_$][\w$]*)/;
const braces = (line) => { let n = 0; for (const c of codeOnly(line)) { if (c === '{') n++; else if (c === '}') n--; } return n; };

// The type whose body holds line `at` (0-based): the nearest type line above whose `{` (on that line, or below
// it after a base list) is still open there; '' when there is none.
function containingType(lines, at) {
  // open[i]: braces opened from line i down to the declaration, less those closed; a brace opened on line j
  // still holds the declaration when open[j] is above every open[k] below it.
  const open = [], maxBelow = [];
  let sum = 0, best = 0;
  for (let i = at - 1; i >= 0; i--) {
    maxBelow[i] = best; sum += braces(lines[i]); open[i] = sum; best = Math.max(best, sum);
    const type = TYPE_LINE.exec(lines[i]);
    if (!type) continue;
    let j = i;
    while (j < at - 1 && j < i + 12 && !/[{;]/.test(codeOnly(lines[j]))) j++;
    if (codeOnly(lines[j]).includes('{') && open[j] > maxBelow[j]) return type[1];
  }
  return '';
}

// The scope of the declaration on line `at`: the function it sits in (a local function, a handler inside a
// component) or, outside any function, its type; '' at the top level. The function is read with a plain
// statement put where the declaration is, since the line itself names only what it defines. Read once per
// declaration.
const scopes = new WeakMap();
function scopeOf(lines, at) {
  if (!scopes.has(lines)) scopes.set(lines, new Map());
  const known = scopes.get(lines);
  if (!known.has(at)) known.set(at, enclosingFunction([...lines.slice(0, at), /^\s*/.exec(lines[at])[0] + ';', ...lines.slice(at)], at) || containingType(lines, at));
  return known.get(at);
}

// 2026-11-17 (audit): overloads were told apart by the line they start on, and a line moves with every edit
// above it, so an outcome followed a line onto another overload (a new overload took over the outcome written
// for its neighbour). An overload is told apart by its parameter list now, which does not move.
// The parameter list of the declaration that starts on line `at` (0-based), on one line, as the code reads it:
// the text between the first `(` after the name and its `)`. null when it cannot be read.
function signatureOf(lines, at, bare) {
  let text = '';
  for (let i = at; i < lines.length && i < at + 12; i++) text += ' ' + codeOnly(lines[i]);
  const name = new RegExp(`(?<![\\w$])${bare.replace(/[$]/g, '\\$&')}(?![\\w$])`).exec(text);
  if (!name) return null;
  const from = name.index + bare.length;
  const open = text.indexOf('(', from);
  if (open < 0 || /[{;]/.test(text.slice(from, open))) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i).replace(/[·→]/g, '-').replace(/\s+/g, ' ').trim();
  }
  return null;
}

// A declaration's row: `fn` is its name on the list. The function's own name when the file declares it once;
// else `<scope>.<name>`. When another declaration of the name has the same scope (overloads, or two of one
// name with no type around them), its parameter list follows the name: `Rules.Apply(int id)`; and `(line N)`
// follows that when two of them have the same parameter list too. `sig`: the parameter list (null: unknown).
// `scope` is null while nobody has asked.
function labelled(lines, { bare, at }) {
  const all = [];
  definedNames(lines).forEach((n, i) => { if (n === bare) all.push(i); });
  const sig = signatureOf(lines, at, bare);
  if (all.length < 2) return { fn: bare, bare, scope: null, at, sig };
  const scope = scopeOf(lines, at);
  const same = all.filter(i => scopeOf(lines, i) === scope);
  const head = `${scope ? scope + '.' : ''}${bare}`;
  if (same.length === 1) return { fn: head, bare, scope, at, sig };
  const withSig = (s) => (s === null ? head : `${head}(${s})`);
  const twins = same.filter(i => withSig(signatureOf(lines, i, bare)) === withSig(sig));
  return { fn: withSig(sig) + (twins.length > 1 ? ` (line ${at + 1})` : ''), bare, scope, at, sig };
}

// One file's hit lines (1-based) grouped by the declaration each sits in, in the order of each row's first
// line: `{ fn, bare, scope, at, peers, lines }`. A hit outside any function, and every hit of a file whose
// functions cannot be named, is the file's own row, `(file)`. `lines` is the file's text as lines, or null
// when it is not readable.
export function declarations(file, hitLines, lines) {
  const named = lines && NAMED_FUNCTIONS.test(file);
  const rows = new Map();
  for (const line of hitLines) {
    const d = named ? declarationOf(lines, line - 1) : null;
    const key = d ? d.at : FILE_PART;
    if (!rows.has(key)) rows.set(key, d ? { ...labelled(lines, d), lines: [] } : { fn: FILE_PART, bare: '', scope: '', at: -1, sig: null, lines: [] });
    rows.get(key).lines.push(line);
  }
  return [...rows.values()];
}

// The same rows as Map(function part → lines).
export function byFunction(file, hitLines, lines) {
  return new Map(declarations(file, hitLines, lines).map(r => [r.fn, r.lines]));
}

// "Type.name(int a) (line 12)" → { scope: 'Type', bare: 'name', sig: 'int a', line: 12 }; sig is undefined when
// the label has none, and line 0 when it has none; null for `(file)` and any other text.
const LABEL = /^(?:([A-Za-z_$][\w$]*)\.)?([A-Za-z_$][\w$]*)(?:\((.*?)\))?(?: \(line (\d+)\))?$/;
const readLabel = (fn) => { const m = LABEL.exec(fn || ''); return m ? { scope: m[1] || '', bare: m[2], sig: m[3], line: Number(m[4] || 0) } : null; };

// Which row found now each place of an older list continues: Map(place → row). `mine`: the list's places of one
// searched name in one file; `rows`: that name's rows in that file; `scope(row)`: the row's scope.
//   1. A label with no line: the same label is the same place.
//   2. A label with a line (two declarations with the same parameter list: a line moves with every edit above
//      it, so it tells nothing alone): the places of one name, scope and parameter list continue under their
//      labels only while every one of them has its row under the same label, none more and none less, as when
//      nothing above them moved. Otherwise they are gone and the declarations are new: no line is followed.
//   3. A label with no line that is not found again (a twin came or went, or the list is from before
//      2026-11-17): a place and a row with the same function name, the same scope when the label names one and
//      the same parameter list when it has one, continue each other when each is the only candidate of the other.
//   4. Any other place is gone and any other row is new and open: an outcome is never moved to a declaration it
//      may not have been written for. A gone place comes back only under its own label, and never by a line.
function continued(mine, rows, scope) {
  const to = new Map(), used = new Set();
  const pair = (p, r) => { to.set(p, r); used.add(r); };
  const label = (p) => p.fn || FILE_PART;
  const live = mine.filter(p => p.mark !== 'gone').map(p => ({ p, l: readLabel(label(p)) }));
  const fits = (l, r) => !used.has(r) && l.bare === r.bare && (!l.scope || l.scope === scope(r)) && (l.sig === undefined || l.sig === r.sig);
  for (const { p, l } of live) { const r = !(l && l.line) && rows.find(row => row.fn === label(p)); if (r) pair(p, r); }
  const key = (l) => `${l.scope}.${l.bare}(${l.sig ?? '\0'})`;
  const byLine = new Map();
  for (const x of live) if (x.l && x.l.line) byLine.set(key(x.l), [...(byLine.get(key(x.l)) || []), x]);
  for (const xs of byLine.values()) {
    const rs = rows.filter(r => { const l = readLabel(r.fn); return l && l.line && key(l) === key(xs[0].l); });
    if (rs.length !== xs.length || !xs.every(x => rs.some(r => r.fn === label(x.p)))) continue;
    for (const x of xs) pair(x.p, rs.find(r => r.fn === label(x.p)));
  }
  const rest = live.filter(x => x.l && !x.l.line && !to.has(x.p)).map(x => ({ ...x, rows: rows.filter(r => fits(x.l, r)) }));
  for (const x of rest) if (x.rows.length === 1 && rest.filter(y => y.rows.includes(x.rows[0])).length === 1) pair(x.p, x.rows[0]);
  for (const p of mine) {
    const l = readLabel(label(p));
    const r = p.mark === 'gone' && !(l && l.line) && rows.find(row => !used.has(row) && row.fn === label(p));
    if (r) pair(p, r);
  }
  return to;
}

// "P3 (new) · name · file · function · lines 12, 40 → outcome"; the older shape has no function part and
// reads as the file's own place. The outcome is all text after the first arrow that follows the lines field,
// so an outcome may hold an arrow of its own.
const PLACE = /^P(\d+)(?: \((new|gone)\))? · (.+?) · (.+?) · (?:(.+?) · )?lines ([^→]*?) ?→ ?(.*)$/;

export function parsePlaces(text) {
  const rows = String(text).split(/\r?\n/);
  const field = (key) => { const m = new RegExp(`^${key}: (.*)$`).exec(rows.find(l => l.startsWith(key + ': ')) || ''); return m ? m[1].trim() : ''; };
  const repo = field('Repo'), names = field('Names').split(',').map(s => s.trim()).filter(Boolean);
  if (!repo || !names.length) return null;
  const places = [];
  for (const row of rows) {
    const m = PLACE.exec(row);
    if (m) places.push({ n: Number(m[1]), mark: m[2] || '', name: m[3], file: m[4], fn: m[5] || FILE_PART, lines: m[6].trim(), outcome: m[7].trim() });
  }
  return { repo, names, searched: field('Searched'), places };
}

const linesText = (lines) => lines.length
  ? lines.slice(0, SHOWN_LINES).join(', ') + (lines.length > SHOWN_LINES ? ` (+${lines.length - SHOWN_LINES} more)` : '')
  : 'none';

const where = (p) => `${p.name} · ${p.file} · ${p.fn || FILE_PART}`;
export const placeLine = (p) => `P${p.n}${p.mark ? ` (${p.mark})` : ''} · ${where(p)} · lines ${p.lines} → ${p.outcome}`;

export function renderPlaces({ repo, names, searched, places, tests }) {
  const out = [
    '# Places that use what this change touches', '',
    `Repo: ${repo.replace(/\\/g, '/')}`,
    `Names: ${names.join(', ')}`,
    `Searched: ${searched} (git grep -w -I -F --untracked, one search per name)`, '',
    'Write the outcome after each →: `C<n>` (check line n covers this place) or `none: <why this place needs no change and no test>`.',
    'places.mjs rewrites this file on each run and keeps every outcome; write nothing else here.', '',
  ];
  for (const name of names) {
    const mine = places.filter(p => p.name === name).sort((a, b) => a.n - b.n);
    out.push(`## ${name}`, '', ...(mine.length ? mine.map(placeLine) : ['No product file uses it.']),
      `Tests that mention it: ${(tests.get(name) || []).join(', ') || 'none'}`, '');
  }
  return out.join('\n');
}

// Search every name and merge with the list already in `out` (if any). Throws a usage error for a name
// that is too wide, and for a newly given name with no hit; a stored name with no hit now only marks its
// places gone (the change may have renamed or removed it).
export function writePlaces({ repo, names = [], out, now = new Date() }) {
  const top = toplevel(repo);
  if (!top) throw usage('not inside a git repository: ' + repo);
  const old = fs.existsSync(out) ? parsePlaces(fs.readFileSync(out, 'utf8')) : null;
  if (fs.existsSync(out) && !old) throw usage(`${out} is not a places list (no Repo: and Names: header); give another --out`);
  const stored = old ? old.names : [];
  const all = [...new Set([...stored, ...names.map(s => s.trim()).filter(Boolean)])];
  if (!all.length) throw usage('--names is required: the function, rule, constant, error code, text key or field the change touches');
  const found = new Map(), tests = new Map();
  for (const name of all) {
    const hit = searchName(top, name, { skip: path.resolve(out) });
    if (hit.product.size > MAX_FILES) throw usage(`too wide: ${name} is used in ${hit.product.size} files; name the rule, function, code or key instead`);
    if (!stored.includes(name) && !hit.product.size && !hit.tests.length) throw usage(`no place uses ${name}: check the spelling`);
    found.set(name, hit.product);
    tests.set(name, hit.tests);
  }
  // Each file is read once per run, however many names and hits it has.
  const texts = new Map();
  const linesOf = (file) => {
    if (!texts.has(file)) { let t = null; try { t = fs.readFileSync(path.join(top, file), 'utf8').split(/\r?\n/); } catch { /* removed meanwhile */ } texts.set(file, t); }
    return texts.get(file);
  };
  // name → [{ file, fn, bare, scope, at, peers, lines }], files in path order, each file's declarations in the
  // order they first appear.
  const hits = new Map();
  for (const name of all) {
    const rows = [];
    for (const file of [...found.get(name).keys()].sort()) {
      for (const row of declarations(file, found.get(name).get(file), linesOf(file))) rows.push({ file, ...row });
    }
    hits.set(name, rows);
  }
  // 2026-11-17: a place of the list is matched to a declaration, not to a name (continued, above).
  const scope = (r) => (r.scope ??= scopeOf(linesOf(r.file), r.at));
  const spots = new Map();
  for (const p of old ? old.places : []) { const k = p.name + '\0' + p.file; spots.set(k, [...(spots.get(k) || []), p]); }
  const rowOf = new Map();
  for (const [k, mine] of spots) {
    const [name, file] = k.split('\0');
    for (const [p, r] of continued(mine, (hits.get(name) || []).filter(row => row.file === file), scope)) rowOf.set(p, r);
  }
  const places = [];
  for (const p of old ? old.places : []) {
    const r = rowOf.get(p);
    if (r) places.push({ ...p, fn: r.fn, lines: linesText(r.lines), mark: p.mark === 'gone' ? '' : p.mark });
    else places.push({ ...p, fn: p.fn || FILE_PART, lines: 'none', mark: 'gone' });
  }
  const kept = new Set(rowOf.values());
  let next = places.reduce((n, p) => Math.max(n, p.n), 0) + 1;
  for (const name of all) {
    for (const r of hits.get(name)) {
      if (kept.has(r)) continue;
      places.push({ n: next++, mark: old ? 'new' : '', name, file: r.file, fn: r.fn, lines: linesText(r.lines), outcome: '' });
    }
  }
  const list = { repo: top, names: all, searched: now.toISOString(), places, tests };
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, renderPlaces(list));
  return list;
}

export function readPlaces(file) {
  if (!fs.existsSync(file)) throw usage('no such places list: ' + file);
  const list = parsePlaces(fs.readFileSync(file, 'utf8'));
  if (!list) throw usage(`${file} is not a places list (no Repo: and Names: header): make it with --repo --names --out`);
  return list;
}

// The stored search again, in the stored repo or in `repo` (a worktree of the same repository).
export function refreshPlaces(file, { repo } = {}) {
  const list = readPlaces(file);
  const where = repo || list.repo;
  if (!fs.existsSync(where)) throw usage(`the stored repo is gone: ${where}; give --repo`);
  return writePlaces({ repo: where, out: file });
}

// Why a place is still open ('' = closed). `checkCount`: how many check lines there are, when known.
export function openReason(p, checkCount) {
  if (p.mark === 'gone') return '';
  const o = p.outcome.trim();
  if (!o) return 'no outcome';
  const none = /^none:\s*(.*)$/i.exec(o);
  if (none) return none[1].trim().length >= MIN_REASON ? '' : `the reason after none: needs at least ${MIN_REASON} characters`;
  const cs = /^(C\d+(?:\s*,\s*C\d+)*)(?![\w])/i.exec(o);
  if (!cs) return 'write C<n> or none: <reason>';
  const bad = cs[1].split(',').map(s => Number(s.trim().slice(1))).filter(n => n < 1 || (checkCount !== undefined && n > checkCount));
  const known = checkCount === undefined ? 'check lines start at C1' : checkCount ? `C1..C${checkCount}` : 'the check file has none';
  if (bad.length) return `${bad.map(n => 'C' + n).join(', ')} ${bad.length === 1 ? 'is' : 'are'} not a check line (${known})`;
  return '';
}

// "file:web/src/**/x.ts" as a regular expression over a list path.
function globRe(glob) {
  const body = glob.replace(/\\/g, '/').split(/(\*\*|\*)/)
    .map(part => (part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))).join('');
  return new RegExp('^' + body + '$');
}

// Which places one --set names: pick(place) → boolean; explicit (P-numbers) replaces a written outcome.
export function selector(which) {
  const w = String(which).trim();
  if (/^P\d+(?:\s*,\s*P\d+)*$/i.test(w)) {
    const nums = new Set(w.split(',').map(x => Number(x.trim().slice(1))));
    return { pick: p => nums.has(p.n), explicit: true };
  }
  const file = /^file:(.+)$/i.exec(w);
  if (file) { const re = globRe(file[1].trim()); return { pick: p => re.test(p.file), explicit: false }; }
  const name = /^name:(.+)$/i.exec(w);
  if (name) return { pick: p => p.name === name[1].trim(), explicit: false };
  throw usage(`--set: "${w}" is not P<n>[,P<m>], file:<path> or name:<name>`);
}

// Writes the outcome of each --set into the list's own lines; every other line of the file stays as it is.
export function closePlaces(file, sets, { checkCount } = {}) {
  const text = fs.readFileSync(file, 'utf8');
  if (!parsePlaces(text)) throw usage(`${file} is not a places list (no Repo: and Names: header)`);
  const rows = text.split(/\r?\n/);
  const counts = [];
  for (const { which, outcome } of sets) {
    const sel = selector(which);
    const reason = openReason({ mark: '', outcome }, checkCount);
    if (reason) throw usage(`--set ${which}: ${reason}`);
    let n = 0;
    const closed = [];
    for (let i = 0; i < rows.length; i++) {
      const m = PLACE.exec(rows[i]);
      if (!m) continue;
      const p = { n: Number(m[1]), mark: m[2] || '', name: m[3], file: m[4], fn: m[5] || FILE_PART, lines: m[6].trim(), outcome: m[7].trim() };
      if (p.mark === 'gone' || !sel.pick(p) || (!sel.explicit && p.outcome)) continue;
      rows[i] = placeLine({ ...p, outcome });
      closed.push(`P${p.n} · ${where(p)}`);
      n++;
    }
    if (!n) throw usage(`--set ${which}: no ${sel.explicit ? '' : 'open '}place matches`);
    counts.push({ which, outcome, n, closed });
  }
  fs.writeFileSync(file, rows.join(text.includes('\r\n') ? '\r\n' : '\n'));
  return counts;
}

// 2026-11-17 (audit, "distinct methods collapse into a single place"): why an open place has no outcome of its
// own, when a gone place used to cover it together with another function of the same name (a list from before
// a place was one declaration, or a second function of that name that now uses the searched name). '' when
// that is not so. The old outcome stays on the gone line; it is never taken for either function.
const SHOWN_OUTCOME = 60;
function splitNote(p, places) {
  const mine = readLabel(p.fn);
  if (!mine) return '';
  const covers = (was, l) => l && l.bare === was.bare && (!was.scope || was.scope === l.scope);
  for (const g of places) {
    const was = g.mark === 'gone' && g.name === p.name && g.file === p.file && String(g.outcome || '').trim() ? readLabel(g.fn) : null;
    if (!was || was.line || was.sig !== undefined || !covers(was, mine)) continue;
    const parts = places.filter(q => q.mark !== 'gone' && q.name === p.name && q.file === p.file && covers(was, readLabel(q.fn)));
    const had = g.outcome.trim().length > SHOWN_OUTCOME ? g.outcome.trim().slice(0, SHOWN_OUTCOME - 1) + '…' : g.outcome.trim();
    if (parts.length > 1) return `split from P${g.n} (${g.fn} → ${had}): ${parts.length} functions named ${was.bare} use ${p.name} in this file, and each is its own place with its own outcome`;
  }
  return '';
}

export function checkPlaces(list, { checkCount } = {}) {
  const live = list.places.filter(p => p.mark !== 'gone');
  const open = live.map(p => ({ p, why: openReason(p, checkCount) })).filter(x => x.why).map(x => {
    const split = x.why === 'no outcome' ? splitNote(x.p, list.places) : '';
    return split ? { ...x, why: split, split: true } : x;
  });
  const lines = open.map(({ p, why }) => `OPEN: P${p.n} · ${where(p)}${why === 'no outcome' ? '' : ' — ' + why}`);
  lines.push(`PLACES: ${live.length} place(s), ${open.length} open`);
  return { ok: !open.length, open, count: live.length, text: lines.join('\n') };
}

function parse(argv) {
  const o = { set: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!['--repo', '--names', '--out', '--refresh', '--check', '--check-lines', '--close', '--set'].includes(k) || argv[i + 1] === undefined) throw usage('Unknown or empty option: ' + k);
    if (k === '--set') {
      const v = argv[++i], eq = v.indexOf('=');
      if (eq < 1) throw usage('--set needs "<which>=<outcome>", e.g. --set "file:src/Other.tsx=none: another screen\'s own state"');
      o.set.push({ which: v.slice(0, eq), outcome: v.slice(eq + 1).trim() });
      continue;
    }
    o[k.slice(2)] = argv[++i];
  }
  if (o.close) {
    if (o.out || o.refresh || o.check) throw usage('--close goes alone, with its --set options');
    if (!o.set.length) throw usage('--close needs at least one --set "<which>=<outcome>"');
    return o;
  }
  if (o.set.length) throw usage('--set goes with --close');
  if (!o.out && !o.refresh && !o.check) throw usage('give --out (make or update a list), --refresh <list>, --check <list> or --close <list>');
  if (o.out && (o.refresh || o.check)) throw usage('--out makes a list; use --refresh or --check on it in another run');
  if (o.out && (!o.repo || !o.names)) throw usage('--out needs --repo and --names');
  if (o['check-lines'] && !o.check) throw usage('--check-lines goes with --check');
  return o;
}

const USAGE = 'Usage: node places.mjs --repo <path> --names <n1,n2,...> --out <places.md>\n' +
  '       node places.mjs --refresh <places.md> [--repo <path>] [--check <places.md> [--check-lines <check.md>]]\n' +
  '       node places.mjs --check <places.md> [--check-lines <check.md>]\n' +
  '       node places.mjs --close <places.md> --set "<P1,P2 | file:<path> | name:<name>>=<C<n> | none: <reason>>" [--set ...]\n';

// Not a top-level await (2026-11-12): review-brief.mjs imports this file, so this file's own import of
// review-brief.mjs must wait until this module has finished loading, or the two wait on each other (exit 13).
async function main() {
  try {
    const o = parse(process.argv.slice(2));
    if (o.close) {
      const file = path.resolve(o.close);
      // Each place a --set closed is named (2026-11-14: one file: outcome closed 8 places, and one of them, a
      // function the author had not opened, did not fit the reason; listed, it is seen before review).
      for (const c of closePlaces(file, o.set)) {
        process.stdout.write(`CLOSED: ${c.n} place(s) — ${c.which} → ${c.outcome}\n`);
        for (const p of c.closed) process.stdout.write(`  ${p}\n`);
      }
      const { count, open } = checkPlaces(readPlaces(file));
      process.stdout.write(`PLACES: ${count} place(s), ${open.length} open — ${file}\n`);
      return;
    }
    // 2026-11-17: a run that only writes the list still says which open places an older place was split into.
    const splits = (open) => open.filter(x => x.split).map(({ p, why }) => `OPEN: P${p.n} · ${where(p)} — ${why}\n`).join('');
    if (o.out) {
      const list = writePlaces({ repo: path.resolve(o.repo), names: o.names.split(','), out: path.resolve(o.out) });
      const { count, open } = checkPlaces(list);
      process.stdout.write(`${splits(open)}PLACES: ${count} place(s), ${open.length} open — written to ${path.resolve(o.out)}; write C<n> or none: <reason> after each →\n`);
    } else {
      if (o.refresh) refreshPlaces(path.resolve(o.refresh), { repo: o.repo && path.resolve(o.repo) });
      if (!o.check) {
        const { count, open } = checkPlaces(readPlaces(path.resolve(o.refresh)));
        process.stdout.write(`${splits(open)}PLACES: ${count} place(s), ${open.length} open — refreshed ${path.resolve(o.refresh)}\n`);
      } else {
        let checkCount;
        if (o['check-lines']) {
          if (!fs.existsSync(o['check-lines'])) throw usage('no such check file: ' + o['check-lines']);
          // The brief's own numbering, so C<n> here is C<n> in the brief.
          const { checkLines } = await import('./review-brief.mjs');
          checkCount = checkLines(fs.readFileSync(o['check-lines'], 'utf8')).length;
        }
        const r = checkPlaces(readPlaces(path.resolve(o.check)), { checkCount });
        process.stdout.write(r.text + '\n');
        process.exitCode = r.ok ? 0 : 1;
      }
    }
  } catch (error) {
    process.stderr.write('PLACES: ' + error.message + '\n' + USAGE);
    process.exitCode = 2;
    if (!(error instanceof UsageError)) process.stderr.write(String(error.stack || '') + '\n');
  }
}

if (isMain(import.meta.url)) main();
