#!/usr/bin/env node
// notes.mjs — one list of the review notes with the guards' own numbers, and one command to answer them.
//
// 2026-11-19: the author called the scanner by hand 7 times in two days to see which notes the guards still held
// open, 27 notes were about 13 problems, and a question known at 10:47 was asked at 11:29. This tool reads the
// session log with the scanner's own reader (hooks/lib/transcript-scan.js), so its numbers are the guards' NOTE
// numbers, and it asks the scanner before it prints an answer line. It adds no filter and closes nothing itself:
// a note is closed only by the line the guards read, exactly as when the author types it.
//
//   node notes.mjs list [--open] [--json]            the notes, each with number, kind, state, seat, place and text.
//       Notes that name the same file and line form a group G<k>. Every text stays visible and every note keeps
//       its own number. --open: only the notes the guards hold open.
//   node notes.mjs answer [--fixed N19,G3 --what "<what changed and its test>"]
//                         [--user N12 (--decision D3 | --words "<the owner's exact words>")] [--refuted N7]
//       Asks the scanner with the same lines (openNotesAfter). A note that would stay open: its reason is printed,
//       nothing is printed as an answer, exit 1. Else one `NOTE <n>: …` line per note number, on stdout.
//   node notes.mjs ask                               one ASK NOW list: each open Question, each open note that asks
//       the user, each open (RARE) note with no decision; the note's mark [N12] is in the question.
//   node notes.mjs decide --kind note|design|drop-line|one-job|outside|push-now --words "<the owner's exact words>"
//                         [--for N12,N14] [--question "<what was asked>"] --notes <dir>
//       One decision record in <notes>/decisions.json (notes-dir.mjs). Kind note asks the scanner first: words the
//       owner did not type after the report are refused. No guard reads the record.
//   node notes.mjs verdict --review|--gate           the REVIEW or GATE line with its numbers counted from the
//       scanner's notes and the lines file. With an open note it prints FAIL and names it.
// Where the notes come from, on every command: --transcript <file.jsonl>, or --repo <path> (the session of that
// repository), or --notes <dir> alone (the repository its task.json names), or --reports <file1,file2,...> alone
// on a host with no session log (the tool numbers the notes itself, and every answer is marked "not checked
// against the session"). verdict with no flag prints the review line; --kind design-choice is --kind design.
// Exit 0: done. 1: an answer or a decision the guards would not accept, or a FAIL verdict. 2: usage error.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';
import { loadScan, codexUserMessages, findTranscript, transcriptCandidates, sessionHolds, readReport, placeOf, placeGroups, LIST as CHECK_LIST } from './note-check.mjs';

// The notes folder map (task.json, decisions.json) of the same release. An install that lacks it still lists and
// answers notes; a command that needs it then says what is missing.
let store = null, storeError = '';
try { store = await import('./notes-dir.mjs'); } catch (error) { storeError = String(error && error.message).split('\n')[0]; }

const here = path.dirname(fileURLToPath(import.meta.url));
export const NOT_CHECKED = 'not checked against the session';
export const KINDS = ['note', 'design', 'drop-line', 'one-job', 'outside', 'push-now'];
// The printed steps name the design decision `design-choice` (as the git config key sanad.designChoice): the same kind.
const KIND_ALIAS = { 'design-choice': 'design' };
// The same floor as the guards' user line (transcript-scan.js applyOutcome): the owner's words, 8 characters or more.
const MIN_WORDS = 8;
const MAX_SESSIONS = 20;
const RARE = /\(RARE\)/i;
// A rare note is a known limit only when its text shows no effect on access, security, saved data or a ticket line.
const RARE_EFFECT = /\b[TC]\d+\b|\b(?:tickets?|security|access|permissions?|data loss|saved data|delete[sd]?|deleting)\b/i;
export const isRare = (n) => RARE.test(String((n && n.text) || '')) && !RARE_EFFECT.test(String((n && n.text) || ''));
// The verdict line of a FAIL report (as the guards' FAIL_VERDICT): such a report with no readable finding is a Blocker.
const FAIL_REPORT = /^[ \t]*(?:(?:[-*•]|\d{1,3}[.)]|#{1,6}|>)[ \t]+)?[`*_]*RECOMMEND:[`*_ \t]*FAIL(?![|\w])/m;

class UsageError extends Error {}
const usage = (message) => new UsageError(message);
const slash = (p) => String(p).replace(/\\/g, '/');
const quote = (p) => (/\s/.test(p) ? `"${p}"` : p);
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// The groups of a list: open notes with the same place (no case), two or more, numbered G1.. by their first note.
// The place rule and the grouping are note-check.mjs's own (placeOf, placeGroups), so the note check brief shows
// the same groups. Each note of a group gets `group`. A group hides nothing: it only names note numbers.
export { placeOf };
export function groupNotes(notes) {
  for (const n of notes) delete n.group;
  const groups = placeGroups(notes.filter((n) => n.state === 'open'));
  for (const g of groups) for (const n of notes) if (g.notes.includes(n.n)) n.group = g.id;
  return groups;
}

// The notes of report files, numbered by this tool (a host with no session log): every note of every report, in
// order, none merged. A FAIL report with no readable finding gives one Blocker, as the guards do.
function reportFileNotes(files, scan) {
  const out = [];
  for (const file of files) {
    if (!isFile(file)) throw usage('no such report: ' + file);
    const text = readReport(file);
    const classes = [];
    const read = scan.reportNotes(text, classes);
    const seat = path.basename(file);
    if (!read.some((n) => !n.none && /^(?:Blocker|Bug|Gap)$/.test(n.kind)) && FAIL_REPORT.test(text.replace(/\r/g, '').replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, ''))) {
      out.push({ kind: 'Blocker', text: 'the reviewer said FAIL but no finding line could be read: ask it to restate each finding as a line that starts with Blocker, Bug, Gap or Question', seat });
    }
    // A line that only says there is none keeps its number, closed (state 'none'), as the guards keep it.
    // A hygiene note is set aside (state 'hygiene'), by the scanner's own rule (hygieneNote).
    for (const [i, n] of read.entries()) {
      const hygiene = !n.none && typeof scan.hygieneNote === 'function' && scan.hygieneNote(n.kind, classes[i], n.text, n.asks);
      out.push({ kind: n.kind, text: n.text, seat, ...(n.asks ? { asks: true } : {}), ...(n.none ? { none: true } : {}), ...(hygiene ? { hygiene: true } : {}) });
    }
  }
  return out;
}

