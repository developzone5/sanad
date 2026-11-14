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
import { enclosingFunction } from './size-check.mjs';
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

// One file's hit lines (1-based) grouped by the function each sits in: Map(function part → lines), in the
// order of each group's first line. `lines` is the file's text as lines, or null when it is not readable.
export function byFunction(file, hitLines, lines) {
  const groups = new Map();
  for (const line of hitLines) {
    const fn = lines && NAMED_FUNCTIONS.test(file) ? enclosingFunction(lines, line - 1) || FILE_PART : FILE_PART;
    if (!groups.has(fn)) groups.set(fn, []);
    groups.get(fn).push(line);
  }
  return groups;
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
  // name → [{ file, fn, lines }], files in path order, each file's functions in the order they first appear.
  const hits = new Map();
  for (const name of all) {
    const rows = [];
    for (const file of [...found.get(name).keys()].sort()) {
      for (const [fn, lines] of byFunction(file, found.get(name).get(file), linesOf(file))) rows.push({ file, fn, lines });
    }
    hits.set(name, rows);
  }
  const key = (name, file, fn) => [name, file, fn || FILE_PART].join('\0');
  const current = new Map();
  for (const [name, rows] of hits) for (const r of rows) current.set(key(name, r.file, r.fn), r.lines);
  const places = [];
  const listed = new Set();
  for (const p of old ? old.places : []) {
    const k = key(p.name, p.file, p.fn);
    listed.add(k);
    const lines = current.get(k);
    if (lines) places.push({ ...p, fn: p.fn || FILE_PART, lines: linesText(lines), mark: p.mark === 'gone' ? '' : p.mark });
    else places.push({ ...p, fn: p.fn || FILE_PART, lines: 'none', mark: 'gone' });
  }
  let next = places.reduce((n, p) => Math.max(n, p.n), 0) + 1;
  for (const name of all) {
    for (const r of hits.get(name)) {
      if (listed.has(key(name, r.file, r.fn))) continue;
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
    for (let i = 0; i < rows.length; i++) {
      const m = PLACE.exec(rows[i]);
      if (!m) continue;
      const p = { n: Number(m[1]), mark: m[2] || '', name: m[3], file: m[4], fn: m[5] || FILE_PART, lines: m[6].trim(), outcome: m[7].trim() };
      if (p.mark === 'gone' || !sel.pick(p) || (!sel.explicit && p.outcome)) continue;
      rows[i] = placeLine({ ...p, outcome });
      n++;
    }
    if (!n) throw usage(`--set ${which}: no ${sel.explicit ? '' : 'open '}place matches`);
    counts.push({ which, outcome, n });
  }
  fs.writeFileSync(file, rows.join(text.includes('\r\n') ? '\r\n' : '\n'));
  return counts;
}

export function checkPlaces(list, { checkCount } = {}) {
  const live = list.places.filter(p => p.mark !== 'gone');
  const open = live.map(p => ({ p, why: openReason(p, checkCount) })).filter(x => x.why);
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
      for (const c of closePlaces(file, o.set)) process.stdout.write(`CLOSED: ${c.n} place(s) — ${c.which} → ${c.outcome}\n`);
      const { count, open } = checkPlaces(readPlaces(file));
      process.stdout.write(`PLACES: ${count} place(s), ${open.length} open — ${file}\n`);
      return;
    }
    if (o.out) {
      const list = writePlaces({ repo: path.resolve(o.repo), names: o.names.split(','), out: path.resolve(o.out) });
      const { count, open } = checkPlaces(list);
      process.stdout.write(`PLACES: ${count} place(s), ${open.length} open — written to ${path.resolve(o.out)}; write C<n> or none: <reason> after each →\n`);
    } else {
      if (o.refresh) refreshPlaces(path.resolve(o.refresh), { repo: o.repo && path.resolve(o.repo) });
      if (!o.check) {
        const { count, open } = checkPlaces(readPlaces(path.resolve(o.refresh)));
        process.stdout.write(`PLACES: ${count} place(s), ${open.length} open — refreshed ${path.resolve(o.refresh)}\n`);
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
