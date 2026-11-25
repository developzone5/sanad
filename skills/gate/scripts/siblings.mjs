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
// 2026-11-20 (timed medium task, twice): the second look listed three same-job designs; the author closed the best one
// (J2, one unpaged read) "not: …" and built another. Three of four reviewers then asked for J2 and the review found 3
// bugs that J2 avoids. A BEST DESIGN pick with an owner-words lock followed; 2026-11-22 (owner, after a timed test in
// which the locked pick made the fix narrower than a plain session's) it is gone. Promise now: the second look gives
// hints and never picks the design; the author designs, closes each J line `reuse` or `not: <why>`, and the reviewer
// sees each reason. When the brief carries the author's design (<notes>/design.md), the second look checks it for gaps.
//   node siblings.mjs --brief --notes <dir> --repo <repo>
//       Writes <notes>/siblings-brief.md from <notes>/lines.md (ticket lines), <notes>/check.md (check lines)
//       and <notes>/places.md (the places, from places.mjs), with fixed instructions, and prints the one launch
//       line for the Agent tool (second-look, a read-only planning seat; never a reviewer prompt, which
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
// 2026-11-19 (one added check line forced a second full run, 3.5 minutes; 13 outcomes were typed through a hand-made
// script): each ticket line keeps its own short hash (`Lines:`), so the list is stale only when a ticket line that is
// not dropped today is not among the recorded ones. A dropped line, a removed line and a new order are no change.
// The check lines keep the rule of 2026-11-18 (any change makes the list stale) only when the owner turns off
// `git config sanad.lateCheckLines false`. By default (2026-11-20) a check line added or edited after the second look
// prints `NOTE: C<n> added after the second look` and is given to the review brief (lateCheckLines), --brief
// needs no check.md, and --check reads the ticket lines alone.
//   node siblings.mjs --close <siblings.md> --set "S1,S3=none: <reason>" --set "J2,J4=reuse" [--places <places.md>]
//       Writes many outcomes at once, by the rules of --check. One refused outcome and nothing is written (exit 1).
//       places.md beside the list is read when --places is not given.
// Exit 0: written, or no open line. 1: an open line. 2: usage error, a missing file, a report with no answer.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readLines, droppedOf, checkLines } from './check-ticket-lines.mjs';
import crypto from 'node:crypto';
import { parsePlaces, placeLine, declarations, readLabel } from './places.mjs';
import { isMain } from './is-main.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIN_REASON = 12;
export const BRIEF = 'siblings-brief.md';
export const LIST = 'siblings.md';
export const REPORT = 'siblings-report.md';
export const INSTRUCTIONS = "Before any code. Read the ticket lines and the check lines first: they are the goal. Then the places, and the code at each place and around it. Name every OTHER place where the ticket's own rule or defect applies and that is not on the list: another field, another screen or role, another entry point (create, edit, publish, import, a job), an API field, an export. A place with a different problem, or one the ticket lines do not reach, is no sibling: write it as 'OUTSIDE PR: <file>:<line> — <what>', and the user decides it at the end. Then, separately: how does this repo already do the same KIND of job the ticket needs? Search by what the code does, not by the names above (for example 'send a change to another system after a save' → an outbox table and the worker that sends it; 'a list with filters' → the screen that already pages and filters). Name each one as 'SAME JOB: <file>:<line> · <what> — <how it does the job>', at most three, the nearest to this job first, or write the single line 'SAME JOB: none' after searching. These are hints: the author designs the change, and you do not choose the design. When the brief carries the author's design, check it for gaps and missed places: each one is a SIBLING line. Answer only with lines 'SIBLING: <file>:<line> · <function or field> — <why it is the ticket's rule>', 'OUTSIDE PR:' lines and 'SAME JOB:' lines, or 'SIBLINGS: none' and 'SAME JOB: none'. Do not edit.";
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