// Each note with number, seat, kind, state (open | fixed | user | refuted | none | hygiene), answer and place, for this tool, the
// re-check brief and the printed steps. An array; it also carries: source ('session' | 'reports'), transcript,
// groups, checked (false with no session log) and scan (the scanner's own result, for a session).
// transcript: the session log; else repo: the newest session of that repository that holds the reports' notes
// (or, with no reports, that holds any note); else reports alone. Throws a usage error when no notes can be read.
// notes: the task's notes folder. With no transcript, repo or report it names the repository (its task.json).
export function sessionNotes({ repo, transcript, reports = [], notes } = {}) {
  const scan = loadScan();
  const files = reports.map((p) => path.resolve(p));
  let since = 0, searched = false;
  if (transcript === undefined && repo === undefined && !files.length && notes) {
    if (!store) throw usage(`the task of ${slash(notes)} cannot be read (notes-dir.mjs: ${storeError}): give --repo <path> or --transcript <file.jsonl>`);
    const task = store.readTask(path.resolve(notes));
    if (!task) throw usage(`the notes cannot be read: ${slash(notes)} has no task.json that names the repository; give --repo <path>, --transcript <file.jsonl> or --reports <file1,file2,...>`);
    repo = task.repo;
    // A session log that was not written since the task started is another task's: it is never read for this one.
    const started = Date.parse(task.startedAt || '');
    if (Number.isFinite(started)) since = started;
  }
  let found = '';
  if (transcript !== undefined) found = findTranscript({ transcript });
  else if (repo !== undefined) {
    if (typeof scan.scanTranscript !== 'function') throw usage("the hooks' scanner has no scanTranscript: install the hooks of the same release as this script.");
    const candidates = transcriptCandidates(repo).slice(0, MAX_SESSIONS).filter((c) => { try { return fs.statSync(c).mtimeMs >= since; } catch { return false; } });
    const wanted = files.length ? reportFileNotes(files, scan) : null;
    searched = true;
    found = candidates.find((c) => (wanted ? sessionHolds(c, scan, wanted) : ((scan.scanTranscript(c) || {}).reviewNotes || []).length > 0)) || '';
    // A clean review writes no note. The newest session log of the task with a readable scan and zero notes is a
    // known, EMPTY list (sanad.mjs reads it the same way), so the verdict can go on to its other checks.
    if (!found && !wanted) {
      found = candidates.find((c) => { try { const r = scan.scanTranscript(c); return !!r && Array.isArray(r.reviewNotes) && r.reviewNotes.length === 0; } catch { return false; } }) || '';
    }
  }
  let list;
  if (found) {
    const r = scan.scanTranscript(found) || {};
    const seats = r.reviewNoteSeats || [];
    list = (r.reviewNotes || []).map((n, i) => ({
      n: n.n, seat: seats[i] || 'reviewer', kind: n.kind, state: n.outcome || 'open',
      // The scanner keeps the note check's evidence of a refuted note; the words of a fixed or user line are not kept.
      answer: n.outcome === 'refuted' ? n.evidence || '' : '',
      place: placeOf(n.text), text: oneLine(n.text), ...(n.asks ? { asks: true } : {}), ...(n.problem ? { problem: n.problem } : {}),
    }));
    // searched: the log was found by search, not named: the caller shows which one was read.
    Object.assign(list, { source: 'session', transcript: found, checked: true, scan: r, searched });
  } else {
    if (!files.length) throw usage(repo !== undefined ? `no session log of ${slash(repo)} holds a review note: pass --transcript <file.jsonl>, or --reports <files> on a host with no session log` : 'the notes cannot be read: give --transcript <file.jsonl>, --repo <path> or --reports <file1,file2,...>');
    list = reportFileNotes(files, scan).map((n, i) => ({ n: i + 1, seat: n.seat, kind: n.kind, state: n.none ? 'none' : n.hygiene ? 'hygiene' : 'open', answer: '', place: placeOf(n.text), text: oneLine(n.text), ...(n.asks ? { asks: true } : {}) }));
    Object.assign(list, { source: 'reports', transcript: '', checked: false, scan: null });
  }
  list.groups = groupNotes(list);
  list.notes = list;
  return list;
}

