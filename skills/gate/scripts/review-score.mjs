#!/usr/bin/env node
// review-score.mjs — which reviewer seat, and which kind of finding, earn their time.
//
// 2026-11-17: the workflow launches several reviewers per task and nobody measured them. One market tool
// tracks the "resolution rate" (the share of a reviewer's notes that led to a real change) and the kinds of
// findings that repeat. Both come from data the hooks already hold: for each reviewer note the scanner keeps
// its outcome, the seat that wrote it and the checklist line it names (hooks/lib/transcript-scan.js,
// "Reviewer notes"). A note led to a change when its outcome line is `NOTE <n>: fixed — …`.
//
// Usage: node review-score.mjs [--repo <path>] [--transcript <file.jsonl>] [--log] [--repeats]
//   The transcript: --transcript; else, in <home>/.claude/projects/<slug>/, this session's own file (the host
//   names the session in CLAUDE_CODE_SESSION_ID; searched in the other project folders too, and never replaced by
//   another file), else, when no session is named, the newest .jsonl there. <slug> is the absolute path of
//   --repo (default: the current folder) with every character that is not a letter or a digit written as "-".
//   A git worktree has its own folder there: its own path is used, never the main checkout's (the log is the main checkout's).
//   SANAD_PROJECTS_DIR names another projects folder (tests).
//   --log      adds one JSON line { at, repo, branch, session, seats, classes } to <state>/review-log/<slug>.jsonl
//              (<state>: SANAD_STATE_DIR, else <home>/.claude/state). <slug> is the main checkout's, so the
//              worktrees of one repository share a log. A session with no reviewer note adds none.
//   --repeats  reads that log: each class named in 3 or more of the last 10 logged tasks, and each reviewer
//              seat with 10 or more notes of which under 30% led to a change. A task is a session: logged
//              twice, only its newest line counts. An expert seat is never listed: the scanner keeps only
//              the questions it asks the user, which the user answers.
// Exit 0: the score of a readable transcript was printed. 2: a usage error, or no transcript found (the
// --repeats lines need only the log, so they are printed first).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { isMain } from './is-main.mjs';

export const REPEAT_TASKS = 3;   // a class named in this many …
export const LAST_TASKS = 10;    // … of the last this many logged tasks repeats
export const LOW_NOTES = 10;     // a seat with this many notes over the log …
export const LOW_SHARE = 0.3;    // … and under this share that led to a change is low value
const USAGE = 'Usage: node review-score.mjs [--repo <path>] [--transcript <file.jsonl>] [--log] [--repeats]';

/** The folder name the host keeps a project's sessions under: its absolute path, every other character as "-". */
export function slugOf(dir) { return path.resolve(dir).replace(/[^A-Za-z0-9]/g, '-'); }
export function projectsDir() { return process.env.SANAD_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects'); }
export function stateDir() { return process.env.SANAD_STATE_DIR || path.join(os.homedir(), '.claude', 'state'); }

function gitOr(dir, args) {
  try { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim(); } catch { return ''; }
}
/** The work tree a folder is in (a worktree's own folder, never the main checkout); outside git, the folder itself. */
export function workTree(dir) {
  const abs = path.resolve(dir);
  const top = gitOr(abs, ['rev-parse', '--show-toplevel']);
  return top ? path.resolve(top) : abs;
}

/** The folder one repository's log is named by: the main checkout, so every worktree of a repository adds to the
 *  same log (--repeats counts tasks across them). Outside git, or in a bare repository, the folder's own work tree. */
export function mainTree(dir) {
  const tree = workTree(dir);
  const common = gitOr(tree, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return common && path.basename(common) === '.git' ? path.dirname(path.resolve(common)) : tree;
}
export function logFile(repo) { return path.join(stateDir(), 'review-log', slugOf(mainTree(repo)) + '.jsonl'); }

const isFile = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } };
/** The newest .jsonl of a folder, or ''. Its top level only: helper transcripts live in folders below. */
export function newestTranscript(folder) {
  let names;
  try { names = fs.readdirSync(folder); } catch { return ''; }
  let best = null;
  for (const name of names.filter((n) => n.toLowerCase().endsWith('.jsonl')).sort()) {
    let stat;
    try { stat = fs.statSync(path.join(folder, name)); } catch { continue; }
    if (stat.isFile() && (!best || stat.mtimeMs > best.mtimeMs)) best = { file: path.join(folder, name), mtimeMs: stat.mtimeMs };
  }
  return best ? best.file : '';
}
/** A folder's session transcript, or '': this session's own file when the host names the session, else the
 *  newest. The folder as given is tried first, then its work tree (a command run from a subfolder). */
