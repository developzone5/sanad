#!/usr/bin/env node
// note-check.mjs — each review note is checked against the code before the author acts on it.
//
// 2026-11-17: a reviewer note that is wrong costs a full fix round: the code, its proof, a second review. Nobody
// tried to disprove a note before the author built its fix. Here one read-only agent opens the code each note
// names and answers CONFIRMED, REFUTED or UNSURE, with the file and line. Rule 5 still holds: the author never
// closes a note alone. A refuted note is not closed here: it goes to the user with the evidence, and no fix is
// built for it meanwhile.
//
// 2026-11-17 (an independent check of this script, each case run on a real input): an answer written for an
// older brief was recorded against the brief on disk, by K number alone, so a note the agent never opened came
// out REFUTED with another note's evidence; a note longer than the hooks' cut reached the agent without the file
// it names; REFUTED was accepted on twelve dots; an empty or UTF-16 report read as a clean one. So every brief
// carries an id the answer must repeat, a new brief removes the last check's files, a cut note is given in
// full, REFUTED needs a file and line, and a report that cannot be read is refused by name.
//
//   node note-check.mjs --brief --notes <dir> --reports <file1,file2,...> [--repo <path>]
//       Reads each reviewer report and takes its notes with the hooks' own parser (reportNotes in
//       hooks/lib/transcript-scan.js: Blocker / Bug / Gap / Question / EXTRA TEST lines and lines that ask the
//       user to decide; never an OUTSIDE PR line), so the notes here are the notes the hooks read. A note with
//       the same text in two reports is listed once. Writes <notes>/note-check-brief.md: the brief's id (a short
//       hash of the repo and the note lines), the repo when given, fixed instructions, the line the answer must
//       start with (`BRIEF <id>`), then `K<n> · <kind> · from <report file name> · <note text>` per note. The
//       hooks' parser cuts a long note (at 300 characters today): such a note gets a second, indented line with
//       its whole text from the report. Prints the one launch line for the Agent tool (note-checker, a
//       read-only seat; never a reviewer prompt, which the hooks would count as a finished review); its prompt
//       names the brief only. Then a THEN line with the --record command; a path with a space is in quotes.
//       A new brief starts a new check: the last one's note-check-report.md and note-check.md are removed, and
//       a REMOVED line names them. No note in any report: prints `NOTE CHECK: no note to check`, writes no brief
//       and removes the old one. A report that is empty or not plain text (it holds a NUL character: UTF-16
//       saved without its byte order mark) is refused, never read as a clean report. An empty --repo is refused.
//       A file name with a comma cannot be listed.
//   node note-check.mjs --record <report file> --notes <dir>
//       Reads the agent's answer: the line `BRIEF <id>`, then one line per note: `CONFIRMED K<n> — <evidence>`,
//       `REFUTED K<n> — <evidence>` or `UNSURE K<n> — <what could not be checked>`. An answer without the id
//       line, or with the id of another brief, is refused: its K numbers are not these notes. List marks, bold,
//       backticks, "K 3" and a - or : separator are read too; the last line for a note wins; the instruction
//       quoted back, with its placeholders, is no answer. Writes <notes>/note-check.md: `K<n> · <verdict> ·
//       <kind> · <note text> — <evidence>` per note of the brief. A note with no answer is `UNSURE (no verdict)`.
//       REFUTED counts only with a file and line in its evidence (`src/a.ts:12`) and 12 characters of it or
//       more; otherwise the note is `UNSURE (refuted without evidence)`: no note is set aside on a bare word.
//       Prints the totals, then `ASK THE USER: K<n> · <note text> — refuted: <evidence>` per refuted note, then
//       one line that says K numbers are not the hooks' NOTE numbers. A report with no verdict line for a note
//       of the brief is refused: the check did not run.
//       2026-11-18 (scoped staleness): --brief also writes <notes>/note-check-files.json (path -> short hash of every
//       file of the repository, not in the brief text) and numbers its run in <notes>/note-check-generation.json and
//       a `Generation: <N>` line of the brief (the answer may write `BRIEF <id> g<N>`). --record no longer refuses
//       the answer when some code changed: a REFUTED note stands only when every file its line and its evidence name
//       is unchanged since the brief (a file new, gone or unreadable counts as changed); otherwise it is `UNSURE (the
//       code it cites changed: check again)`, a `CHANGED SINCE THE BRIEF:` line names it, and it gets no author line.
//       An answer for an older generation than the newest recorded (or than the brief on disk) is refused.
// Exit 0: written, or no note to check. 2: usage error, a missing or unreadable file, the hooks' parser cannot
// be loaded, an answer for another brief, a report with no verdict.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';

// 2026-11-18 (audit 3): the brief id binds the code state, with the same code-tree fingerprint the proof record uses
// (proof-record.mjs: the working tree as git sees it, prose left out). Loaded once and not copied. An install that
// lacks the module still loads this script (the hooks' parser is checked first, with its own message); a brief
// that needs the fingerprint then says what is missing.
let proof = null, proofError = '';
try { proof = await import('./proof-record.mjs'); } catch (error) { proofError = String(error && error.message).split('\n')[0]; }

