#!/usr/bin/env node
// siblings.mjs — a second look for places the places list misses, by another agent, before any code.
//
// 2026-11-14: rule 1 (places.mjs) lists every place that uses the names the AUTHOR chose. A fix for "focus does
// not move to the field with the error after a failed save" listed three chip groups; three sibling fields with
// the same defect (date pickers, a student list, a rich-text description) were found only at the final review,
// which cost a full fix round. Here another agent reads the ticket lines, the check lines and the places, and
// names the other places with the same rule or defect; each one needs an outcome before review
// (pre-review.mjs --siblings).
// 2026-11-15 (role-sync task): the agent named 7 places with other problems, outside the ticket's goal, and the
// author spent time sorting them out. A sibling now carries the ticket's own rule; any other finding is an
// `OUTSIDE PR:` line, kept apart for the user's end list, with no outcome needed.
// 2026-11-16 (PR #784, user: "we should find the best way for any task and if there is simller one we done before"):
// the places search finds code that uses the same NAMES; nobody asked how the repo already does the same KIND of
// job, so a hand-made inline call was built where the repo already had an outbox table and a worker for exactly that.
// The same agent now also names that work (`SAME JOB:` lines, or `SAME JOB: none`); each one needs `reuse` or
// `not: <reason>` before review, and a report with no same-job answer is refused.
//
//   node siblings.mjs --brief --notes <dir> --repo <repo>
//       Writes <notes>/siblings-brief.md from <notes>/lines.md (ticket lines), <notes>/check.md (check lines)
//       and <notes>/places.md (the places, from places.mjs), with fixed instructions, and prints the one launch
//       line for the Agent tool (braintrust-expert, a read-only planning seat; never a reviewer prompt, which
//       the hooks would count as a finished review). Its prompt names the brief only.
//   node siblings.mjs --record <report file> --notes <dir>
//       Reads the agent's report: its `SIBLING: <file>:<line> · <what> — <why>` lines, or `SIBLINGS: none`,
//       and its `OUTSIDE PR: <file>:<line> — <what>` lines (kept under their own heading, for the user's end list).
//       Writes <notes>/siblings.md: one line per sibling, `S<n> · <file>:<line> · <what> — <why> → `, open. A
//       SIBLING line in another shape is kept as written, never dropped. Recorded again: every S line keeps its
//       number and outcome, a sibling not on it yet gets the next number. A report with neither kind of line
//       is refused: the check did not run. Its `SAME JOB: <file>:<line> · <what> — <how>` lines become
//       `J<n> · … → ` lines under their own heading (or `SAME JOB: none`); a report with neither is refused too.
//   node siblings.mjs --check <siblings.md> [--places <places.md>]
//       Every S line needs `P<n>` (the sibling is a place now: its name added with places.mjs --names; with
//       --places, P<n> is on that list, not gone and, when the S line names a file, a place in that file: with
//       several P numbers, at least one of them) or `none: <reason>` (at least 12 characters). Every J line
//       needs `reuse` (the design follows that pattern) or `not: <reason>` (at least 12 characters), and a list
//       with no J line and no `SAME JOB: none` is open. Prints `OPEN: S<n>|J<n> · …` per open line and
//       `SIBLINGS: <k> found, <m> open` plus `SAME JOB: <j> found, <o> open`.
// 2026-11-18 (audit of the release): a P<n> closes a sibling only when it is the place of the function that holds the
// sibling's line (or carries the function name the line gives), in the file the line names: the first `<file>:<line>`
// anywhere in the line; a line with none is open until `none: <reason>`. --record reads a sibling line in any case,
// with bold marks or a number, and refuses a line that starts with SIBLING and is not one. "none" may be followed by
// more words ("SIBLINGS: none (searched …)", "SAME JOB: none - …"); "SIBLING: none" reads as "SIBLINGS: none".
// --record stores `Sources: <hash>` of the ticket lines and check lines (and refuses when they changed after the
// brief); --check with --lines <lines.md> --check-lines <check.md> fails when they differ from that hash.
// Exit 0: written, or no open line. 1: an open line. 2: usage error, a missing file, a report with no answer.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readLines } from './check-ticket-lines.mjs';
import { checkLines } from './review-brief.mjs';
import crypto from 'node:crypto';
import { parsePlaces, placeLine, declarations, readLabel } from './places.mjs';
import { isMain } from './is-main.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIN_REASON = 12;
export const BRIEF = 'siblings-brief.md';
export const LIST = 'siblings.md';
export const REPORT = 'siblings-report.md';
export const INSTRUCTIONS = "Before any code. Read the ticket lines and the check lines first: they are the goal. Then the places, and the code at each place and around it. Name every OTHER place where the ticket's own rule or defect applies and that is not on the list: another field, another screen or role, another entry point (create, edit, publish, import, a job), an API field, an export. A place with a different problem, or one the ticket lines do not reach, is no sibling: write it as 'OUTSIDE PR: <file>:<line> — <what>', and the user decides it at the end. Then, separately: how does this repo already do the same KIND of job the ticket needs? Search by what the code does, not by the names above (for example 'send a change to another system after a save' → an outbox table and the worker that sends it; 'a list with filters' → the screen that already pages and filters). Name each one as 'SAME JOB: <file>:<line> · <what> — <how it does the job>', or write the single line 'SAME JOB: none' after searching. Answer only with lines 'SIBLING: <file>:<line> · <function or field> — <why it is the ticket's rule>', 'OUTSIDE PR:' lines and 'SAME JOB:' lines, or 'SIBLINGS: none' and 'SAME JOB: none'. About 4 minutes; do not edit.";
// A planning seat, never a review (2026-11-14): a prompt that starts "You are the independent reviewer" is
// counted by the stop and push hooks as a finished review, so this check, run before any code, could have
// stood in for the real review of the code written after it.
export const PROMPT_START = 'Seat: Sibling check, before code.';