export function findTranscript(dir, sessionId = process.env.CLAUDE_CODE_SESSION_ID) {
  const id = String(sessionId || '').replace(/[^A-Za-z0-9_-]/g, '');
  const folders = [...new Set([path.resolve(dir), workTree(dir)].map((d) => path.join(projectsDir(), slugOf(d))))];
  if (id) {
    for (const folder of folders) { const own = path.join(folder, id + '.jsonl'); if (isFile(own)) return own; }
    // The host names this session but its file is not here (the session started in a subfolder or another
    // checkout): look in the other project folders. The newest file of this folder is some other session: never used.
    let names = [];
    try { names = fs.readdirSync(projectsDir()); } catch { /* no projects folder */ }
    for (const name of names.sort()) { const own = path.join(projectsDir(), name, id + '.jsonl'); if (isFile(own)) return own; }
    return '';
  }
  for (const folder of folders) { const newest = newestTranscript(folder); if (newest) return newest; }
  return '';
}

/** A scan result's reviewer notes per seat ({ notes, fixed, user, open }, in the order the seats first wrote)
 *  and per class named (a count). The scanner keeps each note's seat and class at the note's own index. */
export function scoreOf(scan) {
  const notes = scan && Array.isArray(scan.reviewNotes) ? scan.reviewNotes : [];
  const seatOf = (scan && scan.reviewNoteSeats) || [], classOf = (scan && scan.reviewNoteClasses) || [];
  const seats = {}, classes = {};
  notes.forEach((note, i) => {
    const name = seatOf[i] || 'reviewer';
    const seat = seats[name] || (seats[name] = { notes: 0, fixed: 0, user: 0, open: 0 });
    seat.notes++;
    // A refuted note (the note checker showed it false) is neither open nor a change; its count appears only when above 0.
    if (note.outcome === 'refuted') seat.refuted = (seat.refuted || 0) + 1;
    else seat[note.outcome === 'fixed' ? 'fixed' : note.outcome === 'user' ? 'user' : 'open']++;
    if (note.outcome !== 'refuted' && classOf[i]) classes[classOf[i]] = (classes[classOf[i]] || 0) + 1;
  });
  return { seats, classes };
}

// The largest count first; equal counts by name, so the same data always prints the same line.
const byCount = (counts) => Object.entries(counts).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));

/** The lines printed for a score. */
export function scoreLines({ seats, classes }) {
  const rows = Object.entries(seats);
  if (!rows.length) return ['REVIEW SCORE: no reviewer note in this session'];
  const total = rows.reduce((n, [, s]) => n + s.notes, 0), fixed = rows.reduce((n, [, s]) => n + s.fixed, 0);
  const named = byCount(classes).map(([name, n]) => `${name} ×${n}`);
  return [
    ...rows.map(([name, s]) => `  ${name}: ${s.notes} note(s) → ${s.fixed} fixed, ${s.user} decided by the user, ${s.open} open${s.refuted ? ', ' + s.refuted + ' refuted' : ''}`),
    `REVIEW SCORE: ${total} note(s), ${fixed} led to a change (${Math.round((100 * fixed) / total)}%)`,
    'CLASSES: ' + (named.length ? named.join(', ') : 'none named'),
    // Notes of every seat but the re-check seat (the scanner tags a re-check prompt by its word "re-check").
    `FOUND IN ROUND 1: ${total - (seats['re-check'] ? seats['re-check'].notes : 0)} of ${total}`,
  ];
}

