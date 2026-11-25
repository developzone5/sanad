#!/usr/bin/env node
// sanad.mjs — prints what is due for the task, from the records of the current tree. It only prints.
//
//   node sanad.mjs start --repo <repo> --notes <dir> [--base <ref>] [--engine claude|codex] [--ticket <file>]
//                        [--suite <words of the full-suite command>] [--suite-ci <CI job>]
//                        [--side <name> [--cwd <dir>] [--server] [--fix-files <a,b>] -- <test command>]
//   node sanad.mjs next    [--repo <repo>] [--notes <dir>] [--last]   the steps due now, with whole commands
//   node sanad.mjs status  [--repo <repo>] [--notes <dir>]            real numbers only
//   node sanad.mjs ready   [--repo <repo>] [--notes <dir>]            the required list, done or not, for this tree
//   node sanad.mjs owed    [--repo <repo>] [--notes <dir>]            what a push-now decision left open
//   node sanad.mjs pr-body [--repo <repo>] [--notes <dir>] [--out <file>]   the evidence block for the PR text
//
// 2026-11-19: the notes folder was picked by hand, the path lists were typed three times a round, three
// files gave three step orders, the owner heard "10 minutes" when 28 were left, a suite ran four times,
// and a push went out with the proof at 7 of 48. So one command prints the steps with every path filled.
//
// Rules of this file:
// - A step is done only by facts read from saved files and records (the lists' own open lines, the proof
//   record, the review pins, the evidence receipts). A done mark typed into task.json is never read.
// - It starts no process but git, and runs no check: every printed command is typed by the author, so
//   the guards see it in the session log as today.
// - A missing or broken record file reads as "not done". No command here stops on one.
// - `next` reads no file of the repository; with more than 200 untracked files it says so and reads no
//   proof record for that tree.
import cp from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMain } from './is-main.mjs';
import { parseSiblings, jobOpenReason } from './siblings.mjs';
import { requestStart, report as timerReport } from './sanad-timer.mjs';
import { readRecord, codeFingerprint, recordKey, oldEntries } from './proof-record.mjs';
import { foreignLine as foreignText } from './change-set.mjs';
import { beforeProofPassed, notesInputs, BEFORE_PROOF_FILES } from './pre-review-cache.mjs';
import { due, render, switchLines, stopRound, askOwner, pathFor, GATE_DIR, q } from './steps.mjs';

export const EVIDENCE_OPEN = (tree) => `<!-- sanad-evidence tree=${tree} -->`;
export const EVIDENCE_CLOSE = '<!-- /sanad-evidence -->';
export const EVIDENCE_MARK = /<!-- sanad-evidence tree=([0-9a-f]*) -->/;
const FOREIGN_LIMIT = 200;

// The only process this file starts. cp.execFileSync is read at call time, so a test can swap it.
function git(repo, args) {
  try { return cp.execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).replace(/\r?\n$/, ''); }
  catch { return null; }
}
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const listOf = (j, key) => (Array.isArray(j) ? j : Array.isArray(j?.[key]) ? j[key] : []).filter((x) => x && typeof x === 'object');
const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const stateDir = () => process.env.SANAD_STATE_DIR || path.join(os.homedir(), '.claude', 'state');
// The shared stores of the notes folder (notes-dir.mjs). Used when it is installed; never needed to read.
const notesDir = await import('./notes-dir.mjs').catch(() => null);
// The size tool, to judge the change as it is now (the tests-only lane).
const sizeTool = await import('./size-check.mjs').catch(() => null);
// The notes with the guards' own numbers (notes.mjs reads the session log with the scanner's reader).
// Loaded only when the notes are read (after the first review, and for status, ready, owed and pr-body):
// `next` before the review loads neither.
let notesTool = null, noteCheck = null;
export async function loadNotesTools() {
  notesTool ||= await import('./notes.mjs').catch(() => null);
  noteCheck ||= await import('./note-check.mjs').catch(() => null);
}

// The completed reviewer runs of a scan: [{ launchAt, doneAt }]. Not known gives null.
const reviewsOf = (scan) => (scan && Array.isArray(scan.reviews) ? scan.reviews.filter((r) => r && r.launchAt && r.doneAt) : null);

