#!/usr/bin/env node
// reviewer-test.mjs — which reviewer seat catches which kind of fault, measured on a fixed set of cases.
//
// 2026-11-25 (owner, batch x task 1): nobody knew which reviewer seat catches which kind of fault, and a bug that
// escaped a passed review was fixed and forgotten. The case set (skills/gate/reviewer-cases/<case>/) holds, per case:
//   before/        the code before the change (only the files the change and its faults touch)
//   change.patch   the change, as one patch on before/ (git apply)
//   pin.patch      optional: the first reviewed round of the same change, on before/ (for the re-check seat)
//   ticket.md      the ticket text the builder had
//   case.json      { "names": [places names], "close": ["<which>=<outcome>", ...]?, "check": "<check.md text>"? }
//   answer.json    { "family", "source", "faults": [{ id, family, file, lines: [from, to], wrong, grade, place? }],
//                    "margin"?, "notes"?: [{ kind, text, true }], "step"?, "checklist"? }
// The reviewer never sees answer.json: prepare copies only before/, the patches and the ticket into a throwaway
// repository in the temp folder, and the briefs are written outside that repository.
//
// No guard reads anything here. It runs outside tasks: when the workflow changes, or when the owner asks. The model
// runs are never part of a test suite; the tests of this file use saved replies only.
//
// Usage:
//   node reviewer-test.mjs check [--cases <dir>]
//       Every case: the files exist, answer.json is well formed, every patch applies on before/. Exit 1 on a bad case.
//   node reviewer-test.mjs prepare <case> [--cases <dir>] [--work <dir>]
//       Builds <work>/repo (before/ as the base commit on main, the change as one commit on feat/change; no path or
//       branch names the case) and the
//       notes folders, and makes the briefs with the live tools, as a live task does: lines.mjs --from, the check
//       lines (case.json "check", else lines.mjs --seed-check), places.mjs --names and --close, then review-brief.mjs
//       --size big --engine claude and --engine codex. A case with pin.patch also gets the re-check brief
//       (review-brief.mjs --pin on the first round, then --recheck on the change). A case with a fault marked
//       "place" gets the second look's brief (siblings.mjs --brief on the code before the change, where the second
//       look runs in a task). A case with "notes" gets the note check's brief (note-check.mjs --brief on a report
//       that holds those notes; the true note goes first or second by the case's name, noteOrder). Writes, in a
//       control folder outside the work folder (<work>-control), seats.json and one launch text per seat job in
//       launch/, copied from the launch lines the live tools printed, and replies/ for the Claude seats' replies. Prints `SEAT <seat> · <job> · <engine> · <file>` per job.
//   node reviewer-test.mjs score <case> <reply file> --job <job> [--cases <dir>] [--minutes <n>] [--results <dir>]
//       Decides caught, missed or false note by comparing the reply with answer.json. No model call; the same input
//       always gives the same result. With --results, writes <results>/<job>/<case>.json.
//   node reviewer-test.mjs report --results <dir> [--cases <dir>]
//       One table: a row per seat job with its model and effort, a column per family (caught of total), then the
//       false notes and the minutes per review.
//   node reviewer-test.mjs add --from <base>..<head> --ticket <file> --name <case> --step <step id> --checklist <LINE>
//                              [--repo <path>] [--also <file,file>] --sanad <Sanad repository> | --cases <dir>
//       Makes a new case from a real change: before/ holds each changed file at <base> (and each --also file: where a
//       fault sits that the change did not touch, or what a reviewer needs to find it), change.patch is the diff, the
//       ticket is copied, and answer.json is left for the builder to fill (no fault yet; `check` refuses it until it
//       has one). --step names the loop step that should have caught the fault (an id of steps.mjs) and --checklist the
//       review-checklist line it belongs to (one of its existing line names: no new line).
// Jobs: fresh-claude, risk-claude, whole-claude (the Claude seats), fresh-codex, risk-codex, whole-codex (the Codex
// seats), recheck (recheck-reviewer), second-look, note-check.
// Exit 0: done. 1: a bad case (check) or a failed tool run (prepare). 2: a usage error.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';
import { parseVerdicts, judge } from './note-check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CASES = path.resolve(HERE, '..', 'reviewer-cases');
const CHECKLIST = path.resolve(HERE, '..', '..', 'sanad', 'reference', 'review-checklist.md');
const slash = (p) => String(p).replace(/\\/g, '/');
class UsageError extends Error {}
const usage = (m) => new UsageError(m);

