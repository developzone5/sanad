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
//       its whole text from the report. Prints the one launch line for the Agent tool (braintrust-expert, a
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
// Exit 0: written, or no note to check. 2: usage error, a missing or unreadable file, the hooks' parser cannot
// be loaded, an answer for another brief, a report with no verdict.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';

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
// The hooks' note parser, from this scripts folder. One parser: a second one here would drift from the hooks,
// and a note the hooks count would be missing from the check (or the other way round).
export const PARSER = '../../../hooks/lib/transcript-scan.js';
export const INSTRUCTIONS = "Before any fix. Each K line below is one note from a code review. Try to DISPROVE each note from the code: open the file and line the note names, and what calls it, and look for what makes the claim false (a guard, a caller that never sends that input, a test that already covers it). Answer with the BRIEF line given below first, then one line per note, and nothing else: 'CONFIRMED K<n> — <file:line and the input that shows it>', 'REFUTED K<n> — <file:line that makes the claim false>' or 'UNSURE K<n> — <what could not be checked>'. A note you cannot disprove with a file and line is CONFIRMED or UNSURE, never REFUTED. Read-only, about 3 minutes; do not edit.";
// The line that names the brief an answer was written for. K numbers start at 1 in every brief, so the number
// alone does not say which note an answer line is about.
export const idLine = (id) => 'BRIEF ' + id;
// A checking seat, never a review: a prompt that starts "You are the independent reviewer" is counted by the
// stop and push hooks as a finished review, so this check could have stood in for the review of the fix.
export const PROMPT_START = 'Seat: Note check, before any fix.';
// A K brief: its answer is "REFUTED K1", and the guards read that as NOTE 1, which is another note. So this prompt
// is not the note check seat to them: a K answer never makes a NOTE number refutable.
export const PROMPT_START_K = 'Check each K note, before any fix.';
export const REFUTED_RULE = 'Refuted notes are not fixed now: ask the user about them together, with this evidence and a recommended answer; their words close each one (rule 5).';
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
  const folder = path.join(process.env.SANAD_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects'), path.resolve(repo).replace(/[^A-Za-z0-9]/g, '-'));
  let names;
  try { names = fs.readdirSync(folder).filter((n) => /\.jsonl$/i.test(n)); } catch { return []; }
  return names.map((n) => ({ file: path.join(folder, n), at: fs.statSync(path.join(folder, n)).mtimeMs })).sort((a, b) => b.at - a.at).map((x) => x.file);
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
  return (res.openReviewNotes || []).map((n) => ({ n: n.n, kind: n.kind, text: oneLine(n.text), guard: true }));
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
      if (list.some((k) => k.text === found.text)) continue;
      const note = { n: list.length + 1, kind: found.kind, from: path.basename(file), text: found.text };
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
export const briefLine = (k) => (k.guard ? `NOTE ${k.n} · ${k.kind} · ${k.text}` : `K${k.n} · ${k.kind} · from ${k.from} · ${k.text}`);
// Under the K line of a cut note. Indented, so it is no K line: the K line keeps the text the hooks show.
export const wholeLine = (k) => (k.whole
  ? `    ${tag(k)} in full (the ${k.guard ? 'line above' : 'K line'} is cut at ${k.cut} characters): ${k.whole}`
  : `    ${tag(k)} is cut at ${k.cut} characters, and its other lines were not found in ${k.from || 'its report'}: answer UNSURE when the part shown is not enough to check.`);
const noteLines = (k) => (k.cut ? [briefLine(k), wholeLine(k)] : [briefLine(k)]);

// A brief's id: a short hash of its repo and its note lines (line ends and spaces at a line's end do not count).
// The same notes for the same repo give the same id; other notes, another order or another repo give another.
export function briefId(repo, lines) {
  const body = [repo ? slash(repo) : '', ...lines.map((l) => String(l).trimEnd()).filter(Boolean)].join('\n');
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 8);
}

// The same instructions for the guards' numbers: the lines are "NOTE <n> · ..." and the answer names "<n>".
export const GUARD_INSTRUCTIONS = INSTRUCTIONS.replace('Each K line below', 'Each NOTE line below').replace(/K<n>/g, '<n>');
export const GUARD_RULE = "These numbers are the guards' own NOTE numbers: the author closes each note under the same number.";

export function buildBrief({ repo, notes, transcript }) {
  const guard = notes.length > 0 && notes.every((k) => k.guard);
  const lines = notes.flatMap(noteLines);
  const id = briefId(repo, lines);
  return [
    '# Note check — before any fix', '',
    `Brief id: ${id}`,
    ...(repo ? [`Repo: ${slash(repo)}`] : []),
    ...(guard && transcript ? [`Numbering: the guards' NOTE numbers, from ${path.basename(transcript)}`] : []), '',
    '## What to do', '',
    guard ? GUARD_INSTRUCTIONS : INSTRUCTIONS, '',
    `First line of your answer: ${idLine(id)}`,
    'It names the brief you read: an answer without it, or with another id, is not recorded.', '',
    ...(repo ? ['A file a note names is relative to the repo above.', ''] : []),
    '## Notes', '',
    ...lines, '',
  ].join('\n');
}