// A review of a pinned commit counts only when a reviewer run that started after the pin was saved has reported.
// No list of runs, or a pin with no saved time: not shown, so not counted.
// A round of several reviewer seats needs a finished report for each seat: one later report is not the round.
// 2026-11-20: reviewers launched together share one launch time, so a run is told apart by its own launch id,
// never by its time. A seat of the other engine leaves a report file in the notes folder and no scanned run:
// the file counts when it is newer than the pin (`reports`: the times of such files, in ms). When the runs
// carry neither an id nor a seat, the seats of the round cannot be matched: one finished run after the pin is
// the round (the rule the push guard has always used), and `matched` is false so `ready` says so.
// A run launched before the pin is never tied to the round.
const OTHER_SEAT = /\b(?:other|codex|claude)\b/;
const runId = (r) => String(r.id || r.launchId || r.agentId || r.callId || '').trim();
export function reviewProgress(pin, reviews, reports = [], reportFiles = []) {
  const seats = Array.isArray(pin && pin.seats) ? pin.seats.map((s) => String(s || '').trim().toLowerCase()).filter(Boolean) : [];
  const need = Math.max(1, new Set(seats).size);
  const from = Date.parse(pin && pin.at);
  if (!Number.isFinite(from)) return { need, have: 0, matched: true };
  // 2026-11-25 (owner): a medium round is the task's own fresh eyes and one review by the other engine. Each seat
  // counts only its own engine: two runs of the task's engine never fill both seats. The other engine is a report
  // file of the other prefix (`reports`); with no session scan, the task's own seat is a file of its own prefix
  // (`reportFiles` holds both prefixes, so its own files are the ones `reports` does not hold).
  const unique = [...new Set(seats)];
  if (unique.length === 2 && unique.includes('fresh eyes') && unique.includes('other engine')) {
    const newer = (list) => (Array.isArray(list) ? list : []).filter((t) => Number.isFinite(t) && t > from).length;
    const other = newer(reports) > 0 ? 1 : 0;
    const own = Array.isArray(reviews)
      ? (reviews.some((r) => Date.parse(r.launchAt) >= from && Number.isFinite(Date.parse(r.doneAt))) ? 1 : 0)
      : (newer(reportFiles) - newer(reports) > 0 ? 1 : 0);
    return { need: 2, have: own + other, matched: true, ...(Array.isArray(reviews) ? {} : { fromFiles: newer(reportFiles) > 0 }) };
  }
  if (!Array.isArray(reviews)) {
    // 2026-11-20: no session scan, so no run is known. A seat is reported when its report file is newer than the pin.
    const filed = (Array.isArray(reportFiles) ? reportFiles : []).filter((t) => Number.isFinite(t) && t > from).length;
    return { need, have: Math.min(need, filed), matched: true, fromFiles: filed > 0 };
  }
  const after = reviews.filter((r) => Date.parse(r.launchAt) >= from && Number.isFinite(Date.parse(r.doneAt)));
  const wantsOther = [...new Set(seats)].some((s) => OTHER_SEAT.test(s));
  const filed = wantsOther && (Array.isArray(reports) ? reports : []).some((t) => Number.isFinite(t) && t > from);
  if (!after.length) return { need, have: filed ? 1 : 0, matched: true };
  if (after.every((r) => runId(r))) return { need, have: Math.min(need, new Set(after.map(runId)).size + (filed ? 1 : 0)), matched: true };
  if (after.every((r) => typeof r.seat === 'string' && r.seat.trim())) {
    const named = new Set(after.map((r) => r.seat.trim().toLowerCase()));
    return { need, have: Math.min(need, named.size + (filed && ![...named].some((s) => OTHER_SEAT.test(s)) ? 1 : 0)), matched: true };
  }
  return { need, have: need, matched: need <= 1 };
}
export function reviewReported(pin, reviews, reports, reportFiles) {
  const { need, have } = reviewProgress(pin, reviews, reports, reportFiles);
  return have >= need;
}

// The finish times of the reports the other engine left in the notes folder (codex-review.md, codex-whole.md,
// claude-fresh.md, ...). The folder is the one notes-dir.mjs names. An empty file is no report.
function otherReports(dir, engine, every = false) {
  const out = [];
  if (!dir) return out;
  let folder = dir;
  try { const p = notesDir?.paths?.(dir)?.dir; if (typeof p === 'string' && p) folder = p; } catch { /* the folder as given */ }
  const prefix = engine === 'codex' ? 'claude-' : 'codex-';
  // `every`: the reports of both engines (a task run natively in Codex has codex-* seats and a claude-fresh seat).
  const wanted = (n) => n.startsWith(prefix) || (every && (n.startsWith('codex-') || n.startsWith('claude-')));
  try {
    for (const n of fs.readdirSync(folder)) {
      if (!wanted(n.toLowerCase()) || !/\.md$/i.test(n)) continue;
      const st = fs.statSync(path.join(folder, n));
      if (st.isFile() && st.size > 0) out.push(st.mtimeMs);
    }
  } catch { /* none */ }
  return out;
}

// The review notes of the task's session: { known, all }. A session log with no note is a known, empty list.
// No log, or a scanner that cannot be loaded: not known, and nothing is called answered.
function sessionNotesOf(top) {
  try { const list = notesTool.sessionNotes({ repo: top }); return { known: true, all: [...list], reviews: reviewsOf(list.scan) }; } catch { /* maybe a session with no note */ }
  try {
    const newest = noteCheck.transcriptCandidates(top)[0];
    const scan = newest && noteCheck.loadScan().scanTranscript(newest);
    if (scan && Array.isArray(scan.reviewNotes) && !scan.reviewNotes.length) return { known: true, all: [], reviews: reviewsOf(scan) };
  } catch { /* not known */ }
  return { known: false, all: [] };
}

// The work tree pointer: one notes folder per work tree, with no session id, so it works on a Codex host.
const canonical = (top) => { let t = top; try { t = fs.realpathSync.native(top); } catch { /* keep */ } return path.resolve(t).replace(/\\/g, '/').toLowerCase(); };
const pointerFile = (top) => path.join(stateDir(), 'sanad-task', crypto.createHash('sha1').update(canonical(top)).digest('hex').slice(0, 16) + '.json');
export function taskDir(top) {
  try { const d = notesDir?.taskDirOf?.(top); if (typeof d === 'string' && d) return d; } catch { /* the plain file below */ }
  const j = readJson(pointerFile(top));
  return j && typeof j.notes === 'string' ? j.notes : '';
}
function setTaskDir(top, notes) {
  if (notesDir?.setTaskDir) { notesDir.setTaskDir(top, notes); return; }
  fs.mkdirSync(path.dirname(pointerFile(top)), { recursive: true });
  fs.writeFileSync(pointerFile(top), JSON.stringify({ version: 1, top: canonical(top), notes: path.resolve(notes) }, null, 2));
}

// 2026-11-20 (fix round): J lines of siblings.md that carry an outcome and are still open by the rules of
// siblings.mjs --check (a reason after not: that is too short), so `next` and `ready` do not say 0 open while
// pre-review refuses. An unreadable list adds none.
// 2026-11-22 (early review is the default): the review may start when, for the tree under review, a proof log shows
// the passing run ("ran green: exit 0") and the old-code run red ("ran old code: exit <n>", n above 0), while its
// breaks still run (red-proof.mjs writes the log line by line). A log of another tree counts for nothing; with a page
// and a server side, each side needs such a log.
export function proofStartedEarly(logs, tree, sides = 1) {
  if (!tree) return false;
  let early = 0;
  for (const l of logs) {
    const t = readText(l);
    const m = /^RED-PROOF-LOG: tree ([0-9a-f]{40,64}) /m.exec(t);
    if (!m || m[1] !== tree) continue;
    if (/^\s*ran green: exit 0\b/m.test(t) && /^\s*ran old code: exit [1-9]\d*\b/m.test(t)) early++;
  }
  return early > 0 && early >= Math.max(1, sides);
}

