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
//       is refused: the check did not run.
//   node siblings.mjs --check <siblings.md> [--places <places.md>]
//       Every S line needs `P<n>` (the sibling is a place now: its name added with places.mjs --names; with
//       --places, P<n> is on that list and not gone) or `none: <reason>` (at least 12 characters). Prints
//       `OPEN: S<n> · <file>:<line> · <what>` per open line and `SIBLINGS: <k> found, <m> open`.
// Exit 0: written, or no open line. 1: an open line. 2: usage error, a missing file, a report with no answer.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readLines } from './check-ticket-lines.mjs';
import { checkLines } from './review-brief.mjs';
import { parsePlaces, placeLine } from './places.mjs';
import { isMain } from './is-main.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIN_REASON = 12;
export const BRIEF = 'siblings-brief.md';
export const LIST = 'siblings.md';
export const REPORT = 'siblings-report.md';
export const INSTRUCTIONS = "Before any code. Read the ticket lines and the check lines first: they are the goal. Then the places, and the code at each place and around it. Name every OTHER place where the ticket's own rule or defect applies and that is not on the list: another field, another screen or role, another entry point (create, edit, publish, import, a job), an API field, an export. A place with a different problem, or one the ticket lines do not reach, is no sibling: write it as 'OUTSIDE PR: <file>:<line> — <what>', and the user decides it at the end. Answer only with lines 'SIBLING: <file>:<line> · <function or field> — <why it is the ticket's rule>' and 'OUTSIDE PR:' lines, or the single line 'SIBLINGS: none'. About 3 minutes; do not edit.";
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
    'Do not open any other file in that folder. Read-only: no builds, no tests, no edits. Your final message is only the SIBLING and OUTSIDE PR lines, or the single line SIBLINGS: none.';
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
const bare = (line) => line.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, '').replace(/^[`*_>"\s]+|[`*_"\s]+$/g, '').replace(/^(SIBLINGS?:)[*_]+\s*/, '$1 ').trim();
const NONE = /^SIBLINGS:\s*none\.?$/i;
const OUTSIDE = /^OUTSIDE PR:\s*(.*)$/i;
// "<file>:<line> · <function or field> — <why>"; a line range (12-20) counts as a line.
const SHAPED = /^(.+?):(\d+(?:[-–]\d+)?) · (.+?) — (.+)$/;

// The agent's answer: { siblings: [text of each S line], none, outside: [text of each OUTSIDE PR line] }, or
// null when it has no line of any kind.
export function parseReport(text) {
  const siblings = [], outside = [];
  let none = false;
  for (const row of String(text).split(/\r?\n/)) {
    const l = bare(row);
    if (NONE.test(l)) { none = true; continue; }
    const o = OUTSIDE.exec(l);
    if (o) {
      const body = o[1].replace(/→/g, '->').trim();
      if (body && !/<file>/.test(body) && !outside.includes(body)) outside.push(body);
      continue;
    }
    const m = /^SIBLING:\s*(.*)$/.exec(l);
    if (!m) continue;
    // The agent's own arrows become "->": the first → on an S line starts its outcome.
    const body = m[1].replace(/→/g, '->').trim();
    // The instruction quoted back, with its placeholders, is no sibling.
    if (!body || /<file>/.test(body)) continue;
    const s = SHAPED.exec(body);
    const shaped = s ? `${s[1].trim()}:${s[2]} · ${s[3].trim()} — ${s[4].trim()}` : body;
    if (!siblings.includes(shaped)) siblings.push(shaped);
  }
  return siblings.length || none || outside.length ? { siblings, none: !siblings.length, outside } : null;
}

// "S3 · <text> → <outcome>"; a line whose arrow was deleted reads with no outcome (open), never dropped.
export function parseSiblings(text) {
  const rows = [];
  let none = false;
  for (const line of String(text).split(/\r?\n/)) {
    if (NONE.test(line.trim())) { none = true; continue; }
    const m = /^S(\d+) · (.*)$/.exec(line);
    if (!m) continue;
    const arrow = m[2].indexOf('→');
    rows.push({ n: Number(m[1]), body: (arrow < 0 ? m[2] : m[2].slice(0, arrow)).trim(), outcome: arrow < 0 ? '' : m[2].slice(arrow + 1).trim() });
  }
  return { rows, none };
}

export const siblingLine = (r) => `S${r.n} · ${r.body} → ${r.outcome}`;
export const OUTSIDE_HEADING = "## Outside the ticket — for the user's end list (no outcome here)";

// The OUTSIDE PR lines already in a siblings list, in order.
export function parseOutside(text) {
  return String(text).split(/\r?\n/).map((l) => /^- OUTSIDE PR:\s*(.*)$/.exec(l)).filter(Boolean).map((m) => m[1].trim());
}

export function renderSiblings({ brief, report, recorded, rows, outside = [] }) {
  return [
    '# Siblings — places with the same rule or defect that the places list missed', '',
    `Brief: ${slash(brief)}`,
    `Report: ${slash(report)}`,
    `Recorded: ${recorded}`, '',
    "Write the outcome after each →: `P<n>` (add the sibling's name with places.mjs --names; n is the place it gets) or `none: <why it is not the same rule>`.",
    'siblings.mjs --record keeps every outcome when it records again; pre-review.mjs --siblings checks this file.', '',
    ...(rows.length ? rows.map(siblingLine) : ['SIBLINGS: none']), '',
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
  const rows = parseSiblings(oldText).rows;
  let next = rows.reduce((n, r) => Math.max(n, r.n), 0) + 1;
  for (const body of found.siblings) if (!rows.some((r) => r.body === body)) rows.push({ n: next++, body, outcome: '' });
  const outside = parseOutside(oldText);
  for (const body of found.outside) if (!outside.includes(body)) outside.push(body);
  const text = renderSiblings({ brief, report: path.resolve(report), recorded: now.toISOString(), rows, outside });
  fs.writeFileSync(out, oldText.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text);
  return { out, rows, outside };
}

// Why an S line is still open ('' = closed). `places`: the parsed places list, when --places is given.
export function openReason(row, places) {
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
  return '';
}

export function checkSiblings({ rows }, { places } = {}) {
  const open = rows.map((r) => ({ r, why: openReason(r, places) })).filter((x) => x.why);
  const lines = open.map(({ r, why }) => `OPEN: S${r.n} · ${r.body.split(' — ')[0]}${why === 'no outcome' ? '' : ' — ' + why}`);
  lines.push(`SIBLINGS: ${rows.length} found, ${open.length} open`);
  return { ok: !open.length, open, count: rows.length, text: lines.join('\n') };
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
    if (!['--notes', '--repo', '--record', '--check', '--places'].includes(k) || argv[i + 1] === undefined) throw usage('Unknown or empty option: ' + k);
    o[k.slice(2)] = argv[++i];
  }
  if ([o.brief, o.record, o.check].filter(Boolean).length !== 1) throw usage('give one of --brief, --record <report> or --check <siblings.md>');
  if (o.brief && (!o.notes || !o.repo)) throw usage('--brief needs --notes <dir> and --repo <repo>');
  if (o.record && !o.notes) throw usage('--record needs --notes <dir>');
  if (o.repo && !o.brief) throw usage('--repo goes with --brief');
  if (o.places && !o.check) throw usage('--places goes with --check');
  return o;
}

const USAGE = 'Usage: node siblings.mjs --brief --notes <dir> --repo <repo>\n' +
  '       node siblings.mjs --record <report file> --notes <dir>\n' +
  '       node siblings.mjs --check <siblings.md> [--places <places.md>]\n';

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
      const { out, rows, outside } = recordSiblings({ report: path.resolve(o.record), notes: path.resolve(o.notes) });
      const r = checkSiblings({ rows });
      process.stdout.write(rows.map((row) => '  ' + siblingLine(row).trimEnd() + '\n').join('') +
        `SIBLINGS: ${r.count} found, ${r.open.length} open — written to ${out}${r.count ? '; write P<n> or none: <reason> after each →' : ''}\n` +
        (outside.length ? `OUTSIDE PR: ${outside.length} line(s) outside the ticket, kept apart — not this task's work; they go to the user's end list (loop.md Step 3.5, item 5)\n` : ''));
    } else {
      let places;
      if (o.places) {
        if (!fs.existsSync(o.places)) throw usage('no such places list: ' + o.places);
        places = parsePlaces(readText(o.places));
        if (!places) throw usage(`${o.places} is not a places list (no Repo: and Names: header)`);
      }
      const r = checkSiblings(readSiblings(path.resolve(o.check)), { places });
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