const here = path.dirname(fileURLToPath(import.meta.url));
const MIN_EVIDENCE = 12;
// REFUTED sets a note aside, so its evidence must point into the code: a file name and its line ("src/a.ts:12";
// bold or backticks may close the name before the colon). Twelve dots or "it is not true." point nowhere.
const FILE_LINE = /\w\.\w+[`*_"']*:\d+/;
// One line of the answer is read up to here: the verdict pattern backtracks, and a line of 40 000 spaces took
// 7.7 s. No answer line of an agent is this long.
const MAX_ROW = 2000;
export const BRIEF = 'note-check-brief.md';
export const LIST = 'note-check.md';
export const REPORT = 'note-check-report.md';
// 2026-11-18 (scoped staleness), both in the notes folder and neither in the brief text: FILES holds the fingerprint of
// every file of the repository at --brief (path -> short hash), which --record reads to see which cited file changed;
// GENERATION holds the counter of the --brief runs and the newest generation recorded.
export const FILES = 'note-check-files.json';
export const GENERATION = 'note-check-generation.json';
// 2026-11-18: why a REFUTED answer was set aside when nothing shows the cited files unchanged.
export const UNBOUND_LABEL = 'UNSURE (the code is not bound to a repository: run --brief again with --repo <the git repository>)';
export const NO_FILE_LABEL = 'UNSURE (no file it cites is in the repository: nothing shows the cited code unchanged)';
// 2026-11-18 (repair 3): a cited file with a line is outside the repository, or the repository does not track it and no
// fingerprint of it exists: its code is not shown unchanged.
export const UNSHOWN_FILE_LABEL = 'UNSURE (a file it cites is not tracked by this repository or lies outside it: nothing shows that code unchanged)';
export const CHANGED_LABEL ='UNSURE (the code it cites changed: check again)';
// The hooks' note parser, from this scripts folder. One parser: a second one here would drift from the hooks,
// and a note the hooks count would be missing from the check (or the other way round).
export const PARSER = '../../../hooks/lib/transcript-scan.js';
export const INSTRUCTIONS = "Before any fix. Each K line below is one note from a code review. Try to DISPROVE each note from the code: open the file and line the note names, and what calls it, and look for what makes the claim false (a guard, a caller that never sends that input, a test that already covers it). Answer with the BRIEF line given below first, then one line per note, and nothing else: 'CONFIRMED K<n> — <file:line and the input that shows it>', 'REFUTED K<n> — <file:line that makes the claim false>' or 'UNSURE K<n> — <what could not be checked>'. A note you cannot disprove with a file and line is CONFIRMED or UNSURE, never REFUTED. Read-only; do not edit.";
// The line that names the brief an answer was written for. K numbers start at 1 in every brief, so the number
// alone does not say which note an answer line is about.
// 2026-11-18 (scoped staleness): a brief also carries its generation, so an answer saved for an older run of the same
// notes over the same code (the same id) is told apart: `BRIEF <id> g<N>`. An answer that drops the g part is read as
// the answer of the brief on disk.
export const idLine = (id, generation = 0) => 'BRIEF ' + id + (generation ? ' g' + generation : '');
// A checking seat, never a review: a prompt that starts "You are the independent reviewer" is counted by the
// stop and push hooks as a finished review, so this check could have stood in for the review of the fix.
export const PROMPT_START = 'Seat: Note check, before any fix.';
// A K brief: its answer is "REFUTED K1", and the guards read that as NOTE 1, which is another note. So this prompt
// is not the note check seat to them: a K answer never makes a NOTE number refutable.
// 2026-11-19: K numbers are only for a call with no session log of these notes. With the log of these notes the
// brief always uses the guards' NOTE numbers (see writeBrief).
export const PROMPT_START_K = 'Check each K note, before any fix.';
// 2026-11-19: the old text said "ask the user about them together". With the guards' numbers that is stale since the
// note check may refute (2026-11-17): a refuted note is closed by its own refuted line, and only a Blocker or a
// Question goes to the user. With K numbers the guards do not take the check as a refutation, so the user is still
// asked: now, when the answer arrives, not later with other questions.
export const REFUTED_RULE = "Refuted notes are not fixed: a note the note check refuted is closed by its own line `NOTE <n>: refuted — <this evidence>` (never a Blocker or a Question: the user's words close those, rule 5). The ship brief lists every refuted note.";
export const REFUTED_RULE_K = 'Refuted notes are not fixed now: ask the user now, with this evidence and a recommended answer; their words close each one (rule 5).';
const refutedRule = (rows) => (rows.length && rows.every((r) => r.guard) ? REFUTED_RULE : REFUTED_RULE_K);
// The hooks number notes their own way (see collectNotes): an author who writes "NOTE 2: …" for K2 names another note.
export const K_RULE = 'K numbers belong to this brief, not to NOTE numbers: close each note under its own NOTE <n>, found by its text.';

class UsageError extends Error {}
const usage = (message) => new UsageError(message);
const slash = (p) => String(p).replace(/\\/g, '/');
// A path in a printed command: in quotes when it holds a space, or the command does not run as printed (as evidence.mjs).
const quote = (p) => (/\s/.test(p) ? `"${p}"` : p);
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// A report saved from PowerShell 5.1 can be UTF-16 or start with a byte order mark: both read as plain text,
// or no note and no verdict would be found in it. The same reading as siblings.mjs; copied, not imported,
// because that module loads the whole proof chain, which this small tool does not need.
export function readText(file) {
  const buf = fs.readFileSync(file);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  const text = buf.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// A report this script cannot read is not a clean report: an empty file, or UTF-16 saved without its byte order
// mark (every second character a NUL), gave "no note to check" with exit 0. Refused, with the file's name.
export function readReport(file) {
  const text = readText(file);
  if (!text.trim()) throw usage(`${file} is empty: save the report there again`);
  if (text.includes('\0')) throw usage(`${file} is not plain text (it holds a NUL character: UTF-16 saved without its byte order mark?): save it again as UTF-8`);
  return text;
}

// The hooks' scanner module. An install without hooks has none: a usage error that names the file.
export function loadScan(file = PARSER) {
  const where = slash(path.resolve(here, file));
  let scan;
  try { scan = createRequire(import.meta.url)(file); }
  catch (error) { throw usage(`the hooks' note parser cannot be loaded: ${where} (${String(error && error.message).split('\n')[0]}). This check reads notes the way the hooks do: install the hooks folder next to the skills folder.`); }
  if (!scan || typeof scan.reportNotes !== 'function') throw usage(`the hooks' note parser has no reportNotes: ${where}. Install the hooks of the same release as this script.`);
  return scan;
}
// reportNotes of the hooks.
export function loadReportNotes(file = PARSER) { return loadScan(file).reportNotes; }

// The session transcript whose open notes carry the guards' own numbers: the file given, else the newest .jsonl
// of the repo's project folder (the slug is the absolute repo path with every non-alphanumeric character replaced
// by "-"; SANAD_PROJECTS_DIR replaces <home>/.claude/projects). '' when none is found: the K numbering then stands.
export function transcriptCandidates(repo) {
  const root = process.env.SANAD_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
  const slug = (p) => path.resolve(p).replace(/[^A-Za-z0-9]/g, '-');
  const folder = path.join(root, slug(repo));
  const siblings = siblingFolders(repo, root, slug, folder);
  // 2026-11-19: when the host names this session (CLAUDE_CODE_SESSION_ID) and its log is there, it is the only
  // candidate: the newest file can be another session on the same repository, with other numbers.
  // 2026-11-20: the log is looked for in the task's folder AND in every sibling work tree's folder.
  const own = String(process.env.CLAUDE_CODE_SESSION_ID || '').replace(/[^\w.-]/g, '');
  if (own) {
    for (const dir of [folder, ...siblings]) {
      const file = path.join(dir, own + '.jsonl');
      if (isFile(file)) return [file];
    }
  }
  let names = null;
  try { names = fs.readdirSync(folder).filter((n) => /\.jsonl$/i.test(n)); } catch { names = null; }
  const first = names ? newestFirst(names.map((n) => path.join(folder, n))) : [];
  return [...first, ...siblingTranscripts(repo, siblings)];
}
const newestFirst = (files) => files.map((file) => { let at = 0; try { at = fs.statSync(file).mtimeMs; } catch { /* gone */ } return { file, at }; }).sort((a, b) => b.at - a.at).map((x) => x.file);
// 2026-11-20: sessions often run in one work tree while the task's code is in another work tree of the same repository.
// The project folders of the other work trees. Any git failure gives none.
function siblingFolders(repo, root, slug, ownFolder) {
  let listing;
  try { listing = execFileSync('git', ['-C', path.resolve(repo), 'worktree', 'list', '--porcelain'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }); } catch { return []; }
  const seen = new Set([ownFolder.toLowerCase()]);
  const out = [];
  for (const line of listing.split(/\r?\n/)) {
    if (!line.startsWith('worktree ')) continue;
    const dir = path.join(root, slug(line.slice('worktree '.length).trim()));
    if (seen.has(dir.toLowerCase())) continue;
    seen.add(dir.toLowerCase());
    out.push(dir);
  }
  return out;
}
// The logs of the other work trees are added after the repository's own logs, newest first, and only those that
// mention the task's repository path (any other log is another task's session).
function siblingTranscripts(repo, folders) {
  const found = [];
  const needles = pathNeedles(repo);
  for (const dir of folders) {
    let names;
    try { names = fs.readdirSync(dir).filter((n) => /\.jsonl$/i.test(n)); } catch { continue; }
    for (const n of names) found.push(path.join(dir, n));
  }
  return newestFirst(found).filter((file) => fileMentions(file, needles));
}
// The repository path in the three spellings a log can hold it, lower case, as latin1 text (one byte per character).
function pathNeedles(repo) {
  const p = path.resolve(repo).replace(/[\\/]+$/, '');
  const fwd = p.replace(/\\/g, '/');
  const back = p.replace(/\//g, '\\');
  return [...new Set([fwd, back, back.replace(/\\/g, '\\\\')])].map((x) => Buffer.from(x, 'utf8').toString('latin1').toLowerCase());
}
// A path mention counts only when the next character is not a letter, digit, "-", "_" or "." (a quote, a slash,
// a backslash, a space or the end). So ".../EduQuest" does not match ".../EduQuest-other". Bytes above 127 count as letters.
const PATH_CONTINUES = { test: (c) => /[a-z0-9_.-]/.test(c) || c.charCodeAt(0) > 127 };
function mentionIn(text, needles, atEnd) {
  for (const x of needles) {
    for (let i = text.indexOf(x); i !== -1; i = text.indexOf(x, i + 1)) {
      const end = i + x.length;
      if (end >= text.length) { if (atEnd) return { hit: true }; return { hit: false, from: i }; }
      if (!PATH_CONTINUES.test(text[end])) return { hit: true };
    }
  }
  return { hit: false };
}
// True at the first chunk that holds one of the needles. 1 MB chunks, overlapped so a hit across a cut is found
// (a hit at the very end of a chunk waits for the next character).
function fileMentions(file, needles) {
  const CHUNK = 1024 * 1024, keep = Math.max(...needles.map((x) => x.length));
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(CHUNK);
    let tail = '';
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, null);
      const atEnd = n <= 0;
      const text = tail + (atEnd ? '' : buf.toString('latin1', 0, n).toLowerCase());
      if (mentionIn(text, needles, atEnd).hit) return true;
      if (atEnd) return false;
      tail = text.slice(-keep);
    }
  } catch { return false; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
}
// 2026-11-20: the Codex CLI keeps its sessions in <codex home>/sessions/<year>/<month>/<day>/rollout-<time>-<id>.jsonl
// (SANAD_CODEX_DIR replaces <home>/.codex). Line shapes seen on this PC:
//   first line   { type: 'session_meta', payload: { cwd, source, ... } }   source is a string for a user session, an object for a helper agent's
//   newer files  { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text }] } } }
//   older files  { type: 'event_msg', payload: { type: 'user_message', message: '<text>' } }
// Only those two line kinds are the owner's own typed messages. A response_item with role 'user' is not: it also holds
// the injected instructions. Helper agents' sessions are skipped: their "user" is the parent agent.
const sameFolder = (a, b) => String(a).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === String(b).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
function codexFiles(dir) {
  const out = [];
  const list = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } };
  for (const y of list(dir).filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse())
    for (const m of list(path.join(dir, y)).filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse())
      for (const d of list(path.join(dir, y, m)).filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse())
        for (const f of list(path.join(dir, y, m, d)).filter((e) => e.isFile() && /\.jsonl$/i.test(e.name)).map((e) => e.name).sort().reverse()) out.push(path.join(dir, y, m, d, f));
  return out;
}
// The working folder and the kind of the session, from the first line only (cheap: the first chunk of the file).
function codexMeta(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(16384);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const head = buf.subarray(0, n).toString('utf8');
    const cwd = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head);
    const helper = /"source":\{/.test(head);
    return cwd ? { cwd: JSON.parse('"' + cwd[1] + '"'), helper } : null;
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
}
const MAX_CODEX_FILES = 300;
// The newest Codex session of this repository: its file, or ''.
export function codexSession(repo) {
  const dir = path.join(process.env.SANAD_CODEX_DIR || path.join(os.homedir(), '.codex'), 'sessions');
  for (const file of codexFiles(dir).slice(0, MAX_CODEX_FILES)) {
    const meta = codexMeta(file);
    if (meta && !meta.helper && sameFolder(meta.cwd, path.resolve(repo))) return file;
  }
  return '';
}
// The owner's typed messages of that session, in order. [] when there is none.
export function codexUserMessages(repo) {
  const file = codexSession(repo);
  if (!file) return [];
  const out = [];
  let rows; try { rows = fs.readFileSync(file, 'utf8').split('\n'); } catch { return []; }
  for (const row of rows) {
    if (!row.trim()) continue;
    let o; try { o = JSON.parse(row); } catch { continue; }
    const p = o && o.type === 'event_msg' && o.payload;
    if (!p) continue;
    if (p.type === 'user_message' && typeof p.message === 'string') out.push(p.message);
    else if (p.type === 'item_completed' && p.item && p.item.type === 'UserMessage' && Array.isArray(p.item.content)) {
      const text = p.item.content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');
      if (text) out.push(text);
    }
  }
  return out;
}