export function refusedJobs(text) {
  try {
    const list = parseSiblings(text);
    return list.jobs.filter((r) => r.outcome.trim() && jobOpenReason(r)).length;
  } catch { return 0; }
}

// Open lines of a list file: a P<n>, S<n> or J<n> line whose outcome after the last arrow is empty.
export function openCount(text, letters) {
  const row = new RegExp(`^(?:[-*]\\s+)?[${letters}]\\d+\\b.*→`);
  return text.split(/\r?\n/).filter((l) => row.test(l) && !l.slice(l.lastIndexOf('→') + 1).trim()).length;
}

// The exact command: every word equal, the program compared by its file name (no folder, no .exe). A filtered run
// that only contains the suite words is another command.
// The suite words of the task as a list. A list stays as it is; a line is cut at spaces outside quotes, the way
// q() writes a word that holds a space, so 'spec files/all.mjs' stays one argument.
export function markWords(mark) {
  if (Array.isArray(mark)) return mark.map(String).filter(Boolean);
  // Shell-like cut: quoted parts join the word they touch, so q()'s 'user'\''s test.mjs' is one word: user's test.mjs.
  // A backslash escapes only a quote mark outside quotes; other backslashes (Windows paths) stay as written.
  const out = [];
  const text = String(mark || '').trim();
  let cur = '', has = false, quote = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote) quote = ''; else cur += c; continue; }
    if (c === "'" || c === '"') { quote = c; has = true; continue; }
    if (c === '\\' && (text[i + 1] === "'" || text[i + 1] === '"')) { cur += text[++i]; has = true; continue; }
    if (/\s/.test(c)) { if (has) out.push(cur); cur = ''; has = false; continue; }
    cur += c; has = true;
  }
  if (has) out.push(cur);
  return out;
}
const program = (w) => String(w).replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.(?:exe|cmd|bat)$/, '');
export function sameCommand(words, mark) {
  const want = markWords(mark);
  const got = words.map(String);
  return want.length > 0 && want.length === got.length && program(want[0]) === program(got[0]) && want.slice(1).every((w, i) => w === got[i + 1]);
}

// The full-suite receipts evidence.mjs wrote: passed, the same tree before and after the run.
function suiteReceipt(dirs, mark, tree) {
  if (!mark || !tree) return null;
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.startsWith('check-')); } catch { continue; }
    for (const n of names) {
      const r = readJson(path.join(dir, n, 'metadata.json'));
      if (!r || r.status !== 'passed' || !r.source || r.source.treeBefore !== tree || r.source.treeAfter !== tree) continue;
      if (sameCommand([r.executable, ...(Array.isArray(r.args) ? r.args : [])], mark)) return r;
    }
  }
  return null;
}

// A side of the task with its test command as one shell line (task.json keeps the words).
const sidesOfTask = (task) => (Array.isArray(task?.sides) ? task.sides : []).filter((s) => s && s.name && (Array.isArray(s.testCommand) ? s.testCommand.length : s.test))
  .map((s) => ({ ...s, test: Array.isArray(s.testCommand) ? s.testCommand.map(q).join(' ') : String(s.test) }));