class UsageError extends Error {}
const usage = (message) => new UsageError(message);
const slash = (p) => String(p).replace(/\\/g, '/');

function toplevel(dir) {
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

// A report saved from PowerShell 5.1 can be UTF-16 or start with a byte order mark (2026-11-14): both read as
// plain text, or no SIBLING line would be found in it.
export function readText(file) {
  const buf = fs.readFileSync(file);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  const text = buf.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// One source file of the notes folder, or a usage error that names the step that makes it.
function source(notes, name, makes) {
  const file = path.join(notes, name);
  if (!fs.existsSync(file)) throw usage(`no ${name} in ${notes}: ${makes}`);
  return readText(file);
}

export function buildBrief({ repo, ticket, checks, list }) {
  const order = (p) => list.names.indexOf(p.name) * 1e6 + p.n;
  const live = list.places.filter((p) => p.mark !== 'gone').sort((a, b) => order(a) - order(b));
  return [
    '# Sibling check — before code', '',
    `Repo: ${slash(repo)}`,
    `Names the author searched (whole words): ${list.names.join(', ')}`, '',
    '## What to do', '',
    INSTRUCTIONS, '',
    '`<file>` is relative to the repo above.', '',
    '## Ticket lines', '',
    ...ticket.map((t, i) => `- T${i + 1}. ${t}`), '',
    '## Check lines', '',
    ...checks.map((c, i) => `- C${i + 1}. ${c}`), '',
    '## Places already on the list (places.mjs)', '',
    ...(live.length ? live.map((p) => '- ' + placeLine(p)) : ['- none: no product file uses these names']), '',
  ].join('\n');
}

export function launchLine(brief) {
  return `LAUNCH: Agent braintrust-expert · prompt: ${PROMPT_START} Read and follow only the brief at ${slash(brief)}. ` +
    'Do not open any other file in that folder. Read-only: no builds, no tests, no edits. Your final message is only the SIBLING, OUTSIDE PR and SAME JOB lines (or SIBLINGS: none and SAME JOB: none).';
}

export function writeBrief({ notes, repo }) {
  const top = toplevel(repo);
  if (!top) throw usage('not inside a git repository: ' + repo);
  // lines.md is numbered "T1. text"; readLines turns that into "T1: text", and the number is written here again.
  const ticket = readLines(source(notes, 'lines.md', 'make it with lines.mjs --from <ticket text> --out <notes>/lines.md'))
    .map((l) => l.replace(/^T\d+:\s*/i, ''));
  if (!ticket.length) throw usage(`lines.md in ${notes} has no ticket line`);
  const checks = checkLines(source(notes, 'check.md', 'write the check lines first, one per result the change must prove'));
  if (!checks.length) throw usage(`check.md in ${notes} has no check line`);
  const list = parsePlaces(source(notes, 'places.md', 'make it with places.mjs --repo <repo> --names <names> --out <notes>/places.md'));
  if (!list) throw usage(`places.md in ${notes} is not a places list (no Repo: and Names: header): make it with places.mjs`);
  const brief = path.join(notes, BRIEF);
  fs.writeFileSync(brief, buildBrief({ repo: top, ticket, checks, list }));
  return { brief, ticket, checks, places: list.places.filter((p) => p.mark !== 'gone').length };
}

// A report line without list marks, quotes or bold: "- `SIBLING: …`" and "**SIBLINGS: none**" read plainly.
// 2026-11-18 (repair round): a heading mark ("### SIBLING: …", "#### 2. SIBLING: …"), a table bar ("| SIBLING: … |"), a
// bracket ("[SIBLING] …", "(SIBLING) …"), an arrow ("➜ SIBLING: …") and strike marks ("~~SIBLING~~: …") before or
// after the line are no part of it: the line was dropped with no word. They are stripped here.
const LEAD = /^(?:[#|>➜➔→»~*•[(]+|-\s|\d+[.)]\s+)\s*/;
const bare = (line) => {
  let s = line.trim();
  for (let k = 0; k < 4; k++) { const n = s.replace(LEAD, ''); if (n === s) break; s = n; }
  return s.replace(/^[`*_>"\s]+|[`*_"|\s]+$/g, '').replace(/^(SIBLINGS?:)[*_]+\s*/, '$1 ').trim();
};
// 2026-11-18 (audit): an honest answer with a few words after "none" ("SIBLINGS: none (searched the three other date
// fields)", "SAME JOB: none - no outbox does this") was refused or became an open line "none - …". "none" may be
// followed by a space, a comma, a bracket, a dash or a full stop; "none.ts:3" is a file, "nonexistent" is a word.
// "SIBLING: none" reads as "SIBLINGS: none".
const AFTER_NONE = '(?=$|[\\s,;(—–-]|\\.(?:\\s|$))';
const NONE = new RegExp('^SIBLINGS?\\s*:\\s*none' + AFTER_NONE, 'i');
const OUTSIDE = /^OUTSIDE PR:\s*(.*)$/i;
const JOB_NONE = new RegExp('^SAME JOB\\s*:\\s*none' + AFTER_NONE, 'i');
// 2026-11-18 (audit): a sibling line in any case, with bold marks or a number ("**SIBLING**: …", "Sibling: …",
// "SIBLING 4: …"). A line that starts with that word and is not one is a usage error, never skipped.
const SIBLING_LINE = /^SIBLINGS?(?:\s*\d+)?\s*[*_`~]*\s*:[*_`~]*\s*(.*)$/i;
// "[SIBLING] <file>:<line> · …" and "(SIBLING) …": the closing bracket stands where the colon would.
const SIBLING_BRACKETED = /^SIBLINGS?\s*[\])]\s*:?\s*(.*)$/i;
const SIBLING_WORD = /^SIBLINGS?\b/i;
const JOB = /^SAME JOB:\s*(.*)$/i;
// "<file>:<line> · <function or field> — <why>"; a line range (12-20) counts as a line.
const SHAPED = /^(.+?):(\d+(?:[-–]\d+)?) · (.+?) — (.+)$/;
// A report line's body: the agent's own arrows become "->" (the first → on a list line starts its outcome), and
// the instruction quoted back, with its placeholders, is no line at all.
const body = (s) => { const b = s.replace(/→/g, '->').trim(); return b && !/<file>/.test(b) ? b : ''; };
const shape = (b) => { const s = SHAPED.exec(b); return s ? `${s[1].trim()}:${s[2]} · ${s[3].trim()} — ${s[4].trim()}` : b; };

// The agent's answer: { siblings, none, outside, jobs, jobNone } (the text of each S, OUTSIDE PR and SAME JOB line),
// or null when it has no sibling answer of any kind.
export function parseReport(text) {
  const siblings = [], outside = [], jobs = [];
  let none = false, jobNone = false;
  for (const row of String(text).split(/\r?\n/)) {
    const l = bare(row);
    if (NONE.test(l)) { none = true; continue; }
    if (JOB_NONE.test(l)) { jobNone = true; continue; }
    const o = OUTSIDE.exec(l);
    if (o) { const b = body(o[1]); if (b && !outside.includes(b)) outside.push(b); continue; }
    const j = JOB.exec(l);
    if (j) { const b = body(j[1]); if (b && !jobs.includes(shape(b))) jobs.push(shape(b)); continue; }
    const m = SIBLING_LINE.exec(l) || SIBLING_BRACKETED.exec(l);
    if (!m || !m[1].trim()) {
      // A line that holds the word SIBLING and a <file>:<line> but starts with other words ("Possible SIBLING: …",
      // "Second sibling: …") is refused, never dropped (2026-11-18).
      if (SIBLING_WORD.test(l) || (/\bSIBLINGS?\b/i.test(l) && siblingSpot(l))) throw usage(`a report line starts with SIBLING but is not "SIBLING: <file>:<line> · <what> — <why>" (nor "SIBLINGS: none"): "${l.slice(0, 100)}". Rewrite it in that shape and record again.`);
      continue;
    }
    const b = body(m[1]);
    if (b && !siblings.includes(shape(b))) siblings.push(shape(b));
  }
  return siblings.length || none || outside.length ? { siblings, none: !siblings.length, outside, jobs, jobNone: jobNone && !jobs.length } : null;
}

// "S3 · <text> → <outcome>" and "J2 · <text> → <outcome>"; a line whose arrow was deleted reads with no outcome
// (open), never dropped.
export function parseSiblings(text) {
  const rows = [], jobs = [];
  let none = false, jobNone = false, sources = '', holds = {};
  for (const line of String(text).split(/\r?\n/)) {
    const hold = /^Holds: (\{.*\})\s*$/.exec(line);
    if (hold) { try { holds = JSON.parse(hold[1]); } catch { /* an unreadable line holds nothing */ } continue; }
    const src = /^Sources: ([0-9a-f]+)\s*$/.exec(line);
    if (src) { sources = src[1]; continue; }
    if (NONE.test(line.trim())) { none = true; continue; }
    if (JOB_NONE.test(line.trim())) { jobNone = true; continue; }
    const m = /^([SJ])(\d+) · (.*)$/.exec(line);
    if (!m) continue;
    const arrow = m[3].indexOf('→');
    (m[1] === 'S' ? rows : jobs).push({ n: Number(m[2]), body: (arrow < 0 ? m[3] : m[3].slice(0, arrow)).trim(), outcome: arrow < 0 ? '' : m[3].slice(arrow + 1).trim() });
  }
  for (const r of rows) if (holds && typeof holds[r.n] === 'string') r.holds = holds[r.n];
  return { rows, none, jobs, jobNone: jobNone && !jobs.length, sources };
}

// 2026-11-18 (audit): the list stayed valid after the ticket lines and the check lines changed, so a line added
// later was never searched for siblings or same-job work. --record stores a hash of the two sources (the ticket
// lines and the check lines as the brief reads them, so spacing and header text do not count); --check fails when
// a --lines / --check-lines given now hash differently. null when a source cannot be read.
export function sourcesOf(linesText, checkText) {
  try {
    const ticket = readLines(linesText).map((l) => l.replace(/^T\d+:\s*/i, ''));
    const checks = checkLines(checkText);
    return { ticket, checks, hash: crypto.createHash('sha256').update(JSON.stringify({ ticket, checks })).digest('hex').slice(0, 12) };
  } catch { return null; }
}

export const siblingLine = (r) => `S${r.n} · ${r.body} → ${r.outcome}`;
export const jobLine = (r) => `J${r.n} · ${r.body} → ${r.outcome}`;
export const OUTSIDE_HEADING = "## Outside the ticket — for the user's end list (no outcome here)";
export const JOB_HEADING = '## Same kind of job done before — write `reuse` (the design follows it) or `not: <why>` after each →';

// The OUTSIDE PR lines already in a siblings list, in order.
export function parseOutside(text) {
  return String(text).split(/\r?\n/).map((l) => /^- OUTSIDE PR:\s*(.*)$/.exec(l)).filter(Boolean).map((m) => m[1].trim());
}

export function renderSiblings({ brief, report, recorded, rows, outside = [], jobs = [], jobNone = false, sources = '' }) {
  return [
    '# Siblings — places with the same rule or defect that the places list missed', '',
    `Brief: ${slash(brief)}`,
    `Report: ${slash(report)}`,
    `Recorded: ${recorded}`,
    ...(sources ? [`Sources: ${sources}`] : []),
    // 2026-11-18 (repair round): the function that held each sibling's line when it was recorded, before the code moved it.
    ...(rows.some((r) => r.holds) ? [`Holds: ${JSON.stringify(Object.fromEntries(rows.filter((r) => r.holds).map((r) => [r.n, r.holds])))}`] : []), '',
    "Write the outcome after each →: `P<n>` (add the sibling's name with places.mjs --names; n is the place it gets in the sibling's own file) or `none: <why it is not the same rule>`.",
    'siblings.mjs --record keeps every outcome when it records again; pre-review.mjs --siblings checks this file.', '',
    ...(rows.length ? rows.map(siblingLine) : ['SIBLINGS: none']), '',
    ...(jobs.length || jobNone ? [JOB_HEADING, '', ...(jobs.length ? jobs.map(jobLine) : ['SAME JOB: none']), ''] : []),
    ...(outside.length ? [OUTSIDE_HEADING, '', ...outside.map((o) => '- OUTSIDE PR: ' + o), ''] : []),
  ].join('\n');
}

export function recordSiblings({ report, notes, now = new Date() }) {
  const brief = path.join(notes, BRIEF);
  // The agent's answer counts only for a brief this script wrote: a "SIBLINGS: none" typed with no brief is no check.
  if (!fs.existsSync(brief)) throw usage(`no ${BRIEF} in ${notes}: run --brief first and launch the line it prints`);
  if (!fs.existsSync(report)) throw usage('no such report: ' + report);
  const found = parseReport(readText(report));
  if (!found) throw usage(`${report} has no SIBLING line, no OUTSIDE PR line and no "SIBLINGS: none" line: the check did not run. Save the agent's final message there and record again.`);
  const out = path.join(notes, LIST);
  const oldText = fs.existsSync(out) ? readText(out) : '';
  const old = parseSiblings(oldText);
  if (!found.jobs.length && !found.jobNone && !old.jobs.length && !old.jobNone) {
    throw usage(`${report} has no SAME JOB line and no "SAME JOB: none" line: the same-job search did not run. Launch the brief's line again (it asks how the repo already does this kind of job), save its answer there and record again.`);
  }
  // 2026-11-18 (audit): the brief was written for the ticket lines and check lines of that time. When the notes
  // folder holds them and they are not the ones in the brief any more, the report answers an older question.
  let sources = '';
  const linesFile = path.join(notes, 'lines.md'), checkFile = path.join(notes, 'check.md');
  if (fs.existsSync(linesFile) && fs.existsSync(checkFile)) {
    const now = sourcesOf(readText(linesFile), readText(checkFile));
    if (now) {
      const briefText = readText(brief);
      const inBrief = (letter) => String(briefText).split(/\r?\n/).map((l) => new RegExp(`^- ${letter}\\d+\\. (.*)$`).exec(l)).filter(Boolean).map((m) => m[1]);
      const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
      if (!same(inBrief('T'), now.ticket) || !same(inBrief('C'), now.checks)) {
        throw usage(`the ticket lines or check lines changed after the brief was written: run --brief again, launch its line, save the new answer as ${slash(path.join(notes, REPORT))} and record that.`);
      }
      sources = now.hash;
    }
  }
  const rows = old.rows;
  let next = rows.reduce((n, r) => Math.max(n, r.n), 0) + 1;
  // The function that holds each new sibling's line is read now, before the code: line numbers move with the fix.
  let repoOf = '';
  try { const pl = parsePlaces(readText(path.join(notes, 'places.md'))); repoOf = pl ? pl.repo : ''; } catch { /* no places list: no stored function */ }
  for (const b of found.siblings) {
    if (rows.some((r) => r.body === b)) continue;
    const spot = siblingSpot(b), at = spot && repoOf ? functionAt(repoOf, spot.file, spot.line) : null;
    rows.push({ n: next++, body: b, outcome: '', ...(at ? { holds: at } : {}) });
  }
  const jobs = old.jobs;
  let nextJob = jobs.reduce((n, r) => Math.max(n, r.n), 0) + 1;
  for (const b of found.jobs) if (!jobs.some((r) => r.body === b)) jobs.push({ n: nextJob++, body: b, outcome: '' });
  const jobNone = !jobs.length && (found.jobNone || old.jobNone);
  const outside = parseOutside(oldText);
  for (const b of found.outside) if (!outside.includes(b)) outside.push(b);
  const text = renderSiblings({ brief, report: path.resolve(report), recorded: now.toISOString(), rows, outside, jobs, jobNone, sources: sources || old.sources });
  fs.writeFileSync(out, oldText.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text);
  return { out, rows, outside, jobs, jobNone };
}

// Why a J line is still open ('' = closed): `reuse` (the design follows that pattern) or `not: <reason>`.
export function jobOpenReason(row) {
  const o = row.outcome.trim();
  if (!o) return 'no outcome';
  if (/^reuse\b/i.test(o)) return '';
  const not = /^not:\s*(.*)$/i.exec(o);
  if (not) return not[1].trim().length >= MIN_REASON ? '' : `the reason after not: needs at least ${MIN_REASON} characters`;
  return 'write reuse or not: <why this pattern does not fit>';
}

// 2026-11-17 (audit, "a sibling can close against an unrelated place"): any P number that was on the list
// closed an S line, so a number copied from another line closed a sibling in PublishNow.cs with a place in
// Schedule.cs, and the sibling's own file was never searched. A place closes a sibling in its own file only.

// The file an S line names: a leading "<file>:<line>" (the shape --record writes is "<file>:<line> · …", but a
// line kept as written may continue with ":<col>", " - ", backticks or a leading "/"); '' when the line starts
// with no file. The file has an extension or a folder, and no space.
// 2026-11-18 (audit): a line that does not start with its file ("DatePicker (src/components/DatePicker.tsx:1) — …")
// had no file and any place closed it. The first `<path>:<line>` anywhere in the line is its file now; a line with
// none is open when it has a P<n> outcome.
const SPOT = /(?:^|[\s`'"(\[])\/*([^\s`'"()\[\]]*[./][^\s`'"()\[\]]*?):(\d+)(?!\w)/;
export const siblingSpot = (body) => {
  const m = SPOT.exec(String(body).trim());
  return m ? { file: m[1].trim(), line: Number(m[2]) } : null;
};
export const siblingFile = (body) => { const s = siblingSpot(body); return s ? s.file : ''; };

// The function part of "<file>:<line> · <function or field> — <why>", as a place of the list names it: no "()".
const functionPart = (body) => { const m = /^.+?:\d+(?:[-–]\d+)? · (.+?) — /.exec(String(body).trim()); return m ? m[1].trim().replace(/\(\)$/, '') : ''; };

// The place label of the declaration that holds `line` of `file` (the list's repo), as places.mjs names it; null when
// the file cannot be read there.
function functionAt(repo, file, line) {
  if (!repo) return null;
  let lines;
  try { lines = fs.readFileSync(path.resolve(repo, file), 'utf8').split(/\r?\n/); } catch { return null; }
  if (line < 1 || line > lines.length) return null;
  const rows = declarations(slash(file), [line], lines);
  return rows.length ? rows[0].fn : null;
}

// A function as a place label: "Type.name(int a)" → { scope, bare, sig }; words after the name are dropped
// ("PublishNow method" is PublishNow); null when no name can be read.
function asLabel(text) {
  const m = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?:\(([^)]*)\))?/.exec(String(text).trim());
  if (!m) return null;
  const parts = m[1].split('.');
  return { bare: parts[parts.length - 1], scope: parts.length > 1 ? parts[parts.length - 2] : '', sig: m[2] === undefined || /\(line \d+\)/.test(String(text)) && m[2] === '' ? undefined : m[2].trim() };
}
function sameFunction(a, b) {
  const la = readLabel(a) || asLabel(a), lb = readLabel(b) || asLabel(b);
  if (!la || !lb) return String(a) === String(b);
  if (String(a).trim() === '(file)' || String(b).trim() === '(file)') return String(a).trim() === String(b).trim();
  return la.bare === lb.bare && (!la.scope || !lb.scope || la.scope === lb.scope) && (la.sig === undefined || lb.sig === undefined || la.sig === lb.sig);
}

// One folder can have two names (Windows' short RUNNER~1 spelling of a temp folder, a junction): its real path.
const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };

// A file as the places list names it: relative to the list's repo, forward slashes, no "./". Letter case is
// ignored where the file system ignores it (Windows).
export function listPath(file, repo, { ignoreCase = process.platform === 'win32' } = {}) {
  let f = slash(String(file).trim());
  if (repo && path.isAbsolute(f)) {
    const rel = slash(path.relative(real(repo), real(f)));
    if (rel && rel !== '..' && !rel.startsWith('../') && !path.isAbsolute(rel)) f = rel;
  }
  f = path.posix.normalize(f);
  return ignoreCase ? f.toLowerCase() : f;
}

// Why an S line is still open ('' = closed). `places`: the parsed places list, when --places is given.
// `ignoreCase`: see listPath.
export function openReason(row, places, { ignoreCase } = {}) {
  const o = row.outcome.trim();
  if (!o) return 'no outcome';
  const none = /^none:\s*(.*)$/i.exec(o);
  if (none) return none[1].trim().length >= MIN_REASON ? '' : `the reason after none: needs at least ${MIN_REASON} characters`;
  const ps = /^(P\d+(?:\s*,\s*P\d+)*)(?![\w])/i.exec(o);
  if (!ps) return 'write P<n> or none: <reason>';
  const nums = ps[1].split(',').map((s) => Number(s.trim().slice(1)));
  const names = (list) => list.map((n) => 'P' + n).join(', ') + (list.length === 1 ? ' is' : ' are');
  const zero = nums.filter((n) => n < 1);
  if (zero.length) return `${names(zero)} not a place (places start at P1)`;
  if (!places) return '';
  const missing = nums.filter((n) => !places.places.some((p) => p.n === n));
  if (missing.length) return `${names(missing)} not on the places list: add the sibling's name with places.mjs --names`;
  const gone = nums.filter((n) => places.places.some((p) => p.n === n && p.mark === 'gone'));
  if (gone.length) return `${names(gone)} gone from the places list`;
  const spot = siblingSpot(row.body);
  if (!spot) return 'no file named: start the line with <file>:<line>, or write none: <reason>';
  const file = spot.file;
  const at = (f) => listPath(f, places.repo, { ignoreCase });
  const found = nums.map((n) => places.places.find((p) => p.n === n));
  const same = found.filter((p) => at(p.file) === at(file));
  if (!same.length) return `${names(nums)} in ${[...new Set(found.map((p) => p.file))].join(', ')}, not in ${slash(file)}: add the sibling's own name with places.mjs --names, or write none: <reason>`;
  // 2026-11-18 (audit): a place of ANOTHER function of that file closed it too (a sibling in PublishNow, closed with the
  // place of Schedule; PublishNow was never searched). The place must be the one of the function that holds the
  // sibling's line, or carry the function name the line gives.
  // 2026-11-18 (repair round): the line number was written before the code, and the fix moves it (four lines added
  // inside Schedule put line 10 inside Schedule, and the place of Schedule closed the sibling in PublishNow). The
  // function stored when the sibling was recorded (row.holds) is the one that counts; today's line is read only
  // for a list with none. A function is the same by its name, and by its type and parameter list only when both
  // name them ("Service.PublishNow", "PublishNow(Homework h)" and "PublishNow method" are the label PublishNow).
  const want = row.holds || functionAt(places.repo, file, spot.line), part = functionPart(row.body);
  if (same.some((p) => (want && sameFunction(p.fn, want)) || (part && sameFunction(p.fn, part)))) return '';
  const mine = want !== null ? want : part || `the function at line ${spot.line}`;
  const theirs = [...new Set(same.map((p) => p.fn || '(file)'))].join(', ');
  return `${names(nums)} ${nums.length === 1 ? 'a place' : 'places'} of ${theirs}, not of ${mine} (${slash(file)}:${spot.line}): add the sibling's own name with places.mjs --names, or write none: <reason>`;
}

// `jobs` undefined: a caller that only checks S lines (siblings --record); a list read from a file always has it.
export function checkSiblings({ rows, jobs, jobNone, sources }, { places, sources: current } = {}) {
  const open = rows.map((r) => ({ r, why: openReason(r, places) })).filter((x) => x.why);
  const lines = open.map(({ r, why }) => `OPEN: S${r.n} · ${r.body.split(' — ')[0]}${why === 'no outcome' ? '' : ' — ' + why}`);
  // 2026-11-18 (audit): recorded for other ticket lines or check lines than the ones given now.
  const stale = Boolean(sources && current && sources !== current);
  if (stale) lines.push('OPEN: SIBLINGS — ticket lines changed: run --brief again, launch its line, and record the new report (the siblings and the same-job search were made for the earlier lines)');
  lines.push(`SIBLINGS: ${rows.length} found, ${open.length + (stale ? 1 : 0)} open`);
  let jobsOpen = [], searchMissing = false;
  if (jobs) {
    jobsOpen = jobs.map((r) => ({ r, why: jobOpenReason(r) })).filter((x) => x.why);
    searchMissing = !jobs.length && !jobNone;
    for (const { r, why } of jobsOpen) lines.push(`OPEN: J${r.n} · ${r.body.split(' — ')[0]}${why === 'no outcome' ? '' : ' — ' + why}`);
    if (searchMissing) lines.push('OPEN: SAME JOB — the same-job search is missing: record a report from the current brief (SAME JOB lines or SAME JOB: none)');
    lines.push(`SAME JOB: ${jobs.length} found, ${jobsOpen.length + (searchMissing ? 1 : 0)} open`);
  }
  return { ok: !open.length && !jobsOpen.length && !searchMissing && !stale, open, jobsOpen, count: rows.length, stale, text: lines.join('\n') };
}

export function readSiblings(file) {
  if (!fs.existsSync(file)) throw usage('no such siblings list: ' + file);
  const list = parseSiblings(readText(file));
  if (!list.rows.length && !list.none) throw usage(`${file} has no S line and no "SIBLINGS: none" line: record the agent's report with --record first`);
  return list;
}

function parse(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--brief') { o.brief = true; continue; }
    if (!['--notes', '--repo', '--record', '--check', '--places', '--lines', '--check-lines'].includes(k) || argv[i + 1] === undefined) throw usage('Unknown or empty option: ' + k);
    o[k.slice(2)] = argv[++i];
  }
  if ([o.brief, o.record, o.check].filter(Boolean).length !== 1) throw usage('give one of --brief, --record <report> or --check <siblings.md>');
  if (o.brief && (!o.notes || !o.repo)) throw usage('--brief needs --notes <dir> and --repo <repo>');
  if (o.record && !o.notes) throw usage('--record needs --notes <dir>');
  if (o.repo && !o.brief) throw usage('--repo goes with --brief');
  if (o.places && !o.check) throw usage('--places goes with --check');
  if ((o.lines || o['check-lines']) && !o.check) throw usage('--lines and --check-lines go with --check');
  if (Boolean(o.lines) !== Boolean(o['check-lines'])) throw usage('--lines and --check-lines go together');
  return o;
}

const USAGE = 'Usage: node siblings.mjs --brief --notes <dir> --repo <repo>\n' +
  '       node siblings.mjs --record <report file> --notes <dir>\n' +
  '       node siblings.mjs --check <siblings.md> [--places <places.md>] [--lines <lines.md> --check-lines <check.md>]\n';

function main() {
  try {
    const o = parse(process.argv.slice(2));
    if (o.brief) {
      const notes = path.resolve(o.notes);
      const b = writeBrief({ notes, repo: path.resolve(o.repo) });
      process.stdout.write(`SIBLINGS BRIEF: ${b.brief} · T1..T${b.ticket.length} · C1..C${b.checks.length} · ${b.places} place(s)\n` +
        launchLine(b.brief) + '\n' +
        `THEN: save the agent's final message as ${slash(path.join(notes, REPORT))}, then run: node ${slash(path.join(here, 'siblings.mjs'))} --record ${slash(path.join(notes, REPORT))} --notes ${slash(notes)}\n`);
    } else if (o.record) {
      const { out, rows, outside, jobs, jobNone } = recordSiblings({ report: path.resolve(o.record), notes: path.resolve(o.notes) });
      const r = checkSiblings({ rows });
      process.stdout.write(rows.map((row) => '  ' + siblingLine(row).trimEnd() + '\n').join('') +
        `SIBLINGS: ${r.count} found, ${r.open.length} open — written to ${out}${r.count ? '; write P<n> or none: <reason> after each →' : ''}\n` +
        jobs.map((row) => '  ' + jobLine(row).trimEnd() + '\n').join('') +
        (jobs.length ? `SAME JOB: ${jobs.length} found — the design reuses each one, or says why not: write reuse or not: <why> after each →\n` : jobNone ? 'SAME JOB: none — the agent found no earlier work of the same kind\n' : '') +
        (outside.length ? `OUTSIDE PR: ${outside.length} line(s) outside the ticket, kept apart — not this task's work; they go to the user's end list (loop.md Step 3.5, item 5)\n` : ''));
    } else {
      let places;
      if (o.places) {
        if (!fs.existsSync(o.places)) throw usage('no such places list: ' + o.places);
        places = parsePlaces(readText(o.places));
        if (!places) throw usage(`${o.places} is not a places list (no Repo: and Names: header)`);
      }
      let sources = '';
      if (o.lines) {
        for (const f of [o.lines, o['check-lines']]) if (!fs.existsSync(f)) throw usage('no such file: ' + f);
        const now = sourcesOf(readText(o.lines), readText(o['check-lines']));
        if (now) sources = now.hash;
      }
      const r = checkSiblings(readSiblings(path.resolve(o.check)), { places, sources });
      process.stdout.write(r.text + '\n');
      process.exitCode = r.ok ? 0 : 1;
    }
  } catch (error) {
    process.stderr.write('SIBLINGS: ' + error.message + '\n' + USAGE);
    process.exitCode = 2;
    if (!(error instanceof UsageError)) process.stderr.write(String(error.stack || '') + '\n');
  }
}

if (isMain(import.meta.url)) main();