export function findTranscript({ transcript, repo }) {
  if (transcript !== undefined) {
    if (!isFile(transcript)) throw usage('no such transcript: ' + transcript);
    return transcript;
  }
  return repo === undefined ? '' : transcriptCandidates(repo)[0] || '';
}

// A session found by --repo is used only when it is the session of these reports: every note of the reports is
// one of its notes (open or closed). The newest file of a project folder can be another session, and its numbers
// are not the numbers the guards of the author's session use (2026-11-17, second check). The 20 newest are looked at.
const MAX_SESSIONS = 20;
export function sessionHolds(file, scan, reportList) {
  if (!reportList.length || typeof scan.scanTranscript !== 'function') return false;
  const seen = new Set(((scan.scanTranscript(file) || {}).reviewNotes || []).map((n) => oneLine(n.text)));
  return reportList.every((k) => seen.has(oneLine(k.text)));
}

// The notes the hooks count as open in a transcript, with their own NOTE numbers: { n, kind, text, guard: true }.
export function guardNotes(transcript, scan) {
  if (typeof scan.scanTranscript !== 'function') throw usage("the hooks' scanner has no scanTranscript: install the hooks of the same release as this script.");
  const res = scan.scanTranscript(transcript) || {};
  return (res.openReviewNotes || []).map((n) => ({ n: n.n, kind: n.kind, text: oneLine(n.text), guard: true, ...(n.asks ? { asks: true } : {}) }));
}

// The hooks' parser cuts a long note. Where it cuts is measured from the parser, not copied: a second number
// here would drift from the hooks. Infinity when it does not cut.
export function noteLimit(reportNotes) {
  const probe = 'Bug — ' + 'word '.repeat(2000).trim();
  const got = reportNotes(probe);
  return got.length === 1 && got[0].text.length < probe.length ? got[0].text.length : Infinity;
}

// The whole text of note number `index` (from 0) of a report, for a note the parser cut: the brief tells the
// agent to open the file and line the note names, and they can be past the cut. Which lines are one note is the
// parser's rule, so the parser is asked, never copied. The note's first line is the first line that brings the
// parser to this note. A line under it is in the note when the parser, given the two lines alone, joins them;
// a first line that reaches the cut by itself is replaced there by a short line with the same indent (both
// have words after the separator, which is all the parser's rule looks at). '' when the lines are not found.
export function wholeNote(report, index, reportNotes, limit = noteLimit(reportNotes)) {
  const rows = String(report).replace(/\r/g, '').split('\n');
  const upTo = (i) => reportNotes(rows.slice(0, i + 1).join('\n'));
  const cut = upTo(rows.length - 1)[index];
  if (!cut) return '';
  let first = 0, last = rows.length - 1;
  while (first < last) {
    const mid = (first + last) >> 1;
    if (upTo(mid).length > index) last = mid; else first = mid + 1;
  }
  const length = (text) => ((reportNotes(text)[0] || {}).text || '').length;
  const head = length(rows[first]) < limit ? rows[first] : /^\s*/.exec(rows[first])[0] + 'Bug — x';
  const alone = length(head);
  if (!alone) return '';
  let end = first + 1;
  while (end < rows.length && length(head + '\n' + rows[end]) > alone) end++;
  const lines = oneLine(rows.slice(first, end).join(' '));
  const at = lines.indexOf(cut.text.trim());
  return at < 0 ? '' : lines.slice(at);
}

// The notes of the reports, in order: { n, kind, from, text }, plus { cut, whole } for a note the parser cut
// (cut: where; whole: its whole text, '' when not found). A note whose text is already on the list (the same
// finding in two reports) is not listed again, so the agent checks it once. The hooks number notes their own
// way: the same finding from two reviewer runs is two NOTE numbers there, and NOTE numbers go on from round to
// round while K starts at 1 in every brief. So a K number is never a NOTE number (K_RULE says it to the author).
export function collectNotes(files, reportNotes) {
  const list = [];
  const limit = noteLimit(reportNotes);
  for (const file of files) {
    const report = readReport(file);
    for (const [index, found] of reportNotes(report).entries()) {
      // A line that only says there is none ("EXTRA TEST: none.") is closed by the guards: nothing to check.
      if (found.none || list.some((k) => k.text === found.text)) continue;
      const note = { n: list.length + 1, kind: found.kind, from: path.basename(file), text: found.text, ...(found.asks ? { asks: true } : {}) };
      if (found.text.length >= limit) {
        const whole = wholeNote(report, index, reportNotes, limit);
        // The same text: the note ends where the parser cuts, and nothing is missing.
        if (whole !== found.text.trim()) Object.assign(note, { cut: limit, whole });
      }
      list.push(note);
    }
  }
  return list;
}

export const tag = (k) => (k.guard ? 'NOTE ' : 'K') + k.n;