/** Every fact the steps and the lists read, from the notes folder, the state folder and git. */
export function readFacts({ repo, notes, last = false, deep = false, sessionNotes = sessionNotesOf }) {
  const head = (git(repo, ['rev-parse', '--show-toplevel', 'HEAD', 'HEAD^{tree}']) || '').split(/\r?\n/);
  const top = head[0] || path.resolve(repo);
  const dir = notes || taskDir(top);
  const at = (name) => path.join(dir || path.join(os.tmpdir(), 'sanad-no-notes'), name);
  const task = readJson(at('task.json')) || {};
  const sw = {};
  for (const l of (git(top, ['config', '--get-regexp', '^sanad\\.']) || '').split(/\r?\n/)) { const m = /^sanad\.(\S+)\s*(.*)$/i.exec(l); if (m) sw[m[1].toLowerCase()] = m[2]; }
  // Where each owner switch came from: the last line git prints for a key wins.
  const hits = new Map();
  for (const l of (git(top, ['config', '--show-origin', '--show-scope', '--get-regexp', '^sanad\.(ticketrequired|stopround|testsonlylane|designchoice|carrydecision|replayblocks)$']) || '').split(/\r?\n/)) {
    const m = /^(\S+)\t(\S+)\tsanad\.(\S+)\s*(.*)$/i.exec(l);
    if (m) hits.set(m[3].toLowerCase(), { key: m[3], scope: m[1], origin: m[2].replace(/^file:/, ''), value: m[4] });
  }
  const KEYS = { ticketrequired: 'ticketRequired', stopround: 'stopRound', testsonlylane: 'testsOnlyLane', designchoice: 'designChoice', carrydecision: 'carryDecision', replayblocks: 'replayBlocks' };
  const switchHits = [...hits].map(([k, h]) => ({ ...h, key: KEYS[k] || h.key }));
  const on = (v) => /^(?:true|yes|on|1)$/i.test(String(v || ''));
  const base = (typeof task.base === 'string' && task.base) || 'origin/' + (sw.integration || 'staging');
  const status = git(top, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const entries = (status || '').split('\0').filter(Boolean);
  const loose = entries.filter((e) => e.startsWith('?? ')).map((e) => e.slice(3));
  const untracked = loose.length;
  const tracked = entries.filter((e) => !e.startsWith('??') && /^[ MADRCUT?!]{2} /.test(e)).length;
  const clean = status !== null && entries.length === 0;
  const ahead = Number(git(top, ['rev-list', '--count', `${base}..HEAD`]) || 0);
  const tree = clean ? head[2] || '' : '';
  const foreign = untracked > FOREIGN_LIMIT;

  const pins = listOf(readJson(at('review-pin.json')), 'pins');
  const lastPin = pins[pins.length - 1] || null;
  const pinAtHead = Boolean(lastPin && head[1] && lastPin.commit === head[1]);
  const decisions = listOf(readJson(at('decisions.json')), 'decisions');

  // The proof: every entry ended PROVED and holds today's code id. A partial run sets neither.
  const record = foreign ? null : readRecord(top);
  const ents = Object.values(record?.entries || {}).filter(Boolean);
  const proved = ents.filter((e) => e.ok === true && e.code);
  let today = '';
  if (proved.length && !foreign) today = codeFingerprint(top);
  const sides = sidesOfTask(task);
  // A task with two or more sides needs a proved entry of each side's own test command: one side's proof is not the other's.
  const sideProved = (s) => {
    if (!Array.isArray(s.testCommand)) return false;
    const cwd = s.cwd ? path.relative(top, s.cwd).replace(/\\/g, '/') : '';
    const key = recordKey(s.testCommand, cwd);
    return Object.entries(record?.entries || {}).some(([k, e]) => e && e.ok === true && e.code === today
      && (k === key || (Array.isArray(e.command) && e.command.join('\0') === s.testCommand.join('\0') && String(e.cwd || '') === cwd)));
  };
  const missingSides = sides.length >= 2 && !foreign && today ? sides.filter((s) => !sideProved(s)).map((s) => s.name) : [];
  // 2026-11-25 (owner, old proof entries; run 3: one more proof run, test 4: two, with no code change): an entry that is
  // not ok on today's code blocks until each test it named is proved by a newer passing entry on today's code, or is no
  // longer in the tree (proof-record.mjs oldEntries). Never by its age, and never because another entry passed.
  const old = today && !foreign ? oldEntries(top, record, today) : new Map();
  const current = Object.values(record?.entries || {}).filter((e) => e && e.ok === true && e.code && e.code === today);
  // Review (2026-11-25): an ok entry with no code id (the format before 2026-11-17) proves nothing today, so it blocks too.
  const blocking = Object.entries(record?.entries || {}).filter(([k, e]) => e && !(e.ok === true && e.code && e.code === today) && !old.get(k)?.released);
  const proofDone = current.length > 0 && Boolean(today) && !blocking.length && !missingSides.length;
  const oldBlocking = blocking.map(([k, e]) => ({ command: Array.isArray(e.command) ? e.command.join(' ') : '', why: old.get(k)?.why || (old.get(k)?.files || []).filter((x) => !x.released).map((x) => `${x.file}: ${x.why}`).join('; ') || 'not proved on today\'s code' }));
  const logs = (sides.length ? sides : [{ name: 'tests' }]).map((s) => at(`proof-${s.name}.log`));
  const progress = logs.map((l) => readJson(l + '.progress.json')).filter(Boolean);

  const size = readText(at('size.txt')).trim();
  // 2026-11-20: the tests-only lane is judged on the code as it is now, each time. A saved size.json label is
  // never trusted: with product code in the diff the proof is on the required list again.
  // 2026-11-20: a saved `tiny` (the text path) is judged again on the code as it is now, and so is the tests-only
  // switch. Nothing else is judged, and a tree called foreign never is, so `next` stays fast.
  let judged;
  const judge = () => { if (judged === undefined) { try { judged = sizeTool?.sizeTask ? sizeTool.sizeTask({ repo: top, base }) : null; } catch { judged = null; } } return judged; };
  let testsOnly = false;
  if (on(sw.testsonlylane) && !foreign) testsOnly = judge()?.testsOnly === true;
  let lane = size === 'tiny' ? 'text' : ['small', 'medium', 'big'].includes(size) ? size : 'small';
  // A saved `tiny` keeps the text path only while the diff is still tiny: with product code in it, the full path is back.
  if (lane === 'text' && !foreign) { const now = judge(); if (now && ['small', 'medium', 'big'].includes(now.size)) lane = now.size; }
  // A text-path change that adds or changes a test file gets the breaks and proof steps (the tests-only lane has none).
  let textProof = false;
  if (lane === 'text' && !foreign && !(on(sw.testsonlylane) && testsOnly) && typeof sizeTool?.fileKind === 'function') {
    const names = [...(git(top, ['diff', '--name-only', '-z', base, '--']) || '').split('\0'), ...loose].filter(Boolean);
    textProof = names.some((n) => sizeTool.fileKind(n.replace(/\\/g, '/')) === 'test');
  }
  const receiptDirs = [typeof task.receipts === 'string' && task.receipts ? task.receipts : at('evidence')];
  const receipt = suiteReceipt(receiptDirs, task.suite, tree);
  const ci = lane === 'small' && typeof task.suiteCi === 'string' && task.suiteCi ? task.suiteCi : '';

  // The notes matter from the first review on; before it the session log is not read at all.
  let read = { known: false, all: [], reviews: null };
  if (deep || pins.length) { try { const got = sessionNotes(top); read = { known: Boolean(got && got.known), all: Array.isArray(got?.all) ? got.all.filter(Boolean) : [], reviews: Array.isArray(got?.reviews) ? got.reviews : null }; } catch { /* not known */ } }
  const all = read.all;
  // The other engine's report files count as a seat's report when they are newer than the pin.
  const engine = task.engine || readText(at('engine.txt')).trim() || 'claude';
  const reports = pins.length && dir ? otherReports(dir, engine) : [];
  // No session scan (a task run natively in Codex): the seats are counted from the report files of the notes folder.
  const reportFiles = pins.length && dir && !Array.isArray(read.reviews) ? otherReports(dir, engine, true) : [];
  const isOpen = (n) => !n.state || n.state === 'open';
  let breaks = null;
  try { breaks = JSON.parse(fs.readFileSync(at('breaks.json'), 'utf8')); } catch { /* none, or half written */ }
  const breakList = Array.isArray(breaks) ? breaks : Array.isArray(breaks?.breaks) ? breaks.breaks : [];

  let pushed = false;
  if (deep || (receipt || ci) && pinAtHead) { const up = git(top, ['rev-parse', '--verify', '-q', '@{u}']); pushed = Boolean(up && head[1] && up === head[1]); }

  return {
    top, notesDir: dir, task, lane, size, last, base,
    testsOnly, textProof,
    switches: { stopRound: sw.stopround, testsOnlyLane: on(sw.testsonlylane), designChoice: on(sw.designchoice), lateCheckLines: String(sw.latechecklines || '').trim().toLowerCase() !== 'false', remoteHost: sw.remotehost || '' },
    stop: stopRound(sw.stopround), switchHits,
    has: {
      lines: fs.existsSync(at('lines.md')), places: fs.existsSync(at('places.md')), siblings: fs.existsSync(at('siblings.md')),
      check: /\S/.test(readText(at('check.md'))), size: Boolean(size),
      breaks: breakList.length > 0 && breakList.every((b) => b && String(b.find || '').length && b.put !== undefined && b.put !== ''),
    },
    open: { places: openCount(readText(at('places.md')), 'P'), siblings: openCount(readText(at('siblings.md')), 'SJ') + refusedJobs(readText(at('siblings.md')), dir) },
    git: { head: head[1] || '', headTree: head[2] || '', tree, clean, changed: tracked > 0 || untracked > 0, ahead, untracked, foreign, foreignDirs: foreign ? foreignDirs(loose) : [] },
    // A short check after the last round is no round (review-brief.mjs nextCheck, 2026-11-25).
    pins, lastPin, pinAtHead, round: pins.filter((p) => p && !p.short).length, reviewReported: pinAtHead && reviewReported(lastPin, read.reviews, reports, reportFiles), reviewSeats: reviewProgress(lastPin, read.reviews, reports, reportFiles),
    // 2026-11-20 (timed task): every proof log of the folder (proof*.log), so the review step names them all.
    proofLogs: dir ? (() => { try { return fs.readdirSync(dir).filter((n) => /^proof.*\.log$/i.test(n)).sort().map((n) => at(n)); } catch { return []; } })() : [],
    proof: { done: proofDone, missingSides, entries: ents.length, oldBlocking: current.length ? oldBlocking : [], breaks: current.reduce((s, e) => s + (Number(e.breaks) || 0), 0), early: clean && proofStartedEarly(logs, head[2] || '', sides.length), progress, logs },
    // beforeProof (2026-11-23): the last whole `pre-review --before-proof` run passed on the work tree as it is now.
    checks: { code: undefined, all: undefined, beforeProof: !foreign && ahead > 0 && dir ? beforeProofPassed(top, undefined, notesInputs(BEFORE_PROOF_FILES.map((n) => at(n))), base) : false },
    suite: { done: Boolean(receipt || ci), receipt, ci, mark: task.suite || '' },
    notes: { known: read.known, all, open: read.known ? all.filter(isOpen) : [] },
    decisions, pushed,
    selfRead: dir ? String((readJson(at(SELF_READ)) || {}).commit || '') : '',
  };
}

/** The values the command builders fill in: every path of the task. */
export function context(f) {
  return { gate: GATE_DIR, lane: f.lane, repo: f.top, notes: f.notesDir, base: f.base, engine: f.task.engine || readText(path.join(f.notesDir, 'engine.txt')).trim() || 'claude',
    size: f.size, textProof: Boolean(f.textProof), ticket: f.task.ticket || '', sides: sidesOfTask(f.task) };
}

// The folders that hold the untracked files, the largest first, until 200 or fewer are left (at most three),
// from the one status listing: no second git call and no file read.
function foreignDirs(names) {
  const by = new Map();
  for (const name of names) { const at = name.indexOf('/'); const d = at < 0 ? './' : name.slice(0, at + 1); by.set(d, (by.get(d) || 0) + 1); }
  const out = [];
  let left = names.length;
  for (const [d, count] of [...by].sort((a, b) => b[1] - a[1])) { if (left <= FOREIGN_LIMIT || out.length === 3) break; out.push({ dir: d, count }); left -= count; }
  return out;
}
// The one FOREIGN? text every tool prints (change-set.mjs foreignLine), then what it means here.
const foreignLine = (f) => `${foreignText(f.git.foreignDirs)}\n(no proof record was read for this tree)`;

export function nextLines(f) {
  if (!f.notesDir) return ['NEXT: no task here — run: node ' + q(`${GATE_DIR}/sanad.mjs`) + ' start --repo ' + q(f.top.replace(/\\/g, '/')) + ' --notes NOTES-DIR'];
  const steps = due(f);
  const out = [`NEXT — size ${f.size || 'not set (the small path until size.txt exists)'} · round ${f.round} · tree ${f.git.tree ? f.git.tree.slice(0, 10) : 'uncommitted work'}`];
  if (f.git.foreign) out.push(foreignLine(f));
  out.push(...switchLines(f));
  if (!steps.length) out.push('NEXT: nothing is due.');
  return [...out, ...render(steps, context(f), f)];
}

/** The required list for the push: each item done or not done for the current tree. */
export async function readyItems(f) {
  const text = f.lane === 'text';
  const noProof = text && !f.textProof;
  const light = f.testsOnly && f.switches.testsOnlyLane;
  const items = [];
  const add = (id, done, why) => items.push({ id, done: Boolean(done), why });
  add('review', f.pinAtHead && f.reviewReported, f.pinAtHead ? (f.reviewReported ? `round ${f.round} is pinned to HEAD and a reviewer has reported` : f.reviewSeats && f.reviewSeats.need > 1 && f.reviewSeats.have > 0 ? `round ${f.round} is pinned to HEAD, but only ${f.reviewSeats.have} of ${f.reviewSeats.need} reviewer seats have a finished report after the pin` : `round ${f.round} is pinned to HEAD, but no completed reviewer run after the pin is on record`) : f.lastPin ? `the last review read ${String(f.lastPin.commit || '').slice(0, 10)}, HEAD is ${f.git.head.slice(0, 10)}: no re-check of the fix` : 'no pinned review');
  add('notes', f.notes.known && !f.notes.open.length, !f.notes.known ? 'the notes list could not be read' : f.notes.open.length ? `${f.notes.open.length} note(s) open: ${f.notes.open.map((n) => n.n).join(', ')}` : 'every note answered');
  // On the tests-only lane (switch on and tests only) no PROVED proof entry is asked for.
  if (!noProof && !light) add('proof', f.proof.done, f.proof.done ? `${f.proof.breaks} break(s) caught on this tree` : f.git.foreign ? 'not read: too many untracked files' : f.proof.missingSides.length ? `no proof of the side(s): ${f.proof.missingSides.join(', ')}` : f.proof.oldBlocking?.length ? `an older proof entry still blocks: ${f.proof.oldBlocking.slice(0, 2).map((o) => `\`${o.command.slice(0, 100)}\` (${o.why.slice(0, 200)})`).join('; ')}${f.proof.oldBlocking.length > 2 ? ` and ${f.proof.oldBlocking.length - 2} more` : ''}: run that proof again on this tree` : f.proof.entries ? 'the proof record is not for this tree, or a run did not end PROVED (a partial run is no proof)' : 'no proof record');
  add('suite', f.suite.done, f.suite.ci ? `left to CI: ${f.suite.ci}` : f.suite.receipt ? `passed on this tree (${f.suite.receipt.runId || 'receipt'})` : !f.git.tree ? 'uncommitted or untracked work: no receipt can be for this tree' : !f.suite.mark ? 'no suite command named (start --suite)' : 'no passing full-suite receipt for this tree');
  add('ticket lines', f.has.lines && (text || (f.has.check && (light || (f.has.places && !f.open.places && !f.open.siblings)))), !f.has.lines ? 'no lines file' : text ? 'lines file kept' : !f.has.check ? 'no check lines' : light ? 'tests-only: lines and check lines kept' : `${f.open.places} place(s) and ${f.open.siblings} second-look line(s) open`);
  add('one commit', f.git.ahead === 1 && f.git.clean, `${f.git.ahead} commit(s) on ${f.base}${f.git.clean ? '' : ', with uncommitted or untracked work'}`);
  const body = readText(path.join(f.notesDir || '.', 'pr-body.md'));
  let bodyWhy = 'no pr-body.md in the notes folder', bodyOk = false;
  if (body) {
    const { check, placeholders, evidenceProblems } = await import('./check-pr-body.mjs');
    const ev = evidenceProblems(body, f, evidenceBlock(f));
    const bad = [...check(body).map((x) => `parked line ${x.line}`), ...placeholders(body, { blockChecked: !ev.length }).map((x) => `placeholder on line ${x.line}`), ...ev];
    bodyOk = !bad.length; bodyWhy = bad.length ? bad.slice(0, 4).join('; ') : 'clean, the evidence block is for this tree';
  }
  add('PR text', bodyOk, bodyWhy);
  return items;
}

/** What a push the owner ordered left open. A green CI run clears nothing here: only the record does. */
export async function owedItems(f) {
  const push = f.decisions.filter((d) => d.kind === 'push-now' && String(d.words || '').trim() && !/^(?:author|claude|codex|assistant|not checked)/i.test(String(d.source || '')));
  if (!push.length) return { decision: null, items: [] };
  const decision = push[push.length - 1];
  const named = Array.isArray(decision.items) ? decision.items.map(String) : null;
  const open = (await readyItems(f)).filter((i) => !i.done && (!named || named.includes(i.id)));
  return { decision, items: open };
}

/** The evidence block of the PR text: every line from a record, between two lines that name the tree. */
export function evidenceBlock(f) {
  const kinds = f.pins.map((p) => (p.short ? 'short check' : p.kind || 'full')).join(', ');
  const answered = f.notes.all.filter((n) => !f.notes.open.includes(n));
  const by = (re) => answered.filter((n) => re.test(String(n.state || ''))).length;
  const noteNumbers = (d) => (Array.isArray(d.notes) ? d.notes : []).map((x) => Number(String(x).replace(/^\D+/, ''))).filter(Number.isFinite);
  // The full text of each finding a decision covers: the reader sees what was deferred, not only an id and the answer.
  const findingText = (d) => noteNumbers(d).map((n) => f.notes.all.find((x) => x.n === n)).filter((x) => x && x.text).map((x) => ` [N${x.n}: ${String(x.text).replace(/\s+/g, ' ').trim()}]`).join('');
  const words = (kind) => f.decisions.filter((d) => d.kind === kind && String(d.words || '').trim()).map((d) => `${String(d.question || d.id || kind).slice(0, 120)} — the user said "${String(d.words).trim().slice(0, 200)}"${findingText(d)}`);
  const lines = [
    EVIDENCE_OPEN(f.git.headTree),
    `- Lane: ${f.testsOnly && f.switches.testsOnlyLane ? 'tests-only (light path)' : 'normal'}`,
    ...switchLines(f).map((l) => `- ${l}`),
    `- Breaks caught: ${f.lane === 'text' && !f.textProof ? 'none needed (text only)' : f.testsOnly && f.switches.testsOnlyLane ? 'none needed (tests-only light path)' : f.proof.done ? `${f.proof.breaks}, on this tree` : 'NOT PROVEN on this tree'}`,
    `- Suite: ${f.suite.ci ? `left to CI: ${f.suite.ci}` : f.suite.receipt ? 'passed on this tree' : 'NOT RUN on this tree'}`,
    `- Review rounds: ${f.round}${kinds ? ` (${kinds})` : ''}${f.pinAtHead ? '' : ' — the last one did not read this commit'}`,
    `- Notes: ${f.notes.known ? `${by(/^fixed/i)} fixed, ${by(/^user/i)} decided by the user, ${by(/^refuted/i)} refuted, ${f.notes.open.length} open` : 'not read'}`,
    ...words('drop-line').map((w) => `- Dropped line: ${w}`),
    ...words('note').map((w) => `- Decided by the user: ${w}`),
    EVIDENCE_CLOSE,
  ];
  return lines;
}

export async function statusLines(f) {
  const out = [`STATUS — size ${f.size || 'not set'} · tree ${f.git.tree ? f.git.tree.slice(0, 10) : 'uncommitted work'} · ${f.git.ahead} commit(s) on ${f.base}`];
  if (f.git.foreign) out.push(foreignLine(f));
  for (const p of f.proof.progress) {
    const k = p.done ?? p.k, n = p.total ?? p.n ?? p.of, m = p.minutesLeft ?? p.aboutMin ?? p.m;
    if (Number.isFinite(k) && Number.isFinite(n)) out.push(`proof: ${k} of ${n}${Number.isFinite(m) ? `, about ${m} min left` : ''}`);
  }
  out.push(`proof: ${f.proof.done ? `PROVED on this tree, ${f.proof.breaks} break(s) caught` : f.proof.entries ? 'not proved on this tree' : 'no record'}`);
  out.push(`rounds: ${f.round} of ${f.stop} before the stop rule${f.lastPin ? ` · last pin ${String(f.lastPin.commit || '').slice(0, 10)} (${f.lastPin.kind || 'full'})${f.pinAtHead ? '' : ', not HEAD'}` : ''}`);
  const groups = new Map();
  for (const n of f.notes.open) groups.set(n.kind || 'note', (groups.get(n.kind || 'note') || 0) + 1);
  out.push(`open notes: ${f.notes.known ? (f.notes.open.length ? [...groups].map(([k, n]) => `${k} ${n}`).join(', ') : 'none') : 'not read (no notes list in the notes folder)'}`);
  let kept = 'not read';
  try { const pre = await import('./pre-review.mjs'); if (typeof pre.checkStatus === 'function') { const s = pre.checkStatus({ repo: f.top, base: f.base, notes: f.notesDir }); kept = Array.isArray(s) ? s.filter((x) => x && (x.kept || x.pass)).map((x) => x.name).join(', ') || 'none' : String(s); } } catch { /* stays not read */ }
  out.push(`kept checks: ${kept}`);
  out.push(`suite: ${f.suite.ci ? `left to CI: ${f.suite.ci}` : f.suite.receipt ? 'passed on this tree' : 'no passing receipt for this tree'}`);
  const owed = await owedItems(f);
  out.push(`owed: ${owed.decision ? (owed.items.length ? owed.items.map((i) => i.id).join(', ') : 'none') : 'none (no push-now decision)'}`);
  return out;
}

function parse(argv) {
  const o = { cmd: argv[0] || '', repo: '.', notes: '', sideCommand: [] };
  const flags = new Set(['--last', '--server']);
  const known = new Set(['--repo', '--notes', '--base', '--engine', '--ticket', '--suite', '--suite-ci', '--side', '--cwd', '--fix-files', '--out', '--receipts', '--found']);
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { o.sideCommand = argv.slice(i + 1); break; }
    if (flags.has(a)) { o[a.slice(2)] = true; continue; }
    if (!known.has(a) || argv[i + 1] === undefined) throw new Error('Unknown or empty option: ' + a);
    o[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
  }
  return o;
}

export const USAGE = 'Usage: sanad.mjs start --repo <repo> --notes <dir> [--base <ref>] [--engine claude|codex] [--ticket <file>] [--suite <words>] [--suite-ci <job>] [--receipts <dir>] [--side <name> [--cwd <dir>] [--server] [--fix-files <a,b>] -- <test command>]\n       sanad.mjs next|status|ready|owed|pr-body [--repo <repo>] [--notes <dir>] [--last] [--out <file>]\n       sanad.mjs self-read [--repo <repo>] [--notes <dir>] --found <what you found and fixed, or none>';

// 2026-11-22 (owner, PR 3 item 1): the author reads its own diff against the "Every change" lines of review-checklist.md
// and fixes what it finds before the checks, the proof and the review. The record holds the commit read, so a later
// commit makes the step due again. It is the step printer's record only: no guard reads it.
export const SELF_READ = 'self-read.json';
function selfRead(f, found, print) {
  if (!f.notesDir) { print('SANAD: no task for this work tree — run start first'); return 3; }
  if (!f.git.clean || !(f.git.ahead > 0) || !f.git.head) { print('SELF-READ: not recorded — commit the change first: the record is for one commit, and only a clean tree has one'); return 1; }
  const said = String(found || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (said.length < 4) { print('SELF-READ: not recorded — --found needs what you found and fixed, or "none"'); return 2; }
  fs.writeFileSync(path.join(f.notesDir, SELF_READ), JSON.stringify({ commit: f.git.head, found: said, at: new Date().toISOString() }, null, 2) + '\n');
  print(`SELF-READ: recorded for commit ${f.git.head.slice(0, 10)} — ${said}`);
  return 0;
}

function start(o) {
  if (!o.notes) throw new Error('start needs --notes <dir>');
  const top = git(o.repo, ['rev-parse', '--show-toplevel']);
  if (!top) throw new Error('--repo is not a git repository: ' + o.repo);
  const notes = path.resolve(o.notes);
  fs.mkdirSync(notes, { recursive: true });
  const file = path.join(notes, 'task.json');
  const old = readJson(file) || {};
  const task = { version: 1, ...old, repo: top, top: canonical(top), sides: Array.isArray(old.sides) ? old.sides : [], base: o.base || old.base || '', branch: git(top, ['rev-parse', '--abbrev-ref', 'HEAD']) || '', startedAt: old.startedAt || new Date().toISOString() };
  for (const [key, from] of [['engine', 'engine'], ['ticket', 'ticket'], ['suite', 'suite'], ['suiteCi', 'suiteCi'], ['receipts', 'receipts']]) if (o[from]) task[key] = key === 'ticket' || key === 'receipts' ? path.resolve(o[from]) : o[from];
  if (o.side) {
    if (!o.sideCommand.length) throw new Error('--side needs its test command after --');
    const side = { name: o.side, cwd: o.cwd ? path.resolve(o.cwd) : '', testCommand: o.sideCommand, server: Boolean(o.server), fixFiles: o.fixFiles ? o.fixFiles.split(',').filter(Boolean) : [] };
    task.sides = [...task.sides.filter((s) => s && s.name !== side.name), side];
  }
  if (notesDir?.writeTask) { const { top: _top, version: _version, ...mine } = task; notesDir.writeTask(notes, mine); }
  else {
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(task, null, 2));
    fs.renameSync(temp, file);
  }
  if (o.engine && !fs.existsSync(path.join(notes, 'engine.txt'))) fs.writeFileSync(path.join(notes, 'engine.txt'), o.engine + '\n');
  setTaskDir(top, notes);
  if (!old.startedAt) requestStart(new Date(), { repo: top, unlessFresh: true });
  // 2026-11-20 (timed task: the author named ticket-text.md, breaks-page.json, proof-page.log; later steps asked for ticket.md,
  // breaks.json, proof-tests.log, and files were copied by hand): the file names of the task folder, printed once.
  const shown = notes.replace(/\\/g, '/');
  const logs = (task.sides.length ? task.sides.map((s) => s.name) : ['tests']).map((s) => `proof-${s}.log`).join(', ');
  return [`START: task notes ${shown} for ${top} (base ${task.base || 'the integration branch'})`,
    `FILES in ${shown}: ticket-text.md (the ticket's words you save) · ticket.md (made by lines.mjs) · lines.md · check.md · places.md · siblings-report.md · siblings.md · breaks.json (one file, all sides) · proof logs: ${logs} (one per side) — use these names, the later steps read them`];
}

export async function main(argv, print = (line) => process.stdout.write(line + '\n'), { sessionNotes } = {}) {
  let o;
  try { o = parse(argv); } catch (error) { process.stderr.write(`SANAD: ${error.message}\n${USAGE}\n`); return 2; }
  if (!['start', 'next', 'status', 'ready', 'owed', 'pr-body', 'self-read'].includes(o.cmd)) { process.stderr.write(USAGE + '\n'); return 2; }
  try {
    if (o.cmd === 'start') { for (const l of [...start(o), ...nextLines(readFacts({ repo: o.repo, notes: path.resolve(o.notes) }))]) print(l); return 0; }
    const ask = { repo: path.resolve(o.repo), notes: o.notes ? path.resolve(o.notes) : '', last: Boolean(o.last), deep: o.cmd !== 'next', ...(sessionNotes ? { sessionNotes } : {}) };
    if (ask.deep && !sessionNotes) await loadNotesTools();
    let f = readFacts(ask);
    // After the first review the notes decide the step: read them, with the scanner's reader.
    if (!ask.deep && !sessionNotes && f.pins.length) { await loadNotesTools(); f = readFacts(ask); }
    if (o.cmd === 'next') { for (const l of nextLines(f)) print(l); return 0; }
    if (o.cmd === 'self-read') return selfRead(f, o.found, print);
    if (!f.notesDir) { print('SANAD: no task for this work tree — run start first'); return 3; }
    if (o.cmd === 'status') { for (const l of await statusLines(f)) print(l); return 0; }
    if (o.cmd === 'ready') {
      const items = await readyItems(f);
      for (const l of switchLines(f)) print(l);
      print(`READY lane: ${f.testsOnly && f.switches.testsOnlyLane ? 'tests-only (light path)' : 'normal'}`);
      for (const i of items) print(`READY ${i.done ? 'done    ' : 'NOT DONE'} — ${i.id}: ${i.why}`);
      if (f.pinAtHead && f.reviewSeats && f.reviewSeats.fromFiles) print(`READY note — review: no session scan is available; the seats were counted from the report files in the notes folder (${f.reviewSeats.have} of ${f.reviewSeats.need})`);
      // The seats of the round could not be matched to reports: the item rests on one finished run (the push guard's rule).
      if (f.pinAtHead && f.reviewReported && f.reviewSeats && f.reviewSeats.matched === false) print(`READY note — review: the ${f.reviewSeats.need} seats of round ${f.round} could not be matched to reports; one finished reviewer run after the pin is taken as the round`);
      const left = items.filter((i) => !i.done);
      print(`READY: ${left.length ? `no — ${left.length} of ${items.length} not done` : `yes — ${items.length} of ${items.length} done`} for tree ${f.git.tree ? f.git.tree.slice(0, 10) : 'with uncommitted work'}`);
      if (left.length) print(`A push the owner orders now is saved first: node ${q(`${GATE_DIR}/notes.mjs`)} decide --kind push-now --words OWNER-WORDS --notes ${q(f.notesDir.replace(/\\/g, '/'))}`);
      return left.length ? 1 : 0;
    }
    if (o.cmd === 'owed') {
      const owed = await owedItems(f);
      if (!owed.decision) { print('OWED: none (no push-now decision)'); return 0; }
      for (const i of owed.items) print(`OWED — ${i.id}: ${i.why}`);
      print(`OWED: ${owed.items.length} item(s) open after the push the user ordered ("${String(owed.decision.words).trim().slice(0, 120)}"). A green CI run clears none of them.`);
      return owed.items.length ? 1 : 0;
    }
    const block = evidenceBlock(f);
    if (o.out) fs.writeFileSync(path.resolve(o.out), block.join('\n') + '\n');
    for (const l of block) print(l);
    if (o.cmd === 'pr-body' && f.notesDir) { const t = timerReport(f.notesDir).split('\n').pop(); if (t && !/no marks/.test(t)) print(`(timer, for the task-metrics line: ${t.trim()})`); }
    return 0;
  } catch (error) {
    // A broken record never stops the author: say it, and print nothing as done.
    print(`SANAD: could not read the task (${String(error && error.message || error).split(/\r?\n/)[0]}). Nothing is shown as done.`);
    return 3;
  }
}

export { askOwner, pathFor };

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