// What a brief on disk says of itself: { written (its "Brief id:" line), made (the id its repo and note lines give) }.
// They differ when the note lines were changed after the brief was written, or when it has no id line.
export function briefIds(text) {
  const rows = String(text).split(/\r?\n/).map((l) => l.trimEnd());
  const notes = rows.indexOf('## Notes');
  const find = (pattern) => rows.slice(0, Math.max(notes, 0)).map((l) => pattern.exec(l)).filter(Boolean).map((m) => m[1])[0] || '';
  return { written: find(/^Brief id: ([0-9a-f]{8})$/), made: notes < 0 ? '' : briefId(find(/^Repo: (.+)$/), rows.slice(notes + 1)) };
}

export function launchLine(brief, guard = true) {
  return `LAUNCH: Agent braintrust-expert · prompt: ${guard ? PROMPT_START : PROMPT_START_K} Read and follow only the brief at ${slash(brief)}. ` +
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
  const list = open.length ? open : fromReports;
  const numbering = open.length ? found : '';
  const removed = [REPORT, LIST, ...(list.length ? [] : [BRIEF])].filter((name) => removeOld(path.join(notes, name)));
  if (!list.length) return { brief: '', notes: list, removed, transcript: '', unmatched: [], skipped };
  const brief = path.join(notes, BRIEF);
  fs.writeFileSync(brief, buildBrief({ repo, notes: list, transcript: numbering }));
  return { brief, notes: list, removed, transcript: numbering, unmatched, skipped };
}

// The K lines of a brief, in order: { n, kind, from, text }.
export function parseBrief(text) {
  const out = [];
  for (const l of String(text).split(/\r?\n/)) {
    let m = /^K(\d+) · (.+?) · from (.+?) · (.*)$/.exec(l);
    if (m) { out.push({ n: Number(m[1]), kind: m[2], from: m[3], text: m[4].trim() }); continue; }
    m = /^NOTE (\d+) · (.+?) · (.*)$/.exec(l);
    if (m) out.push({ n: Number(m[1]), kind: m[2], text: m[3].trim(), guard: true });
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
    'REFUTED: build no fix now; ask the user with this evidence and a recommended answer, and their words close it.',
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
  const { written, made } = briefIds(briefText);
  if (!written || written !== made) throw usage(`${brief} does not carry the id of its notes (an older release wrote it, or it was changed since): run --brief again and launch the line it prints`);
  const answer = readReport(report);
  const ids = answerIds(answer);
  if (!ids.length) throw usage(`${report} has no '${idLine(written)}' line, so it does not say which brief the agent read: its K numbers may be other notes. Nothing recorded: launch the check again from the LAUNCH line of --brief.`);
  const other = ids.find((id) => id !== written);
  if (other) throw usage(`${report} answers brief ${other}; the brief in ${notes} is ${written}: the K numbers are not the same notes. Nothing recorded: launch the check again from the newest brief.`);
  const guard = list.every((k) => k.guard);
  const verdicts = parseVerdicts(answer, guard);
  if (!list.some((k) => verdicts.has(k.n))) {
    throw usage(`${report} has no CONFIRMED, REFUTED or UNSURE line for ${guard ? 'any NOTE of the brief' : `K1..K${list.length}`}: the check did not run. Save the agent's final message there and record again.`);
  }
  const rows = list.map((k) => judge(k, verdicts.get(k.n)));
  const out = path.join(notes, LIST);
  fs.writeFileSync(out, renderCheck({ brief, report: path.resolve(report), recorded: now.toISOString(), rows }));
  return { out, rows, answer };
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
  const text = String(answer || '').replace(/\r/g, '').replace(GUARD_FENCED, '');
  const verdicts = [...[...text.matchAll(GUARD_REFUTED)].map((m) => ({ at: m.index, m })), ...[...text.matchAll(GUARD_NOT_REFUTED)].map((m) => ({ at: m.index, m, other: true }))]
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
  if (!r.guard) return '';
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
      if (!b.notes.length) { process.stdout.write('NOTE CHECK: no note to check\n' + removed); return; }
      const report = quote(slash(path.join(notes, REPORT)));
      process.stdout.write(`NOTE CHECK BRIEF: ${slash(b.brief)} · ${b.notes.length} note(s)${b.transcript ? ` · the guards' NOTE numbers, from ${slash(b.transcript)}` : ''}\n` +
        launchLine(b.brief, b.notes.every((k) => k.guard)) + '\n' +
        `THEN: save the agent's final message as ${report}, then run: node ${quote(slash(path.join(here, 'note-check.mjs')))} --record ${report} --notes ${quote(slash(notes))}\n` +
        (b.skipped ? `NUMBERING: no session in ${slash(path.dirname(b.skipped))} holds these notes, so K numbers are used (pass --transcript <file.jsonl> for the guards' NOTE numbers)\n` : '') +
        b.unmatched.map((u) => `NOT AN OPEN NOTE OF THE SESSION (left out of the brief): ${u.kind} · ${oneLine(u.text)}\n`).join('') +
        removed);
    } else {
      const { out, rows, answer } = recordCheck({ report: path.resolve(o.record), notes });
      const count = (verdict) => rows.filter((r) => r.verdict === verdict).length;
      const refuted = rows.filter((r) => r.verdict === 'REFUTED');
      process.stdout.write(`NOTE CHECK: ${rows.length} note(s) — ${count('CONFIRMED')} confirmed, ${refuted.length} refuted, ${count('UNSURE')} unsure\n` +
        refuted.map((r) => `ASK THE USER: ${tag(r)} · ${r.text} — refuted: ${r.evidence}\n` + authorLine(r, answer)).join('') +
        (refuted.length ? REFUTED_RULE + '\n' : '') +
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