// 2026-11-19 (groups): the file and line a note names ("src/save.ts:12"), '' when it names none. Day 2 had 27 notes
// about 13 problems: notes that name the same place are shown as one group, and each keeps its own number and text.
const PLACE = /((?:[A-Za-z]:)?[\w@.\-\/\\]+\.[A-Za-z]\w{0,9})[`*_"']*:(\d+)/;
export function placeOf(text) {
  const m = PLACE.exec(String(text || ''));
  return m ? slash(m[1]).replace(/^(?:\.\/)+/, '') + ':' + m[2] : '';
}
// The groups of a list of notes ({ n, text }): two or more notes with the same place (no case), numbered G1.. by
// their first note: [{ id, place, notes: [n] }]. A group hides nothing: it only names note numbers.
export function placeGroups(notes) {
  const byPlace = new Map();
  for (const k of notes) {
    const place = placeOf(k.text);
    if (!place) continue;
    const key = place.toLowerCase();
    if (!byPlace.has(key)) byPlace.set(key, { place, notes: [] });
    byPlace.get(key).notes.push(k.n);
  }
  return [...byPlace.values()].filter((g) => g.notes.length > 1).map((g, i) => ({ id: 'G' + (i + 1), place: g.place, notes: g.notes }));
}
export const GROUP_RULE = 'Notes that name the same file and line are one group. They can be one finding or different ones: read every text, and answer one line per note number. You may split a group: two notes of it can get different verdicts.';
export const groupLine = (g, guard) => `${g.id} · ${g.place} · ${g.notes.map((n) => (guard ? 'NOTE ' : 'K') + n).join(', ')}`;
// asks (2026-11-18): a Gap or Bug line that asks the user to decide is marked on its line, so --record treats it as a Question.
export const ASKS_MARK = ' (asks the user)';
const kindText = (k) => k.kind + (k.asks && !/^Question$/i.test(k.kind) ? ASKS_MARK : '');   // a Question needs no mark
export const briefLine = (k) => (k.guard ? `NOTE ${k.n} · ${kindText(k)} · ${k.text}` : `K${k.n} · ${kindText(k)} · from ${k.from} · ${k.text}`);
// Under the K line of a cut note. Indented, so it is no K line: the K line keeps the text the hooks show.
export const wholeLine = (k) => (k.whole
  ? `    ${tag(k)} in full (the ${k.guard ? 'line above' : 'K line'} is cut at ${k.cut} characters): ${k.whole}`
  : `    ${tag(k)} is cut at ${k.cut} characters, and its other lines were not found in ${k.from || 'its report'}: answer UNSURE when the part shown is not enough to check.`);
const noteLines = (k) => (k.cut ? [briefLine(k), wholeLine(k)] : [briefLine(k)]);

// A brief's id: a short hash of its repo, its code state and its note lines (line ends and spaces at a line's end do
// not count). The same notes for the same repo and code give the same id; other notes, another order, another repo
// or other code give another. code: the code-tree fingerprint, '' when the folder is no git repository.
export function briefId(repo, lines, code = '') {
  const body = [repo ? slash(repo) : '', ...(code ? ['code ' + code] : []), ...lines.map((l) => String(l).trimEnd()).filter(Boolean)].join('\n');
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 8);
}

// The code state of the folder the check is about (the repo given, else the current folder): { top, code }. Both ''
// when the folder is no git repository: there is no code state to bind then. Throws when it cannot be read.
export function codeState(dir) {
  if (!proof) throw usage(`the code fingerprint cannot be loaded (${proofError}). This check binds its brief to the code with proof-record.mjs: install the gate scripts of the same release.`);
  const top = proof.toplevelOf(dir);
  if (!top) return { top: '', code: '' };
  const code = proof.codeFingerprint(top);
  if (!code) throw usage(`the code state of ${slash(top)} cannot be read (git failed): fix the repository, then run --brief again`);
  return { top: slash(top), code };
}
// 2026-11-18 (scoped staleness): the files of a repository as git sees them (tracked, and untracked but not ignored),
// each with a short hash of its bytes: { 'src/a.cs': '1a2b3c4d5e6f', ... }. A file that cannot be read gets '' (changed
// against any other state). Throws a usage error when git cannot list the files.
const HASH_CAP = 64 * 1024 * 1024;   // a file larger than this is judged by its size
export function listRepoFiles(top) {
  let out;
  try { out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: top, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 }); }
  catch { throw usage(`the files of ${slash(top)} cannot be listed (git failed): fix the repository, then run --brief again`); }
  return [...new Set(out.split('\0').filter(Boolean))];
}
export function hashRepoFile(top, rel) {
  try {
    const file = path.join(top, rel);
    const size = fs.statSync(file).size;
    if (size > HASH_CAP) return 'big:' + size;
    return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
  } catch { return ''; }
}
export function fileFingerprint(top) {
  const files = {};
  for (const rel of listRepoFiles(top)) files[rel] = hashRepoFile(top, rel);
  return files;
}
// The file names a text cites: a word with an extension, "Upload.cs:9", "src/App.cs", "README.md:1", "ar.json". The same
// reading as the hooks' citedFiles (hooks/lib/transcript-scan.js), with whether a line number follows.
// 2026-11-18 (repair 1, 2): a drive prefix ("C:\repos\x\src\Policy.cs:4"), [ ] ( ) + and a space are part of a name, and a leading
// "/", "./" or "../" and the drive are dropped before names are compared; a match with spaces is also read word by word.
// 2026-11-18 (repair 3): letters beyond ASCII are part of a name ("Política.cs"); a word is also read without a leading ( [ @ +.
const CITED_FILE = /((?:[A-Za-z]:)?[\p{L}\p{N}_@.\-\/\\\[\]()+ ]+\.\p{L}[\p{L}\p{N}_]{0,9})(?![\p{L}\p{N}_])(:\d+)?/gu;
// A name with no extension and a line ("Dockerfile:2"): read only when a file of the repository has that name.
const NO_EXT_FILE = /([\p{L}\p{N}_@.\-\/\\]+):(\d+)/gu;
const EXT_END = /\.\p{L}[\p{L}\p{N}_]{0,9}$/u;
const rawOf = (p) => String(p || '').replace(/\\/g, '/').replace(/[),;]+$/, '').replace(/^[A-Za-z]:(?=\/)/, '').replace(/^(?:\.{0,2}\/)+/, '').replace(/\.+$/, '');
const keyOf = (p) => rawOf(p).toLowerCase();
const baseOf = (k) => k.slice(k.lastIndexOf('/') + 1);
const isFileOnDisk = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
// The cited files of the notes' texts that changed since the fingerprint `saved` was made, as their names. A name that
// matches files (the end of the path, no case) counts changed when any of them is new (not in the fingerprint), gone or
// unreadable, or has other bytes. A name that matches no file of the repository, then or now, is no file of it (a bare
// word with a dot such as "e.g", a path outside it) and counts for nothing.
export function citedChanged(top, saved, texts) { return citedState(top, saved, texts).changed; }
// 2026-11-18: also whether any cited name is a file of the repository (found): a text that names none shows nothing unchanged.
// 2026-11-18 (repair 3): a citation (one match, with its word spellings) that carries a line number and matches no listed file
// is `unresolved`: nothing shows that file unchanged (git ignores it, it is in a nested repository, it lies outside the repository).
// A file that exists under the root but is not listed is judged by its modified time against `since` (when the brief was made);
// without `since` it is unresolved. The bare-name fallback is not used for such a path, nor for an absolute path outside the root.
export function citedState(top, saved, texts, since) {
  const cites = [];
  const prefix = keyOf(top) + '/';
  for (const t of texts) for (const m of String(t || '').matchAll(CITED_FILE)) {
    const spellings = [];
    for (const w of new Set([m[1], ...m[1].split(/\s+/).flatMap((x) => [x, x.replace(/^[(\[@+]+/, '')])])) {
      let raw = rawOf(w);
      let k = raw.toLowerCase();
      if (!EXT_END.test(k)) continue;
      const abs = /^(?:[A-Za-z]:[\\/]|[\\/])/.test(w);
      const inRoot = k.startsWith(prefix);
      if (inRoot) { raw = raw.slice(prefix.length); k = k.slice(prefix.length); }
      if (!k) continue;
      spellings.push({ k, raw, outside: abs && !inRoot && !isFileOnDisk(path.join(top, raw)) });
    }
    if (spellings.length) cites.push({ spellings, lined: !!m[2], rels: null });
  }
  const noExt = [];
  for (const t of texts) for (const m of String(t || '').matchAll(NO_EXT_FILE)) {
    const k = keyOf(m[1]);
    if (k && !baseOf(k).includes('.')) noExt.push(k.startsWith(prefix) ? k.slice(prefix.length) : k);
  }
  if (!cites.length && !noExt.length) return { changed: [], found: false, unresolved: false };
  const now = listRepoFiles(top);
  const rels = [...new Set([...Object.keys(saved), ...now])];
  const nowSet = new Set(now);
  const changed = [];
  let found = false, unresolved = false;
  const fresh = (hits) => !hits.some((rel) => !(rel in saved) || !nowSet.has(rel) || !saved[rel] || hashRepoFile(top, rel) !== saved[rel]);
  for (const name of new Set(noExt)) {
    const hits = rels.filter((rel) => { const k = rel.toLowerCase(); return !baseOf(k).includes('.') && (k === name || k.endsWith('/' + name)); });
    if (!hits.length) continue;   // "line:4" and the like: no file of that name
    found = true;
    if (!fresh(hits)) changed.push(name);
  }
  for (const c of cites) {
    let hits = [...new Set(c.spellings.flatMap((s) => rels.filter((rel) => { const k = rel.toLowerCase(); return k === s.k || k.endsWith('/' + s.k); })))];
    const name = c.spellings[c.spellings.length - 1].k;
    if (!hits.length) {
      // The file is not listed. One that exists under the root (git ignores it, a nested repository) or an absolute path
      // outside it is no match for a same-named listed file: it is judged by itself or counts as not shown.
      let barred = false, shown = false, moved = false;
      for (const s of c.spellings) {
        if (s.outside) { barred = true; continue; }
        const file = path.join(top, s.raw);
        if (!isFileOnDisk(file)) continue;
        barred = true;
        if (since === undefined || since === null) continue;
        shown = true;
        try { if (fs.statSync(file).mtimeMs > since) moved = true; } catch { moved = true; }
      }
      if (barred) {
        if (shown) { found = true; if (moved) changed.push(name); }
        else if (c.lined) unresolved = true;
        continue;
      }
      // 2026-11-18 (repair 2): the full name matched no file (a diff prefix, a folder written another way): the bare file name is read too.
      hits = [...new Set(c.spellings.flatMap((s) => rels.filter((rel) => baseOf(rel.toLowerCase()) === baseOf(s.k))))];
      if (!hits.length) { if (c.lined) unresolved = true; continue; }   // no file of this repository: nothing is shown for it
    }
    found = true;
    if (!fresh(hits)) changed.push(name);
  }
  return { changed, found, unresolved };
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
// { issued: the number of the last --brief run, recorded: the newest generation recorded }.
export function readGenerations(notes) {
  const s = readJson(path.join(notes, GENERATION)) || {};
  return { issued: Number.isInteger(s.issued) && s.issued > 0 ? s.issued : 0, recorded: Number.isInteger(s.recorded) && s.recorded > 0 ? s.recorded : 0 };
}
function writeGenerations(notes, state) {
  try { fs.writeFileSync(path.join(notes, GENERATION), JSON.stringify(state) + '\n'); }
  catch (error) { throw usage(`${path.join(notes, GENERATION)} cannot be written (${error.code}): the check cannot number its runs`); }
}

// A Question, or a note that asks the user to decide (asks, 2026-11-18): never refuted, the user's words close it.
export const isQuestion = (k) => /^Question$/i.test(k.kind) || k.asks === true;
// A Question is for the user: the checker still looks at the code and says what it shows and what it recommends.
export const QUESTION_RULE = 'For a Question line: you cannot refute it, the user decides it. Whatever your verdict, say what the code shows (file:line) and give your recommended answer on the same line.';
export const QUESTION_LIST_RULE = "A Question is never closed here or by the author: the user's words close it; the checker's view is advice.";

// The same instructions for the guards' numbers: the lines are "NOTE <n> · ..." and the answer names "<n>".
export const GUARD_INSTRUCTIONS = INSTRUCTIONS.replace('Each K line below', 'Each NOTE line below').replace(/K<n>/g, '<n>');
export const GUARD_RULE = "These numbers are the guards' own NOTE numbers: the author closes each note under the same number.";

// 2026-11-18 (audit 3 repair): a brief with no code state says so, in the file, on the screen and again at --record. The current
// folder is never taken as the code (it can be another repository: the change in the reviewed one was then never seen).
export const NOT_BOUND = 'CODE: NOT BOUND — no --repo, or it is no git repository: this check is not tied to any code, so a code change after the agent read the code is not seen here. Run --brief again with --repo <the git repository> to bind it.';
export function buildBrief({ repo, notes, transcript, code, generation = 0 }) {
  const guard = notes.length > 0 && notes.every((k) => k.guard);
  const lines = notes.flatMap(noteLines);
  const id = briefId(repo, lines, code && code.code);
  // The groups stand above the notes: the id is made of the note lines only, so a group line never changes it.
  const groups = placeGroups(notes);
  return [
    '# Note check — before any fix', '',
    `Brief id: ${id}`,
    ...(generation ? [`Generation: ${generation}`] : []),
    ...(repo ? [`Repo: ${slash(repo)}`] : []),
    ...(code && code.code ? [`Code: ${code.code}`, `Code root: ${code.top}`] : [NOT_BOUND]),
    ...(guard && transcript ? [`Numbering: the guards' NOTE numbers, from ${path.basename(transcript)}`] : []), '',
    '## What to do', '',
    guard ? GUARD_INSTRUCTIONS : INSTRUCTIONS, '',
    ...(notes.some(isQuestion) ? [QUESTION_RULE, ''] : []),
    `First line of your answer: ${idLine(id, generation)}`,
    'It names the brief you read: an answer without it, or with another id, is not recorded.',
    ...(generation ? [`Write the run number after the id, as ${idLine(id, generation)}: an answer for an older run of this check is not recorded.`] : []), '',
    ...(repo ? ['A file a note names is relative to the repo above.', ''] : []),
    ...(groups.length ? ['## Groups', '', GROUP_RULE, ...groups.map((g) => groupLine(g, guard)), ''] : []),
    '## Notes', '',
    ...lines, '',
  ].join('\n');
}