// "N19,N25,G3" (also "19", "NOTE 19") as note numbers, a group as each of its notes. An unknown mark is refused.
export function resolveTargets(spec, list) {
  const out = [];
  for (const raw of String(spec || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const g = /^G(\d+)$/i.exec(raw);
    if (g) {
      const group = list.groups.find((x) => x.id === 'G' + Number(g[1]));
      if (!group) throw usage(`no group ${raw.toUpperCase()} among the open notes: run list --open for the groups of now`);
      out.push(...group.notes);
      continue;
    }
    const m = /^(?:NOTE\s*|N)?(\d{1,4})$/i.exec(raw);
    if (!m) throw usage(`'${raw}' is no note mark: write N<number> or G<number>`);
    out.push(Number(m[1]));
  }
  return [...new Set(out)];
}

const isQuestion = (n) => /^Question$/i.test(n.kind) || n.asks === true;
// The owner's words as they go between the quotes of a user line: one line, and no quote mark inside (the guards
// read up to the first closing quote). With a quote mark inside, the longest part without one is used.
export function quotable(words) {
  const flat = oneLine(words);
  if (!/["“”]/.test(flat)) return flat;
  return flat.split(/["“”]/).map((s) => s.trim()).sort((a, b) => b.length - a.length)[0] || '';
}

// The answer lines for a selection, judged by the scanner: { lines: [{ n, line }], refused: [{ n, reason }] }.
// sel: { fixed: [n], what, user: [n], words, refuted: [n] }. With no session log nothing can be asked: only the
// rules that need no log are applied (a Blocker or a Question is never refuted, the text floors).
export function judgeAnswers(list, sel) {
  const scan = loadScan();
  const byN = new Map(list.map((n) => [n.n, n]));
  const lines = [], refused = [];
  const refutable = (list.scan && list.scan.reviewRefutable) || [];
  const add = (n, line) => {
    const note = byN.get(n);
    if (!note) { refused.push({ n, reason: 'no such note in ' + (list.source === 'session' ? 'this session' : 'these reports') }); return; }
    if (note.state !== 'open') { refused.push({ n, reason: 'already closed (' + note.state + ')' }); return; }
    lines.push({ n, line });
  };
  for (const n of sel.fixed || []) add(n, `NOTE ${n}: fixed — ${oneLine(sel.what || '')}`);
  for (const n of sel.user || []) add(n, `NOTE ${n}: user — "${quotable(sel.words || '')}"`);
  for (const n of sel.refuted || []) add(n, `NOTE ${n}: refuted — ${oneLine(((refutable.find((x) => x.n === n) || {}).evidence) || "no note check refuted this note")}`);
  if (list.source === 'session') {
    const still = scan.openNotesAfter(list.scan, lines.map((l) => l.line).join('\n'));
    for (const l of lines) {
      const open = still.find((x) => x.n === l.n);
      if (open) refused.push({ n: l.n, reason: open.problem || 'the guards did not read the line as an answer (a code block mark in the text?)' });
    }
  } else {
    for (const l of lines) {
      const note = byN.get(l.n);
      if ((sel.refuted || []).includes(l.n)) refused.push({ n: l.n, reason: isQuestion(note) || /^Blocker$/i.test(note.kind) ? 'a Blocker or a Question is never closed as refuted: the owner decides it' : 'only a note the note check refuted can be closed as refuted, and this host has no session log that shows the note check' });
      else if ((sel.fixed || []).includes(l.n) && oneLine(sel.what || '').length < 12) refused.push({ n: l.n, reason: 'a fixed line must say what changed and its test (12 characters or more)' });
      else if ((sel.user || []).includes(l.n) && quotable(sel.words || '').length < MIN_WORDS) refused.push({ n: l.n, reason: "a user line needs the user's exact words in quotes (8 characters or more)" });
    }
  }
  return { lines, refused: refused.sort((a, b) => a.n - b.n) };
}

// The decision store of the notes folder (notes-dir.mjs, loaded once at the top of this file). A missing module
// is a named error when a command needs it, never an empty list.
async function decisionStore() {
  if (!store) throw usage(`the decision store cannot be loaded (notes-dir.mjs: ${storeError}): install the gate scripts of the same release`);
  return store;
}
const asList = (d) => (Array.isArray(d) ? d : (d && (d.decisions || d.items || d.list)) || []);
const wordsOf = (d) => String((d && (d.words ?? d.ownerWords ?? d.owner ?? d.answer)) || '');
const notesOf = (d) => ((d && (d.notes ?? d.noteNumbers ?? d.for)) || []).map((x) => Number(String(x).replace(/^\D+/, ''))).filter(Number.isFinite);
export async function readDecisionList(notesDir) {
  if (!notesDir) return [];
  if (!isDir(notesDir)) throw usage('no such notes folder: ' + notesDir);
  const store = await decisionStore();
  return asList(store.readDecisions(notesDir)).map((d) => ({ id: String(d.id || ''), kind: String(d.kind || ''), words: wordsOf(d), notes: notesOf(d), raw: d }));
}

// The ASK NOW list: { ask: [{ n, mark, kind, text, rare, recommended }], decided: [{ n, id, words }] }.
export function askList(list, decisions = [], views = new Map()) {
  const ask = [], decided = [];
  for (const n of list) {
    if (n.state !== 'open') continue;
    const rare = isRare(n);
    if (!isQuestion(n) && !rare) continue;
    const d = decisions.find((x) => x.notes.includes(n.n));
    if (d) { decided.push({ n: n.n, id: d.id, words: d.words }); continue; }
    const recommended = views.get(n.n) || (rare && !isQuestion(n)
      ? 'name it in the PR text as a known limit (fix now only on your word)'
      : '<write your recommended answer here before you send this>');
    ask.push({ n: n.n, mark: `[N${n.n}]`, kind: n.kind, text: n.text, rare, recommended });
  }
  return { ask, decided };
}

// The note checker's view of each note, from <notes>/note-check.md (`NOTE <n> · <label> · <kind> · <text> — <view>`).
function checkerViews(notesDir, list) {
  const views = new Map();
  if (!notesDir || !isFile(path.join(notesDir, CHECK_LIST))) return views;
  for (const row of fs.readFileSync(path.join(notesDir, CHECK_LIST), 'utf8').split(/\r?\n/)) {
    const m = /^NOTE (\d+) · (.+?) · /.exec(row);
    const note = m && list.find((n) => n.n === Number(m[1]));
    if (!note) continue;
    const at = row.indexOf(note.text + ' — ');
    if (at >= 0) views.set(note.n, `the note check says ${m[2]}: ${row.slice(at + note.text.length + 3).trim()}`);
  }
  return views;
}

// The T lines of <notes>/lines.md: how many goals the task has.
function goalCount(notesDir) {
  const file = notesDir && path.join(notesDir, 'lines.md');
  if (!file || !isFile(file)) return null;
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => /^T\d+\.\s/.test(l)).length;
}

// The REVIEW line of loop.md Step 3.5 item 7, counted: bugs = Blocker and Bug notes, fixed = those closed as fixed.
// PASS needs no open note and no untested goal.
export function reviewLine(list, { goals, untested = 0, reviewed = true }) {
  // No finished reviewer run on record: no PASS and no FAIL, the review has not happened.
  if (!reviewed) return { pass: false, open: [], line: NO_REVIEW };
  // A "Bug: none." line (state 'none') is no bug.
  const bugs = list.filter((n) => n.state !== 'none' && /^(?:Blocker|Bug)$/i.test(n.kind));
  const open = list.filter((n) => n.state === 'open');
  const tested = goals - untested;
  const pass = !open.length && untested === 0;
  const names = [...open.map((n) => 'NOTE ' + n.n), ...(untested ? [untested + ' untested goal(s)'] : [])];
  return { pass, open, line: `REVIEW: ${pass ? 'PASS' : 'FAIL'} — bugs ${bugs.length}/${bugs.filter((n) => n.state === 'fixed').length}, goals tested ${tested}/${goals}${tested === goals ? ' ✓' : ''}, untested ${untested}, open: ${names.length ? names.join(', ') : 'none'}` };
}
export const NO_REVIEW = 'REVIEW: INCOMPLETE — no reviewer report on record';
// What an evidence mark says: 'pass', 'fail' or 'unclear'. The one place that defines the accepted forms.
// A mark passes ONLY when the whole value (trimmed, lower case) is one of a short closed list, or such a form followed by
// plain detail after a separator ("pass - 0 warnings", "ok: 215 tests"). Any negation word anywhere is a fail. Else unclear.
const PASS_FORMS = '(?:pass|passed|ok|green|clean|success|✓|✔|0 errors|0 failed|no errors)';
const PASS_MARK = new RegExp('^' + PASS_FORMS + '(?:[ ]*[-–—:;,|(][ ]*[^ ].*)?[.!]?$');
const ZERO_COUNT = /\b(?:0|no|zero)\s+(?:errors?|failures?|failed|failing|warnings?|problems?|issues?)\b|\bwithout\s+(?:errors?|failures?)\b/g;
const NEGATED = /✗|✘|\bnot\b|\bnever\b|n['’]t\b|\bno\s+(?:pass|passed|passing|ok|okay|green|clean|success|successful|succeed|succeeded)\b|\bun(?:successful|pass\w*|ok|clean|green|succe\w+)\b|\b(?:fail\w*|errors?|broken|red|crash\w*|refused|blocked|cannot)\b/;
export function markResult(value) {
  const text = String(value === undefined || value === null ? '' : value).toLowerCase().replace(/\s+/g, ' ').trim();
  if (!text) return 'unclear';
  // A zero count ("0 errors", "no errors") is not an error word; the pass form itself is judged on the whole text.
  if (NEGATED.test(text.replace(ZERO_COUNT, ' '))) return 'fail';
  return PASS_MARK.test(text) ? 'pass' : 'unclear';
}
// The GATE line of the gate skill. The tool counts the review and the goals. Every other mark is the author's own
// evidence: --tests <passed>/<run> and --build, --attack, --security, --ran (a short note of the real result).
// A PASS needs a positive test count with every test passing and every mark given. Otherwise no PASS line is printed.
export const GATE_MARKS = [['build', 'build'], ['attack', 'attack tests'], ['security', 'security'], ['ran', 'ran it']];
export function gateLine(list, { goals, untested = 0, tests, evidence = {}, reviewed = true }) {
  if (!reviewed) return { pass: false, open: [], line: NO_REVIEW.replace('REVIEW', 'GATE') };
  const open = list.filter((n) => n.state === 'open');
  const names = [...open.map((n) => 'NOTE ' + n.n), ...(untested ? [untested + ' untested goal(s)'] : [])];
  if (open.length || untested) return { pass: false, open, line: `GATE: FAIL — review ✗, open: ${names.join(', ')}` };
  const m = /^(\d+)\/(\d+)$/.exec(String(tests || ''));
  if (m && (Number(m[2]) === 0 || Number(m[1]) !== Number(m[2]))) return { pass: false, open, line: `GATE: FAIL — tests ${tests} ✗: a PASS needs at least one test and every test passing` };
  const failed = GATE_MARKS.filter(([k]) => markResult(evidence[k]) === 'fail');
  if (failed.length) return { pass: false, open, line: `GATE: FAIL — ${failed.map(([, label]) => label + ' ✗').join(', ')}` };
  const missing = [...(m ? [] : ['--tests <passed>/<run>']), ...GATE_MARKS.filter(([k]) => markResult(evidence[k]) !== 'pass').map(([k, label]) => `--${k} "<${label}: the real result, saying pass, ok or 0 errors>"`)];
  if (missing.length) return { pass: false, open, line: `GATE: INCOMPLETE — no pass line printed; missing evidence: ${missing.join(', ')}` };
  return { pass: true, open, line: `GATE: PASS — build ✓, tests ${tests} ✓, attack tests ✓, security ✓, ran it ✓, review ✓, goals ${goals}/${goals} ✓` };
}

const VALUE = ['--repo', '--transcript', '--reports', '--notes', '--fixed', '--what', '--user', '--decision', '--words', '--refuted', '--kind', '--for', '--question', '--untested', '--goals', '--tests', '--build', '--attack', '--security', '--ran'];
const FLAG = ['--open', '--json', '--review', '--gate'];
const COMMANDS = ['list', 'answer', 'ask', 'decide', 'verdict'];
function parse(argv) {
  const o = { command: argv[0] };
  if (!COMMANDS.includes(o.command)) throw usage('give one of: ' + COMMANDS.join(', '));
  for (let i = 1; i < argv.length; i++) {
    const k = argv[i];
    if (FLAG.includes(k)) { o[k.slice(2)] = true; continue; }
    if (!VALUE.includes(k) || argv[i + 1] === undefined) throw usage('Unknown or empty option: ' + k);
    o[k.slice(2)] = argv[++i];
  }
  for (const k of ['repo', 'transcript', 'reports', 'notes']) if (o[k] === '') throw usage(`--${k} names nothing`);
  return o;
}

const USAGE = 'Usage: node notes.mjs list [--open] [--json] <source>\n' +
  '       node notes.mjs answer [--fixed N1,G2 --what "<what changed and its test>"] [--user N3 (--decision D1 --notes <dir> | --words "<the owner\'s exact words>")] [--refuted N4] <source>\n' +
  '       node notes.mjs ask [--notes <dir>] <source>\n' +
  '       node notes.mjs decide --kind ' + KINDS.join('|') + ' --words "<the owner\'s exact words>" [--for N1,N2] [--question "<text>"] --notes <dir> [<source>]\n' +
  '       node notes.mjs verdict --review|--gate [--notes <dir>] [--goals <k>] [--untested <n>] [--tests <n>/<n>] <source>\n' +
  '       <source>: --transcript <file.jsonl> | --repo <path> [--reports <file1,file2,...>] | --reports <file1,file2,...> | --notes <dir> alone (the repository of its task.json)\n';

const sourceOf = (o) => ({
  notes: o.notes === undefined ? undefined : path.resolve(o.notes),
  repo: o.repo === undefined ? undefined : path.resolve(o.repo),
  transcript: o.transcript === undefined ? undefined : path.resolve(o.transcript),
  reports: o.reports ? o.reports.split(',').map((s) => s.trim()).filter(Boolean) : [],
});
// The notes of a command. A session log found by search is named on stderr: a second session on the same repository
// has other numbers, and --transcript <file.jsonl> names the right one.
let warn = (s) => process.stderr.write(s);
function readNotes(o) {
  const list = sessionNotes(sourceOf(o));
  if (list.searched) warn(`SESSION: ${slash(list.transcript)} (found by search; --transcript <file.jsonl> names another)\n`);
  return list;
}
const sourceArgs = (o) => [o.transcript && `--transcript ${quote(slash(path.resolve(o.transcript)))}`, o.repo && `--repo ${quote(slash(path.resolve(o.repo)))}`, o.reports && `--reports ${quote(o.reports)}`].filter(Boolean).join(' ');
const headLine = (list, shown) => `NOTES: ${shown} · ` + (list.source === 'session' ? `the guards' NOTE numbers, from ${slash(list.transcript)}` : `numbered by this tool from the report files, ${NOT_CHECKED}`);
const noteRow = (n) => `N${n.n} · ${n.kind}${n.asks && !/^Question$/i.test(n.kind) ? ' (asks the user)' : ''} · ${n.state}${n.answer && n.state === 'refuted' ? ' (' + n.answer + ')' : ''} · ${n.seat} · ${n.text}${n.problem ? ' — still open: ' + n.problem : ''}`;

function runList(o, out) {
  const list = readNotes(o);
  const shown = o.open ? list.filter((n) => n.state === 'open') : [...list];
  if (o.json) {
    out(JSON.stringify({ source: list.source, transcript: list.transcript ? slash(list.transcript) : '', checked: list.checked, notes: shown.map((n) => ({ ...n })), groups: list.groups }, null, 2) + '\n');
    return 0;
  }
  const open = list.filter((n) => n.state === 'open').length;
  const rows = [headLine(list, `${open} open of ${list.length}`)];
  const done = new Set();
  for (const n of shown) {
    if (done.has(n.n)) continue;
    const group = n.group && list.groups.find((g) => g.id === n.group);
    if (!group) { rows.push(noteRow(n)); continue; }
    rows.push(`${group.id} · ${group.place} · ${group.notes.map((x) => 'N' + x).join(', ')} (one place, ${group.notes.length} notes: each text is below and each number is answered)`);
    for (const m of shown.filter((x) => x.group === group.id)) { rows.push('  ' + noteRow(m)); done.add(m.n); }
  }
  // Hygiene notes (2026-11-25, owner): they hold nothing and are not fixed in the loop; the owner reads them at the
  // end, one line each, with the fix cost the reviewer wrote. Shown with --open too: that list is the owner's.
  const hygiene = list.filter((n) => n.state === 'hygiene');
  if (hygiene.length) {
    rows.push(`FOR THE OWNER'S END LIST — ${hygiene.length} hygiene note(s): they hold no stop and no push; each is fixed only if the owner says so`);
    for (const n of hygiene) rows.push(`  N${n.n} · ${n.text}`);
  }
  out(rows.join('\n') + '\n');
  return 0;
}

async function runAnswer(o, out, err) {
  if (!o.fixed && !o.user && !o.refuted) throw usage('answer needs --fixed, --user or --refuted');
  if (o.fixed && !o.what) throw usage('--fixed needs --what "<what changed and its test>"');
  if (o.user && [o.decision, o.words].filter((x) => x !== undefined).length !== 1) throw usage('--user needs one of --decision D<n> or --words "<the owner\'s exact words>"');
  const list = readNotes(o);
  let words = o.words;
  if (o.user && o.decision !== undefined) {
    if (!o.notes) throw usage('--decision needs --notes <dir>, the folder of decisions.json');
    const d = (await readDecisionList(path.resolve(o.notes))).find((x) => x.id.toLowerCase() === String(o.decision).trim().toLowerCase());
    if (!d) throw usage(`no decision ${o.decision} in ${slash(path.resolve(o.notes))}: run decide first`);
    words = d.words;
  }
  const sel = { fixed: o.fixed ? resolveTargets(o.fixed, list) : [], what: o.what, user: o.user ? resolveTargets(o.user, list) : [], words, refuted: o.refuted ? resolveTargets(o.refuted, list) : [] };
  const twice = [...sel.fixed, ...sel.user, ...sel.refuted].filter((n, i, all) => all.indexOf(n) !== i);
  if (twice.length) throw usage(`NOTE ${twice[0]} has two answers in one run: give each note one answer`);
  const judged = judgeAnswers(list, sel);
  const refused = judged.refused;
  // 2026-11-22 (owner): a note the guards accept as answered closes, even when another note of the same run is still
  // open (a fixed note no longer waits for a note that waits for the owner). The open ones are named, and the run
  // still ends with exit 1, so nothing is called done.
  const lines = judged.lines.filter((l) => !refused.some((r) => r.n === l.n));
  if (refused.length) err(refused.map((r) => `STILL OPEN: NOTE ${r.n} — ${r.reason}`).join('\n') + '\n');
  if (!lines.length) { err('NOTES: no answer written: no note of this run was accepted (fix the cause, then run answer again)\n'); return 1; }
  // A group is answered with one text: each of its texts is shown, so one answer never hides a second finding.
  for (const g of list.groups) {
    const hit = g.notes.filter((n) => lines.some((l) => l.n === n));
    if (hit.length > 1) err(`${g.id} · ${g.place} · one answer for ${hit.length} notes, check that it covers each text:\n` + hit.map((n) => `  N${n} · ${list.find((x) => x.n === n).text}`).join('\n') + '\n');
  }
  out(lines.map((l) => l.line).join('\n') + '\n' + (list.checked ? '' : lines.map((l) => `NOT CHECKED: NOTE ${l.n} — ${NOT_CHECKED}`).join('\n') + '\n'));
  err('SEND: these NOTE lines as one message with no tool call, unless the guards of this release read them from this run.\n');
  return refused.length ? 1 : 0;
}

async function runAsk(o, out) {
  const list = readNotes(o);
  const notesDir = o.notes ? path.resolve(o.notes) : '';
  const { ask, decided } = askList(list, await readDecisionList(notesDir), checkerViews(notesDir, list));
  const rows = ask.length ? [`ASK NOW: ${ask.length} question(s) for the owner, in one message${list.checked ? '' : ' (' + NOT_CHECKED + ')'}`] : ['ASK NOW: nothing to ask'];
  ask.forEach((a, i) => rows.push(`${i + 1}. ${a.mark} ${a.rare ? '(rare case) ' : ''}${a.text} · Recommended: ${a.recommended}`));
  for (const d of decided) rows.push(`DECIDED (not asked again): N${d.n} · ${d.id} · "${d.words}"`);
  out(rows.join('\n') + '\n');
  return 0;
}

// The owner's words, for every kind of decision (not only a note): the words must be inside a message the owner typed
// in the session, read with the scanner's own humanWords. Guarded: a scanner without humanWords export, or no session
// log to read, gives null (not checked) and the old behaviour stays. true = found, false = not in any owner message.
const flat = (s) => String(s).toLowerCase().replace(/[\s"'`‘’“”]+/g, ' ').trim();
// exact = true (a design choice): one whole owner message must EQUAL the words (or a question-dialog answer's chosen option
// equals them). A longer message that only contains them ("do not use option B") does not count.
// The question-dialog answers are read by the scanner itself (hooks/lib/transcript-scan.js, askAnswers: both host
// wordings and toolUseResult.answers); it exposes them as reviewDecisions on its scan result. This tool never
// parses the dialog text.
const dialogAnswers = (file, scan) => {
  if (typeof scan.scanTranscript !== 'function') return [];
  try { return ((scan.scanTranscript(file) || {}).reviewDecisions || []).map((d) => String((d && d.text) || '')); } catch { return []; }
};
// Claude first, Codex second (2026-11-20): when no Claude session log of the repository holds the words, the typed
// messages of the newest Codex session of the repository are read (note-check.mjs, codexUserMessages). The exact rule stays.
export function ownerSaid(words, o = {}, exact = false) {
  let repo = o.repo;
  if (!o.transcript && repo === undefined && o.notes && store) { try { const task = store.readTask(path.resolve(o.notes)); repo = task && task.repo; } catch { /* no task */ } }
  const claude = claudeOwnerSaid(words, o, exact, repo);
  if (claude === true || o.transcript || repo === undefined) return claude;
  let said;
  try { said = codexUserMessages(repo); } catch { return claude; }
  if (!said.length) return claude;
  const want = flat(words);
  return said.some((m) => (exact ? flat(m) === want : flat(m).includes(want))) ? true : (claude === null ? false : claude);
}
function claudeOwnerSaid(words, o, exact, repo) {
  let scan;
  try { scan = loadScan(); } catch { return null; }
  if (typeof scan.humanWords !== 'function') return null;
  let file = '';
  try {
    if (o.transcript) file = findTranscript({ transcript: o.transcript });
    else if (repo !== undefined) file = transcriptCandidates(repo).slice(0, MAX_SESSIONS)[0] || '';
  } catch { return null; }
  if (!file || !isFile(file)) return null;
  const want = flat(words);
  for (const row of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!row.trim()) continue;
    let entry; try { entry = JSON.parse(row); } catch { continue; }
    let said = null; try { said = scan.humanWords(entry); } catch { said = null; }
    if (said && (exact ? flat(said) === want : flat(said).includes(want))) return true;
  }
  if (exact && dialogAnswers(file, scan).some((opt) => flat(opt) === want)) return true;
  return false;
}

async function runDecide(o, out, err) {
  o.kind = KIND_ALIAS[o.kind] || o.kind;
  if (!KINDS.includes(o.kind)) throw usage('--kind is one of: ' + KINDS.join(', '));
  if (!o.notes) throw usage('decide needs --notes <dir>, the folder of decisions.json');
  const notesDir = path.resolve(o.notes);
  if (!isDir(notesDir)) throw usage('no such notes folder: ' + notesDir);
  const words = oneLine(o.words || '');
  if (!words) throw usage('decide needs --words "<the owner\'s exact words>"');
  if (o.kind === 'note' && !o.for) throw usage('--kind note needs --for N<n>[,N<n>]: the notes the words answer');
  let targets = [], checked = false;
  if (o.for) {
    const list = readNotes(o);
    targets = resolveTargets(o.for, list);
    if (o.kind === 'note') {
      // The guards' own rule for a user line, asked of the scanner: the words must be in a message the owner typed after the report.
      const { refused } = judgeAnswers(list, { user: targets, words });
      if (refused.length) {
        err(refused.map((r) => `REFUSED: NOTE ${r.n} — ${r.reason}`).join('\n') + '\nNOTES: no decision written\n');
        return 1;
      }
      checked = list.checked;
    }
  } else if (words.length < MIN_WORDS && o.kind === 'one-job') throw usage("--kind one-job needs the owner's own words (8 characters or more), as one-job.mjs --keep does");
  if (o.kind === 'design' && words.length < MIN_WORDS) throw usage("--kind design needs the owner's own words (8 characters or more), found in a message the owner typed");
  // A design choice needs proof: no readable session log, or no owner words in it, is a refusal. Never an author-entered choice.
  if (o.kind === 'design' && ownerSaid(words, o, true) !== true) {
    err(`REFUSED: these words are not in any message the owner typed in this session (or the session log cannot be read): ${words}
NOTES: no decision written
`);
    return 1;
  }
  // A design choice was already checked above, with the exact rule: its words are validated once.
  if (o.kind !== 'note' && o.kind !== 'design' && words.length >= MIN_WORDS && ownerSaid(words, o) === false) {
    err(`REFUSED: these words are not in any message the owner typed in this session: ${words}
NOTES: no decision written
`);
    return 1;
  }
  const store = await decisionStore();
  const same = (await readDecisionList(notesDir)).find((d) => d.kind === o.kind && d.words === words && d.notes.join(',') === targets.join(','));
  let id = same && same.id;
  if (same) out(`ALREADY DECIDED: ${id} (the same kind, words and notes): no second record\n`);
  else {
    const made = store.addDecision(notesDir, { kind: o.kind, question: oneLine(o.question || ''), words, source: o.kind === 'note' ? (checked ? 'session' : NOT_CHECKED) : 'typed by the author', notes: targets.map((n) => 'N' + n) });
    id = String((made && made.id) || (typeof made === 'string' ? made : '') || ((await readDecisionList(notesDir)).pop() || {}).id || '');
    out(`DECIDED: ${id} · ${o.kind} · "${words}"${targets.length ? ' · for ' + targets.map((n) => 'N' + n).join(', ') : ''}${o.kind === 'note' && !checked ? ' · ' + NOT_CHECKED : ''}\n`);
  }
  const shell = words.replace(/"/g, '\\"');
  const script = (name) => quote(slash(path.join(here, name)));
  if (o.kind === 'note') out(`NEXT: node ${script('notes.mjs')} answer --user ${targets.map((n) => 'N' + n).join(',')} --decision ${id} --notes ${quote(slash(notesDir))} ${sourceArgs(o)}\n`);
  if (o.kind === 'one-job') out(`NEXT: node ${script('one-job.mjs')}${o.repo ? ' --repo ' + quote(slash(path.resolve(o.repo))) : ''} --keep "${shell}"\n`);
  if (o.kind === 'drop-line') out(`NEXT: node ${script('lines.mjs')} --drop <T number> --words "${shell}"\n`);
  if (o.kind !== 'note') out(`PR TEXT: Decided by the owner (${id}, ${o.kind}): "${words}"\n`);
  return 0;
}

function runVerdict(o, out) {
  if (o.review && o.gate) throw usage('verdict takes one of --review or --gate');
  if (!o.gate) o.review = true;   // the review line is the default: the printed steps call `verdict --notes <dir>`
  const list = readNotes(o);
  const count = (v, name) => { if (!/^\d{1,5}$/.test(String(v))) throw usage(`${name} is a whole number`); return Number(v); };
  const fromFile = goalCount(o.notes ? path.resolve(o.notes) : '');
  const goals = o.goals !== undefined ? count(o.goals, '--goals') : fromFile;
  if (goals === null) throw usage('the goals cannot be counted: give --notes <dir> with its lines.md, or --goals <k>');
  const untested = o.untested === undefined ? 0 : count(o.untested, '--untested');
  if (untested > goals) throw usage('--untested is larger than the number of goals');
  if (o.gate && o.tests !== undefined && !/^\d+\/\d+$/.test(o.tests)) throw usage('--tests is <passed>/<run>, as 412/412');
  // A finished reviewer run on record, read as sanad.mjs reads it (reviewsOf). No scan, or no run: not reviewed.
  const runs = list.scan && Array.isArray(list.scan.reviews) ? list.scan.reviews.filter((r) => r && r.launchAt && r.doneAt) : [];
  const reviewed = runs.length > 0;
  const v = o.review ? reviewLine(list, { goals, untested, reviewed }) : gateLine(list, { goals, untested, reviewed, tests: o.tests, evidence: { build: o.build, attack: o.attack, security: o.security, ran: o.ran } });
  out(v.line + '\n' + v.open.map((n) => `OPEN: NOTE ${n.n} (${n.kind}): ${n.text.slice(0, 140)}`).join('\n') + (v.open.length ? '\n' : '') + (list.checked ? '' : `NOT CHECKED: ${NOT_CHECKED}\n`));
  return v.pass ? 0 : 1;
}

export async function main(argv = process.argv.slice(2), out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s)) {
  try {
    const o = parse(argv);
    warn = err;
    if (o.command === 'list') return runList(o, out);
    if (o.command === 'answer') return await runAnswer(o, out, err);
    if (o.command === 'ask') return await runAsk(o, out);
    if (o.command === 'decide') return await runDecide(o, out, err);
    return runVerdict(o, out);
  } catch (error) {
    // A refusal of this tool, of note-check.mjs or of the notes folder store is a usage error; anything else is a crash, with its stack.
    const named = error instanceof UsageError || /^(?:UsageError|NotesError)$/.test((error && error.constructor && error.constructor.name) || '');
    err('NOTES: ' + error.message + '\n' + (named ? USAGE : String(error.stack || '') + '\n'));
    return 2;
  }
}

if (isMain(import.meta.url)) process.exitCode = await main();