/** Adds one task's line to the repository's log and returns the log's path. */
export function appendLog(repo, entry) {
  const file = logFile(repo);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  return file;
}
const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** The logged tasks, oldest first. A line that does not parse is skipped. A session logged twice (the command
 *  run again, or a second task in one session: its scan holds the first task's notes too) counts once, as its newest line. */
export function readLog(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const tasks = [];
  for (const line of text.split('\n')) {
    let entry = null;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!isMap(entry) || !isMap(entry.seats) || !isMap(entry.classes)) continue;
    const before = entry.session ? tasks.findIndex((t) => t.session === entry.session) : -1;
    if (before !== -1) tasks.splice(before, 1);
    tasks.push(entry);
  }
  return tasks;
}

/** What the log shows over many tasks: the classes that repeat, and the reviewer seats whose notes rarely led to a change. */
export function repeatLines(tasks) {
  const last = tasks.slice(-LAST_TASKS);
  const named = {};
  for (const task of last) for (const [name, n] of Object.entries(task.classes)) if (Number(n) > 0) named[name] = (named[name] || 0) + 1;
  const repeats = byCount(named).filter(([, k]) => k >= REPEAT_TASKS)
    .map(([name, k]) => `REPEAT: ${name} in ${k} of the last ${last.length} tasks — write a check for it in the project's own check script, or a rule for the author`);
  const seats = {};
  for (const task of tasks) for (const [name, s] of Object.entries(task.seats)) {
    const notes = Number(s && s.notes) || 0;
    if (!notes) continue;
    const sum = seats[name] || (seats[name] = { notes: 0, fixed: 0, tasks: 0 });
    sum.notes += notes; sum.fixed += Number(s.fixed) || 0; sum.tasks++;
  }
  // An expert seat's notes are only its questions for the user (the scanner drops its findings): the user
  // answers them, so their share that "led to a change" says nothing about the seat.
  const low = Object.entries(seats).filter(([name, s]) => !name.startsWith('expert') && s.notes >= LOW_NOTES && s.fixed / s.notes < LOW_SHARE)
    .map(([name, s]) => `LOW VALUE: ${name} — ${s.fixed} of ${s.notes} notes led to a change over ${s.tasks} task${s.tasks === 1 ? '' : 's'}`);
  return [...(repeats.length ? repeats : ['REPEATS: none']), ...low];
}

function usage(message) { return Object.assign(new Error(message), { usage: true }); }
function parseArgs(argv) {
  const o = { log: false, repeats: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--log') o.log = true;
    else if (k === '--repeats') o.repeats = true;
    else if ((k === '--repo' || k === '--transcript') && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) o[k.slice(2)] = argv[++i];
    else throw usage('Unknown or empty option: ' + k);
  }
  return o;
}

export function main(argv, out = (line) => process.stdout.write(line + '\n')) {
  const o = parseArgs(argv);
  const repo = workTree(o.repo || '.');
  const repeats = () => { if (o.repeats) repeatLines(readLog(logFile(repo))).forEach(out); };
  let transcript = '';
  if (o.transcript !== undefined) {
    transcript = path.resolve(o.transcript);
    if (!isFile(transcript)) throw usage('cannot read the transcript ' + transcript);
  } else {
    transcript = findTranscript(o.repo || '.');
    if (!transcript) { repeats(); throw new Error(`no transcript found for ${repo} in ${path.join(projectsDir(), slugOf(repo))}`); }
  }
  const { scanTranscript } = createRequire(import.meta.url)('../../../hooks/lib/transcript-scan.js');
  const score = scoreOf(scanTranscript(transcript));
  scoreLines(score).forEach(out);
  if (o.log) {
    const entry = { at: new Date().toISOString(), repo, branch: gitOr(repo, ['branch', '--show-current']), session: path.basename(transcript, '.jsonl'), ...score };
    out(Object.keys(score.seats).length ? 'LOGGED: ' + appendLog(repo, entry) : 'LOGGED: nothing (no reviewer note in this session)');
  }
  repeats();
  return 0;
}

if (isMain(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write('REVIEW SCORE: ' + error.message + '\n' + (error.usage ? USAGE + '\n' : ''));
    process.exitCode = 2;
  }
}