// What a brief on disk says of itself: { written (its "Brief id:" line), made (the id its repo, code and note lines
// give), code and root (its "Code:" and "Code root:" lines, '' when it has none) }.
// They differ when the note lines were changed after the brief was written, or when it has no id line.
export function briefIds(text) {
  const rows = String(text).split(/\r?\n/).map((l) => l.trimEnd());
  const notes = rows.indexOf('## Notes');
  const find = (pattern) => rows.slice(0, Math.max(notes, 0)).map((l) => pattern.exec(l)).filter(Boolean).map((m) => m[1])[0] || '';
  const code = find(/^Code: ([0-9a-f]{40,64})$/);
  return { generation: Number(find(/^Generation: (\d{1,9})$/)) || 0, written: find(/^Brief id: ([0-9a-f]{8})$/), made: notes < 0 ? '' : briefId(find(/^Repo: (.+)$/), rows.slice(notes + 1), code), code, root: find(/^Code root: (.+)$/), unbound: !code && find(/^(CODE: NOT BOUND) /) !== '' };
}

export function launchLine(brief, guard = true) {
  return `LAUNCH: Agent note-checker · prompt: ${guard ? PROMPT_START : PROMPT_START_K} Read and follow only the brief at ${slash(brief)}. ` +
    'Do not open any other file in that folder. Read-only: no builds, no tests, no edits. Your final message is only the BRIEF line the brief gives, then the CONFIRMED, REFUTED and UNSURE lines, one per note.';
}

// Removes a file of the last check: true when there was one. A file that cannot be removed stops the run, so
// an old answer never stays beside a new brief without a word.
function removeOld(file) {
  try { fs.unlinkSync(file); return true; }
  catch (error) {
    if (error.code === 'ENOENT') return false;
    throw usage(`the old ${file} cannot be removed (${error.code}): close it and run --brief again`);
  }
}

