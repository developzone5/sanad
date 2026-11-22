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
// 2026-11-18 (audit of the release): a name used in more than 40 product files is no longer refused: it keeps one
// place per declaration, as for any name (a second audit pass, same day: not one per file), and `WIDE: <name> is used in <n> files …` is printed. An attribute line (C#) belongs to
// the method under it; a member of an object literal (JS, TS) and a C# property are declarations of their own
// (`api.create`, `CreateDto.DueDate`). A (gone) place with no outcome stays open while no live place of its name is
// left (`OPEN: P<n> … — no longer found: …`); `--close` writes it by number (`--set P1=none: <reason>`). A label with
// no scope pairs with a row only while the file declares the name once (a list written before 2026-11-17 excepted).
// 2026-11-19 (release 19b, measured: 439 rows for TryParse, Failed and UpdateAsync, 377 closed as none; and a new
// call inside a closed function kept its old "none: no test needed"):
//   - `Uses:` in the header holds a short hash of each place's use lines (their text only: no line numbers, spaces
//     left out). On a refresh a place whose use lines changed and that had an outcome is open again: `(changed)`,
//     with `→ was: <old outcome>`. Code that only moved, or was only re-spaced, keeps its outcome.
//   - A name written `Type.Member`, when the repository declares that type, is searched by the member word. A hit
//     stays a place only when its file names the type, a type derived from it or its interface. Every other hit is
//     folded: one line `F<n> · Type.Member · other type · 377 use(s) in 212 file(s) · e.g. a.cs, b.cs, c.cs`, and
//     all of them in `<list>.folded.md` beside the list. The tool closes an F line itself and counts it apart:
//     `PLACES: 17 place(s), 0 open, 377 folded`. A bare name keeps the whole word search (text keys, error codes).
//     `--refresh <list> --unfold F1` lists the folded uses again as open places, and so does a type that is no
//     longer declared (renamed): nothing folded is ever dropped unseen.
//   - `--add-changed --base <ref>` (with --out or --refresh): every changed function that has callers, as
//     size-check.mjs counts them, joins the names (a C# method as Type.Member) and gives open places. The tool
//     never writes an outcome.
//   - `--set "fn:<function>=<outcome>"` fills every open place of one function.
// Exit 0: written, or no open place. 1: an open place. 2: usage error, a missing file or a name with no hit at all.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { TEST_FILE } from './check-ticket-lines.mjs';
import { enclosingFunction, codeOnly } from './size-check.mjs';
// Read by name at call time: derivedTypeNames and the allCallers rows come with the same release (size-check as
// data), and this file must still load beside an older size-check.mjs.
import * as sizeCheck from './size-check.mjs';
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
  // `skip`: one file or several (the list and its folded file).
  const skips = [].concat(skip).filter(Boolean), skipped = new Map();
  const isSkipped = (file) => { if (!skipped.has(file)) skipped.set(file, skips.some(s => same(path.join(repo, file), s))); return skipped.get(file); };
  for (const row of String(r.stdout).split('\n')) {
    const a = row.indexOf('\0'), b = a < 0 ? -1 : row.indexOf('\0', a + 1);
    if (b < 0) continue;
    const file = row.slice(0, a), line = Number(row.slice(a + 1, b));
    if (skips.length && isSkipped(file)) continue;
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

// 2026-11-18 (audit, "one (file) place covers several entry points"): a hit on a C# attribute line
// (`[Authorize(Policy = …)]` above Create, PublishNow and Delete), on a member of an exported API object
// (`export const api = { create: (…) => …, schedule: … }`) or on a C# property was "outside any function", so
// every such hit of a file was one `(file)` place and one outcome closed them all, as on 2026-11-12. An
// attribute line now belongs to the method under it; an object member and a C# property are declarations of
// their own (`api.create`, `CreateDto.DueDate`). Only a hit that is truly top level stays `(file)`.
const SKIP_WORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'await', 'new', 'typeof', 'delete', 'void', 'throw', 'else', 'do', 'try', 'super', 'import', 'export', 'case', 'with', 'yield', 'var', 'let', 'const', 'using', 'lock']);
// `name: (…`, `name: async (…`, `name: function`, `name: x =>`, and a method `name(…`, with `async`, `get`, `set`.
const JS_MEMBER = /^\s*(?:async\s+)?(?:(?:get|set)\s+)?([A-Za-z_$][\w$]*)\s*(?::\s*(?:async\s*)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>)|\()/;
// A C# property: `public DateTime? DueDate { get; set; }`, `public bool IsLate => …`.
const CS_PROPERTY = /^\s*(?:(?:public|private|protected|internal|static|required|virtual|override|abstract|new|readonly|sealed|unsafe)\s+)*[A-Za-z_][\w.]*(?:<[^>]*>)?(?:\[\])*\??\s+([A-Za-z_]\w*)\s*(?:\{\s*(?:get|set|init|private|protected|internal)\b|=>)/;
const CS_FILE = /\.cs$/i;

// The unmatched `{` above line i (0-based): the text before it, or null. Read up to 400 lines up.
function openerAbove(lines, i) {
  let need = 0;
  for (let k = i - 1; k >= 0 && k >= i - 400; k--) {
    const code = codeOnly(lines[k]);
    for (let c = code.length - 1; c >= 0; c--) {
      if (code[c] === '}') need++;
      else if (code[c] === '{') {
        if (need) { need--; continue; }
        const before = code.slice(0, c).trimEnd();
        return before || (k > 0 ? codeOnly(lines[k - 1]).trimEnd() : '');
      }
    }
  }
  return null;
}

// The member declared on line i (0-based), as `{ bare, owner }`, or null. JS and TS: a function-valued member
// of an object literal (the `{` around it opens after `=`, `:`, `(`, `,`, `[`, `return` or `default`, never
// after `)`, `=>` or a word: that is a function or a type body); owner = the name the literal is given.
// C#: a property of a type; owner = the type.
// 2026-11-18 (repair round): a C# method with no access modifier (`void Apply(H h)`) or an explicit interface method
// (`void IRule.Apply(H h)`), a TS class field with an arrow function (`create = (x) => …`) and a one-line class
// method were still "outside any function": the file's one `(file)` place, closed by one outcome for several
// functions. Each is a declaration of its own now (`Schedule.Apply`, `AssignmentsApi.create`).
const CS_METHOD = /^\s*(?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|async|partial|extern|unsafe|new|readonly)\s+)*[A-Za-z_][\w.]*(?:<[^()]*?>)?(?:\[\])*\??\s+(?:[A-Za-z_]\w*\.)*([A-Za-z_]\w*)\s*(?:<[^()]*?>)?\s*\(/;
const CS_NOT_A_TYPE = new Set(['select', 'where', 'from', 'orderby', 'group', 'join', 'let', 'on', 'into', 'equals', 'by', 'in', 'is', 'as', 'not', 'and', 'or', 'out', 'ref', 'goto', 'break', 'continue', 'default', 'params', 'checked', 'unchecked', 'fixed', 'foreach', 'when']);
const CLASS_FIELD = /^\s*(?:(?:public|private|protected|static|readonly|override|declare)\s+)*(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\(|function\b|[A-Za-z_$][\w$]*\s*=>)/;
function memberAt(file, lines, i) {
  const code = codeOnly(lines[i] || '');
  if (CS_FILE.test(file)) {
    const first = /^\s*(\w+)/.exec(code);
    if (!first || (SKIP_WORDS.has(first[1]) && first[1] !== 'void') || CS_NOT_A_TYPE.has(first[1])) return null;
    const m = CS_PROPERTY.exec(code);
    const method = m ? null : CS_METHOD.exec(code);
    if (!m && !(method && !SKIP_WORDS.has(method[1]))) return null;
    const owner = containingType(lines, i);
    return owner ? { bare: (m || method)[1], owner, method: !m } : null;
  }
  const before = openerAbove(lines, i);
  const cls = before !== null && /\bclass\s+([A-Za-z_$][\w$]*)/.exec(before);
  if (cls && !/[=:(,[]$/.test(before)) {
    const f = CLASS_FIELD.exec(code), meth = JS_MEMBER.exec(code);
    const bare = f ? f[1] : meth && !SKIP_WORDS.has(meth[1]) ? meth[1] : '';
    return bare ? { bare, owner: cls[1] } : null;
  }
  const m = JS_MEMBER.exec(code);
  if (!m || SKIP_WORDS.has(m[1])) return null;
  if (before === null || !/(?:[=:(,[]|\breturn|\bdefault)$/.test(before)) return null;
  const owner = /([A-Za-z_$][\w$]*)(?:\s*:\s*[^=:]+)?\s*[=:]\s*$/.exec(before);
  return { bare: m[1], owner: owner ? owner[1] : '' };
}

// The last line (0-based) of the C# method that starts on line i: its body's closing brace, or the `;` that ends an
// expression-bodied or body-less one.
function methodEnd(lines, i) {
  let paren = 0, brace = 0, seen = false, arrow = false;
  for (let k = i; k < lines.length && k < i + 400; k++) {
    const code = codeOnly(lines[k]);
    for (let c = 0; c < code.length; c++) {
      const ch = code[c];
      if (ch === '(') paren++;
      else if (ch === ')') paren--;
      else if (paren > 0) continue;
      else if (ch === '=' && code[c + 1] === '>' && !seen) arrow = true;
      else if (ch === ';' && brace === 0 && !seen) return k;
      else if (ch === ';' && brace === 0 && arrow) return k;
      else if (ch === '{' && !arrow) { brace++; seen = true; }
      else if (ch === '}' && !arrow && --brace === 0 && seen) return k;
    }
  }
  return i;
}

// The last line (0-based) of the member that starts on line i: where its brackets are closed again and the
// line ends with `;`, `,` or a closing bracket.
function memberEnd(lines, i) {
  let depth = 0;
  for (let k = i; k < lines.length && k < i + 200; k++) {
    const code = codeOnly(lines[k]);
    for (const c of code) { if ('({['.includes(c)) depth++; else if (')}]'.includes(c)) depth--; }
    if (depth <= 0 && /[;,})\]]\s*$/.test(code.trimEnd())) return k;
  }
  return i;
}

// The member whose lines hold the hit line (0-based), as a declaration `{ bare, at, owner, member: true }`; null
// when the hit sits in no member.
function memberOf(file, lines, hit) {
  for (let i = hit; i >= 0 && i >= hit - 200; i--) {
    const m = memberAt(file, lines, i);
    if (m && (m.method ? methodEnd(lines, i) : memberEnd(lines, i)) >= hit) return { ...m, at: i, member: true };
  }
  return null;
}

// C#: the line (0-based) of the method or property that the attribute line `i` (one of several stacked, or one
// that runs over several lines) sits above; -1 when line i is no attribute or nothing follows. As size-check.mjs
// attributeTarget reads it, with a property as a target too.
function attributeUnder(lines, i) {
  const defs = definedNames(lines);
  let depth = 0;
  for (let k = i; k < Math.min(lines.length, i + 30); k++) {
    const line = String(lines[k] || '');
    if (depth === 0) {
      if (k > i && (defs[k] || memberAt('x.cs', lines, k))) return k;
      if (!/^\s*\[/.test(line)) return -1;
    }
    for (const c of codeOnly(line)) { if (c === '[') depth++; else if (c === ']') depth--; }
  }
  return -1;
}

// A member's row: `Owner.name`, or the bare name with no owner; ` (line N)` follows when the file has another
// member or function of that same label.
function labelledMember(file, lines, d) {
  const fn = d.owner ? `${d.owner}.${d.bare}` : d.bare;
  let same = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = memberAt(file, lines, i);
    if (m && m.bare === d.bare && m.owner === d.owner) same++;
  }
  if (!d.owner) definedNames(lines).forEach(n => { if (n === d.bare) same++; });
  return { fn: same > 1 ? `${fn} (line ${d.at + 1})` : fn, bare: d.bare, scope: d.owner, at: d.at, sig: null, member: true };
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
    let d = null;
    if (named) {
      // An attribute line reads as the method under it (2026-11-18).
      const under = CS_FILE.test(file) ? attributeUnder(lines, line - 1) : -1;
      const at = under >= 0 ? under : line - 1;
      d = declarationOf(lines, at) || memberOf(file, lines, at);
    }
    const key = d ? d.at : FILE_PART;
    if (!rows.has(key)) rows.set(key, d ? { ...(d.member ? labelledMember(file, lines, d) : labelled(lines, d)), lines: [] } : { fn: FILE_PART, bare: '', scope: '', at: -1, sig: null, lines: [] });
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
export const readLabel = (fn) => { const m = LABEL.exec(fn || ''); return m ? { scope: m[1] || '', bare: m[2], sig: m[3], line: Number(m[4] || 0) } : null; };

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
function continued(mine, rows, scope, legacy = false) {
  const to = new Map(), used = new Set();
  const pair = (p, r) => { to.set(p, r); used.add(r); };
  const label = (p) => p.fn || FILE_PART;
  const live = mine.filter(p => p.mark !== 'gone').map(p => ({ p, l: readLabel(label(p)) }));
  // 2026-11-18 (audit): a label with no scope was written while its file declared the name once; it pairs with a
  // row only while the file still does (the row's own label is the bare name). A second class with the same
  // method name is a new declaration, not the old one under a longer label.
  const fits = (l, r) => !used.has(r) && l.bare === r.bare && (l.scope ? l.scope === scope(r) : legacy || r.fn === r.bare) && (l.sig === undefined || l.sig === r.sig);
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

// 2026-11-19: the hash of a place's use lines, stored in the list's `Uses:` line. Only the text of the lines that
// hold the name counts, in file order: no line number (code that moved keeps its outcome) and no space (an
// indent, a tab, a line ending or a re-spaced call changes nothing). A file that cannot be read hashes its count.
export function useHash(fileLines, hitLines) {
  const text = fileLines ? hitLines.map(n => String(fileLines[n - 1] ?? '').replace(/\s+/g, '')).join('\n') : '?' + hitLines.length;
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 10);
}
// An outcome the tool set aside when the place's use lines changed: `was: none: …`. It is no outcome.
const WAS = /^was:\s*/i;

// 2026-11-19: a name written Type.Member.
const TYPE_MEMBER = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function grepWord(repo, words, globs = []) {
  const args = ['-c', 'core.quotepath=off', 'grep', '-n', '-w', '-I', '-F', '--untracked', '--no-color', '-z'];
  for (const w of words) args.push('-e', w);
  if (globs.length) args.push('--', ...globs);
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (r.error || (r.status !== 0 && r.status !== 1)) throw usage(`git grep failed in ${repo}: ${r.error ? r.error.message : String(r.stderr).trim() || 'exit ' + r.status}`);
  const rows = [];
  for (const row of String(r.stdout).split('\n')) {
    const a = row.indexOf('\0'), b = a < 0 ? -1 : row.indexOf('\0', a + 1);
    if (b >= 0) rows.push({ file: row.slice(0, a), line: Number(row.slice(a + 1, b)), text: row.slice(b + 1) });
  }
  return rows;
}
// The names a base list gives: C# `: Base, IFoo<T>` (interfaces by their I name, as size-check.mjs reads them) and
// TS `implements A, B`.
function listedInterfaces(rest) {
  const flat = rest.replace(/<[^<>]*>/g, '');
  const cs = (/:\s*([^{]+)/.exec(flat) || ['', ''])[1].split(/[\s,]+/).filter(b => /^I[A-Z]\w*$/.test(b));
  const ts = (/\bimplements\s+([^{]+)/.exec(flat) || ['', ''])[1].split(/[\s,]+/).filter(b => /^[A-Za-z_$][\w$]*$/.test(b));
  return [...cs, ...ts];
}
// The types that derive from the given ones, with the interfaces each lists, through three levels: the rule of
// size-check.mjs derivedTypeNames (C# only), read here for TS `extends` and `implements` too. typeFamily asks both
// when size-check.mjs exports its own.
function derivedHere(repo, names) {
  const out = new Set(), known = new Set(names);
  let level = [...names];
  for (let pass = 0; pass < 3 && level.length; pass++) {
    const next = new Set();
    for (const row of grepWord(repo, level)) {
      const decl = TYPE_LINE.exec(row.text);
      if (!decl) continue;
      const rest = codeOnly(row.text).slice(decl[0].length).replace(/<[^<>]*>/g, '');
      const bases = (/(?::|\bextends\b|\bimplements\b)\s*([^{]+)/.exec(rest) || ['', ''])[1].split(/[\s,]+/).filter(b => /^[A-Za-z_$][\w$]*$/.test(b));
      if (!bases.some(b => level.includes(b))) continue;
      for (const t of [decl[1], ...listedInterfaces(rest)]) if (!known.has(t)) { known.add(t); out.add(t); }
      next.add(decl[1]);
    }
    level = [...next];
  }
  return [...out];
}
// The names through which a member of `type` is reached: the type, I<Type>, the interfaces its declarations list
// (every partial file) and the types that derive from it. null when the repository declares no such type: the name
// is then a text key or an object member, and keeps the plain search. `extension`: the member is a C# extension
// method (`this` first parameter): it is called on any value, so no use of it is folded.
export function typeFamily(repo, type, member = '') {
  const names = new Set();
  const files = new Set();
  for (const row of grepWord(repo, [type])) {
    const decl = TYPE_LINE.exec(row.text);
    if (!decl || decl[1] !== type) continue;
    files.add(row.file);
    names.add(type);
    for (const i of listedInterfaces(codeOnly(row.text).slice(decl[0].length))) names.add(i);
  }
  if (!names.size) return null;
  names.add('I' + type);
  const theirs = typeof sizeCheck.derivedTypeNames === 'function' ? sizeCheck.derivedTypeNames(repo, [...names]) : [];
  for (const d of [...theirs, ...derivedHere(repo, [...names])]) names.add(d);
  let extension = false;
  if (member) {
    const ext = new RegExp(`(?<![\\w$])${escapeRe(member)}\\s*(?:<[^()]*>)?\\s*\\(\\s*this\\s`);
    for (const f of files) { try { if (ext.test(fs.readFileSync(path.join(repo, f), 'utf8'))) extension = true; } catch { /* not readable: not an extension */ } }
  }
  return { names: [...names], extension, re: new RegExp(`(?<![\\w$])(?:${[...names].map(escapeRe).join('|')})(?![\\w$])`) };
}

// The folded uses of a list sit beside it: places.md → places.folded.md.
export const foldedPath = (out) => path.resolve(out).replace(/\.md$/i, '') + '.folded.md';
// "F1 · RoleService.UpdateAsync · other type · 377 use(s) in 212 file(s) · e.g. a.cs, b.cs, c.cs"
const FOLD = /^F(\d+) · (.+?) · other type · (\d+) use\(s\) in (\d+) file\(s\)/;
export const foldLine = (f) => `F${f.n} · ${f.name} · other type · ${f.uses} use(s) in ${f.files} file(s)${f.samples && f.samples.length ? ' · e.g. ' + f.samples.join(', ') : ''}`;

// "P3 (new) · name · file · function · lines 12, 40 → outcome"; the older shape has no function part and
// reads as the file's own place. The outcome is all text after the first arrow that follows the lines field,
// so an outcome may hold an arrow of its own.
const PLACE = /^P(\d+)(?: \((new|gone|changed)\))? · (.+?) · (.+?) · (?:(.+?) · )?lines ([^→]*?) ?→ ?(.*)$/;

export function parsePlaces(text) {
  const rows = String(text).split(/\r?\n/);
  const field = (key) => { const m = new RegExp(`^${key}: (.*)$`).exec(rows.find(l => l.startsWith(key + ': ')) || ''); return m ? m[1].trim() : ''; };
  const repo = field('Repo'), names = field('Names').split(',').map(s => s.trim()).filter(Boolean);
  if (!repo || !names.length) return null;
  const places = [], folded = [];
  for (const row of rows) {
    const m = PLACE.exec(row);
    if (m) places.push({ n: Number(m[1]), mark: m[2] || '', name: m[3], file: m[4], fn: m[5] || FILE_PART, lines: m[6].trim(), outcome: m[7].trim() });
    const f = m ? null : FOLD.exec(row);
    if (f) folded.push({ n: Number(f[1]), name: f[2], uses: Number(f[3]), files: Number(f[4]), samples: (/ · e\.g\. (.*)$/.exec(row) || ['', ''])[1].split(', ').filter(Boolean) });
  }
  // `Uses:` place number → hash of its use lines; a list of an older release has none, and keeps every outcome.
  let uses = {};
  try { const u = JSON.parse(field('Uses') || '{}'); if (u && typeof u === 'object' && !Array.isArray(u)) uses = u; } catch { /* not readable: as a list with no hashes */ }
  return { repo, names, searched: field('Searched'), places, uses, folded, unfolded: field('Unfolded').split(',').map(s => s.trim()).filter(Boolean) };
}

const linesText = (lines) => lines.length
  ? lines.slice(0, SHOWN_LINES).join(', ') + (lines.length > SHOWN_LINES ? ` (+${lines.length - SHOWN_LINES} more)` : '')
  : 'none';

const where = (p) => `${p.name} · ${p.file} · ${p.fn || FILE_PART}`;
export const placeLine = (p) => `P${p.n}${p.mark ? ` (${p.mark})` : ''} · ${where(p)} · lines ${p.lines} → ${p.outcome}`;

export function renderPlaces({ repo, names, searched, places, tests, uses = {}, folded = [], unfolded = [] }) {
  const out = [
    '# Places that use what this change touches', '',
    `Repo: ${repo.replace(/\\/g, '/')}`,
    `Names: ${names.join(', ')}`,
    `Searched: ${searched} (git grep -w -I -F --untracked, one search per name)`,
    // 2026-11-19: the tool's own lines. Uses: the hash of each place's use lines. Unfolded: the Type.Member names
    // whose other-type uses are listed as places.
    ...(Object.keys(uses).length ? [`Uses: ${JSON.stringify(uses)}`] : []),
    ...(unfolded.length ? [`Unfolded: ${unfolded.join(', ')}`] : []), '',
    'Write the outcome after each →: `C<n>` (check line n covers this place) or `none: <why this place needs no change and no test>`.',
    'places.mjs rewrites this file on each run and keeps every outcome; write nothing else here.', '',
  ];
  for (const name of names) {
    const mine = places.filter(p => p.name === name).sort((a, b) => a.n - b.n);
    out.push(`## ${name}`, '', ...(mine.length ? mine.map(placeLine) : ['No product file uses it.']),
      ...folded.filter(f => f.name === name).map(foldLine),
      `Tests that mention it: ${(tests.get(name) || []).join(', ') || 'none'}`, '');
  }
  return out.join('\n');
}

// The folded uses, every one: a file per line with its line numbers. The reviewer reads this file.
function renderFolded(list, out) {
  const rows = ['# Folded uses — the same member word in files that do not name the type', '',
    `List: ${path.resolve(out).replace(/\\/g, '/')}`,
    'places.mjs writes this file on each run. `places.mjs --refresh <list> --unfold F<n>` lists a group again as open places.', ''];
  for (const f of list.folded) {
    rows.push(`## ${foldLine({ ...f, samples: [] })}`, '', ...f.rows.map(r => `- ${r.file} · lines ${r.lines.join(', ')}`),
      ...(f.tests.length ? [`Tests of another type that mention it: ${f.tests.join(', ')}`] : []), '');
  }
  return rows.join('\n');
}

// Search every name and merge with the list already in `out` (if any). Throws a usage error for a name
// that is too wide, and for a newly given name with no hit; a stored name with no hit now only marks its
// places gone (the change may have renamed or removed it).
// `dry`: search and merge as always, write nothing (stampUses reads the hashes of the code as it is now).
export function writePlaces({ repo, names = [], out, now = new Date(), unfold = [], dry = false }) {
  const top = toplevel(repo);
  if (!top) throw usage('not inside a git repository: ' + repo);
  const old = fs.existsSync(out) ? parsePlaces(fs.readFileSync(out, 'utf8')) : null;
  if (fs.existsSync(out) && !old) throw usage(`${out} is not a places list (no Repo: and Names: header); give another --out`);
  const stored = old ? old.names : [];
  const all = [...new Set([...stored, ...names.map(s => s.trim()).filter(Boolean)])];
  if (!all.length) throw usage('--names is required: the function, rule, constant, error code, text key or field the change touches');
  const found = new Map(), tests = new Map(), wide = new Map();
  // 2026-11-18 (audit): a list written before 2026-11-17 gave a place a bare function name whatever the file held.
  const legacy = Boolean(old && old.searched && old.searched < '2026-11-17');
  // 2026-11-19: folding. `unfolded`: the Type.Member names whose other-type uses are places (--unfold, or a type
  // that is no longer declared). `folds`: name → the uses in files that do not name the type.
  const skip = [path.resolve(out), foldedPath(out)];
  const unfolded = new Set(old ? old.unfolded : []);
  for (const f of unfold) {
    const row = (old ? old.folded : []).find(x => 'F' + x.n === String(f).trim().toUpperCase());
    if (!row) throw usage(`--unfold ${f}: the list has no such folded line`);
    unfolded.add(row.name);
  }
  const folds = new Map(), reopened = [], extensions = [];
  for (const name of all) {
    const tm = TYPE_MEMBER.exec(name);
    const family = tm ? typeFamily(top, tm[1], tm[2]) : null;
    const wasFolded = Boolean(old && old.folded.some(f => f.name === name));
    // A name that was folded and whose type is gone (renamed) has nothing to fold by: its uses are places again.
    if (tm && !family && wasFolded && !unfolded.has(name)) { unfolded.add(name); reopened.push(name); }
    const byMember = Boolean(tm && (family || unfolded.has(name)));
    const hit = searchName(top, byMember ? tm[2] : name, { skip });
    if (byMember && family && family.extension) extensions.push(name);
    if (byMember && family && !family.extension && !unfolded.has(name)) {
      // A file stays when it names the type, a derived type or its interface; a file that cannot be read stays.
      const namesType = (file) => { try { return family.re.test(fs.readFileSync(path.join(top, file), 'utf8')); } catch { return true; } };
      const rows = [], otherTests = [];
      for (const [file, lines] of [...hit.product]) if (!namesType(file)) { rows.push({ file, lines }); hit.product.delete(file); }
      hit.tests = hit.tests.filter(file => namesType(file) || (otherTests.push(file), false));
      if (rows.length || otherTests.length) folds.set(name, { rows: rows.sort((a, b) => (a.file < b.file ? -1 : 1)), tests: otherTests });
    }
    // 2026-11-18 (audit): a name in more files than the limit is never refused (a changed function with 41 caller
    // files has no narrower name, and was then left off the list); it gets one place per file.
    if (hit.product.size > MAX_FILES) wide.set(name, hit.product.size);
    if (!stored.includes(name) && !hit.product.size && !hit.tests.length && !folds.has(name)) throw usage(`no place uses ${name}: check the spelling`);
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
      // 2026-11-18 (audit): a wide name is listed exactly as a narrow one: one place per declaration. A (file) row
      // for a wide name let one outcome close two functions of one file.
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
    for (const [p, r] of continued(mine, (hits.get(name) || []).filter(row => row.file === file), scope, legacy)) rowOf.set(p, r);
  }
  // 2026-11-19: an outcome stays on a place only while that place's own use lines are unchanged. Before, the same
  // declaration found again kept its outcome whatever changed inside it: a new call in a closed function inherited
  // "none: no test needed". The hash of every live place is stored on each run; a place that had an outcome and
  // whose hash differs is open again, `(changed)`, with its old outcome kept after `was:`. A list with no hash yet
  // (an older release) keeps every outcome and gets its hashes now.
  const hashOf = (r) => useHash(linesOf(r.file), r.lines);
  const uses = {};
  const places = [];
  for (const p of old ? old.places : []) {
    const r = rowOf.get(p);
    if (!r) {
      places.push({ ...p, fn: p.fn || FILE_PART, lines: 'none', mark: 'gone' });
      if (old.uses[p.n]) uses[p.n] = old.uses[p.n];
      continue;
    }
    const hash = hashOf(r), judged = Boolean(p.outcome) && !WAS.test(p.outcome);
    const changed = judged && Boolean(old.uses[p.n]) && old.uses[p.n] !== hash;
    uses[p.n] = hash;
    const mark = changed ? 'changed' : p.mark === 'gone' || (p.mark === 'changed' && judged) ? '' : p.mark;
    places.push({ ...p, fn: r.fn, lines: linesText(r.lines), mark, outcome: changed ? `was: ${p.outcome}` : p.outcome });
  }
  const kept = new Set(rowOf.values());
  let next = places.reduce((n, p) => Math.max(n, p.n), 0) + 1;
  for (const name of all) {
    for (const r of hits.get(name)) {
      if (kept.has(r)) continue;
      uses[next] = hashOf(r);
      places.push({ n: next++, mark: old ? 'new' : '', name, file: r.file, fn: r.fn, lines: linesText(r.lines), outcome: '' });
    }
  }
  // One F line per folded name; a name keeps its number.
  let nextF = (old ? old.folded : []).reduce((n, f) => Math.max(n, f.n), 0) + 1;
  const folded = [];
  for (const name of all) {
    const f = folds.get(name);
    if (!f) continue;
    const had = old && old.folded.find(x => x.name === name);
    folded.push({ n: had ? had.n : nextF++, name, uses: f.rows.reduce((n, r) => n + r.lines.length, 0), files: f.rows.length, samples: f.rows.slice(0, 3).map(r => r.file), rows: f.rows, tests: f.tests });
  }
  const list = { repo: top, names: all, searched: now.toISOString(), places, tests, wide, uses, folded, unfolded: [...unfolded], reopened, extensions };
  if (dry) return list;
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, renderPlaces(list));
  // The folded file is the tool's own: written when a name is folded, and taken away when none is any more.
  const beside = foldedPath(out);
  if (folded.length) fs.writeFileSync(beside, renderFolded(list, out));
  else if (fs.existsSync(beside) && fs.readFileSync(beside, 'utf8').startsWith('# Folded uses')) fs.rmSync(beside, { force: true });
  return list;
}

// 2026-11-19 (--add-changed): the changed functions that have callers, as size-check.mjs counts them against `base`,
// each as the name to search: a C# method as Type.Member (its other types fold), anything else as it is named.
// `more`: how many changed functions an older size-check.mjs did not hand over (it gave only its printed rows).
export function changedNames(repo, base) {
  const r = sizeCheck.sizeTask({ repo, base });
  const rows = r.allCallers || r.callers || [];
  const top = toplevel(repo) || repo;
  const names = new Set();
  for (const c of rows) {
    if (!(c.count > 0 || (c.unresolved && c.unresolved.length))) continue;
    const types = new Set();
    if (CS_FILE.test(c.file || '') && /^[A-Za-z_]\w*$/.test(c.name)) {
      let lines = [];
      try { lines = fs.readFileSync(path.join(top, c.file), 'utf8').split(/\r?\n/); } catch { /* removed: the bare name */ }
      const defs = definedNames(lines);
      lines.forEach((_, i) => {
        const m = defs[i] === c.name ? null : memberAt(c.file, lines, i);
        if (defs[i] === c.name || (m && m.bare === c.name)) { const t = containingType(lines, i); if (t) types.add(t); }
      });
    }
    if (types.size) for (const t of types) names.add(`${t}.${c.name}`); else names.add(c.name);
  }
  return { names: [...names], more: r.allCallers ? 0 : r.moreSymbols || 0 };
}

export function readPlaces(file) {
  if (!fs.existsSync(file)) throw usage('no such places list: ' + file);
  const list = parsePlaces(fs.readFileSync(file, 'utf8'));
  if (!list) throw usage(`${file} is not a places list (no Repo: and Names: header): make it with --repo --names --out`);
  return list;
}

// The stored search again, in the stored repo or in `repo` (a worktree of the same repository).
export function refreshPlaces(file, { repo, names = [], unfold = [] } = {}) {
  const list = readPlaces(file);
  const where = repo || list.repo;
  if (!fs.existsSync(where)) throw usage(`the stored repo is gone: ${where}; give --repo`);
  return writePlaces({ repo: where, out: file, names, unfold });
}

// Why a place is still open ('' = closed). `checkCount`: how many check lines there are, when known.
export function openReason(p, checkCount) {
  if (p.mark === 'gone') return '';
  const o = p.outcome.trim();
  if (!o) return 'no outcome';
  // 2026-11-19: an outcome the tool set aside is shown, never counted.
  if (WAS.test(o)) return `its use lines changed after its outcome was written (${o.length > SHOWN_OUTCOME + 5 ? o.slice(0, SHOWN_OUTCOME + 4) + '…' : o}): read it again and write C<n> or none: <reason>`;
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
  // 2026-11-19: every place of one function, by its label on the list or by its bare or Type.name form.
  const fn = /^fn:(.+)$/i.exec(w);
  if (fn) {
    const want = fn[1].trim();
    return { pick: p => { const l = readLabel(p.fn); return p.fn === want || Boolean(l && (l.bare === want || (l.scope && `${l.scope}.${l.bare}` === want))); }, explicit: false };
  }
  throw usage(`--set: "${w}" is not P<n>[,P<m>], file:<path>, name:<name> or fn:<function>`);
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
    const closed = [], nums = [];
    for (let i = 0; i < rows.length; i++) {
      const m = PLACE.exec(rows[i]);
      if (!m) continue;
      const p = { n: Number(m[1]), mark: m[2] || '', name: m[3], file: m[4], fn: m[5] || FILE_PART, lines: m[6].trim(), outcome: m[7].trim() };
      // A (gone) place is written only when it is named by number (2026-11-18: one that no file uses any more has
      // no outcome and stays open until `none: <reason>` is written on it).
      // An outcome set aside by the tool (`was: …`, 2026-11-19) is no outcome: file:, name: and fn: fill it too.
      if ((p.mark === 'gone' && !sel.explicit) || !sel.pick(p) || (!sel.explicit && p.outcome && !WAS.test(p.outcome))) continue;
      if (p.mark === 'changed') p.mark = '';
      rows[i] = placeLine({ ...p, outcome });
      closed.push(`P${p.n} · ${where(p)}`);
      nums.push(p.n);
      n++;
    }
    if (!n) throw usage(`--set ${which}: no ${sel.explicit ? '' : 'open '}place matches`);
    counts.push({ which, outcome, n, closed, nums });
  }
  fs.writeFileSync(file, rows.join(text.includes('\r\n') ? '\r\n' : '\n'));
  return counts;
}

// 2026-11-19: an outcome written with --close was judged on the code as it is now, so the hash of that code is
// stored for each place it closed: a later change of its use lines reopens it, and the edits made between the last
// refresh and the close do not. Only the `Uses:` line of the file changes. false when the stored repo is gone: the
// hashes of the last refresh then stand. (An outcome typed by hand has no such moment: it is compared with the code
// of the last refresh.)
export function stampUses(file, numbers) {
  const text = fs.readFileSync(file, 'utf8');
  const list = parsePlaces(text);
  if (!list || !numbers.length || !fs.existsSync(list.repo)) return false;
  const now = writePlaces({ repo: list.repo, out: file, dry: true });
  const uses = { ...list.uses };
  for (const n of numbers) if (now.uses[n]) uses[n] = now.uses[n];
  const rows = text.split(/\r?\n/);
  const at = rows.findIndex(l => l.startsWith('Uses: ')), after = rows.findIndex(l => l.startsWith('Searched: '));
  if (at < 0 && after < 0) return false;
  if (at >= 0) rows[at] = `Uses: ${JSON.stringify(uses)}`; else rows.splice(after + 1, 0, `Uses: ${JSON.stringify(uses)}`);
  fs.writeFileSync(file, rows.join(text.includes('\r\n') ? '\r\n' : '\n'));
  return true;
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

// 2026-11-18 (repair round): does this live place still use its name as code? A doc or text file never does; in any
// other file, at least one of its listed lines holds the name outside a comment and a string. A file or line that
// cannot be read counts as code (the old rule), never as a leftover.
const DOC_FILE = /\.(?:md|mdx|markdown|txt|rst|adoc|csv|json|ya?ml|html?)$/i;
function liveCode(repo, p) {
  if (DOC_FILE.test(p.file)) return false;
  let lines;
  try { lines = fs.readFileSync(path.join(repo, p.file), 'utf8').split(/\r?\n/); } catch { return true; }
  const nums = [...String(p.lines).matchAll(/\d+/g)].map(m => Number(m[0]));
  if (!nums.length || String(p.lines).includes('more')) return true;
  // A Type.Member name is searched by its member word (2026-11-19), so that word as code counts too.
  const tm = TYPE_MEMBER.exec(p.name);
  const re = new RegExp(`(?<![\\w$])(?:${escapeRe(p.name)}${tm ? '|' + escapeRe(tm[2]) : ''})(?![\\w$])`);
  return nums.some(n => n < 1 || n > lines.length || re.test(codeOnly(lines[n - 1])));
}

export function checkPlaces(list, { checkCount } = {}) {
  const live = list.places.filter(p => p.mark !== 'gone');
  const open = live.map(p => ({ p, why: openReason(p, checkCount) })).filter(x => x.why).map(x => {
    const split = x.why === 'no outcome' ? splitNote(x.p, list.places) : '';
    return split ? { ...x, why: split, split: true } : x;
  });
  // 2026-11-18 (audit): a name that was renamed turned every one of its places (gone) with no outcome, and the
  // check read "0 place(s), 0 open" though the callers still use the rule under its new name. A (gone) place with
  // no outcome stays open while no live place of its name is left: write none: <reason> after its →, or add the
  // new name with --names (its places are then listed) and say so in the reason. One of several places of a name
  // that lost its file is still gone and needs nothing.
  // 2026-11-18 (repair round): one leftover mention of the old name (a spec text, a comment, an alias) kept a live
  // place of the name and switched this off, so P2..P8 stayed (gone) with no outcome and unjudged. A (gone) place
  // with no outcome is open whatever else is live: it never had an outcome, so nobody judged it. A gone place that
  // has an outcome stays closed.
  // The older rule stays for a name whose other places are real code (a name that lost one of its files). A leftover
  // that is no code does not count as live: a doc file (a spec text), or a line that is only a comment or a string.
  const liveNames = new Set(live.filter(p => liveCode(list.repo, p)).map(p => p.name));
  for (const p of list.places) {
    if (p.mark === 'gone' && !liveNames.has(p.name) && !String(p.outcome || '').trim()) {
      open.push({ p, why: 'no longer found: add its new name with --names, or write none: <reason> after its →', vanished: true });
    }
  }
  const lines = open.map(({ p, why }) => `OPEN: P${p.n} · ${where(p)}${why === 'no outcome' ? '' : ' — ' + why}`);
  // 2026-11-19: an F line is closed by the tool and counted apart; a place is never shrunk to a count.
  const folded = (list.folded || []).reduce((n, f) => n + f.uses, 0);
  lines.push(`PLACES: ${tally(live.length, open.length, folded)}`);
  return { ok: !open.length, open, count: live.length, folded, text: lines.join('\n') };
}
// "17 place(s), 0 open, 377 folded"; a list with nothing folded reads as before.
const tally = (count, open, folded) => `${count} place(s), ${open} open${folded ? `, ${folded} folded` : ''}`;

function parse(argv) {
  const o = { set: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--add-changed') { o['add-changed'] = true; continue; }
    if (!['--repo', '--names', '--out', '--refresh', '--check', '--check-lines', '--close', '--set', '--unfold', '--base'].includes(k) || argv[i + 1] === undefined) throw usage('Unknown or empty option: ' + k);
    if (k === '--set') {
      const v = argv[++i], eq = v.indexOf('=');
      if (eq < 1) throw usage('--set needs "<which>=<outcome>", e.g. --set "file:src/Other.tsx=none: another screen\'s own state"');
      o.set.push({ which: v.slice(0, eq), outcome: v.slice(eq + 1).trim() });
      continue;
    }
    o[k.slice(2)] = argv[++i];
  }
  if (o.close) {
    if (o.out || o.refresh || o.check || o.unfold || o['add-changed'] || o.base) throw usage('--close goes alone, with its --set options');
    if (!o.set.length) throw usage('--close needs at least one --set "<which>=<outcome>"');
    return o;
  }
  if (o.set.length) throw usage('--set goes with --close');
  if (!o.out && !o.refresh && !o.check) throw usage('give --out (make or update a list), --refresh <list>, --check <list> or --close <list>');
  if (o.out && (o.refresh || o.check)) throw usage('--out makes a list; use --refresh or --check on it in another run');
  if (!o['add-changed'] !== !o.base) throw usage('--add-changed and --base <ref> go together');
  if (o['add-changed'] && !o.out && !o.refresh) throw usage('--add-changed goes with --out or --refresh: it adds names and searches them');
  if (o.out && (!o.repo || (!o.names && !o['add-changed']))) throw usage('--out needs --repo and --names');
  if (o.unfold && !o.refresh) throw usage('--unfold F<n> goes with --refresh <list>');
  if (o.unfold && !/^F\d+(?:\s*,\s*F\d+)*$/i.test(o.unfold.trim())) throw usage(`--unfold: "${o.unfold}" is not F<n>[,F<m>]`);
  if (o['check-lines'] && !o.check) throw usage('--check-lines goes with --check');
  return o;
}

const USAGE = 'Usage: node places.mjs --repo <path> --names <n1,n2,...> --out <places.md> [--add-changed --base <ref>]\n' +
  '       node places.mjs --refresh <places.md> [--repo <path>] [--unfold <F1,F2>] [--add-changed --base <ref>] [--check <places.md> [--check-lines <check.md>]]\n' +
  '       node places.mjs --check <places.md> [--check-lines <check.md>]\n' +
  '       node places.mjs --close <places.md> --set "<P1,P2 | file:<path> | name:<name> | fn:<function>>=<C<n> | none: <reason>>" [--set ...]\n';

// Not a top-level await (2026-11-12): review-brief.mjs imports this file, so this file's own import of
// review-brief.mjs must wait until this module has finished loading, or the two wait on each other (exit 13).
async function main() {
  try {
    const o = parse(process.argv.slice(2));
    if (o.close) {
      const file = path.resolve(o.close);
      // Each place a --set closed is named (2026-11-14: one file: outcome closed 8 places, and one of them, a
      // function the author had not opened, did not fit the reason; listed, it is seen before review).
      const closedNow = [];
      for (const c of closePlaces(file, o.set)) {
        process.stdout.write(`CLOSED: ${c.n} place(s) — ${c.which} → ${c.outcome}\n`);
        for (const p of c.closed) process.stdout.write(`  ${p}\n`);
        closedNow.push(...c.nums);
      }
      // The outcomes are written; a search that fails here only leaves the hashes of the last refresh in place.
      try { stampUses(file, closedNow); } catch { /* the stricter hashes stand */ }
      const { count, open, folded } = checkPlaces(readPlaces(file));
      process.stdout.write(`PLACES: ${tally(count, open.length, folded)} — ${file}\n`);
      return;
    }
    // 2026-11-19 (--add-changed): the changed functions with callers join the names. Names only add, every outcome
    // stays, and the tool writes none.
    let added = [], addNote = '';
    if (o['add-changed']) {
      const repo = path.resolve(o.repo || readPlaces(path.resolve(o.refresh)).repo);
      const has = new Set([...(o.names ? o.names.split(',') : []), ...(o.refresh ? readPlaces(path.resolve(o.refresh)).names : [])].map(s => s.trim()));
      // A bare name already on the list searches every type: its Type.Member form would only repeat places.
      const changed = changedNames(repo, o.base);
      added = changed.names.filter(n => !has.has(n) && !has.has(n.slice(n.lastIndexOf('.') + 1)));
      addNote = `ADDED: ${added.length ? added.join(', ') : 'no name'} — ${changed.names.length} changed function(s) with callers against ${o.base}${added.length ? '; each of their places is open' : ', all on the list already'}\n`
        + (changed.more ? `NOTE: ${changed.more} more changed function(s) were not handed over by size-check.mjs (it gave only its printed rows); add them with --names\n` : '');
    }
    // What a run folded, reopened or could not fold, one line each.
    const folds = (list) => !list ? '' : [
      ...(list.folded || []).map(f => `FOLDED: ${foldLine(f)} — all in ${foldedPath(o.out || o.refresh).replace(/\\/g, '/')}; places.mjs --refresh <list> --unfold F${f.n} lists them as open places\n`),
      ...(list.reopened || []).map(n => `UNFOLDED: ${n} — its type is no longer declared, so its folded uses are open places again; add the new Type.Member with --names\n`),
      ...(list.extensions || []).map(n => `NOT FOLDED: ${n} is an extension method (called on any value): every use of the member word is a place\n`),
    ].join('');
    // 2026-11-17: a run that only writes the list still says which open places an older place was split into.
    // 2026-11-18: and which places of a name no file uses any more (the name may have been renamed).
    const splits = (open) => open.filter(x => x.split || x.vanished).map(({ p, why }) => `OPEN: P${p.n} · ${where(p)} — ${why}\n`).join('');
    // 2026-11-18: a name past the file limit says so: it has one place per file.
    // 2026-11-19: a bare wide name is told how to fold the other types.
    const widths = (wide) => [...(wide || [])].map(([name, n]) => `WIDE: ${name} is used in ${n} files (more than ${MAX_FILES}): one place per declaration, as for any name; close many at once with --close <list> --set "name:${name}=<outcome>"${TYPE_MEMBER.test(name) ? '' : '; write it as Type.Member to fold other types'}\n`).join('');
    if (o.out) {
      const list = writePlaces({ repo: path.resolve(o.repo), names: [...(o.names ? o.names.split(',') : []), ...added], out: path.resolve(o.out) });
      const { count, open, folded } = checkPlaces(list);
      process.stdout.write(`${addNote}${widths(list.wide)}${folds(list)}${splits(open)}PLACES: ${tally(count, open.length, folded)} — written to ${path.resolve(o.out)}; write C<n> or none: <reason> after each →\n`);
    } else {
      let refreshed;
      if (o.refresh) refreshed = refreshPlaces(path.resolve(o.refresh), { repo: o.repo && path.resolve(o.repo), names: added, unfold: o.unfold ? o.unfold.split(',') : [] });
      if (!o.check) {
        const { count, open, folded } = checkPlaces(readPlaces(path.resolve(o.refresh)));
        process.stdout.write(`${addNote}${widths(refreshed && refreshed.wide)}${folds(refreshed)}${splits(open)}PLACES: ${tally(count, open.length, folded)} — refreshed ${path.resolve(o.refresh)}\n`);
      } else {
        let checkCount;
        if (o['check-lines']) {
          if (!fs.existsSync(o['check-lines'])) throw usage('no such check file: ' + o['check-lines']);
          // The brief's own numbering, so C<n> here is C<n> in the brief.
          const { checkLines } = await import('./review-brief.mjs');
          checkCount = checkLines(fs.readFileSync(o['check-lines'], 'utf8')).length;
        }
        const r = checkPlaces(readPlaces(path.resolve(o.check)), { checkCount });
        process.stdout.write(addNote + widths(refreshed && refreshed.wide) + folds(refreshed) + r.text + '\n');
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