// The owner's switch for check lines written after the second look (2026-11-20: on unless he sets it to false):
// `git config sanad.lateCheckLines false`, read in `dir`. An unset key or any error reads as on.
export function lateChecksOn(dir) {
  try {
    return execFileSync('git', ['config', '--get', '--bool', 'sanad.lateCheckLines'], { cwd: dir || process.cwd(), encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim() !== 'false';
  } catch { return true; }
}

// The ticket lines by position: { n, text, dropped }. `text` is the line without its number and without the
// dropped mark, so a drop changes no line's words.
export function ticketRows(linesText) {
  return readLines(linesText).map((l, i) => {
    const d = droppedOf(l);
    return { n: i + 1, text: d ? d.text : l.replace(/^T\d+:\s*/i, ''), dropped: Boolean(d) };
  });
}

// `ticket`: the lines as strings (T1 first), or { n, text } rows that keep their own number.
export function buildBrief({ repo, ticket, checks, list, dropped = [], design = '' }) {
  const order = (p) => list.names.indexOf(p.name) * 1e6 + p.n;
  const live = list.places.filter((p) => p.mark !== 'gone').sort((a, b) => order(a) - order(b));
  return [
    '# Sibling check — before code', '',
    `Repo: ${slash(repo)}`,
    `Names the author searched (whole words): ${list.names.join(', ')}`, '',
    '## What to do', '',
    INSTRUCTIONS, '',
    // 2026-11-25 (owner, test 4): the Settings badges and the view-as strip showed the same role value by another path,
    // and the review found them two rounds later. One direct question, asked every time.
    '## Where else is this value read or shown?', '',
    `Answer it directly: where else is the value this change touches${list.names.some((x) => x.startsWith('data:')) ? ` (${list.names.filter((x) => x.startsWith('data:')).map((x) => x.slice(5)).join(', ')})` : ''} read or shown, by another path than the names above: another screen, a badge, a strip, a list, an export, a second word list for the same value? Each such place not on the list is a SIBLING line.`, '',
    '`<file>` is relative to the repo above.', '',
    '## Ticket lines', '',
    ...ticket.map((t, i) => (typeof t === 'string' ? `- T${i + 1}. ${t}` : `- T${t.n}. ${t.text}`)),
    ...(dropped.length ? [`(${dropped.map((n) => 'T' + n).join(', ')} dropped by the user: no part of the goal)`] : []), '',
    '## Check lines', '',
    ...(checks.length ? checks.map((c, i) => `- C${i + 1}. ${c}`) : ['- none yet: the check lines are written after this look']), '',
    '## Places already on the list (places.mjs)', '',
    ...(live.length ? live.map((p) => '- ' + placeLine(p)) : ['- none: no product file uses these names']), '',
    // 2026-11-22: the author's own design, when written, is what the second look checks for gaps; it never picks one.
    // Indented as a block, so a "- T1." or "- C1." line of the design is never read back as a ticket or check line.
    ...(String(design).trim() ? ["## The author's design (design.md) — check it for gaps and missed places", '', ...String(design).trim().split(/\r?\n/).map((l) => '    ' + l), ''] : []),
  ].join('\n');
}

export function launchLine(brief) {
  return `LAUNCH: Agent second-look · prompt: ${PROMPT_START} Read and follow only the brief at ${slash(brief)}. ` +
    'Do not open any other file in that folder. Read-only: no builds, no tests, no edits. Your final message is only the SIBLING, OUTSIDE PR and SAME JOB lines (or SIBLINGS: none and SAME JOB: none).';
}

export function writeBrief({ notes, repo }) {
  const top = toplevel(repo);
  if (!top) throw usage('not inside a git repository: ' + repo);
  // lines.md is numbered "T1. text"; readLines turns that into "T1: text", and the number is written here again.
  const ticket = ticketRows(source(notes, 'lines.md', 'make it with lines.mjs --from <ticket text> --out <notes>/lines.md'));
  if (!ticket.length) throw usage(`lines.md in ${notes} has no ticket line`);
  const live = ticket.filter((t) => !t.dropped);
  if (!live.length) throw usage(`every ticket line of lines.md in ${notes} is dropped: there is no rule to search for`);
  // By default (the switch is not false) the second look starts right after the places list, before the check lines exist.
  const early = lateChecksOn(top) && !fs.existsSync(path.join(notes, 'check.md'));
  const checks = early ? [] : checkLines(source(notes, 'check.md', 'write the check lines first, one per result the change must prove (lines.mjs --seed-check starts the file). The owner has set git config sanad.lateCheckLines false, so the second look waits for the check lines'));
  if (!checks.length && !early) throw usage(`check.md in ${notes} has no check line`);
  const list = parsePlaces(source(notes, 'places.md', 'make it with places.mjs --repo <repo> --names <names> --out <notes>/places.md'));
  if (!list) throw usage(`places.md in ${notes} is not a places list (no Repo: and Names: header): make it with places.mjs`);
  const brief = path.join(notes, BRIEF);
  const dropped = ticket.filter((t) => t.dropped).map((t) => t.n);
  const designFile = path.join(notes, 'design.md');
  const design = fs.existsSync(designFile) ? readText(designFile) : '';
  fs.writeFileSync(brief, buildBrief({ repo: top, ticket: live, checks, list, dropped, design }));
  return { brief, ticket, checks, dropped, design: Boolean(String(design).trim()), places: list.places.filter((p) => p.mark !== 'gone').length };
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
// 2026-11-22 (owner): the second look gives hints, never the design. A BEST DESIGN line of an older report or list
// (bold or code marks around it too) is passed over.
const BEST_LINE = /^[*_`]*BEST DESIGN\b/i;
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
  let none = false, jobNone = false, best = null;
  for (const row of String(text).split(/\r?\n/)) {
    const l = bare(row);
    if (BEST_LINE.test(l)) continue;
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
  return siblings.length || none || outside.length ? { siblings, none: !siblings.length, outside, jobs, jobNone: jobNone && !jobs.length, best } : null;
}

// "S3 · <text> → <outcome>" and "J2 · <text> → <outcome>"; a line whose arrow was deleted reads with no outcome
// (open), never dropped.
export function parseSiblings(text) {
  const rows = [], jobs = [];
  let none = false, jobNone = false, sources = '', holds = {}, lineHashes = null, checkHashes = null, best = null, recorded = '';
  const hashes = (s) => s.split(/\s+/).filter((h) => /^[0-9a-f]+$/.test(h));
  for (const line of String(text).split(/\r?\n/)) {
    const hold = /^Holds: (\{.*\})\s*$/.exec(line);
    if (hold) { try { holds = JSON.parse(hold[1]); } catch { /* an unreadable line holds nothing */ } continue; }
    const src = /^Sources: ([0-9a-f]+)\s*$/.exec(line);
    if (src) { sources = src[1]; continue; }
    // One short hash per ticket line and per check line the second look read; null on a list of an earlier release.
    const lh = /^Lines: (.*)$/.exec(line);
    if (lh) { if (!lineHashes) lineHashes = hashes(lh[1]); continue; }
    const ch = /^Checks: (.*)$/.exec(line);
    if (ch) { if (!checkHashes) checkHashes = hashes(ch[1]); continue; }
    if (NONE.test(line.trim())) { none = true; continue; }
    if (JOB_NONE.test(line.trim())) { jobNone = true; continue; }
    const rec = /^Recorded: (.*)$/.exec(line);
    if (rec) { recorded = rec[1].trim(); continue; }
    if (BEST_LINE.test(line.trim())) continue;
    const m = /^([SJ])(\d+) · (.*)$/.exec(line);
    if (!m) continue;
    const arrow = m[3].indexOf('→');
    (m[1] === 'S' ? rows : jobs).push({ n: Number(m[2]), body: (arrow < 0 ? m[3] : m[3].slice(0, arrow)).trim(), outcome: arrow < 0 ? '' : m[3].slice(arrow + 1).trim() });
  }
  for (const r of rows) if (holds && typeof holds[r.n] === 'string') r.holds = holds[r.n];
  return { rows, none, jobs, jobNone: jobNone && !jobs.length, sources, lineHashes, checkHashes, best, recorded };
}

// One line's short hash: its words, with runs of spaces as one space.
export const lineHash = (text) => crypto.createHash('sha256').update(String(text).replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 10);

// The check lines of `checkText` the second look never read: added or edited after it. [{ n, text }], C1 first.
// `list`: the text of siblings.md, or the list as parseSiblings reads it. A list of an earlier release (no
// `Checks:` line) has none: any change makes that list stale as a whole.
export function lateCheckLines(list, checkText) {
  const l = typeof list === 'string' ? parseSiblings(list) : list;
  if (!l || !l.checkHashes) return [];
  return checkLines(checkText).map((text, i) => ({ n: i + 1, text })).filter((c) => !l.checkHashes.includes(lineHash(c.text)));
}

// 2026-11-18 (audit): the list stayed valid after the ticket lines and the check lines changed, so a line added
// later was never searched for siblings or same-job work. --record stores a hash of the two sources (the ticket
// lines and the check lines as the brief reads them, so spacing and header text do not count); --check fails when
// a --lines / --check-lines given now hash differently. null when a source cannot be read.
// 2026-11-19: `live` is each ticket line that is not dropped, with its own hash, and `checkHashes` one hash per
// check line. `hash` stays the one hash of the release before (a dropped line counts with its own words there, so a
// drop does not change it).
export function sourcesOf(linesText, checkText = '') {
  try {
    const rows = ticketRows(linesText);
    const ticket = rows.map((r) => r.text);
    const checks = checkLines(checkText);
    return {
      ticket, checks, hash: crypto.createHash('sha256').update(JSON.stringify({ ticket, checks })).digest('hex').slice(0, 12),
      live: rows.filter((r) => !r.dropped).map((r) => ({ n: r.n, text: r.text, hash: lineHash(r.text) })),
      checkHashes: checks.map(lineHash),
    };
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

export function renderSiblings({ brief, report, recorded, rows, outside = [], jobs = [], jobNone = false, sources = '', lineHashes = null, checkHashes = null }) {
  return [
    '# Siblings — places with the same rule or defect that the places list missed', '',
    `Brief: ${slash(brief)}`,
    `Report: ${slash(report)}`,
    `Recorded: ${recorded}`,
    ...(sources ? [`Sources: ${sources}`] : []),
    ...(lineHashes ? [`Lines: ${lineHashes.join(' ') || 'none'}`] : []),
    ...(checkHashes ? [`Checks: ${checkHashes.join(' ') || 'none'}`] : []),
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
  // The function that holds each new sibling's line is read now, before the code: line numbers move with the fix.
  let repoOf = '';
  try { const pl = parsePlaces(readText(path.join(notes, 'places.md'))); repoOf = pl ? pl.repo : ''; } catch { /* no places list: no stored function */ }
  // 2026-11-19: a ticket line counts by its own words. The report is refused when a ticket line that is not dropped
  // today was not in the brief (new, or a word changed); a dropped or removed line and a new order are no change.
  // The check lines must be the brief's, as before, unless the owner's switch is on (lateChecksOn).
  let sources = '', lineHashes = null, checkHashes = null;
  const linesFile = path.join(notes, 'lines.md'), checkFile = path.join(notes, 'check.md');
  const late = lateChecksOn(repoOf);
  if (fs.existsSync(linesFile) && (late || fs.existsSync(checkFile))) {
    const now = sourcesOf(readText(linesFile), fs.existsSync(checkFile) ? readText(checkFile) : '');
    if (now) {
      const briefText = readText(brief);
      const inBrief = (letter) => String(briefText).split(/\r?\n/).map((l) => new RegExp(`^- ${letter}\\d+\\. (.*)$`).exec(l)).filter(Boolean).map((m) => m[1]);
      const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
      const seenT = inBrief('T'), seenC = inBrief('C');
      if (now.live.some((l) => !seenT.includes(l.text)) || (!late && !same(seenC, now.checks))) {
        throw usage(`the ticket lines or check lines changed after the brief was written: run --brief again, launch its line, save the new answer as ${slash(path.join(notes, REPORT))} and record that.`);
      }
      // What is stored is what the brief carried: the lines the agent read, not the files of a later minute.
      sources = now.hash; lineHashes = seenT.map(lineHash); checkHashes = seenC.map(lineHash);
    }
  }
  const rows = old.rows;
  let next = rows.reduce((n, r) => Math.max(n, r.n), 0) + 1;
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
  const text = renderSiblings({ brief, report: path.resolve(report), recorded: now.toISOString(), rows, outside, jobs, jobNone, sources: sources || old.sources, lineHashes: lineHashes || old.lineHashes, checkHashes: checkHashes || old.checkHashes });
  fs.writeFileSync(out, oldText.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text);
  return { out, rows, outside, jobs, jobNone };
}

// Why a J line is still open ('' = closed): `reuse` (the design follows that pattern) or `not: <reason>`.
// 2026-11-22 (owner): a hint is advice. The author closes any J line "not: <why>" without the owner's words; the
// reason goes to the reviewer with the hint.
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
// 2026-11-19: `now` is sourcesOf of the lines file and the check file of today (`now.checksRead`: a check file was
// read). The list is stale when a ticket line that is not dropped today is not among the recorded ones. The check
// lines: any change makes it stale, as since 2026-11-18; with `late` (the owner's switch) a check line the second
// look never read is a NOTE line and no reason to run again. A list of the release before has one hash for all.
export function checkSiblings({ rows, jobs, jobNone, sources, lineHashes, checkHashes }, { places, sources: current, now, late = false } = {}) {
  const open = rows.map((r) => ({ r, why: openReason(r, places) })).filter((x) => x.why);
  const lines = open.map(({ r, why }) => `OPEN: S${r.n} · ${r.body.split(' — ')[0]}${why === 'no outcome' ? '' : ' — ' + why}`);
  // 2026-11-18 (audit): recorded for other ticket lines or check lines than the ones given now.
  let stale = Boolean(sources && current && sources !== current), what = '';
  const added = [];
  if (now && lineHashes) {
    const fresh = now.live.filter((l) => !lineHashes.includes(l.hash));
    const unread = now.checksRead && checkHashes ? now.checks.map((text, i) => ({ n: i + 1, text })).filter((c, i) => !checkHashes.includes(now.checkHashes[i])) : [];
    if (fresh.length) { stale = true; what = `${fresh.map((l) => 'T' + l.n).join(', ')} ${fresh.length === 1 ? 'is' : 'are'} new or changed`; }
    else if (late) added.push(...unread);
    else if (now.checksRead && checkHashes && (checkHashes.length !== now.checkHashes.length || checkHashes.some((h, i) => h !== now.checkHashes[i]))) {
      stale = true; what = 'the check lines changed' + (unread.length ? `: ${unread.map((c) => 'C' + c.n).join(', ')}` : '');
    }
  } else if (now && sources) stale = sources !== now.hash;
  if (stale) lines.push('OPEN: SIBLINGS — ticket lines changed: run --brief again, launch its line, and record the new report (the siblings and the same-job search were made for the earlier lines)' + (what ? ' — ' + what : ''));
  lines.push(`SIBLINGS: ${rows.length} found, ${open.length + (stale ? 1 : 0)} open`);
  let jobsOpen = [], searchMissing = false;
  if (jobs) {
    jobsOpen = jobs.map((r) => ({ r, why: jobOpenReason(r) })).filter((x) => x.why);
    searchMissing = !jobs.length && !jobNone;
    for (const { r, why } of jobsOpen) lines.push(`OPEN: J${r.n} · ${r.body.split(' — ')[0]}${why === 'no outcome' ? '' : ' — ' + why}`);
    if (searchMissing) lines.push('OPEN: SAME JOB — the same-job search is missing: record a report from the current brief (SAME JOB lines or SAME JOB: none)');
    lines.push(`SAME JOB: ${jobs.length} found, ${jobsOpen.length + (searchMissing ? 1 : 0)} open`);
  }
  // The second look never searched siblings for these; the review brief gives them to the reviewer (lateCheckLines).
  for (const c of added) lines.push(`NOTE: C${c.n} added after the second look`);
  return { ok: !open.length && !jobsOpen.length && !searchMissing && !stale, open, jobsOpen, count: rows.length, stale, late: added, text: lines.join('\n') };
}

// 2026-11-19 (13 outcomes went through a hand-made script): many outcomes at once. `sets`: [{ which: 'S1,S3',
// outcome }]. Each outcome is judged as --check judges it (openReason, jobOpenReason); one refused outcome and
// nothing is written. Returns { written: ['S1', …], refused: ['S1 — <why>', …] }. Only the named lines change.
export function closeSiblings(file, sets, { places } = {}) {
  if (!fs.existsSync(file)) throw usage('no such siblings list: ' + file);
  const text = readText(file);
  const list = parseSiblings(text);
  const want = new Map();
  for (const { which, outcome } of sets) {
    if (!outcome) throw usage(`--set "${which}=" has no outcome`);
    if (outcome.includes('→')) throw usage('an outcome holds no → of its own: ' + outcome);
    for (const id of String(which).split(',').map((s) => s.trim().toUpperCase())) {
      if (!/^[SJ]\d+$/.test(id)) throw usage(`--set names S and J lines by number ("S1,S3=none: <reason>", "J2=reuse"), not "${id}"`);
      const key = id[0] + Number(id.slice(1));
      const row = (id[0] === 'S' ? list.rows : list.jobs).find((r) => r.n === Number(id.slice(1)));
      if (!row) throw usage(`${key} is not on the list ${slash(file)}`);
      if (want.has(key)) throw usage(`${key} is set twice`);
      want.set(key, { row, outcome });
    }
  }
  const refused = [];
  for (const [key, { row, outcome }] of want) {
    const why = key[0] === 'S' ? openReason({ ...row, outcome }, places) : jobOpenReason({ ...row, outcome });
    if (why) refused.push(`${key} — ${why}`);
  }
  if (refused.length) return { written: [], refused };
  const out = text.split('\n').map((raw) => {
    const cr = raw.endsWith('\r') ? '\r' : '', line = cr ? raw.slice(0, -1) : raw;
    const m = /^([SJ])(\d+) · (.*)$/.exec(line);
    const set = m && want.get(m[1] + Number(m[2]));
    if (!set) return raw;
    const arrow = m[3].indexOf('→');
    return `${m[1]}${m[2]} · ${(arrow < 0 ? m[3] : m[3].slice(0, arrow)).trim()} → ${set.outcome}${cr}`;
  });
  fs.writeFileSync(file, out.join('\n'));
  return { written: [...want.keys()], refused: [] };
}

export function readSiblings(file) {
  if (!fs.existsSync(file)) throw usage('no such siblings list: ' + file);
  const list = parseSiblings(readText(file));
  if (!list.rows.length && !list.none) throw usage(`${file} has no S line and no "SIBLINGS: none" line: record the agent's report with --record first`);
  return list;
}

function parse(argv) {
  const o = { set: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--brief') { o.brief = true; continue; }
    if (!['--notes', '--repo', '--record', '--check', '--places', '--lines', '--check-lines', '--close', '--set'].includes(k) || argv[i + 1] === undefined) throw usage('Unknown or empty option: ' + k);
    if (k === '--set') {
      const v = argv[++i], eq = v.indexOf('=');
      if (eq < 1) throw usage('--set needs "<S or J numbers>=<outcome>", e.g. --set "S1,S3=none: another screen\'s own rule" --set "J2=reuse"');
      o.set.push({ which: v.slice(0, eq), outcome: v.slice(eq + 1).trim() });
      continue;
    }
    o[k.slice(2)] = argv[++i];
  }
  if ([o.brief, o.record, o.check, o.close].filter(Boolean).length !== 1) throw usage('give one of --brief, --record <report>, --check <siblings.md> or --close <siblings.md>');
  if (o.brief && (!o.notes || !o.repo)) throw usage('--brief needs --notes <dir> and --repo <repo>');
  if (o.record && !o.notes) throw usage('--record needs --notes <dir>');
  if (o.close && !o.set.length) throw usage('--close needs at least one --set "<S or J numbers>=<outcome>"');
  if (o.set.length && !o.close) throw usage('--set goes with --close');
  if (o.repo && !o.brief && !o.check) throw usage('--repo goes with --brief or --check');
  if (o.places && !o.check && !o.close) throw usage('--places goes with --check or --close');
  if ((o.lines || o['check-lines']) && !o.check) throw usage('--lines and --check-lines go with --check');
  // 2026-11-19: --lines may come alone; the check file beside it is still read (see main).
  if (o['check-lines'] && !o.lines) throw usage('--check-lines goes with --lines');
  return o;
}

const USAGE = 'Usage: node siblings.mjs --brief --notes <dir> --repo <repo>\n' +
  '       node siblings.mjs --record <report file> --notes <dir>\n' +
  '       node siblings.mjs --check <siblings.md> [--places <places.md>] [--lines <lines.md> [--check-lines <check.md>]] [--repo <repo>]\n' +
  '       node siblings.mjs --close <siblings.md> --set "S1,S3=<P<n> | none: <reason>>" --set "J2=<reuse | not: <reason>>" [--places <places.md>]\n';

// The places list a --check or --close reads, or undefined. A usage error when the file is no places list.
function placesOf(file) {
  if (!file) return undefined;
  if (!fs.existsSync(file)) throw usage('no such places list: ' + file);
  const places = parsePlaces(readText(file));
  if (!places) throw usage(`${file} is not a places list (no Repo: and Names: header)`);
  return places;
}

function main() {
  try {
    const o = parse(process.argv.slice(2));
    if (o.brief) {
      const notes = path.resolve(o.notes);
      const b = writeBrief({ notes, repo: path.resolve(o.repo) });
      process.stdout.write(`SIBLINGS BRIEF: ${b.brief} · T1..T${b.ticket.length}${b.dropped.length ? ` (${b.dropped.map((n) => 'T' + n).join(', ')} dropped)` : ''} · ${b.checks.length ? `C1..C${b.checks.length}` : 'no check line yet'} · ${b.places} place(s)${b.design ? ' · your design (design.md)' : ''}\n` +
        (b.design ? '' : `NOTE: no design.md: write your design in a few lines as ${slash(path.join(notes, 'design.md'))} and run --brief again, so the second look checks it for gaps\n`) +
        launchLine(b.brief) + '\n' +
        `THEN: save the agent's final message as ${slash(path.join(notes, REPORT))}, then run: node ${slash(path.join(here, 'siblings.mjs'))} --record ${slash(path.join(notes, REPORT))} --notes ${slash(notes)}\n`);
    } else if (o.record) {
      const { out, rows, outside, jobs, jobNone } = recordSiblings({ report: path.resolve(o.record), notes: path.resolve(o.notes) });
      const r = checkSiblings({ rows });
      process.stdout.write(rows.map((row) => '  ' + siblingLine(row).trimEnd() + '\n').join('') +
        `SIBLINGS: ${r.count} found, ${r.open.length} open — written to ${out}${r.count ? '; write P<n> or none: <reason> after each →' : ''}\n` +
        jobs.map((row) => '  ' + jobLine(row).trimEnd() + '\n').join('') +
        (jobs.length ? `SAME JOB: ${jobs.length} found — hints for the design: write reuse or not: <why> after each (the reviewer sees the reason) →\n` : jobNone ? 'SAME JOB: none — the agent found no earlier work of the same kind\n' : '') +
        (outside.length ? `OUTSIDE PR: ${outside.length} line(s) outside the ticket, kept apart — not this task's work; they go to the user's end list (loop.md Step 3.5, item 5)\n` : ''));
    } else if (o.close) {
      const file = path.resolve(o.close);
      // The places list beside the siblings list is read when none is named, so a P number is always judged.
      const beside = path.join(path.dirname(file), 'places.md');
      const places = placesOf(o.places || (fs.existsSync(beside) ? beside : ''));
      const done = closeSiblings(file, o.set, { places });
      if (done.refused.length) {
        process.stdout.write(done.refused.map((l) => 'REFUSED: ' + l + '\n').join('') + 'SIBLINGS: nothing written — correct the refused outcome(s) and run --close again\n');
        process.exitCode = 1;
        return;
      }
      const list = readSiblings(file);
      const r = checkSiblings(list, { places });
      process.stdout.write([...list.rows.map((row) => ({ id: 'S' + row.n, line: siblingLine(row) })), ...list.jobs.map((row) => ({ id: 'J' + row.n, line: jobLine(row) }))]
        .filter((x) => done.written.includes(x.id)).map((x) => '  ' + x.line.trimEnd() + '\n').join('') +
        `CLOSED: ${done.written.length} line(s) written to ${slash(file)}\n` + r.text + '\n');
    } else {
      const places = placesOf(o.places);
      let now = null;
      if (o.lines) {
        for (const f of [o.lines, o['check-lines']]) if (f && !fs.existsSync(f)) throw usage('no such file: ' + f);
        // The check file beside the lines file is read even when the caller names the ticket lines alone: the
        // rule for check lines lives here, not in the caller.
        const beside = path.join(path.dirname(path.resolve(o.lines)), 'check.md');
        const checkFile = o['check-lines'] || (fs.existsSync(beside) ? beside : '');
        now = sourcesOf(readText(o.lines), checkFile ? readText(checkFile) : '');
        if (now) now.checksRead = Boolean(checkFile);
      }
      const late = lateChecksOn(o.repo ? path.resolve(o.repo) : places ? places.repo : process.cwd());
      const list = readSiblings(path.resolve(o.check));
      const r = checkSiblings(list, { places, now, late });
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