// Writes the brief, or nothing when no report has a note: { brief ('' when not written), notes, removed }.
// A new brief starts a new check: the last one's answer and list are removed (removed: their names), and the
// old brief too when no note is left, so --record can never give the last round's verdicts again.
export function writeBrief({ notes, reports, repo, transcript }) {
  if (!isDir(notes)) throw usage('no such notes folder: ' + notes);
  if (repo !== undefined && !isDir(repo)) throw usage('no such repo folder: ' + repo);
  for (const file of reports) if (!isFile(file)) throw usage('no such report: ' + file);
  // This check's own files are never a reviewer report: one named here would be removed below.
  const own = [BRIEF, REPORT, LIST].map((name) => path.resolve(notes, name).toLowerCase());
  for (const file of reports) if (own.includes(path.resolve(file).toLowerCase())) throw usage(`${file} is this check's own file, not a reviewer report`);
  const scan = loadScan();
  // The reports' notes, always read: an empty or unreadable report is refused here too, and a long note is given in full.
  const fromReports = collectNotes(reports, scan.reportNotes);
  let found = '', skipped = '';
  if (transcript !== undefined) found = findTranscript({ transcript });
  else if (repo !== undefined) {
    const candidates = transcriptCandidates(repo).slice(0, MAX_SESSIONS);
    found = candidates.find((c) => sessionHolds(c, scan, fromReports)) || '';
    if (!found && candidates.length) skipped = candidates[0];
  }
  // The session's open notes, as the guards number them; none open (or no transcript): the reports' own K numbering.
  const open = found ? guardNotes(found, scan) : [];
  const unmatched = open.length ? fromReports.filter((r) => !open.some((g) => g.text === oneLine(r.text))) : [];
  for (const g of open) {
    const r = fromReports.find((x) => oneLine(x.text) === g.text);
    if (r && r.cut) Object.assign(g, { cut: r.cut, whole: r.whole, from: r.from });
  }
  // 2026-11-19: with the session log of these notes the brief always uses NOTE numbers. When every note of the
  // reports is a note of that session and none is open, nothing is left to check (they came back as K notes before).
  // A log that does not hold these notes is not their log: the K numbering stands, as with no log.
  const closed = found && !open.length && sessionHolds(found, scan, fromReports) ? fromReports : [];
  const list = open.length ? open : closed.length ? [] : fromReports;
  const numbering = open.length ? found : '';
  const removed = [REPORT, LIST, ...(list.length ? [] : [BRIEF])].filter((name) => removeOld(path.join(notes, name)));
  removeOld(path.join(notes, FILES));   // the file fingerprint of the last brief goes with it, silently
  if (!list.length) return { brief: '', notes: list, removed, transcript: '', unmatched: closed, skipped, bound: true };
  const brief = path.join(notes, BRIEF);
  const code = repo === undefined ? { top: '', code: '' } : codeState(repo);
  // 2026-11-18: every --brief run has its own generation, and a bound one saves the fingerprint of the repository's files.
  const state = readGenerations(notes);
  const generation = state.issued + 1;
  const at = Date.now();   // 2026-11-18 (repair 3): a file git does not list is shown unchanged by its modified time against this
  const files = code.code ? fileFingerprint(code.top) : null;
  const text = buildBrief({ repo, notes: list, transcript: numbering, code, generation });
  writeGenerations(notes, { issued: generation, recorded: state.recorded });
  fs.writeFileSync(brief, text);
  if (files) fs.writeFileSync(path.join(notes, FILES), JSON.stringify({ brief: briefIds(text).written, generation, root: code.top, at, files }));
  return { brief, notes: list, removed, transcript: numbering, unmatched, skipped, bound: !!code.code, generation };
}

// The kind of a brief line, without the asks mark: { kind, asks? }.
const kindOf = (raw) => (raw.endsWith(ASKS_MARK) ? { kind: raw.slice(0, -ASKS_MARK.length), asks: true } : { kind: raw });
// The K lines of a brief, in order: { n, kind, from, text }.
export function parseBrief(text) {
  const out = [];
  for (const l of String(text).split(/\r?\n/)) {
    let m = /^K(\d+) · (.+?) · from (.+?) · (.*)$/.exec(l);
    if (m) { out.push({ n: Number(m[1]), ...kindOf(m[2]), from: m[3], text: m[4].trim() }); continue; }
    m = /^NOTE (\d+) · (.+?) · (.*)$/.exec(l);
    if (m) out.push({ n: Number(m[1]), ...kindOf(m[2]), text: m[3].trim(), guard: true });
  }
  return out;
}

// A report line without its list mark or heading mark, and without the marks (bold, backticks, quotes) that
// open it: { text, close }. The same marks are taken off the line's end when they are there. When they are not,
// they close inside the line ("**REFUTED K2** — …", "**REFUTED K2 —** …"): close names them. Marks inside the
// evidence are never touched, so a code span or a bold file name in it stays whole.
function unwrap(line) {
  const l = line.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, '').replace(/^(?:#{1,6}|>)\s+/, '');
  const open = /^[`*_"]+/.exec(l);
  if (!open) return { text: l, close: '' };
  const rest = l.slice(open[0].length);
  const close = [...open[0]].reverse().join('');
  return rest.endsWith(close) ? { text: rest.slice(0, -close.length).trimEnd(), close: '' } : { text: rest, close };
}
// "<VERDICT> K<n> — <evidence>"; "K 3", "REFUTED: K2", a number in backticks, and - or : for the dash are read too.
const VERDICT = /^(CONFIRMED|REFUTED|UNSURE)([`*_]*)\s*:?\s*[`*_]*(NOTE\s+|K\s*)?(\d+)([`*_]*)\s*(?:[—–:-]+\s*)?(.*)$/i;
// The instruction quoted back: its placeholders are no evidence, and "K<n>" is no note number.
const PLACEHOLDER = /<(?:file:line[^>]*|what could not be checked)>/i;