// 'other' is for a known fault of a real case that fits no family: listed so a true finding is never a false note.
// A case's own family is never 'other'; a clean case has no fault.
export const FAMILIES = ['access', 'owner', 'query-loop', 'crash', 'shared-value', 'paging', 'double-submit', 'language', 'swallowed-error', 'old-data', 'test-cannot-fail', 'other', 'clean'];
export const GRADES = ['blocker', 'bug', 'gap'];
// Each job: the seat (the agent or Codex role a live review launches), its engine, and what it is scored on.
export const JOBS = {
  'fresh-claude': { seat: 'independent-reviewer', engine: 'claude', kind: 'review', heading: /^## Fresh eyes \(Claude\) — Agent independent-reviewer/ },
  'risk-claude': { seat: 'independent-reviewer', engine: 'claude', kind: 'review', heading: /^## Risk files \(Claude\) — Agent independent-reviewer/ },
  'whole-claude': { seat: 'routine-reviewer', engine: 'claude', kind: 'review', heading: /^## Whole diff \(Claude\) — Agent routine-reviewer/ },
  'fresh-codex': { seat: 'sanad-risk-reviewer', engine: 'codex', kind: 'review', heading: /^## Fresh eyes \(Codex\) — Bash/ },
  'risk-codex': { seat: 'sanad-risk-reviewer', engine: 'codex', kind: 'review', heading: /^## Risk files \(Codex\) — Bash/ },
  'whole-codex': { seat: 'sanad-reviewer', engine: 'codex', kind: 'review', heading: /^## Whole diff \(Codex\) — Bash/ },
  recheck: { seat: 'recheck-reviewer', engine: 'claude', kind: 'review', heading: /^## Re-check, whole diff \(Claude\) — Agent recheck-reviewer/ },
  'second-look': { seat: 'second-look', engine: 'claude', kind: 'place' },
  'note-check': { seat: 'note-checker', engine: 'claude', kind: 'notes' },
};

// ---- the case files -------------------------------------------------------------------------------------------

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`${slash(file)}: ${e.code === 'ENOENT' ? 'missing' : 'not valid JSON'}`); }
}
export function caseDir(name, cases = CASES) {
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(String(name || ''))) throw usage(`a case name is lower-case letters, digits and dashes: ${name}`);
  return path.join(cases, name);
}
// The problems of an answer object, as lines; [] when it is well formed.
export function answerProblems(a) {
  const out = [];
  if (!a || typeof a !== 'object') return ['answer.json is not an object'];
  if (!FAMILIES.includes(a.family) || a.family === 'other') out.push(`family "${a.family}" is not one of ${FAMILIES.filter((f) => f !== 'other').join(', ')}`);
  if (!Array.isArray(a.faults)) return [...out, 'faults is not a list'];
  if (a.family === 'clean' && a.faults.length) out.push('a clean case has no fault');
  if (a.family !== 'clean' && !a.faults.length) out.push('no fault yet: fill answer.json (file, lines, wrong, grade, family)');
  const ids = new Set();
  for (const [i, f] of a.faults.entries()) {
    const at = `fault ${f && f.id ? f.id : i + 1}`;
    if (!f || typeof f !== 'object') { out.push(`${at}: not an object`); continue; }
    if (!/^F\d+$/.test(String(f.id || ''))) out.push(`${at}: id is F<n>`);
    if (ids.has(f.id)) out.push(`${at}: id used twice`);
    ids.add(f.id);
    if (!FAMILIES.includes(f.family) || f.family === 'clean') out.push(`${at}: family "${f.family}" is not a fault family`);
    if (typeof f.file !== 'string' || !f.file || /\\|^\//.test(f.file)) out.push(`${at}: file is a repository path with forward slashes`);
    if (!Array.isArray(f.lines) || f.lines.length !== 2 || !f.lines.every((n) => Number.isInteger(n) && n > 0) || f.lines[0] > f.lines[1]) out.push(`${at}: lines is [from, to]`);
    if (typeof f.wrong !== 'string' || f.wrong.trim().length < 12) out.push(`${at}: wrong is one sentence`);
    if (!GRADES.includes(f.grade)) out.push(`${at}: grade is one of ${GRADES.join(', ')}`);
    if (f.words !== undefined && !(Array.isArray(f.words) && f.words.length && f.words.every((w) => typeof w === 'string' && w.trim().length >= 3))) out.push(`${at}: words is a list of words a note on this fault holds (3 letters or more)`);
  }
  if (a.family !== 'clean' && a.faults.length && !a.faults.some((f) => f && f.family === a.family)) out.push(`no fault of the case's own family ${a.family}`);
  if (a.margin !== undefined && !(Number.isInteger(a.margin) && a.margin >= 0 && a.margin <= 20)) out.push('margin is a whole number from 0 to 20');
  if (a.notes !== undefined) {
    if (!Array.isArray(a.notes) || a.notes.length !== 2 || a.notes.filter((n) => n && n.true === true).length !== 1 || a.notes.filter((n) => n && n.true === false).length !== 1) out.push('notes holds one true note and one false note');
    else for (const n of a.notes) if (!/^(Blocker|Bug|Gap)$/.test(n.kind) || typeof n.text !== 'string' || !/\w\.\w+:\d+/.test(n.text)) out.push('each note has kind Blocker|Bug|Gap and a text that names file:line');
  }
  return out;
}
export function loadCase(name, cases = CASES) {
  const dir = caseDir(name, cases);
  if (!fs.existsSync(dir)) throw usage(`no case ${name} in ${slash(cases)}`);
  const answer = readJson(path.join(dir, 'answer.json'));
  const meta = readJson(path.join(dir, 'case.json'));
  return { name, dir, answer, meta };
}
export function caseNames(cases = CASES) {
  try { return fs.readdirSync(cases, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { return []; }
}

// ---- git in the throwaway repository ---------------------------------------------------------------------------

// No hook of the user's (a global core.hooksPath) runs in the throwaway repository: an empty hooks folder.
let noHooks = '';
function gitId() {
  if (!noHooks) noHooks = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-test-nohooks-'));
  return ['-c', 'user.name=reviewer-test', '-c', 'user.email=reviewer-test@invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', `core.hooksPath=${slash(noHooks)}`];
}
function git(repo, args) { return execFileSync('git', ['-C', repo, ...gitId(), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim(); }
function copyTree(from, to) {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) { fs.mkdirSync(b, { recursive: true }); copyTree(a, b); } else fs.copyFileSync(a, b);
  }
}
function baseRepo(c, repo) {
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  copyTree(path.join(c.dir, 'before'), repo);
  git(repo, ['add', '--all']);
  git(repo, ['commit', '-q', '-m', 'base']);
}
function applyPatch(repo, file, reverse = false) {
  git(repo, ['apply', '--whitespace=nowarn', ...(reverse ? ['-R'] : []), path.resolve(file)]);
}

// One child process of a gate tool; its output, or an error with both streams.
function tool(name, args, cwd) {
  const r = spawnSync(process.execPath, [path.join(HERE, name), ...args], { cwd, encoding: 'utf8', windowsHide: true, timeout: 180000 });
  if (r.status !== 0) throw new Error(`${name} ${args.join(' ')} → exit ${r.status}\n${r.stdout || ''}${r.stderr || ''}`);
  return r.stdout || '';
}

// The sections of a launch.md, by heading: the text under the first heading that matches.
export function launchSection(text, heading) {
  const rows = String(text).replace(/\r/g, '').split('\n');
  const at = rows.findIndex((l) => heading.test(l));
  if (at < 0) return '';
  let end = rows.length;
  for (let i = at + 1; i < rows.length; i++) if (/^## /.test(rows[i])) { end = i; break; }
  return rows.slice(at + 1, end).join('\n').trim();
}

// The live-task notes folder for one brief: the ticket lines, the check lines and the places list of the case.
// names: the places names to search (case.json "names"). Only the names the code at hand holds are searched: a name the
// change adds does not exist before it (the second look's code, a re-check's first round), and a builder lists only
// names that exist. Run again on the same notes folder, the names add to the list (places.mjs).
function seedNotes(c, notes, repo, all = c.meta.names) {
  const names = (Array.isArray(all) ? all : []).filter((n) => {
    try { git(repo, ['grep', '-q', '-w', '-I', '-F', '--', n]); return true; } catch { return false; }
  });
  fs.mkdirSync(notes, { recursive: true });
  const ticketText = path.join(notes, 'ticket-text.md');
  if (!fs.existsSync(path.join(notes, 'lines.md'))) {
    fs.copyFileSync(path.join(c.dir, 'ticket.md'), ticketText);
    tool('lines.mjs', ['--from', ticketText, '--out', path.join(notes, 'lines.md')], notes);
    if (typeof c.meta.check === 'string' && c.meta.check.trim()) fs.writeFileSync(path.join(notes, 'check.md'), c.meta.check.trim() + '\n');
    else tool('lines.mjs', ['--seed-check', '--notes', notes], notes);
  }
  if (!Array.isArray(names) || !names.length) throw new Error(`${c.name}: case.json names no place name`);
  tool('places.mjs', ['--repo', repo, '--names', names.join(','), '--out', path.join(notes, 'places.md')], notes);
  // name: sets fill only the places with no outcome yet (places.mjs --close), so a second run keeps the first outcomes.
  // A set whose places were closed by the first run matches no open place: that is no error here.
  const sets = Array.isArray(c.meta.close) && c.meta.close.length ? c.meta.close : names.map((n) => `name:${n}=C1`);
  for (const s of sets) {
    try { tool('places.mjs', ['--close', path.join(notes, 'places.md'), '--set', s], notes); } catch (e) {
      if (!/no open place matches/.test(e.message)) throw e;
    }
  }
}

export function prepare(name, { cases = CASES, work } = {}) {
  const c = loadCase(name, cases);
  const problems = answerProblems(c.answer);
  if (problems.length) throw new Error(`${name}: ${problems.join('; ')}`);
  // No folder, branch or file name tells the reviewer the case's name or family (it is in the brief's paths).
  const root = work ? path.resolve(work) : fs.mkdtempSync(path.join(os.tmpdir(), 'task-'));
  fs.mkdirSync(root, { recursive: true });
  // Review round (2026-11-25): seats.json, the launch texts and the replies sat in the seat's own work folder, where a
  // seat that lists it found the case's name and earlier seats' replies. They live in a control folder of their own,
  // outside the work folder, and seats.json does not name the case.
  const control = work ? path.resolve(work) + '-control' : fs.mkdtempSync(path.join(os.tmpdir(), 'run-'));
  const repo = path.join(root, 'repo'), notes = path.join(root, 'notes');
  baseRepo(c, repo);
  git(repo, ['checkout', '-q', '-b', 'feat/change']);
  const seats = [];
  const launchDir = path.join(control, 'launch'), replies = path.join(control, 'replies');
  fs.mkdirSync(launchDir, { recursive: true });
  fs.mkdirSync(replies, { recursive: true });
  const keep = (job, text) => {
    if (!text) throw new Error(`${name}: the live tools printed no launch line for ${job}`);
    const file = path.join(launchDir, `${job}.txt`);
    fs.writeFileSync(file, text + '\n');
    // A Codex launch writes its own reply where its -o names it; a Claude seat's reply is saved in replies/.
    const out = (/\s-o\s+"([^"]+)"/.exec(text) || [])[1];
    seats.push({ job, seat: JOBS[job].seat, engine: JOBS[job].engine, launch: slash(file), reply: slash(out || path.join(replies, `${job}.md`)) });
  };
  const pin = path.join(c.dir, 'pin.patch');
  if (fs.existsSync(pin)) {
    // The re-check, as in a task: round 1 is pinned, then the fix is committed on it.
    applyPatch(repo, pin);
    git(repo, ['add', '--all']);
    git(repo, ['commit', '-q', '-m', 'change (round 1)']);
    const rn = path.join(notes, 'recheck');
    seedNotes(c, rn, repo);
    const briefArgs = ['--out', path.join(rn, 'brief.md'), '--ticket', path.join(rn, 'ticket.md'), '--lines', path.join(rn, 'lines.md'), '--check', path.join(rn, 'check.md'), '--repo', repo, '--base', 'main', '--places', path.join(rn, 'places.md'), '--size', 'medium'];
    tool('review-brief.mjs', [...briefArgs, '--pin'], rn);
    applyPatch(repo, pin, true);
    applyPatch(repo, path.join(c.dir, 'change.patch'));
    git(repo, ['add', '--all']);
    git(repo, ['commit', '-q', '-m', 'change (fix)']);
    seedNotes(c, rn, repo);
    tool('review-brief.mjs', [...briefArgs, '--recheck'], rn);
    keep('recheck', launchSection(fs.readFileSync(path.join(rn, 'launch.md'), 'utf8'), JOBS.recheck.heading));
  } else {
    applyPatch(repo, path.join(c.dir, 'change.patch'));
    git(repo, ['add', '--all']);
    git(repo, ['commit', '-q', '-m', 'change']);
  }
  for (const engine of ['claude', 'codex']) {
    const n = path.join(notes, engine);
    seedNotes(c, n, repo);
    tool('review-brief.mjs', ['--out', path.join(n, 'brief.md'), '--ticket', path.join(n, 'ticket.md'), '--lines', path.join(n, 'lines.md'), '--check', path.join(n, 'check.md'), '--repo', repo, '--base', 'main', '--places', path.join(n, 'places.md'), '--size', 'big', '--engine', engine], n);
    const launch = fs.readFileSync(path.join(n, 'launch.md'), 'utf8');
    for (const [job, j] of Object.entries(JOBS)) {
      if (j.kind !== 'review' || job === 'recheck' || j.engine !== engine) continue;
      keep(job, launchSection(launch, j.heading));
    }
  }
  if (c.answer.faults.some((f) => f.place)) {
    // The second look runs before code in a task: on the code before the change.
    const before = path.join(root, 'repo-before');
    git(repo, ['worktree', 'add', '-q', before, 'main']);
    const sn = path.join(notes, 'second-look');
    seedNotes(c, sn, before);
    const out = tool('siblings.mjs', ['--brief', '--notes', sn, '--repo', before], sn);
    const line = (out.match(/^LAUNCH: Agent second-look · prompt: (.*)$/m) || [])[1] || '';
    keep('second-look', line);
  }
  if (Array.isArray(c.answer.notes)) {
    const nn = path.join(notes, 'note-check');
    fs.mkdirSync(nn, { recursive: true });
    const report = path.join(nn, 'review-report.md');
    fs.writeFileSync(report, ['RECOMMEND: FAIL', '', ...noteOrder(name, c.answer.notes).map((x) => `${x.kind} — ${x.text}`), ''].join('\n'));
    const out = tool('note-check.mjs', ['--brief', '--notes', nn, '--reports', report, '--repo', repo], nn);
    const line = (out.match(/^LAUNCH: Agent note-checker · prompt: (.*)$/m) || [])[1] || '';
    keep('note-check', line);
  }
  fs.writeFileSync(path.join(control, 'seats.json'), JSON.stringify({ work: slash(root), repo: slash(repo), seats }, null, 2) + '\n');
  return { root: slash(root), control: slash(control), repo: slash(repo), seats };
}

// ---- scoring ---------------------------------------------------------------------------------------------------

let parser = null;
function reportNotes(text) {
  if (!parser) parser = createRequire(import.meta.url)('../../../hooks/lib/transcript-scan.js');
  return parser.reportNotes(text);
}
// Every file:line a text names: { file, from, to }. `a/b.ts:12`, `b.ts:12-18`, `b.ts:12–18`, `b.ts lines 12-18`.
export function refsOf(text) {
  const out = [];
  const re = /([A-Za-z0-9_.@\/\\-]*[A-Za-z0-9_-]\.[A-Za-z0-9]{1,6})[`*_"')\]]*(?::|\s+lines?\s+|#L)(\d{1,6})(?:\s*[-–]\s*L?(\d{1,6}))?/g;
  for (let m = re.exec(String(text)); m; m = re.exec(String(text))) {
    const from = Number(m[2]), to = m[3] ? Number(m[3]) : from;
    out.push({ file: slash(m[1]).replace(/^\.\//, ''), from: Math.min(from, to), to: Math.max(from, to) });
  }
  return out;
}
// A reply path and a fault path are the same file when one, cut at a folder line, is the end of the other.
export function sameFile(a, b) {
  const x = slash(a).toLowerCase().replace(/^\/+/, ''), y = slash(b).toLowerCase().replace(/^\/+/, '');
  return x === y || x.endsWith('/' + y) || y.endsWith('/' + x);
}
const hits = (ref, f, margin) => sameFile(ref.file, f.file) && ref.from <= f.lines[1] + margin && ref.to >= f.lines[0] - margin;
const firstLine = (t) => String(t).split('\n')[0].slice(0, 200);

// A review reply against the answer. Counted notes: Blocker, Bug and Gap lines (the hooks' parser; a "none" line
// is no note). A note that names a fault's file and a line within its range (± margin) catches that fault. A
// counted note that catches no fault is a false note. A Question or an EXTRA TEST line counts neither way.
// Review round (2026-11-25): a place alone was a catch, whatever the note said. Now:
//  - a `Gap (HYGIENE)` line names no wrong result: it is neither a catch nor a false note;
//  - only the file:line before the note's `— kind:` tail counts (its `also:` inputs are other places);
//  - a fault with `words` is caught only by a note that holds one of them (a fault among several on close lines);
//  - one note catches one fault: the nearest of those it names.
const HYGIENE = /^\s*Gap\s*\(\s*HYGIENE\s*\)/i;
const head = (text) => String(text).split(/\s[—–-]\s*kind:/i)[0];
const saysOne = (f, text) => !Array.isArray(f.words) || !f.words.length || f.words.some((w) => text.toLowerCase().includes(String(w).toLowerCase()));
const distance = (r, f) => Math.max(0, f.lines[0] - r.to, r.from - f.lines[1]);
export function scoreReview(answer, reply) {
  const margin = Number.isInteger(answer.margin) ? answer.margin : 3;
  const notes = reportNotes(reply).filter((n) => /^(Blocker|Bug|Gap)$/.test(n.kind) && !n.none && !HYGIENE.test(n.text));
  const caught = new Map(), falseNotes = [];
  for (const n of notes) {
    const refs = refsOf(head(n.text));
    const found = answer.faults
      .map((f) => ({ f, d: Math.min(...refs.filter((r) => hits(r, f, margin)).map((r) => distance(r, f)), Infinity) }))
      .filter((x) => x.d !== Infinity && saysOne(x.f, n.text) && !caught.has(x.f.id))
      .sort((a, b) => a.d - b.d || (a.f.lines[1] - a.f.lines[0]) - (b.f.lines[1] - b.f.lines[0]));
    // The parser's text is the note line itself, its kind included.
    if (!found.length) {
      // A second note on a fault already caught is no false note; a note that catches nothing is.
      if (!answer.faults.some((f) => caught.has(f.id) && refs.some((r) => hits(r, f, margin)))) falseNotes.push(firstLine(n.text));
      continue;
    }
    caught.set(found[0].f.id, firstLine(n.text));
  }
  return result(answer, caught, falseNotes);
}
// The second look: caught when one of its SIBLING (or SAME JOB / OUTSIDE PR) lines names the file of a fault marked
// "place" (the place the change should have reached). Only those faults are graded; its other lines are hints, not notes.
export function scorePlace(answer, reply) {
  const graded = answer.faults.filter((f) => f.place);
  const caught = new Map();
  for (const row of String(reply).replace(/\r/g, '').split('\n')) {
    if (!/^\s*(?:[-*•]\s+|\d+[.)]\s+)?(?:\*\*)?(?:SIBLING|SAME JOB|OUTSIDE PR)\b/i.test(row)) continue;
    // By its path only (review round: a base name alone, index.ts, matched any file of that name).
    for (const f of graded) {
      const named = refsOf(row).some((r) => sameFile(r.file, f.file) && r.file.includes('/'));
      if (named && !caught.has(f.id)) caught.set(f.id, firstLine(row.trim()));
    }
  }
  // The second look gives hints, not notes: its other lines are not counted either way (the report shows –).
  return { ...result({ ...answer, faults: graded }, caught, []), falseNotes: null };
}
// The order the two notes go into the note check's brief: the true note first or second, by the case's name, so a
// checker that always confirms K1 and refutes K2 is not right by position. prepare and score use the same order.
export function noteOrder(name, notes) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  const list = Array.isArray(notes) ? notes : [];
  return h % 2 ? [...list].reverse() : [...list];
}
// The note check: one true note and one false note. Kept = CONFIRMED or UNSURE; dropped = REFUTED. The true note
// kept is a catch; the false note kept is a false note; the true note dropped is a miss.
// The reply is read as note-check.mjs --record reads it (its own parseVerdicts and judge): a REFUTED with no file:line
// evidence of 12 characters is UNSURE, the false note kept. A reply with no BRIEF line or no verdict at all is no
// answer: nothing is caught (review round: an empty reply scored one catch).
export function scoreNotes(answer, reply, name = '') {
  const notes = noteOrder(name, answer.notes);
  const out = { caught: [], missed: [], falseNotes: [], caughtLines: [], graded: 1, note: '' };
  const verdicts = /^\s*(?:[-*•]\s+)?(?:\*\*)?BRIEF\s+[0-9a-f]{6,}/im.test(String(reply)) ? parseVerdicts(String(reply)) : new Map();
  if (!verdicts.size) {
    out.missed.push('TRUE');
    out.note = 'no answer: the reply has no BRIEF line or no verdict';
    out.families = { [answer.family]: { caught: 0, total: 1 } };
    return out;
  }
  notes.forEach((n, i) => {
    const v = judge({ n: i + 1, kind: n.kind, text: n.text }, verdicts.get(i + 1)).verdict;
    if (n.true && v !== 'REFUTED') { out.caught.push('TRUE'); out.caughtLines.push(`K${i + 1} ${v} — ${firstLine(n.text)}`); }
    if (n.true && v === 'REFUTED') out.missed.push('TRUE');
    if (!n.true && v !== 'REFUTED') out.falseNotes.push(`K${i + 1} ${v} (kept a false note) — ${firstLine(n.text)}`);
  });
  out.families = { [answer.family]: { caught: out.caught.length, total: 1 } };
  return out;
}
function result(answer, caught, falseNotes) {
  const families = {};
  for (const f of answer.faults) {
    const e = families[f.family] || (families[f.family] = { caught: 0, total: 0 });
    e.total++;
    if (caught.has(f.id)) e.caught++;
  }
  return {
    caught: [...caught.keys()], missed: answer.faults.filter((f) => !caught.has(f.id)).map((f) => f.id),
    caughtLines: [...caught.entries()].map(([id, line]) => `${id}: ${line}`), falseNotes, families, graded: answer.faults.length,
  };
}
export function score(c, reply, job) {
  const j = JOBS[job];
  if (!j) throw usage(`--job is one of ${Object.keys(JOBS).join(', ')}`);
  if (j.kind === 'notes') {
    if (!Array.isArray(c.answer.notes)) throw usage(`${c.name} has no notes for the note check`);
    return scoreNotes(c.answer, reply, c.name);
  }
  if (j.kind === 'place') return scorePlace(c.answer, reply);
  return scoreReview(c.answer, reply);
}

// ---- the report ------------------------------------------------------------------------------------------------

// The model and effort of a seat, from its live role file; '?' when it cannot be read.
export function seatModel(seat, home = os.homedir()) {
  try {
    const md = path.join(home, '.claude', 'agents', `${seat}.md`);
    if (fs.existsSync(md)) {
      const t = fs.readFileSync(md, 'utf8');
      return `${(/^model:\s*(\S+)/m.exec(t) || [])[1] || '?'}/${(/^effort:\s*(\S+)/m.exec(t) || [])[1] || '?'}`;
    }
    const t = fs.readFileSync(path.join(home, '.codex', 'agents', `${seat}.toml`), 'utf8');
    return `${(/^model\s*=\s*"([^"]+)"/m.exec(t) || [])[1] || '?'}/${(/^model_reasoning_effort\s*=\s*"([^"]+)"/m.exec(t) || [])[1] || '?'}`;
  } catch { return '?'; }
}
export function readResults(dir) {
  const rows = [];
  for (const job of Object.keys(JOBS)) {
    const d = path.join(dir, job);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.json')).sort()) rows.push({ job, ...readJson(path.join(d, f)) });
  }
  return rows;
}
export function reportText(rows, { home } = {}) {
  const fams = FAMILIES.filter((f) => rows.some((r) => r.families && r.families[f]));
  const head = ['seat · job', 'model/effort', ...fams, 'false notes', 'min/review'];
  const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  for (const job of Object.keys(JOBS)) {
    const mine = rows.filter((r) => r.job === job);
    if (!mine.length) continue;
    const cells = fams.map((f) => {
      const e = mine.reduce((s, r) => { const x = r.families && r.families[f]; return x ? { c: s.c + x.caught, t: s.t + x.total } : s; }, { c: 0, t: 0 });
      return e.t ? `${e.c}/${e.t}` : '–';
    });
    const minutes = mine.filter((r) => typeof r.minutes === 'number');
    const avg = minutes.length ? (minutes.reduce((s, r) => s + r.minutes, 0) / minutes.length).toFixed(1) : '–';
    const falseCount = mine.every((r) => r.falseNotes === null) ? '–' : mine.reduce((s, r) => s + (r.falseNotes || []).length, 0);
    lines.push(`| ${JOBS[job].seat} · ${job} | ${seatModel(JOBS[job].seat, home)} | ${cells.join(' | ')} | ${falseCount} | ${avg} |`);
  }
  return lines.join('\n') + '\n';
}

// ---- add: a new case from a real change -----------------------------------------------------------------------

export function stepIds() {
  const t = fs.readFileSync(path.join(HERE, 'steps.mjs'), 'utf8');
  return [...t.matchAll(/^\s*\{ id: '([a-z-]+)'/gm)].map((m) => m[1]);
}
export function checklistNames(file = CHECKLIST) {
  return [...fs.readFileSync(file, 'utf8').matchAll(/^- `([A-Z][A-Z /-]*[A-Z]):`/gm)].map((m) => m[1]);
}
export function add({ from, ticket, name, step, checklist, repo = process.cwd(), cases, also = [] }) {
  const m = /^([^.\s]+)\.\.([^.\s]+)$/.exec(String(from || ''));
  if (!m) throw usage('--from is <base>..<head>');
  if (!ticket || !fs.existsSync(ticket)) throw usage('--ticket names the ticket text file');
  if (!stepIds().includes(step)) throw usage(`--step is one of ${stepIds().join(', ')}`);
  if (!checklistNames().includes(checklist)) throw usage(`--checklist is one of the review checklist's lines: ${checklistNames().join(', ')}`);
  const dir = caseDir(name, cases);
  if (fs.existsSync(dir)) throw usage(`case ${name} exists already`);
  const run = (args) => execFileSync('git', ['-C', repo, '-c', 'core.quotepath=off', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const base = run(['rev-parse', '--verify', `${m[1]}^{commit}`]).trim(), head = run(['rev-parse', '--verify', `${m[2]}^{commit}`]).trim();
  const files = run(['diff', '--name-only', '--no-renames', '-z', base, head]).split('\0').filter(Boolean);
  if (!files.length) throw usage(`${from} changes no file`);
  fs.mkdirSync(path.join(dir, 'before'), { recursive: true });
  // --also: the files the change did not touch where a fault sits (the place that should have changed), and the
  // files a reviewer needs to find it; each at <base>.
  for (const f of also) if (!/^[^\\:]+$/.test(f) || f.split('/').includes('..')) throw usage(`--also takes repository paths: ${f}`);
  for (const f of [...files, ...also.filter((f) => !files.includes(f))]) {
    let body;
    try { body = execFileSync('git', ['-C', repo, 'show', `${base}:${f}`], { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); } catch {
      if (also.includes(f) && !files.includes(f)) throw usage(`--also ${f} is not in ${base.slice(0, 12)}`);
      continue;   // a file the change adds
    }
    fs.mkdirSync(path.dirname(path.join(dir, 'before', f)), { recursive: true });
    fs.writeFileSync(path.join(dir, 'before', f), body);
  }
  fs.writeFileSync(path.join(dir, 'change.patch'), run(['diff', '--binary', '--no-renames', base, head]));
  fs.copyFileSync(ticket, path.join(dir, 'ticket.md'));
  fs.writeFileSync(path.join(dir, 'case.json'), JSON.stringify({ names: [], from: `${base.slice(0, 12)}..${head.slice(0, 12)}` }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'answer.json'), JSON.stringify({ family: '', source: `real: ${base.slice(0, 12)}..${head.slice(0, 12)}`, step, checklist, faults: [] }, null, 2) + '\n');
  return { dir: slash(dir), files: files.length };
}

// ---- check -----------------------------------------------------------------------------------------------------

export function checkCase(name, cases = CASES) {
  const out = [];
  let c;
  try { c = loadCase(name, cases); } catch (e) { return [e.message]; }
  for (const f of ['ticket.md', 'change.patch']) if (!fs.existsSync(path.join(c.dir, f))) out.push(`${f} missing`);
  if (!fs.existsSync(path.join(c.dir, 'before'))) out.push('before/ missing');
  out.push(...answerProblems(c.answer));
  if (!Array.isArray(c.meta.names) || !c.meta.names.length) out.push('case.json names no place name');
  if (out.length) return out;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-check-'));
  try {
    baseRepo(c, tmp);
    for (const p of ['change.patch', 'pin.patch']) {
      const file = path.join(c.dir, p);
      if (!fs.existsSync(file)) continue;
      try { git(tmp, ['apply', '--check', '--whitespace=nowarn', path.resolve(file)]); } catch (e) { out.push(`${p} does not apply on before/: ${String(e.stderr || e.message).split('\n')[0]}`); }
    }
    if (!out.length) {
      applyPatch(tmp, path.join(c.dir, 'change.patch'));
      for (const f of c.answer.faults) {
        const file = path.join(tmp, f.file);
        if (!fs.existsSync(file)) { out.push(`${f.id}: ${f.file} is not in the changed code`); continue; }
        const n = fs.readFileSync(file, 'utf8').split('\n').length;
        if (f.lines[1] > n) out.push(`${f.id}: lines ${f.lines.join('-')} are past the end of ${f.file} (${n} lines)`);
      }
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  return out;
}

// ---- the command line ------------------------------------------------------------------------------------------

function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) { o._.push(k); continue; }
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw usage(`${k} needs a value`);
    o[k.slice(2)] = argv[++i];
  }
  return o;
}
function main(argv) {
  const [cmd, ...rest] = argv;
  const o = parse(rest);
  const cases = o.cases ? path.resolve(o.cases) : o.sanad ? path.resolve(o.sanad, 'skills', 'gate', 'reviewer-cases') : CASES;
  if (cmd === 'check') {
    let bad = 0;
    const names = caseNames(cases);
    for (const n of names) {
      const p = checkCase(n, cases);
      if (p.length) { bad++; for (const x of p) process.stdout.write(`BAD ${n}: ${x}\n`); } else process.stdout.write(`OK ${n}\n`);
    }
    process.stdout.write(`CASES: ${names.length}, ${bad} bad\n`);
    // Review round: a missing or empty case folder checked nothing; it is no pass.
    if (!names.length) { process.stdout.write(`BAD: no case in ${slash(cases)}\n`); return 1; }
    return bad ? 1 : 0;
  }
  if (cmd === 'prepare') {
    if (o._.length !== 1) throw usage('prepare <case>');
    const r = prepare(o._[0], { cases, work: o.work });
    for (const s of r.seats) process.stdout.write(`SEAT ${s.seat} · ${s.job} · ${s.engine} · ${s.launch} → reply ${s.reply}\n`);
    process.stdout.write(`PREPARED ${o._[0]}: ${r.root}\n`);
    return 0;
  }
  if (cmd === 'score') {
    if (o._.length !== 2 || !o.job) throw usage('score <case> <reply file> --job <job>');
    const c = loadCase(o._[0], cases);
    const reply = fs.readFileSync(o._[1], 'utf8');
    const r = score(c, reply, o.job);
    if (o.minutes !== undefined) { const n = Number(o.minutes); if (!Number.isFinite(n) || n < 0) throw usage('--minutes is a number'); r.minutes = n; }
    for (const l of r.caughtLines) process.stdout.write(`CAUGHT ${l}\n`);
    for (const id of r.missed) process.stdout.write(`MISSED ${id}\n`);
    for (const l of r.falseNotes || []) process.stdout.write(`FALSE ${l}\n`);
    if (r.note) process.stdout.write(`NOTE ${r.note}\n`);
    process.stdout.write(`SCORE ${o._[0]} · ${o.job}: ${r.caught.length} caught, ${r.missed.length} missed, ${r.falseNotes === null ? 'no' : r.falseNotes.length} false\n`);
    if (o.results) {
      const d = path.join(path.resolve(o.results), o.job);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, `${o._[0]}.json`), JSON.stringify({ case: o._[0], ...r }, null, 2) + '\n');
    }
    return 0;
  }
  if (cmd === 'report') {
    if (!o.results) throw usage('report --results <dir>');
    process.stdout.write(reportText(readResults(path.resolve(o.results))));
    return 0;
  }
  if (cmd === 'add') {
    if (!o.cases && !o.sanad) throw usage('add writes into the Sanad repository: give --sanad <path> (or --cases <dir>)');
    const also = o.also ? String(o.also).split(',').map((s) => s.trim()).filter(Boolean) : [];
    const r = add({ from: o.from, ticket: o.ticket, name: o.name, step: o.step, checklist: o.checklist, repo: o.repo ? path.resolve(o.repo) : process.cwd(), cases, also });
    process.stdout.write(`ADDED ${r.dir}: ${r.files} file(s); fill answer.json (the faults), case.json (the places names), then run: node ${slash(fileURLToPath(import.meta.url))} check --cases ${slash(cases)}\n`);
    return 0;
  }
  throw usage('give one of check, prepare, score, report, add');
}

if (isMain(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) {
    process.stderr.write(`REVIEWER-TEST: ${e.message}\n`);
    process.exitCode = e instanceof UsageError ? 2 : 1;
  }
}