// The line that names the brief the agent read: "BRIEF <id>". "Brief id: <id>" and marks around it are read too.
const BRIEF_ID = /^BRIEF(?:\s+ID)?\s*[:#—–-]?\s*[`*_"]*([0-9a-f]{8})(?![0-9a-z])/i;

// The generation the agent's BRIEF lines repeat ("BRIEF 1a2b3c4d g3"), in order; a line with no g part gives none.
const BRIEF_GENERATION = /^BRIEF(?:\s+ID)?\s*[:#—–-]?\s*[`*_"]*[0-9a-f]{8}[`*_"]*[ \t]+g(\d{1,9})(?![0-9a-z])/i;
export function answerGenerations(text) {
  const out = [];
  for (const row of String(text).split(/\r?\n/)) {
    const m = BRIEF_GENERATION.exec(unwrap(row.slice(0, MAX_ROW)).text);
    if (m) out.push(Number(m[1]));
  }
  return out;
}

// Every brief id the agent's answer names, in order.
export function answerIds(text) {
  const ids = [];
  for (const row of String(text).split(/\r?\n/)) {
    const m = BRIEF_ID.exec(unwrap(row.slice(0, MAX_ROW)).text);
    if (m) ids.push(m[1].toLowerCase());
  }
  return ids;
}

// The agent's answer: Map of note number → { verdict, evidence }. The last line for a note wins.
// A brief with the guards' numbers is answered "CONFIRMED 41 — ..." ("NOTE 41" and "K41" are read too); a K brief
// needs the K, as before, so a prose line such as "CONFIRMED 3 files ..." is no verdict there.
export function parseVerdicts(text, guard = false) {
  const verdicts = new Map();
  for (const row of String(text).split(/\r?\n/)) {
    const { text: line, close } = unwrap(row.slice(0, MAX_ROW));
    const m = VERDICT.exec(line);
    if (!m || PLACEHOLDER.test(m[6]) || (!guard && !m[3])) continue;
    // The line's opening marks, closed neither after the verdict nor after the number, close after the separator.
    const closedEarly = !close || m[2].includes(close) || m[5].includes(close);
    const evidence = closedEarly || !m[6].startsWith(close) ? m[6] : m[6].slice(close.length);
    verdicts.set(Number(m[4]), { verdict: m[1].toUpperCase(), evidence: evidence.trim() });
  }
  return verdicts;
}

// One note with its answer: { n, kind, text, verdict (CONFIRMED | REFUTED | UNSURE), label, evidence }.
// REFUTED needs evidence, a file and line and 12 characters or more: without it the note is UNSURE, so it is
// never set aside on the agent's word alone ("............" and "it is not true." were both accepted).
export function judge(note, answer) {
  if (!answer) return { ...note, verdict: 'UNSURE', label: 'UNSURE (no verdict)', evidence: '' };
  const shown = answer.evidence.length >= MIN_EVIDENCE && FILE_LINE.test(answer.evidence);
  if (answer.verdict === 'REFUTED' && !shown) return { ...note, verdict: 'UNSURE', label: 'UNSURE (refuted without evidence)', evidence: answer.evidence };
  return { ...note, verdict: answer.verdict, label: answer.verdict, evidence: answer.evidence };
}

export const checkLine = (r) => `${tag(r)} · ${r.label} · ${r.kind} · ${r.text}${r.evidence ? ' — ' + r.evidence : ''}`;

export function renderCheck({ brief, report, recorded, rows }) {
  return [
    '# Note check — each review note, checked against the code before any fix', '',
    `Brief: ${slash(brief)}`,
    `Report: ${slash(report)}`,
    `Recorded: ${recorded}`, '',
    'No note is closed here (rule 5). CONFIRMED: fix it with a test. UNSURE: not proven either way; check the missing fact first (a reproducer, or the file the checker could not read), fix it only when the fact holds, and a product choice goes to the user.',
    rows.length && rows.every((r) => r.guard)
      ? 'REFUTED: build no fix; the note is closed by its own refuted line with this evidence (never a Blocker or a Question: the user decides those).'
      : 'REFUTED: build no fix now; ask the user with this evidence and a recommended answer, and their words close it.',
    ...(rows.some(isQuestion) ? [QUESTION_LIST_RULE] : []),
    rows.length && rows.every((r) => r.guard) ? GUARD_RULE : K_RULE, '',
    ...rows.map(checkLine), '',
  ].join('\n');
}

export function recordCheck({ report, notes, now = new Date() }) {
  const brief = path.join(notes, BRIEF);
  // The agent's answer counts only for a brief this script wrote: its K numbers are the brief's.
  if (!isFile(brief)) throw usage(`no ${BRIEF} in ${notes}: run --brief first and launch the line it prints`);
  if (!isFile(report)) throw usage('no such report: ' + report);
  const briefText = readText(brief);
  const list = parseBrief(briefText);
  if (!list.length) throw usage(`${brief} has no K line: run --brief again`);
  // And only for the brief on disk now: K1 of an older brief is another note. The answer names the brief it
  // was written for; an answer that names none, or another one, is not recorded.
  const { generation, written, made, code, root, unbound } = briefIds(briefText);
  if (!written || written !== made) throw usage(`${brief} does not carry the id of its notes (an older release wrote it, or it was changed since): run --brief again and launch the line it prints`);
  const answer = readReport(report);
  const ids = answerIds(answer);
  if (!ids.length) throw usage(`${report} has no '${idLine(written)}' line, so it does not say which brief the agent read: its K numbers may be other notes. Nothing recorded: launch the check again from the LAUNCH line of --brief.`);
  const other = ids.find((id) => id !== written);
  if (other) throw usage(`${report} answers brief ${other}; the brief in ${notes} is ${written}: the K numbers are not the same notes. Nothing recorded: launch the check again from the newest brief.`);
  // 2026-11-18 (scoped staleness): two runs of --brief for the same notes and code share one id, so an older saved answer
  // could be recorded after a newer one. Every run has a generation: an answer for an older generation than the newest
  // recorded (or than the brief on disk) is refused.
  const recorded = readGenerations(notes).recorded;
  const said = answerGenerations(answer);
  // 2026-11-18 (repair 4): a brief with a run number needs it in the answer: an answer with no g part could be an older run's.
  if (generation && !said.length) throw usage(`${report} names the brief but not the run: write '${idLine(written, generation)}' as the first line (the g${generation} part is the run number). Nothing recorded: launch the check again from the LAUNCH line of --brief.`);
  const old = said.find((g) => g < Math.max(recorded, generation));
  if (old !== undefined) throw usage(`${report} was written for generation ${old} of this check; generation ${Math.max(recorded, generation)} ${recorded > generation ? 'is already recorded' : 'is the brief in ' + notes}: an older answer never replaces a newer one. Nothing recorded: launch the check again from the newest brief.`);
  if (generation && recorded > generation) throw usage(`the brief in ${notes} is generation ${generation}, but generation ${recorded} is already recorded: an older check never replaces a newer one. Nothing recorded: run --brief again and launch the line it prints.`);
  const guard = list.every((k) => k.guard);
  const verdicts = parseVerdicts(answer, guard);
  if (!list.some((k) => verdicts.has(k.n))) {
    throw usage(`${report} has no CONFIRMED, REFUTED or UNSURE line for ${guard ? 'any NOTE of the brief' : `K1..K${list.length}`}: the check did not run. Save the agent's final message there and record again.`);
  }
  let rows = list.map((k) => judge(k, verdicts.get(k.n)));
  // 2026-11-18 (scoped staleness): the answer counts for the files it cites, not for the whole code. A REFUTED verdict
  // stands only when every file the note's line and the evidence name is unchanged since the brief; otherwise the note
  // is UNSURE and gets no author line. Other code that changed (a plainly right note fixed meanwhile) changes nothing.
  const changedNotes = [];
  // 2026-11-18 (recheck by the other engine): a REFUTED answer is accepted only when the cited files are SHOWN unchanged.
  // Not bound (no code line, whatever else the brief says), or no cited name that is a file of the repository: nothing is shown.
  const unshown = [];
  if (!code) {
    rows = rows.map((r) => {
      if (r.verdict !== 'REFUTED') return r;
      unshown.push(tag(r));
      return { ...r, verdict: 'UNSURE', label: UNBOUND_LABEL };
    });
  } else {
    if (!proof) throw usage(`the code fingerprint cannot be loaded (${proofError}): the brief is bound to code, and this install cannot check it. Install the gate scripts of the same release.`);
    const top = proof.toplevelOf(root);
    const side = readJson(path.join(notes, FILES));
    const saved = side && side.brief === written && side.files && typeof side.files === 'object' ? side.files : null;
    rows = rows.map((r) => {
      if (r.verdict !== 'REFUTED') return r;
      let changed = !saved || !top;   // no fingerprint of that brief, or no repository now: nothing shows the files unchanged
      const since = side && Number.isFinite(side.at) ? side.at : undefined;
      if (!changed) changed = citedState(top, saved, [r.text, r.evidence], since).changed.length > 0;
      if (!changed) {
        // The note's own text may name a line that is gone (a typo, an old line): only the answer's citations must all be shown.
        const { found, unresolved } = citedState(top, saved, [r.evidence], since);
        if (!found || unresolved) {
          unshown.push(tag(r));
          return { ...r, verdict: 'UNSURE', label: found ? UNSHOWN_FILE_LABEL : NO_FILE_LABEL };
        }
      }
      if (!changed) return r;
      changedNotes.push(tag(r));
      return { ...r, verdict: 'UNSURE', label: CHANGED_LABEL };
    });
  }
  const out = path.join(notes, LIST);
  fs.writeFileSync(out, renderCheck({ brief, report: path.resolve(report), recorded: now.toISOString(), rows }));
  if (generation) writeGenerations(notes, { issued: Math.max(readGenerations(notes).issued, generation), recorded: Math.max(recorded, generation) });
  return { out, rows, answer, unbound, changedNotes, unshown };
}

// The guards' own reader of a note checker's answer (hooks/lib/transcript-scan.js, REFUTED_RE and readRefutations),
// copied because the hooks do not export it; a test runs every answer shape through the real scanner. Gives the
// evidence the guards would hold for note n, or '' when they would not read note n as refuted from this answer.
const GUARD_FENCED = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
// Kept word for word with the guards' REFUTED_RE and FILE_LINE: no "K" before the number (a K number belongs to a
// brief, not to the guards), and evidence that names a file and a line.
const GUARD_REFUTED = /^[ \t]*(?:(?:[-*•]|\d{1,3}[.)]|#{1,6}|>)[ \t]+)?[`*_ \t]*REFUTED:?[ \t]+(?:NOTE[ \t]+)?[`*_]*(\d{1,4})[`*_]*[ \t]*(?:[—–:]|-)[ \t]*[`*_]*[ \t]*(\S.*)$/gim;
const GUARD_FILE_LINE = /\w\.\w+[`*_"']*:\d+/;
// 2026-11-17: the checker's last verdict for a note wins in the guards: a later CONFIRMED or UNSURE line for n
// withdraws an earlier refutation (the guards' NOT_REFUTED_RE, word for word). Repair (2026-11-17): as wide as the
// script's own VERDICT reader; m[1] holds the numbers of the line ("1 and 2").
const GUARD_NOT_REFUTED = /^[ \t]*(?:(?:[-*•]|\d{1,3}[.)]|#{1,6}|>)[ \t]+)?[`*_ \t]*(?:CONFIRMED|UNSURE)[`*_]*[ \t]*:?[ \t]*[`*_]*(?:NOTE[ \t]+|K[ \t]*)?[`*_]*(\d{1,4}(?:(?:[ \t]*,[ \t]*|[ \t]+(?:and|&)[ \t]+)(?:K[ \t]*)?\d{1,4})*)(?!\d)/gim;
export function guardEvidence(answer, n) {
  const raw = String(answer || '').replace(/\r/g, '');
  // 2026-11-18: a REFUTED line is read outside code blocks only (blanked in place, so places stay the same); a CONFIRMED
  // or UNSURE line is read in one too, as it only withdraws, exactly as the guards do.
  const text = raw.replace(GUARD_FENCED, (b) => b.replace(/[^\n]/g, ' '));
  const verdicts = [...[...text.matchAll(GUARD_REFUTED)].map((m) => ({ at: m.index, m })), ...[...raw.matchAll(GUARD_NOT_REFUTED)].map((m) => ({ at: m.index, m, other: true }))]
    .sort((a, b) => a.at - b.at);
  let held = '';
  for (const { m, other } of verdicts) {
    if (other) { if (m[1].match(/\d+/g).some((x) => Number(x) === n)) held = ''; continue; }
    if (Number(m[1]) !== n) continue;
    const evidence = m[2].replace(/[`*_\s]+$/, '').trim();
    if (!held && evidence.length >= 12 && GUARD_FILE_LINE.test(evidence)) held = evidence;
  }
  return held;
}

function parse(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--brief') { o.brief = true; continue; }
    if (!['--notes', '--reports', '--repo', '--record', '--transcript'].includes(k) || argv[i + 1] === undefined) throw usage('Unknown or empty option: ' + k);
    o[k.slice(2)] = argv[++i];
  }
  if ([o.brief, o.record].filter(Boolean).length !== 1) throw usage('give one of --brief or --record <report>');
  if (!o.notes) throw usage((o.brief ? '--brief' : '--record') + ' needs --notes <dir>');
  if (o.brief && !o.reports) throw usage('--brief needs --reports <file1,file2,...>');
  if (o.record && (o.reports !== undefined || o.repo !== undefined)) throw usage('--reports and --repo go with --brief');
  if (o.record && o.transcript !== undefined) throw usage('--transcript goes with --brief');
  // An empty --repo resolved to the current folder, and the brief named that folder to the agent as the repo.
  if (o.repo === '') throw usage('--repo names no folder');
  if (o.transcript === '') throw usage('--transcript names no file');
  return o;
}

const USAGE = 'Usage: node note-check.mjs --brief --notes <dir> --reports <file1,file2,...> [--repo <path>] [--transcript <file.jsonl>]\n' +
  '       node note-check.mjs --record <report file> --notes <dir>\n';

// What the author may write for a refuted note that has a guard number. The guards never close a Blocker so.
// Printed only when the guards' own reader takes the checker's line as a refutation of this note (2026-11-17: nine
// answer shapes this script read were not read by the guards, and the printed line was then refused).
const authorLine = (r, answer) => {
  if (!r.guard || isQuestion(r)) return '';
  if (/^Blocker$/i.test(r.kind)) return `NOTE ${r.n} is a Blocker: ask the user; the guards do not close a Blocker as refuted.\n`;
  const held = guardEvidence(answer, r.n);
  return held ? `THE AUTHOR MAY NOW WRITE: NOTE ${r.n}: refuted — ${held}\n`
    : `NOTE ${r.n}: the guards cannot read the checker's line as a refutation: ask the checker to restate it as a plain line \`REFUTED ${r.n} — <file:line that makes the claim false>\` (no code block, no marks inside the line) and record again.\n`;
};

function main() {
  try {
    const o = parse(process.argv.slice(2));
    const notes = path.resolve(o.notes);
    if (o.brief) {
      const reports = o.reports.split(',').map((s) => s.trim()).filter(Boolean).map((p) => path.resolve(p));
      if (!reports.length) throw usage('--reports names no file');
      const b = writeBrief({ notes, reports, repo: o.repo === undefined ? undefined : path.resolve(o.repo), transcript: o.transcript === undefined ? undefined : path.resolve(o.transcript) });
      const removed = b.removed.length ? `REMOVED: ${b.removed.join(', ')} (the last check's files: a new --brief starts a new check)\n` : '';
      if (!b.notes.length) { process.stdout.write('NOTE CHECK: no note to check\n' + b.unmatched.map((u) => `NOT AN OPEN NOTE OF THE SESSION (already closed there): ${u.kind} · ${oneLine(u.text)}\n`).join('') + removed); return; }
      const report = quote(slash(path.join(notes, REPORT)));
      process.stdout.write(`NOTE CHECK BRIEF: ${slash(b.brief)} · ${b.notes.length} note(s)${b.transcript ? ` · the guards' NOTE numbers, from ${slash(b.transcript)}` : ''}\n` +
        launchLine(b.brief, b.notes.every((k) => k.guard)) + '\n' +
        (b.bound ? '' : NOT_BOUND + '\n') +
        `THEN: save the agent's final message as ${report}, then run: node ${quote(slash(path.join(here, 'note-check.mjs')))} --record ${report} --notes ${quote(slash(notes))}\n` +
        (b.skipped ? `NUMBERING: no session in ${slash(path.dirname(b.skipped))} holds these notes, so K numbers are used (pass --transcript <file.jsonl> for the guards' NOTE numbers)\n` : '') +
        b.unmatched.map((u) => `NOT AN OPEN NOTE OF THE SESSION (left out of the brief): ${u.kind} · ${oneLine(u.text)}\n`).join('') +
        removed);
    } else {
      const { out, rows, answer, unbound, changedNotes, unshown } = recordCheck({ report: path.resolve(o.record), notes });
      const count = (verdict) => rows.filter((r) => r.verdict === verdict).length;
      const refuted = rows.filter((r) => r.verdict === 'REFUTED');
      // 2026-11-18 (user decision): a Question is never refuted: the user sees it with the checker's view and its
      // recommended answer, and the user's words close it. No line for the author to write.
      const ask = (r) => (isQuestion(r)
        ? `ASK THE USER: ${tag(r)} · ${r.text} — Question, the checker's view (${r.label}): ${r.evidence || 'no view given'}\n`
        : r.verdict === 'REFUTED' ? `ASK THE USER: ${tag(r)} · ${r.text} — refuted: ${r.evidence}\n` + authorLine(r, answer) : '');
      // On stderr, so the result lines stay as they were (2026-11-18, audit 3 repair): the answer is not tied to any code.
      if (unbound) process.stderr.write(NOT_BOUND + '\n');
      process.stdout.write(`NOTE CHECK: ${rows.length} note(s) — ${count('CONFIRMED')} confirmed, ${refuted.length} refuted, ${count('UNSURE')} unsure\n` +
        rows.map(ask).join('') +
        // 2026-11-19 (groups): each group with the verdict of every number of it. The ready answer of each refuted
        // number is its own THE AUTHOR MAY NOW WRITE line above; a split group is said to be split.
        placeGroups(rows).map((g) => {
          const of = g.notes.map((n) => rows.find((r) => r.n === n));
          const split = new Set(of.map((r) => r.verdict)).size > 1;
          return `GROUP ${g.id} · ${g.place} · ${of.map((r) => tag(r) + ' ' + r.verdict).join(', ')} — ${split ? 'split: the checker judged these texts differently' : 'one verdict'}; answer every number of the group by its own verdict\n`;
        }).join('') +
        (unshown.length ? `NOT SHOWN UNCHANGED: ${unshown.join(', ')} — nothing shows the code it cites unchanged since the brief (see the label in the list): its REFUTED does not stand; no author line\n` : '') +
        (changedNotes.length ? `CHANGED SINCE THE BRIEF: ${changedNotes.join(', ')} — the code it cites changed: check again (its REFUTED does not stand; no author line)\n` : '') +
        (refuted.some((r) => !isQuestion(r)) ? refutedRule(rows) + '\n' : '') +
        (rows.length && rows.every((r) => r.guard) ? GUARD_RULE : K_RULE) + '\n' +
        `WRITTEN: ${slash(out)}\n`);
    }
  } catch (error) {
    process.stderr.write('NOTE CHECK: ' + error.message + '\n' + USAGE);
    process.exitCode = 2;
    if (!(error instanceof UsageError)) process.stderr.write(String(error.stack || '') + '\n');
  }
}

if (isMain(import.meta.url)) main();
