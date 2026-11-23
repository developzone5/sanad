#!/usr/bin/env node
// review-brief.mjs — the task's briefs, from a fixed template, so nothing is copied by hand.
//
//   <out>          the framed brief: the Test designer and the whole-diff reviewer read it (changed
//                  files, ticket, numbered Check lines, callers, the places list, known items, the proof
//                  run's result, the rules).
//   <out>-fresh.md the unframed brief for the fresh-eyes reviewers (Claude and Codex): the ticket,
//                  the pinned diff and the changed files (new untracked ones marked), the places list, the
//                  known items and the rules, and no other author text (no Check lines, no callers, no
//                  proof result). 2026-11-12 (user: the workflow must not depend on a list of old bugs):
//                  the missed-bug classes left this brief; --missed is accepted and ignored.
//   launch.md      the exact launch lines for the designer and the reviewers, next to <out>: four
//                  reviewers on a big change (or a size not known): the Claude fresh eyes, the risk files
//                  with their trace list, the whole diff and the Codex fresh eyes (the risk files 2026-11-15);
//                  on a tiny, small or medium change only the Claude fresh eyes (tiny and small 2026-11-11;
//                  medium 2026-11-12, user-approved sizes). A medium change keeps the full brief, and its one
//                  review gets the checklist sentence.
//                  2026-11-17 (audit S4): on a big change the Test designer runs before code and its cases
//                  become the tests, so its line is left out once its report is saved in the notes folder (or
//                  with --designer-done); launched again after the proof, it repeated the planning.
//
// 2026-11-07: a brief copied by hand from the last round lacked the newest rule; the designer got
// other lines than the reviewers; launch prompts drifted between rounds; the diff named a moving
// branch; and the "unframed" review read the author's framing. The standing rules are kept to
// three: anything else a reviewer used to be told is now a script check (pre-review).
//
// 2026-11-08 (user: "check lines should come from the tickets"; "extra ... mention in the end"): every
// line of the ticket (steps, expected, actual, the linked ticket's rows) is numbered T1..Tn, and each
// Check line names where it comes from: [T2], [change] (what the change itself touches) or [rule: x]
// (a project rule, such as both languages). A ticket line no Check line covers, or a Check line with
// no source, stops the brief. Cases outside the ticket are not Check lines: reviewers and the Test
// designer list them as EXTRA TEST lines for the user to decide at the end.
//
// 2026-11-12: rule 1 ("before code, list every place that uses the rule or data you change, by search") was
// text and was skipped: a date rule was fixed on the "schedule" path and missed on the "publish now" path. A
// change the size check does not measure tiny (text only) gets no brief until its places list (places.mjs)
// exists and every place on it has an outcome; the list is searched again here first.
//
// Usage: node review-brief.mjs --out <brief.md> --ticket <file> --lines <file> --check <file>
//          [--repo <path>] [--base <ref>] [--outside <file>] [--places <file>] [--size <size>] [--proof-log <file>]
//          [--designer-done] [--engine claude|codex]
//   --engine     the task's engine (2026-11-18, default claude): launch.md names it in its first lines and plans
//                the task's own reviewers on it (a Codex task: codex exec launches; Claude is then the other engine)
//   --ticket    the ticket and QA text, verbatim
//   --lines      every requirement line of the ticket, one per line (the check-ticket-lines file)
//   --check      what must hold, one line each, each starting with its source tag; numbered C1..Cn
//                here, and each needs a test tagged [Cn]
//   --outside    the project's outside list (default: `git config sanad.outsideList`)
//   --places     the places list from places.mjs; required unless the measured size is tiny
//   --missed     accepted and ignored (2026-11-12)
//   --size       the routed size (tiny, small, medium or big); the larger of it and the size check's
//                answer is used, and tiny or small adds the focused budget and the one-review launch;
//                2026-11-18: kept in the notes folder as size.txt, read back by a run without --size, never lowered
//   --proof-log  a red-proof.mjs --log file; give it once per proof (server, page), or a comma list of them; the result lines of
//                each go into the framed brief, with a note when the code changed after that proof ran
//   --designer-done  (no value) the Test designer already ran before code, and its report is not saved in the
//                notes folder (the folder of --out) as test-designer.md, test-designer-report.md or test-design.md
// Run it before the Test designer starts, and again after the proof run, before the reviewers:
// the second run adds the callers and the proof. Exit 0: written. 2: usage error.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readLines, TEST_FILE, checkLines } from './check-ticket-lines.mjs';
import { treeId } from './red-proof.mjs';
import { refreshPlaces, checkPlaces, placeLine } from './places.mjs';
// The size check still runs as a child process (sizeFacts: a timeout ends it); its sizes, signal labels and
// text form come from the module itself, which places.mjs loads anyway.
import { SIZES, SIGNALS, format, sizeTask, functionSpan, fileKind } from './size-check.mjs';
import { isMain } from './is-main.mjs';
// 2026-11-19: a pinned round. The one change set, the saved rounds and decisions, and the Big round's copy.
import crypto from 'node:crypto';
import { changeSet, foreignLine } from './change-set.mjs';
import { paths as notePaths, readPins, addPin, readDecisions } from './notes-dir.mjs';
import { makeCopy, dropCopies } from './review-copy.mjs';
import { lateCheckLines, parseSiblings } from './siblings.mjs';
import { stopRound, reopensRound } from './steps.mjs';
// Read as a whole, so an export a later release adds (droppedLines) is used when it is there.
import * as ticketLinesTool from './check-ticket-lines.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// Each Check line's sources: "[T1, T3]", "[change]", "[rule: both languages]", "[design]" or a mix, at its start —
// in one bracket or several ("[T1] [T2] …", 2026-11-09: only the first bracket was read, so steps needed a line each).
// [design] (2026-11-16, PR #784): the author's own design choice ("remove only what this edit removed"). Written as
// a plain goal, five reviewers checked the code against it and none asked whether it was the best design; a
// teammate then found a better one. Both briefs list these lines for the reviewers to attack.
export function checkSources(line) {
  const lead = /^(?:\[[^\]]+\]\s*)+/.exec(String(line).trim());
  if (!lead) return null;
  const parts = [...lead[0].matchAll(/\[([^\]]+)\]/g)].flatMap(m => m[1].split(',')).map(p => p.trim()).filter(Boolean);
  return parts.every(p => /^T\d+$/i.test(p) || /^(?:change|design)$/i.test(p) || /^rule:\s*\S/i.test(p)) ? parts : null;
}
export const isDesignLine = (line) => (checkSources(line) || []).some(p => /^design$/i.test(p));

// Problems that stop the brief: a ticket line with no Check line, a Check line with no source, or a
// source that names a ticket line that does not exist.
// `dropped` (2026-11-19): the numbers of the ticket lines the owner dropped (droppedLines of check-ticket-lines.mjs).
// A dropped line needs no Check line; the brief lists it under "Dropped by the owner".
export function coverageProblems(ticketLines, checks, dropped = []) {
  const problems = [];
  const covered = new Set(dropped.map(d => Number(String(d).replace(/^T/i, ''))).filter(Number.isInteger));
  checks.forEach((c, i) => {
    const sources = checkSources(c);
    if (!sources) { problems.push(`C${i + 1} names no source ([T1], [change], [rule: ...] or [design]): ${c}`); return; }
    for (const s of sources) {
      const n = /^T(\d+)$/i.exec(s);
      if (!n) continue;
      if (Number(n[1]) < 1 || Number(n[1]) > ticketLines.length) problems.push(`C${i + 1} names ${s}, but the ticket has T1..T${ticketLines.length}`);
      else covered.add(Number(n[1]));
    }
  });
  ticketLines.forEach((t, i) => { if (!covered.has(i + 1)) problems.push(`T${i + 1} has no Check line: ${t}`); });
  return problems;
}

function git(cwd, args) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

// The outside list: "- date · what happens · where · status", one bullet line each. Each line is kept whole,
// less a leading date part (2026-11-12, audit C9: items were read by position, so a line with two parts lost
// its place, and a line joining five items lost its first one, which sat in the date part).
const bulletText = l => {
  const parts = l.replace(/^\s*[-*]\s+/, '').split(' · ');
  return (/^\d{4}-\d{2}-\d{2}$/.test(parts[0].trim()) ? parts.slice(1) : parts).join(' · ').trim();
};
const bullets = text => String(text).split(/\r?\n/).filter(l => /^\s*[-*]\s+/.test(l));
// Done items: a CLOSED, FIXED or MERGED status word (upper case: "the exam is closed" in an item's text is
// no status), or "fixed in PR" / "merged in #12" in any case (2026-11-12: "FIXED in PR #765" stayed listed).
const DECIDED = /\bCLOSED\b/;
const isDone = l => /\b(?:CLOSED|FIXED|MERGED)\b/.test(l) || /\b(?:fixed|merged) in (?:PR\b|#\d)/i.test(l);

// The open items of a project's outside list.
export function outsideItems(text) {
  return bullets(text).filter(l => !isDone(l)).map(l => ({ what: bulletText(l), where: '' })).filter(i => i.what);
}

// The questions the user already decided (CLOSED lines), so no reviewer asks them again (2026-11-07:
// a reviewer re-asked a QA question the user had closed the day before; the brief had dropped it).
export function decidedItems(text) {
  return bullets(text).filter(l => DECIDED.test(l)).map(bulletText).filter(Boolean);
}

// Items that name a file this change touches, anywhere in their text: its path, its base name, or, for a
// file named like a class or a kebab-case module (AttemptService.cs, exam-form-schema.ts), that name without
// the extension, as C# items name the class ("AttemptService.CreateAsync"). A longer name that only ends the
// same (HomeworkForm.tsx for Form.tsx) is another file. This change may alter or worsen these items.
export function splitOutside(items, changedFiles) {
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const names = new Set();
  for (const f of changedFiles.map(n => String(n).replace(/\\/g, '/')).filter(Boolean)) {
    names.add(f); names.add(path.posix.basename(f));
    const stem = path.posix.basename(f).replace(/\.[^.]+$/, '');
    if (stem.length >= 6 && /[a-z][A-Z]|[-_]/.test(stem)) names.add(stem);
  }
  const res = [...names].map(n => new RegExp(`(?<![\\w-])${esc(n)}(?![\\w-])`));
  const touched = [], other = [];
  for (const item of items) (res.some(re => re.test(`${item.what} ${item.where || ''}`)) ? touched : other).push(item);
  return { touched, other };
}

// checkLines lives in check-ticket-lines.mjs (no import cycle with siblings.mjs); kept here under the same name.
export { checkLines };

// The size check's lines that the brief carries: stack, size and callers. A crash or a timeout is `failed`
// (its first error line), so the brief says SIZE CHECK FAILED (2026-11-12: it said "Callers: none yet").
// 2026-11-15: it runs with --json, and `signals` keeps each signal's files for the risk-files line of
// launch.md (that reviewer's prompt was typed by hand); the text lines are the check's own format() of the
// same answer. Output that is not its JSON is read as text, with no signals (null).
// `extra` (2026-11-19): more options for the size check, such as the range of a re-check (--from <commit> --at <commit>).
export function sizeFacts(repo, base, { script = path.join(here, 'size-check.mjs'), timeout = 60000, extra = [] } = {}) {
  let out = '', failed = '';
  try { out = execFileSync(process.execPath, [script, '--repo', repo, ...(extra.includes('--from') ? [] : ['--base', base]), '--json', ...extra], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout }); }
  catch (e) {
    out = String(e.stdout || '');
    const errLines = String(e.stderr || e.message || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    failed = e.code === 'ETIMEDOUT' ? `timed out after ${Math.round(timeout / 1000)} s`
      : (errLines.find(l => /^(?:SIZE: |\w*Error\b)/.test(l)) || errLines[0] || 'exit ' + e.status).replace(/^SIZE:\s*/, '');
  }
  let text = out, signals = null, rows = [];
  try { const r = JSON.parse(out); text = format(r); signals = signalFiles(r); rows = Array.isArray(r.allCallers) ? r.allCallers : []; } catch { /* not its JSON: read as text */ }
  const line = re => (text.split(/\r?\n/).find(l => re.test(l)) || '').trim();
  const size = line(/^SIZE/);
  if (!failed && !size) failed = 'no SIZE line in its output';
  return { stack: line(/^Stack:/), size, callers: line(/^\s*callers:/).replace(/^callers:\s*/, ''), failed, signals, rows };
}

// 2026-11-22 (owner): the second look gives hints, never the design. The reviewer sees each hint and the author's
// answer, so a hint closed "not: <why>" is judged: is the reason right, or is the hint the better way?
export function hintsBlock(siblingsText) {
  const list = parseSiblings(siblingsText);
  const rows = [...list.jobs.map((r) => ({ id: 'J' + r.n, ...r })), ...list.rows.map((r) => ({ id: 'S' + r.n, ...r }))];
  if (!rows.length) return [];
  return ["## The second look's hints and the author's answers — judge each answer, a `not:` reason above all", '',
    ...rows.map((r) => `- ${r.id} · ${r.body} → ${r.outcome || '(no answer yet)'}`), ''];
}

// 2026-11-22 (owner): the brief carries the code under review — the diff, the whole text of every changed
// function and the whole text of each calling function — so a reviewer starts reading, not searching. Every text
// is read at the pinned commit (the working tree when there is no pin yet). It is a copy for reading: the
// reviewer still searches the repository for the places it does not show. Each function is copied whole and every
// caller location of the size check is read; one total line cap keeps a huge change readable, and its cut line
// says so. A diff that cannot be read is said, never shown as no change.
const CODE_LINES_TOTAL = 20000;
function fileAt(repo, ref, file) {
  try {
    return ref ? execFileSync('git', ['show', `${ref}:${file}`], { cwd: repo, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
      : fs.readFileSync(path.join(repo, file), 'utf8');
  } catch { return null; }
}
// The new-side line ranges (1-based, inclusive) of each file a `--unified=0` diff changes.
export function changedRanges(diffText) {
  const out = new Map();
  let file = null;
  for (const l of String(diffText).split(/\r?\n/)) {
    const f = /^\+\+\+ (?:b\/)?(.+)$/.exec(l);
    if (f) { file = f[1] === '/dev/null' ? null : f[1].trim(); if (file && !out.has(file)) out.set(file, []); continue; }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (h && file) { const s = Number(h[1]), n = h[2] === undefined ? 1 : Number(h[2]); out.get(file).push([s, s + Math.max(n, 1) - 1]); }
  }
  return out;
}
const fence = (text) => { let f = '```'; while (text.includes(f)) f += '`'; return f; };
export function codeBlock({ repo, mergeBase, pin = '', rows = [] }) {
  const range = pin ? [mergeBase, pin] : [mergeBase];
  let failed = '';
  const run = (args) => { try { return execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { failed = failed || String(e.code || e.message || e).split(/\r?\n/)[0]; return ''; } };
  const diff = run(['diff', ...range]);
  // Before the commit, a new file git does not track yet is part of the change too.
  const untracked = pin ? [] : run(['ls-files', '--others', '--exclude-standard']).split(/\r?\n/).filter(Boolean).filter((f) => fileKind(f) === 'code');
  const head = ['## Code under review — a copy for reading; the commit counts', ''];
  if (failed && !diff.trim()) return [...head, `- The diff could not be read here (${failed}): read it yourself with \`git diff ${range.join(' ')}\`.`, ''];
  if (!diff.trim() && !untracked.length) return [];
  const ref = pin || '';
  const at = pin ? `commit ${pin.slice(0, 12)}` : 'the working tree';
  const out = [...head,
    `- Every text below is read at ${at}. Search the repository yourself for the places this copy does not show.`, '',
    ...(diff.trim() ? ['### Diff', '', fence(diff) + 'diff', diff.replace(/\s+$/, ''), fence(diff), ''] : [])];
  let used = 0, cut = false;
  const shown = new Set();
  const cache = new Map();
  const linesOf = (file) => { if (!cache.has(file)) { const t = fileAt(repo, ref, file); cache.set(file, t == null ? null : t.split(/\r?\n/)); } return cache.get(file); };
  const block = (title, file, span, lines) => {
    const key = `${file}:${span.start}`;
    if (shown.has(key)) return [];
    shown.add(key);
    if (used >= CODE_LINES_TOTAL) { cut = true; return []; }
    const body = lines.slice(span.start, span.end + 1).join('\n');
    used += span.end - span.start + 1;
    return [`#### ${title}`, '', fence(body), body, fence(body), ''];
  };
  const changed = [];
  for (const file of untracked) {
    const lines = linesOf(file);
    if (lines) changed.push(...block(`${file} (new, not in git yet: the whole file)`, file, { start: 0, end: lines.length - 1 }, lines));
  }
  for (const [file, ranges] of changedRanges(run(['diff', '--unified=0', ...range]))) {
    if (fileKind(file) !== 'code') continue;
    const lines = linesOf(file);
    if (!lines) continue;
    for (const [s, e] of ranges) {
      for (let i = s - 1; i <= Math.min(e - 1, lines.length - 1); i++) {
        const span = functionSpan(lines, i);
        if (!span) continue;
        changed.push(...block(`${file} · ${span.name} (lines ${span.start + 1}-${span.end + 1})`, file, span, lines));
        i = Math.max(i, span.end);
      }
    }
  }
  if (changed.length) out.push('### Changed functions — the whole text', '', ...changed);
  const callerText = [];
  for (const row of rows) {
    if (!row) continue;
    // `places` holds every caller line with its repository path; an older size check gave only `where` (the first six,
    // a caller in the function's own file named by its base name).
    const full = Array.isArray(row.places);
    for (const w of full ? row.places : Array.isArray(row.where) ? row.where : []) {
      const m = /^(.+):(\d+)$/.exec(String(w));
      if (!m) continue;
      const file = !full && !m[1].includes('/') && path.posix.basename(String(row.file || '')) === m[1] ? row.file : m[1];
      const lines = linesOf(file);
      if (!lines) continue;
      const span = functionSpan(lines, Number(m[2]) - 1);
      if (!span) continue;
      callerText.push(...block(`${file} · ${span.name} (line ${m[2]} uses ${row.name})`, file, span, lines));
    }
  }
  if (callerText.length) out.push('### Callers of the changed functions — the whole calling function', '', ...callerText);
  if (cut) out.push(`(the copy stops at ${CODE_LINES_TOTAL} lines: read the rest in the repository)`, '');
  return out;
}

// Each signal's files, as the size check's JSON names them: base names, at most three per signal; for a function
// with many callers (evidence "name ×count") the file that defines it; none for the 400-line split.
export function signalFiles(r) {
  const files = {};
  for (const [key, where] of Object.entries(r.signals)) {
    // 2026-11-17: matched on the function name (the text before " ×", after an optional "<basename>:" prefix), so
    // "name ×?" (count unknown) and plan mode's "base:name ×n" still name the defining file; same-named ones all list.
    const names = new Set(key === 'callersMany' ? where.map(w => String(w).replace(/ ×[^ ]*$/, '')) : []);
    files[key] = key === 'callersMany' ? r.callers.filter(c => names.has(c.name) || [...names].some(n => n.endsWith(`:${c.name}`))).map(c => c.file)
      : key === 'split' ? [] : where.map(String);
  }
  return files;
}

// The size the size check measured ('' when it failed or printed none).
export function measuredSize(facts) {
  const m = /^SIZE:\s*(\w+)|^SIZE GREW:\s*\w+\s*→\s*(\w+)/.exec((facts && facts.size) || '') || [];
  return SIZES.includes(m[1] || m[2]) ? (m[1] || m[2]) : '';
}

// The size the briefs and launch.md use: the larger of the routed size (--size) and the measured one, so a
// change routed small that measures big gets the full round (2026-11-12, audit C8a: --size beat the measure).
export function chooseSize(facts, routed) {
  const measured = measuredSize(facts);
  const asked = SIZES.includes(routed) ? routed : '';
  const size = asked && measured ? SIZES[Math.max(SIZES.indexOf(asked), SIZES.indexOf(measured))] : asked || measured;
  return { size, note: asked && measured && asked !== measured ? `size: routed ${asked}, measured ${measured} → using ${size}` : '' };
}

// The sentence on the checklist line (2026-11-17, review score): a finding that names its line in brackets after
// the kind can be counted by kind across tasks (hooks/lib/transcript-scan.js noteClass, review-score.mjs).
// 2026-11-19: the finding line's shape stands once, here; the review brief and the re-check brief both use it.
export const FINDING_SHAPE = '`Blocker|Bug|Gap|Question — file:line — <input> → <wrong result> — <one-line fix>`';
// 2026-11-22 (owner, PR 3 item 3): a Bug or a Blocker brings the test that shows it, fenced so the scanner never reads
// its lines as notes or a verdict. The reviewer stays read-only; the author adds the test and runs it.
export const TEST_IN_NOTE = 'Where a test can show a Bug or a Blocker, put that test\'s code under the note, always inside a fenced code block (```); you run no test: the author adds it and runs it on the reviewed code.';
const ROLE = 'You are a code reviewer. Read-only: no builds, no tests, no edits. Report: `RECOMMEND: PASS|FAIL` first, then the findings, most severe first, one line each: ' + FINDING_SHAPE + '; or "no findings" and what you checked. When a finding falls under a line of the review checklist, name that line in round brackets ( ) after the kind, as the checklist names it (CALLERS, CLIENT STATE, DATABASE, FAILURES / LOCALES, USERS FOUND BY SEARCH, …): `Bug (CLIENT STATE) — file:line — …`. ' + TEST_IN_NOTE + ' Then `OUTSIDE PR:` and `EXTRA TEST:` lines, if any. Last, one line `ONE JOB: yes|no`: does this PR do more than one thing? A yes is also a `Question` finding that names the jobs (user rule 2026-11-15).';
// The standing rules. A new rule replaces one of these or becomes a script check. The last two (2026-11-16, PR #784:
// a teammate found 6 real issues after 5 reviewers passed the PR): the author's design was never attacked, and weak
// spots passed because "the old code does it too".
// 2026-11-17 (audit, review brief): the test rule's last sentence. Fresh eyes never see the Check lines, and a
// ticket seldom names every access, concurrency or rollback rule, so a missing test for a rule the change itself
// adds was only an EXTRA TEST line. It is a Gap now; EXTRA TEST is for every other case.
const RULES = [
  '- A `Question` is only for what the ticket lines above leave open: quote the line that leaves it open. A question those lines already answer (an "Expected" line, a rule row) is not listed; check the change against that answer instead. A better design is a different `Question`: see the design rule below.',
  '- A test weakness on a Check line is reported as a concrete break: the change to the product code (file, what changes) that the tests would let through, and the test that should then fail. A case that no Check line covers and the ticket does not name is an `EXTRA TEST:` line (one line: the case and why it matters), not a finding: the user decides it. But a missing test for a correctness or security rule that this change adds, widens or newly exposes (access, tenant, a concurrent or repeated request, a rollback, a failure path) is a `Gap` finding, whatever the ticket says; `EXTRA TEST:` is for every other case.',
  '- A defect on a path the change neither touches, exposes nor makes reachable goes under `OUTSIDE PR:`. A problem outside the ticket that is already listed is not reported, unless this change alters or worsens it; then it is a finding.',
  '- Attack the design, not only the code: is this the best way to do the job, and does the repo already do the same kind of job another way (a queue table and its worker, a shared helper, an existing screen)? A better way is a `Question` finding that names it, with file:line. A `[design]` Check line is the author\'s choice, never a goal: a change that only matches it has not passed.',
  '- "The old code does it too" or "the other calls do the same" is never a pass. When the change relies on, copies or widens a weak spot (a token never cleared, an error kept as text, a missing retry), it is a `Gap` or `Bug` finding that names the weak spot; the user decides it.',
];
// The author's design choices (Check lines tagged [design]), for both briefs: claims to attack, not goals.
function designBlock(checks = []) {
  const lines = checks.map((c, i) => ({ c, i })).filter(({ c }) => isDesignLine(c));
  return lines.length ? ["## Author's design choices — attack these: is there a better way, or one the repo already uses?", '',
    ...lines.map(({ c, i }) => `- C${i + 1}. ${c}`), ''] : [];
}

// 2026-11-19: with `pin` (review-brief --pin) the review is of one commit, named in full, and the diff is between
// two exact commits. Reviewers read while the author works, and a brief that said "the working tree" was a
// different change for each reviewer. `copy` is the Big round's read-only folder of that commit (review-copy.mjs).
// With no pin the line is today's: the run before code has no commit yet.
function diffLine({ repo, branch, base, mergeBase, pin = '', copy = '' }) {
  if (pin) {
    return `Repo: ${copy || repo}, branch ${branch}. Review commit ${pin} against ${mergeBase.slice(0, 12)} (where it left ${base}): \`git diff ${mergeBase} ${pin}\`. Only this commit is under review. `
      + (copy ? 'This folder is a read-only copy of that commit: read the files here.' : `When a file in the folder differs from the commit, the commit counts: \`git show ${pin}:<path>\`.`);
  }
  return `Repo: ${repo}, branch ${branch}. Review the working tree against ${mergeBase.slice(0, 12)} (where it left ${base}): \`git diff ${mergeBase}\` (uncommitted work included).`;
}
// Every changed file, untracked ones marked: reviewers start before the commit, and `git diff` never shows
// a file not yet added to git (2026-11-12, audit C1: a new component or test was never reviewed).
const NEW_FILE = '(new, not in git yet: read the whole file — `git diff` does not show it)';
function changedBlock(changed) {
  if (!changed) return [];
  return ['## Changed files', '', ...(changed.length ? changed.map(f => `- ${f.name}${f.untracked ? ' ' + NEW_FILE : ''}`) : ['- none yet']), ''];
}
// Items in the files this change touches come first, under a heading that asks for a check against the
// change (2026-11-12, audit C9: they sat beside "do not report again").
// 2026-11-19: "Decided by the user" read only the CLOSED lines of the outside list, so a thing the owner decided in
// this task came back in the next round. `decisions` are this task's own (decisions.json, decisionLines). A reviewer
// may still say once, with new evidence, that a decision is unsafe: a decision closes a question, not a danger.
const DECISION_UNSAFE = 'You may say once, with new evidence, that a decision is unsafe: name the evidence (file:line, the input and the wrong result).';
function decidedBlock({ decided = [], decisions = [] }) {
  const all = [...decided, ...decisions];
  return all.length ? ['## Decided by the user — do not ask again', '', ...all.map(d => '- ' + d), ...(decisions.length ? ['', DECISION_UNSAFE] : []), ''] : [];
}
function known({ touched, other, decided = [], decisions = [] }) {
  const fmt = o => `- ${o.what}${o.where ? ` (${o.where})` : ''}`;
  return [
    ...(touched.length ? ['## Problems outside the ticket in the files this change touches — CHECK each one against the change: report it if this change alters or worsens it', '', ...touched.map(fmt), ''] : []),
    '## Problems outside the ticket — known, do not report again', '', ...(other.length ? other.map(fmt) : ['- none']), '',
    ...decidedBlock({ decided, decisions }),
  ];
}
// One line per decision of this task: its id, what was asked, and the owner's own words.
export function decisionLines(decisions = []) {
  const one = s => String(s || '').replace(/\s+/g, ' ').trim();
  return decisions.filter(d => d && one(d.words)).map(d => `${d.id || 'D?'} (${one(d.kind) || 'decision'})${one(d.question) ? ': ' + one(d.question) : ''} — the user: "${one(d.words)}"${Array.isArray(d.notes) && d.notes.length ? ` [${d.notes.join(', ')}]` : ''}`);
}
const focusedBlock = ['## Focused brief (small change)', '',
  'Trace the changed hunks, each caller and each Check line; do not re-derive the whole screen or file. About 15 tool calls; stop once every line is traced.'];
const isFocused = (facts, size) => /^(?:tiny|small)$/.test(chooseSize(facts, size).size);
const callersLine = facts => facts.failed ? `SIZE CHECK FAILED: ${facts.failed}` : `Callers: ${facts.callers || 'none yet (no change yet)'}`;
const tidy = lines => lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n') + '\n';

// The lines of each proof log that the brief carries. 2026-11-12: two proofs (server and page) give two
// logs and only one reached the reviewers; a stopped proof (ENVIRONMENT, TIMEOUT, BREAK INVALID) was
// filtered out; and nothing said which code a log was for. red-proof.mjs writes the tree it proves as
// the log's first line ("RED-PROOF-LOG: tree <id> at <time>"): when the code under review is another
// tree, the brief says so beside that proof.
// 2026-11-16: a partial proof (--changed-since) shows its PARTIAL lines, so it is never read as a full proof.
const PROOF_LINE = /^(?:RED-PROOF: (?:RED|NOT|PROVED|PARTIAL|SETUP|ENVIRONMENT|TIMEOUT|REMOTE)|\s*(?:BREAK|GREEN) )/;
export function proofLines(logs, currentTree = '') {
  const out = [];
  for (const { name, text } of logs) {
    const rows = String(text).split(/\r?\n/);
    const stamp = /^RED-PROOF-LOG: tree (\S+)(?: dirty)? at (\S+)/.exec(rows[0] || '');
    const kept = rows.filter(l => PROOF_LINE.test(l)).map(l => l.trim());
    if (logs.length > 1 || stamp) out.push(`${name}${stamp ? ` — ran ${stamp[2]} on tree ${stamp[1].slice(0, 12)}` : ''}:`);
    if (stamp && currentTree && stamp[1] !== currentTree) out.push(`NOTE: the code under review is tree ${currentTree.slice(0, 12)}; it changed after this proof ran. Check that the proof still covers it, or ask for a new run.`);
    out.push(...(kept.length ? kept : ['(no result line in this log: the proof did not finish)']));
  }
  return out;
}

// The places list (places.mjs) in both briefs, with the two lines that make a reviewer check it, not trust
// it (2026-11-12: a fix reached the "schedule" path and not the "publish now" path).
const PLACES_RULES = [
  'For each `none:` line, read that place and check the reason; a place that needs the change and has none is a Bug.',
  'Search yourself for a place this list misses; a missing place is a Bug.',
];
function placesBlock(list) {
  if (!list) return [];
  const order = p => list.names.indexOf(p.name) * 1e6 + p.n;
  return ['## Places that use what this change touches', '', ...PLACES_RULES, '',
    `Names searched (whole words): ${list.names.join(', ')}`, '',
    ...[...list.places].sort((a, b) => order(a) - order(b)).map(p => '- ' + placeLine(p)),
    ...list.names.map(n => `- Tests that mention ${n}: ${((list.tests && list.tests.get(n)) || []).join(', ') || 'none'}`), ''];
}

// Why the brief is refused for its places ('' = not refused). A change measured tiny (text only) needs no
// list; any other change needs one, searched again now, with no open place.
export function placesRefusal({ measured, list, file, checkCount, repo }) {
  if (measured === 'tiny') return '';
  if (!list) {
    const cmd = `node ${path.join(here, 'places.mjs')} --repo ${repo} --names <names> --out <notes>/places.md`.replace(/\\/g, '/');
    return `no --places: ${measured ? `a ${measured} change` : 'a change of unknown size (the size check failed)'} needs the list of every place that uses what it changes: ${cmd}`;
  }
  const { open } = checkPlaces(list, { checkCount });
  if (!open.length) return '';
  const named = open.map(({ p, why }) => `P${p.n}${why === 'no outcome' ? '' : ' — ' + why}`).join(', ');
  return `places: ${open.length} open place(s) in ${file} (${named}): write C<n> or none: <reason> after each →, then run this again`;
}

// The ticket lines the owner dropped (2026-11-19), for both the cover check and the brief: [{ n, text }].
function droppedBlock(dropped = []) {
  return dropped.length ? ['## Dropped by the owner — not part of this change, no Check line and no test', '', ...dropped.map(d => `- T${d.n}. ${d.text}`), ''] : [];
}
// 2026-11-19: on the tests-only light path the brief does not ask for a proof log. One line says why.
export const LIGHT_LANE_LINE = 'Tests-only light path: it has no breaks, so there is no proof log.';
// True when `git config sanad.testsOnlyLane` is true AND the size check says the change is tests only, judged now.
export function onLightLane(repo, base) {
  try {
    if (git(repo, ['config', '--get', 'sanad.testsOnlyLane']).toLowerCase() !== 'true') return false;
    return sizeTask({ repo, base }).testsOnly === true;
  } catch { return false; }
}

export function buildBrief({ repo, branch, base, mergeBase, ticket, ticketLines = [], checks, outside, facts, size, proof = [], changed, places = null, pin = '', copy = '', dropped = [], lightLane = false, code = [], hints = [] }) {
  const gone = new Set(dropped.map(d => d.n));
  return tidy([
    ROLE, '', diffLine({ repo, branch, base, mergeBase, pin, copy }), '',
    facts.stack || 'Stack: unknown', facts.size || '', callersLine(facts), '',
    ...changedBlock(changed),
    '## Ticket (verbatim)', '', ticket.trim(), '',
    ...(ticketLines.length ? ['## Ticket lines — every one has a Check line', '', ...ticketLines.map((t, i) => ({ t, i })).filter(({ i }) => !gone.has(i + 1)).map(({ t, i }) => `- T${i + 1}. ${t}`), ''] : []),
    ...droppedBlock(dropped),
    '## Check — each line names its source ([Tn] a ticket line, [change], [rule: ...], [design] the author\'s choice); its tests carry the tag [Cn]', '',
    ...checks.map((c, i) => `- C${i + 1}. ${c}`), '',
    ...designBlock(checks),
    ...hints,
    ...placesBlock(places),
    ...known(outside),
    ...(proof.length ? ['## Proof run (red-proof.mjs)', '', ...proof.map(p => '    ' + p), ''] : lightLane ? ['## Proof run (red-proof.mjs)', '', LIGHT_LANE_LINE, ''] : []),
    '## Rules', '', ...RULES, '',
    ...(isFocused(facts, size) ? focusedBlock : []),
    ...code,
  ]);
}

// `checks`: only its [design] lines reach fresh eyes, under "attack these" (an author claim, never a goal).
// `lateChecks` (2026-11-19): the check lines added after the second look (lateCheckLines of siblings.mjs). The fresh
// brief shows only their rule text, with no source tag: no sibling search ever read them.
export function buildFreshBrief({ repo, branch, base, mergeBase, ticket, outside, facts, size, changed, places = null, checks = [], pin = '', copy = '', dropped = [], lateChecks = [], code = [], hints = [] }) {
  const freshKnown = knownFresh(outside);
  // 2026-11-19: on a change with one review (not big) the risk reviewer's after-save question is one more rule here.
  const oneReview = /^(?:tiny|small|medium)$/.test(chooseSize(facts, size).size);
  const afterSave = oneReview && facts.signals && facts.signals.afterSave ? ['- ' + TRACE.afterSave] : [];
  return tidy([
    ROLE.replace('You are a code reviewer.', 'You are a code reviewer with fresh eyes: judge the change only against the ticket and the code.'), '',
    diffLine({ repo, branch, base, mergeBase, pin, copy }), '', facts.stack || 'Stack: unknown', callersLine(facts), '',
    ...changedBlock(changed),
    '## Ticket (verbatim)', '', ticket.trim(), '',
    ...droppedBlock(dropped),
    ...designBlock(checks),
    ...hints,
    ...placesBlock(places),
    ...(lateChecks.length ? ['## Rules added after the sibling search — search the repo for siblings of each one yourself', '', ...lateChecks.map(c => '- ' + String(c.text ?? c).replace(/^(?:\[[^\]]+\]\s*)+/, '')), ''] : []),
    ...freshKnown.before,
    '## Rules', '', ...RULES, ...afterSave, '',
    ...(isFocused(facts, size) ? [...focusedBlock.map(l => l.replace(', each caller and each Check line', ' and every place that uses the changed code')), ''] : []),
    ...freshKnown.after,
    ...code,
  ]);
}
// 2026-11-19: the known items of the fresh brief. An item in a touched file is an earlier diagnosis of the same
// code: read first, it steered the reviewer, so it comes last, to be checked after the findings are written. The
// other items are a count and the list's path (29 lines once), when the path is known. The framed brief keeps both lists.
function knownFresh({ touched = [], other = [], decided = [], decisions = [], file = '' }) {
  const fmt = o => `- ${o.what}${o.where ? ` (${o.where})` : ''}`;
  return {
    before: ['## Problems outside the ticket — known, do not report again', '',
      ...(!other.length ? ['- none'] : file ? [`- ${other.length} item(s), listed in ${file}. Open it only to see whether a finding of yours is already there.`] : other.map(fmt)), '',
      ...decidedBlock({ decided, decisions })],
    after: touched.length ? ['## After you wrote your findings, check these — known problems outside the ticket in the files this change touches: report one if this change alters or worsens it', '', ...touched.map(fmt), ''] : [],
  };
}

// A tiny or small change gets ONE review, the Claude fresh eyes (user rule 2026-11-11: "yes skip codex on
// small fixes"; TUW-242, a one-method fix, was heading to ~25 minutes, half of it three reviews). pre-review
// checks each Check line's test mechanically, the job the small whole-diff pass had. 2026-11-12 (user-approved
// sizes: Small and Medium get one fresh-eyes review, only Big the full round): a medium change gets the same
// one review, with the full brief and the checklist sentence the whole-diff pass carried.
const WHOLE_DIFF_FULL = 'Fill the coverage checklist lines that apply (CLIENT STATE, NEW BLOCKS, FAILURES / LOCALES, USERS FOUND BY SEARCH, TESTS CAN FAIL).';
const ONE_REVIEW = {
  tiny: '(A tiny or small change: only this one review, user rule 2026-11-11.)',
  small: '(A tiny or small change: only this one review, user rule 2026-11-11.)',
  medium: '(A medium change: one review, with the full brief; user-approved sizes 2026-11-12.)',
};

// The risk-files reviewer's trace list (2026-11-15: loop.md and CLAUDE.md give a Big change a risk reviewer on the
// risk files with a trace list, and launch.md had no such line, so its prompt was typed by hand). One fixed
// question per risk signal the size check names, in this order, then CLOSING. The client-state lens (the
// whole-diff checklist covers it) and the 400-line split (it names no risk) have none.
const TRACE = {
  access: 'Can a caller without the right role, school/tenant or ownership read or change data through any changed path? Trace anonymous, wrong role, and a signed-in user who does not own the row.',
  accessUi: 'Does the server refuse every action this screen hides or disables for a role, when the request is sent directly, without the screen?',
  files: 'Can a caller-supplied key, path, id or URL reach a stored object or URL it does not own (every spelling the code normalizes: encoded, relative, absolute, doubled prefixes, dot segments)?',
  filesUi: 'Does the server check every file name, type, size, key or URL the page sends, so a hand-made request cannot pass what the page would block?',
  schema: 'Does the schema change apply to a database that already has rows, including rows that break the new rule (nulls, duplicates, too-long values), and apply again safely after it stopped part-way?',
  query: 'Does the changed query return only the rows this caller may see, with no duplicates and a stable order across pages, and keep the same number of database calls as the rows grow?',
  concurrency: 'What happens when the same request runs twice at once, or is retried after a timeout? Trace two callers on the same row: the result must be one correct write, never a lost or a double one.',
  concurrencyUi: 'What happens with two tabs open, a timer that fires after the page closed or the user signed out, or an answer that arrives after the user moved on?',
  money: 'Can an amount be negative, zero, rounded wrong, in another currency, or counted twice on a retry? Trace each amount from the input to the stored value.',
  contract: 'Does every reader and sender of the changed request or response shape (the other half of the app, an older client, stored data) still use each field with the same name, type, empty value and meaning?',
  serverEntry: 'Does every new server entry point check who the caller is and what they may do before it reads or writes, as the entry points beside it do?',
  bothSides: 'Do the page and the server apply the same rule to the same cases? Trace one input the page allows and the server refuses, and one the other way round.',
  dependency: 'Is the new or changed package the one intended (name, version, publisher), free of known High or Critical advisories, and is every use of its changed API updated?',
  callersMany: 'For each caller of the changed function, is the result it relies on unchanged, for empty, missing and failing inputs too? Name every caller whose result changes.',
  infra: 'Does the app still start with the new or changed setting missing, empty or wrong, and is each startup step safe to run again after a crash?',
  // 2026-11-19: a change that saves and then calls another system (the size check's afterSave signal).
  afterSave: 'The change saves and then calls another system. For each result of that call (sent; refused; failed; no answer before the timeout, so the result is unknown; an answer that arrives late; cancelled after the save), what is saved here and what does the other system hold? Name each result that leaves the two sides different, and what repairs it.',
};
// 2026-11-19: on a Big round each seat has its own question, so four reviewers do not all read for the same thing.
// Fresh eyes stays free, and the other engine stays fresh eyes.
export const SEAT_QUESTION = {
  risk: 'Your own question: follow the order of the steps across the database and every other system the change calls. What is saved, sent or shown at each step, and what state is left when a step fails or runs twice?',
  whole: 'Your own question: is every outcome the ticket promises reached by the code, and is every decision the brief leaves open named?',
};
const CLOSING = 'Does a refused or failed request leave any row half-written, or leak an internal value (a key, a signature, whether an object exists)?';

// The risk files: each file the size check names for a signal on the trace list, as its repo path from the
// changed files, with the labels of the signals that name it. The check names base names; one that two changed
// files share names both, and one that no changed file has stays as it is.
export function riskFiles(signals, changed = []) {
  const files = new Map();
  for (const key of Object.keys(TRACE)) {
    for (const n of (signals && signals[key]) || []) {
      const exact = changed.filter(f => f.name === n);
      const hits = exact.length ? exact : changed.filter(f => path.posix.basename(f.name) === n);
      for (const f of hits.length ? hits : [{ name: n }]) {
        if (!files.has(f.name)) files.set(f.name, { name: f.name, untracked: !!f.untracked, labels: [] });
        const labels = files.get(f.name).labels;
        // A signal the size check does not name yet keeps its key as its label.
        const label = (SIGNALS[key] && SIGNALS[key].label) || key;
        if (!labels.includes(label)) labels.push(label);
      }
    }
  }
  return [...files.values()];
}

// The risk-files launch line of a big change. With no file named (the size check failed, or the size was set
// above what it measured), every changed file that is not a test is in scope, and every question is asked.
// 2026-11-18 (audit finding 6): the list itself (files and trace questions) is one function, so the Claude agent line
// and the Codex command line of a task ask the same questions.
function riskBody({ facts, changed = [] }) {
  const signals = facts && facts.signals;
  const listed = riskFiles(signals, changed);
  const named = Object.keys(TRACE).filter(k => signals && signals[k]);
  const files = listed.length ? listed : changed.filter(f => !TEST_FILE.test(f.name)).map(f => ({ ...f, labels: [] }));
  const why = !signals ? 'the size check gave no signals' : 'the size check named no risk file';
  return [
    listed.length ? 'Risk files (the size check names at most three per signal: another changed file on the same boundary is in scope too):'
      : `Risk files (${why}: every changed file that is not a test):`,
    ...(files.length ? files.map(f => `- ${f.name}${f.labels.length ? ' — ' + f.labels.join('; ') : ''}${f.untracked ? ' ' + NEW_FILE : ''}`) : ["- none yet: the files in the brief's Changed files section"]),
    named.length ? 'Trace list:' : `Trace list (${why}: answer each question that applies; n/a for the rest):`,
    ...[...(named.length ? named : Object.keys(TRACE)).map(k => TRACE[k]), CLOSING].map((q, i) => `${i + 1}. ${q}`),
  ];
}
function riskLaunch({ brief, facts, changed = [] }) {
  return [
    '## Risk files (Claude) — Agent independent-reviewer, run_in_background', '',
    `You are the independent reviewer — risk files pass (Pass A). Read and follow the brief at ${brief}, including its Rules section. Do not open any other file in that folder. Review the risk files below with their callers and writers: answer each trace question for each file by following real inputs through the changed code. ${SEAT_QUESTION.risk} Read-only: no builds, no tests, no edits.`,
    ...riskBody({ facts, changed }), '',
  ];
}

// The Test designer's area: every changed file, code first, then the changed tests (2026-11-15: the line held an
// "author fills" placeholder).
function areaLine(changed = []) {
  const code = changed.filter(f => !TEST_FILE.test(f.name)).map(f => f.name), tests = changed.filter(f => TEST_FILE.test(f.name)).map(f => f.name);
  if (!changed.length) return "Area: no changed file yet: the places on the brief's places list.";
  return `Area: ${[code.length ? 'the changed files ' + code.join(', ') : '', tests.length ? 'the changed tests ' + tests.join(', ') : ''].filter(Boolean).join('; ')}.`;
}

// 2026-11-17 (audit S4): on a Big task the Test designer runs before code, and its SETUP / CASES / BREAKS became
// the tests. launch.md listed it again after the proof, and "launch every line" ran the planning twice. Its saved
// report in the notes folder, under any of these names, takes its launch line out. An empty file is no report.
const DESIGNER_REPORTS = ['test-designer.md', 'test-designer-report.md', 'test-design.md'];
// A report older than `notBefore` (ms; the newest of the lines and check files) is from before a requirement changed:
// the designer must run again then, so it does not count.
export function designerReport(notesDir, notBefore = 0) {
  return DESIGNER_REPORTS.find(n => {
    try {
      const f = path.join(notesDir, n);
      return fs.readFileSync(f, 'utf8').trim() !== '' && fs.statSync(f).mtimeMs >= notBefore;
    } catch { return false; }
  }) || '';
}
// Under the designer's line while no report is saved: the same launch.md is written before code and after the proof.
const DESIGNER_AGAIN = `(Launch it before code. After that, launch it only for a requirement that changed after the plan: its cases are already the tests. Save its report in this folder as ${DESIGNER_REPORTS[0]}, or pass --designer-done, and this line is left out.)`;

// `size`: the size used (chooseSize); big or an unknown size gets the full round. `facts` (sizeFacts) gives the
// risk files their signals; `changed` (the changed files, as the briefs list them) gives their repo paths and
// the Test designer's area. `designerDone` (2026-11-17): the designer's saved report (its file name) or
// '--designer-done'; a big launch then holds no designer line, and one line says why.
// 2026-11-18 (audit finding 6): the plan follows the engine chosen for the task (engines.md). A Codex task's own
// reviewers are Codex launches (codex exec, read-only, xhigh, the sanad-* roles) and, on a Big task, Claude is the one
// other engine; a Claude task is the plan above, with its engine line.
export const ENGINES = ['claude', 'codex'];
// Text inside a double-quoted shell argument: a file name from the repo cannot end the quote or run a command.
const shq = s => String(s).replace(/[\\"$`]/g, '\\$&');
// 2026-11-18: a joined path (Windows joins with a backslash) escapes a backslash only before a character bash reads inside
// quotes, so a plain path keeps its text and a folder starting with $ or a backtick still runs as the path it names.
const shqPath = s => String(s).replace(/\\(?=[\\"$`])|["$`]/g, m => '\\' + m);
// Fresh eyes is the risk reviewer again (loop-rare-cases.md; the Claude seat is independent-reviewer), not the
// whole-diff role, whose file tells it to follow the whole-diff scope and the author's Done means (2026-11-18, finding 2).
const CODEX_ROLE = { designer: 'sanad-practical-expert', fresh: 'sanad-risk-reviewer', risk: 'sanad-risk-reviewer', whole: 'sanad-reviewer' };
const roleSentence = role => `Your Codex role is ${role}: read ~/.codex/agents/${role}.toml first and follow it.`;
// 2026-11-19: every Codex launch runs on the model its role is set to. The model is read from the role's own settings
// file when the plan is written (<codex home>/agents/<role>.toml, its first `model = "..."` line); no model name stands
// in this script. A missing file or line gives '' and never throws.
export function codexRoleModel(role, { codexHome } = {}) {
  try {
    const home = codexHome || process.env.SANAD_CODEX_HOME || path.join(os.homedir(), '.codex');
    const text = fs.readFileSync(path.join(home, 'agents', `${role}.toml`), 'utf8').replace(/^﻿/, '');
    // Only the role's own top-level setting counts: a `model = "..."` line inside the multi-line instructions
    // (a text example) or under a [table] is not the role's model (the independent check, 2026-11-19).
    const top = text.replace(/("""|''')[\s\S]*?\1/g, '""').split(/^[ \t]*\[/m)[0];
    const m = /^[ \t]*model[ \t]*=[ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)')/m.exec(top);
    return m ? (m[1] ?? m[2]).trim() : '';
  } catch { return ''; }
}
// The launch flag for a role, and the one plain line a plan carries under the seat when the role has no model setting.
function codexModel(role, codexHome) {
  const model = codexRoleModel(role, { codexHome });
  return model
    ? { flag: ` -m "${shq(model)}"`, note: [] }
    : { flag: '', note: [`(no model setting found for ${role}: this launch runs on the Codex default model)`, ''] };
}
function codexRun({ repo, out, log, prompt, role, codexHome }) {
  const { flag, note } = codexModel(role, codexHome);
  return ['```bash', `cd "${shq(repo)}" && codex exec -s read-only -c model_reasoning_effort="xhigh" -C "${shq(repo)}" -o "${shq(out)}"${flag} "${shq(prompt)}" < /dev/null > "${shq(log)}" 2>&1`, '```', '', ...note];
}
function buildCodexLaunch({ brief, fresh, repo, branch, size, sizeNote, facts, changed, designerDone, codexHome }) {
  const one = ONE_REVIEW[size];
  const dir = path.posix.dirname(String(brief).replace(/\\/g, '/'));
  // The designer's report is saved under the name designerReport() accepts, so its line leaves after it ran (finding 5).
  const run = (name, prompt) => codexRun({ repo, out: `${dir}/${name === 'designer' ? DESIGNER_REPORTS[0] : `codex-${name}.md`}`, log: `${dir}/codex-${name}.log`, prompt, role: CODEX_ROLE[name], codexHome });
  const tail = 'Read-only: no builds, no tests, no edits. Your final message is the report in the shape the brief gives.';
  return [
    '# Launch lines (copy as they are)', '',
    'Engine: Codex — the reviewers below are Codex launches (codex exec, read-only, xhigh)' + (one ? '.' : '; Claude is the one other engine.'), '',
    ...(sizeNote ? [sizeNote, ''] : []),
    ...(one ? [] : designerDone ? [`Test designer: already ran before code (${designerDone})`, ''] : ['## Test designer — Bash, run_in_background (Codex sanad-practical-expert)', '',
      ...run('designer', `Seat: Test designer. ${roleSentence(CODEX_ROLE.designer)} Read your role guide too: ~/.claude/skills/braintrust/experts/test-designer.md. Use the [TEST] lines of the stack's playbooks in ~/.claude/skills/braintrust/playbooks/. Read-only. The task's brief: ${brief} — read its Ticket, Check and Rules sections. Code: ${repo}, branch ${branch}. ${areaLine(changed)} Deliver per your guide.`),
      DESIGNER_AGAIN, '']),
    '## Fresh eyes (Codex) — Bash, run_in_background', '',
    ...run('fresh', `You are the independent reviewer — FRESH EYES whole-PR review. Read and follow only the brief at ${fresh}, including its Rules section. Do not open any other file in that folder. ${roleSentence(CODEX_ROLE.fresh)} ${size === 'medium' ? WHOLE_DIFF_FULL + ' ' : ''}${tail}`),
    ...(one ? [one, ''] : [
      '## Risk files (Codex) — Bash, run_in_background', '',
      ...run('risk', [`You are the independent reviewer — risk files pass (Pass A). Read and follow the brief at ${brief}, including its Rules section. Do not open any other file in that folder. ${roleSentence(CODEX_ROLE.risk)} Review the risk files below with their callers and writers: answer each trace question for each file by following real inputs through the changed code. ${SEAT_QUESTION.risk} ${tail}`, ...riskBody({ facts, changed })].join('\n')),
      '## Whole diff (Codex) — Bash, run_in_background', '',
      ...run('whole', `You are the independent reviewer — whole-diff pass. Read and follow the brief at ${brief}, including its Rules section. Do not open any other file in that folder. ${roleSentence(CODEX_ROLE.whole)} ${WHOLE_DIFF_FULL} ${SEAT_QUESTION.whole} ${tail}`),
      // The Agent tool is Claude Code's; a Codex host runs a shell line (finding 4). `claude -p` prints the report on
      // stdout; plan mode keeps it read-only, and the independent-reviewer agent file bars Write and Edit.
      '## Fresh eyes (Claude) — Bash, run_in_background (claude -p)', '',
      '```bash', `cd "${shq(repo)}" && claude -p --agent independent-reviewer --permission-mode plan "${shq(`You are the independent reviewer — FRESH EYES whole-PR review. Read and follow only the brief at ${fresh}, including its Rules section. Do not open any other file in that folder. Read-only: no builds, no tests, no edits. Your final message is the report in the shape the brief gives.`)}" < /dev/null > "${shq(`${dir}/claude-fresh.md`)}" 2> "${shq(`${dir}/claude-fresh.log`)}"`, '```', '',
    ]),
  ].join('\n');
}

export function buildLaunch({ brief, fresh, repo, branch, size = '', sizeNote = '', facts = null, changed = [], designerDone = '', engine = 'claude', codexHome = '' }) {
  if (!ENGINES.includes(engine)) throw new Error('--engine must be one of ' + ENGINES.join(', '));
  if (engine === 'codex') return buildCodexLaunch({ brief, fresh, repo, branch, size, sizeNote, facts, changed, designerDone, codexHome });
  const freshModel = codexModel(CODEX_ROLE.fresh, codexHome);
  const one = ONE_REVIEW[size];
  return [
    '# Launch lines (copy as they are)', '',
    'Engine: Claude — the reviewers below are Claude agents' + (one ? '.' : '; Codex is the one other engine.'), '',
    ...(sizeNote ? [sizeNote, ''] : []),
    // The Test designer is a Big-task seat (loop-rare-cases.md, the expert panel); a tiny, small or medium change
    // listed it too, and the line looked like a step to run (2026-11-13).
    ...(one ? [] : designerDone ? [`Test designer: already ran before code (${designerDone})`, ''] : ['## Test designer — Agent braintrust-expert-sonnet, run_in_background', '',
    `Seat: Test designer. Read your role guide first: ~/.claude/skills/braintrust/experts/test-designer.md. Use the [TEST] lines of the stack's playbooks in ~/.claude/skills/braintrust/playbooks/. Read-only. The task's brief: ${brief} — read its Ticket, Check and Rules sections. Code: ${repo}, branch ${branch}. ${areaLine(changed)} Deliver per your guide.`, '', DESIGNER_AGAIN, '']),
    '## Fresh eyes (Claude) — Agent independent-reviewer, run_in_background', '',
    `You are the independent reviewer — FRESH EYES whole-PR review. Read and follow only the brief at ${fresh}, including its Rules section. Do not open any other file in that folder. ${size === 'medium' ? WHOLE_DIFF_FULL + ' ' : ''}Read-only: no builds, no tests, no edits.`, '',
    ...(one ? [one, ''] : [
      ...riskLaunch({ brief, facts, changed }),
      '## Whole diff (Claude) — Agent routine-reviewer, run_in_background', '',
      `You are the independent reviewer — whole-diff pass. Read and follow the brief at ${brief}, including its Rules section. Do not open any other file in that folder. ${WHOLE_DIFF_FULL} ${SEAT_QUESTION.whole} Read-only: no builds, no tests, no edits.`, '',
      // -m comes from the fresh-eyes role's settings file (codexRoleModel), read when the plan is written.
      '## Fresh eyes (Codex) — Bash, run_in_background', '',
      // 2026-11-18 (audit finding 5): every value goes through shq, as in the Codex plan. The folder is escaped first and
      // joined after, so an ordinary path keeps the separators it had.
      '```bash', `cd "${shq(repo)}" && codex exec -s read-only -c model_reasoning_effort="xhigh" -C "${shq(repo)}" -o "${shqPath(path.join(path.dirname(brief), 'codex-review.md'))}"${freshModel.flag} "${shq(`You are the independent reviewer — FRESH EYES. Read and follow only the brief at ${fresh}, including its Rules section. Do not open any other file in that folder. Read-only: no builds, no tests, no edits. Your final message is the report in the shape the brief gives.`)}" < /dev/null > "${shqPath(path.join(path.dirname(brief), 'codex.log'))}" 2>&1`, '```', '', ...freshModel.note,
    ]),
  ].join('\n');
}

// ---- Pinned rounds and the re-check (2026-11-19) ----
//
// A review round is pinned to one commit (--pin). The round is saved in the notes folder (review-pin.json, addPin) and
// the commit is kept alive under a local ref, refs/sanad/review/<task>/<round>: a fix round amends the one commit of
// the PR, and without the ref the reviewed commit could be collected. The refs are local and never pushed;
// --drop-pins removes them when the task is done.
//
// The re-check (--recheck) was typed by hand, or ran as a full review (209 to 470 s where a narrow one took 30 s).
// The tool makes it now, from the last pinned commit to HEAD: the fix's diff between the two exact commits, its new
// files, the callers of the changed functions, the earlier notes with their answers, the decided list and the round
// number. The round number is information only: the brief never tells a reviewer to stop reporting.

// Files that can change what the product does: code, tests, markup, styles, settings. Prose and logs are not.
const CODE_LIKE = /\.(?:cs|[cm]?[jt]sx?|py|go|java|kt|rb|php|sql|razor|cshtml|vue|svelte|css|scss|less|html?|json|ya?ml|toml|xml|resx|csproj|props|targets|sln|sh|ps1|cmd|bat)$/i;
export const isCodeFile = name => CODE_LIKE.test(String(name)) || TEST_FILE.test(String(name).replace(/\\/g, '/'));

// The name of a task in its refs: the notes folder's name and a short hash of its full path, so two tasks whose
// folders have the same name keep their own refs.
export function pinTask(notesDir) {
  const full = path.resolve(notesDir).replace(/\\/g, '/');
  const slug = path.posix.basename(full).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'task';
  return `${slug}-${crypto.createHash('sha1').update(process.platform === 'win32' ? full.toLowerCase() : full).digest('hex').slice(0, 8)}`;
}
export const pinRef = (task, round) => `refs/sanad/review/${task}/${round}`;

// This task's review notes from the session log, as notes.mjs reads them: { list } or { failed: <why> }. `taskOnly`
// (the round limit, attack 2026-11-22): only a session log written since this task started (task.json), so another
// task's notes in the same repository never count.
async function readSessionNotes(repo, notesDir, { taskOnly = false } = {}) {
  try {
    const tool = await import('./notes.mjs');
    if (typeof tool.sessionNotes !== 'function') throw new Error('notes.mjs has no sessionNotes');
    // A folder with no task.json (no `sanad.mjs start`) cannot be scoped to one task: the repository's newest log, as before.
    const scoped = taskOnly && fs.existsSync(path.join(notesDir, 'task.json'));
    const got = await tool.sessionNotes(scoped ? { notes: notesDir } : { repo, notes: notesDir });
    return { list: Array.isArray(got) ? got : (got && Array.isArray(got.notes) ? got.notes : []) };
  } catch (e) { return { failed: e.code === 'ERR_MODULE_NOT_FOUND' ? 'the notes tool notes.mjs is not installed' : String(e.message || e).split(/\r?\n/)[0] }; }
}

// 2026-11-22 (owner): the round limit is a refusal, not printed text. A re-run ran 4 review rounds with
// sanad.stopRound 2, because only the step printer knew the limit. Past the owner's stop round (git config
// sanad.stopRound, 3 when it is not set) this tool writes no brief for a new round unless:
//   - an OPEN note is a Blocker, a security note or a ticket-line note (steps.mjs reopensRound); or
//   - a note of the last round (numbered after the last pin's `notes` count) is such a note answered `fixed`: its fix
//     needs the re-check the push guard asks for; or
//   - a note of the last round was answered with the owner's own words (`user`), such as "fix now".
// Only the owner raises the limit; the author never sets a switch. Notes that cannot be read show no exception, so the
// round is refused. `since`: the last pin's note count (none for an older pin: only the open rule). '' when it may run.
export function roundLimitRefusal({ round, stop, notes, since }) {
  if (!(Number(round) > Number(stop))) return '';
  const head = `ROUND LIMIT: round ${round} is past the owner's stop round ${stop} (git config sanad.stopRound; 3 when it is not set). No brief was written.`;
  const tail = ' The open notes go to the owner in one list (notes.mjs ask): fix now, or a known limit in the PR text. Only an open Blocker, security note or ticket-line note, the fix of one found in the last round, or the owner\'s words on a note of the last round open another round; only the owner raises the limit.';
  if (!notes || notes.failed || !Array.isArray(notes.list)) return `${head} The notes could not be read (${(notes && notes.failed) || 'no list'}), so no open Blocker, security note or ticket-line note can be shown.${tail}`;
  const lastRound = (n) => Number.isInteger(since) && Number(n.n) > since;
  const opens = (n) => {
    const state = n.state || 'open';
    if (state === 'open') return reopensRound(n);
    if (!lastRound(n)) return false;
    return state === 'user' || (state === 'fixed' && reopensRound(n));
  };
  return notes.list.some((n) => n && opens(n)) ? '' : head + tail;
}

// The files a pin refuses: code that is not in the pinned commit. A reviewer of that commit would never see them.
export function pinRefusal(set) {
  if (set.foreign && set.foreign.length) return foreignLine(set);
  const loose = [...new Set([...(set.uncommitted || []), ...(set.untracked || [])])].filter(isCodeFile);
  if (!loose.length) return '';
  const shown = loose.slice(0, 20).join(', ') + (loose.length > 20 ? `, and ${loose.length - 20} more` : '');
  return `--pin: ${loose.length} code file(s) are not in commit ${String(set.at).slice(0, 12)}: ${shown}. Commit them, or add a file that is not this task's to .git/info/exclude, then run this again. No brief was written.`;
}

// A fix over one of these is not a re-check: it gets the full brief again. The numbers are first guesses to tune.
export const RECHECK_LIMIT = { lines: 150, files: 8 };
// `files`: the fix's files [{ name, lines }]; `newSignals`: risk signals the fix brought that the round before
// did not have. Tests are not counted: they are the proof of the fix, not the fix. Returns the reasons, [] when it fits.
export function recheckTooLarge({ files = [], newSignals = [] }) {
  const code = files.filter(f => isCodeFile(f.name) && !TEST_FILE.test(f.name));
  const lines = code.reduce((sum, f) => sum + (f.lines || 0), 0);
  return [
    ...(lines > RECHECK_LIMIT.lines ? [`${lines} changed code lines (limit ${RECHECK_LIMIT.lines})`] : []),
    ...(code.length > RECHECK_LIMIT.files ? [`${code.length} code files (limit ${RECHECK_LIMIT.files})`] : []),
    ...(newSignals.length ? [`a new risk signal: ${newSignals.map(k => (SIGNALS[k] && SIGNALS[k].label) || k).join('; ')}`] : []),
  ];
}

// The files between two exact commits: [{ name, added (a new file), deleted, lines }]. Renames show as a delete and a new file.
export function rangeFiles(repo, from, to) {
  const run = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
  const status = new Map();
  const st = run(['diff', '--name-status', '-z', '--no-renames', from, to, '--']).split('\0').filter(Boolean);
  for (let i = 0; i + 1 < st.length; i += 2) status.set(st[i + 1], st[i][0]);
  return run(['diff', '--numstat', '-z', '--no-renames', from, to, '--']).split('\0').filter(Boolean).map((row) => {
    const [add, del, ...rest] = row.split('\t');
    const name = rest.join('\t');
    return { name, added: status.get(name) === 'A', deleted: status.get(name) === 'D', lines: (Number(add) || 0) + (Number(del) || 0) };
  });
}

// The signals of the size check that name a file of the fix, with those files only.
export function fixSignals(signals, files = []) {
  const out = {};
  for (const [key, names] of Object.entries(signals || {})) {
    if (!TRACE[key]) continue;
    const hit = (names || []).filter(n => files.some(f => f.name === n || path.posix.basename(f.name) === n));
    if (hit.length) out[key] = hit;
  }
  return out;
}

// One earlier note as the re-check brief shows it: its number, seat, kind, place and text, then its answer.
function noteRows(notes) {
  const one = s => String(s ?? '').replace(/\s+/g, ' ').trim();
  return notes.flatMap((n) => {
    const number = one(n.number ?? n.n ?? n.id);
    const head = [number ? (/^\d+$/.test(number) ? 'N' + number : number) : '', n.seat ? `[${one(n.seat)}]` : '', one(n.kind)].filter(Boolean).join(' ');
    const body = [one(n.place), one(n.text ?? n.note)].filter(Boolean).join(' — ');
    const answer = [one(n.state), one(n.answer)].filter(Boolean).join(' — ');
    return [`- ${[head, body].filter(Boolean).join(' — ')}`, `  Answer: ${answer || 'none yet (open)'}`];
  });
}

// `notes`: { list: [...] } from sessionNotes (notes.mjs), or { failed: <why> }. With no readable note the brief says
// so and tells the reviewer where the reports are; it never shows an empty list as "no earlier notes".
// `callers`: { text } from the size check's range form, or { failed }.
export function buildRecheckBrief({ repo, branch, from, to, round, fromRound = '', files = [], callers = {}, notes = {}, decided = [], decisions = [], notesDir = '', code = [] }) {
  const list = Array.isArray(notes.list) ? notes.list : [];
  const why = notes.failed || (list.length ? '' : 'the notes reader gave no note for this task');
  return tidy([
    'You are a code reviewer on a re-check after a fix. Read-only: no builds, no tests, no edits. Report: `RECOMMEND: PASS|FAIL` first, then the findings, most severe first, one line each: ' + FINDING_SHAPE + '; or "no findings" and what you checked. ' + TEST_IN_NOTE + ' Then `OUTSIDE PR:` and `EXTRA TEST:` lines, if any.', '',
    `Re-check, round ${round}. The round number is information only: report every finding you have.`, '',
    `Repo: ${repo}, branch ${branch}. The fix is the change from commit ${from}${fromRound ? ` (round ${fromRound}, already reviewed)` : ''} to commit ${to}: \`git diff ${from} ${to}\`. Only these two commits count. When a file in the folder differs from the new commit, the commit counts: \`git show ${to}:<path>\`.`, '',
    '## Files the fix changed', '',
    ...(files.length ? files.map(f => `- ${f.name}${f.added ? ' (new in this fix: read the whole file)' : f.deleted ? ' (deleted by this fix)' : ` — ${f.lines} changed line(s)`}`) : ['- none']), '',
    '## Callers of the changed functions', '',
    callers.failed ? `The size check gave no callers for this range (${callers.failed}). Find the callers of each changed function yourself, by search, before you pass a fix.`
      : callers.text ? `Callers: ${callers.text}` : 'The size check found no caller of a changed function in this range. Search once yourself for a caller it misses.', '',
    '## Earlier notes and their answers', '',
    ...(why ? [`The earlier notes could not be read here (${why}). Read the reviewers' reports${notesDir ? ' in ' + notesDir : ' in the notes folder'} and the author's NOTE lines before you judge the fix; say in your report which notes you checked.`]
      : noteRows(list)), '',
    ...decidedBlock({ decided, decisions }),
    '## What to check', '',
    '- Each `fixed` answer: follow the note\'s own input through the new code. A fix that hides the case, or moves it, is a `Bug`.',
    '- Each caller of a changed function: does the fix change a result that caller relies on? A hole the fix opens outside the changed lines is a finding.',
    '- Each new file and each new test: can the test fail? Name the product change it would let through.',
    '- A `refuted` or `user` answer is not a fix: check only that the code still matches what the answer says.',
    '- A problem you see outside the fix is still reported, on its own line, with the words "outside the fix".', '',
    ...code,
  ]);
}

// The re-check's launch lines. Every prompt starts with the reviewer words and holds "re-check", so the guards count
// the run and give its notes the re-check seat (hooks/lib/transcript-scan.js REVIEWER_PROMPT, reviewerSeat).
// `risk`: the fix's risk signals with their files (fixSignals); with one, the risk reviewer re-checks too.
export function buildRecheckLaunch({ brief, repo, round, engine = 'claude', risk = {}, files = [], codexHome = '' }) {
  if (!ENGINES.includes(engine)) throw new Error('--engine must be one of ' + ENGINES.join(', '));
  // `risk` null: the size check gave no signals, so the risk reviewer gets every changed file and every question.
  const withRisk = risk === null || Object.keys(risk).length > 0;
  const whole =`You are the independent reviewer — re-check (whole-diff pass on the fix only). Read and follow only the brief at ${brief}. Do not open any other file in that folder. Read-only: no builds, no tests, no edits.`;
  const riskPrompt = [`You are the independent reviewer — re-check (risk files pass on the fix only). Read and follow only the brief at ${brief}. Do not open any other file in that folder. Review the risk files below with their callers and writers: answer each trace question for each file by following real inputs through the changed code. Read-only: no builds, no tests, no edits.`,
    ...riskBody({ facts: { signals: risk }, changed: files })];
  const dir = path.posix.dirname(String(brief).replace(/\\/g, '/'));
  const tail = ' Your final message is the report in the shape the brief gives.';
  const codex = (name, prompt, role) => codexRun({ repo, out: `${dir}/codex-recheck-${round}${name}.md`, log: `${dir}/codex-recheck-${round}${name}.log`, prompt, role, codexHome });
  return [
    '# Launch lines (copy as they are)', '',
    `Engine: ${engine === 'codex' ? 'Codex' : 'Claude'} — re-check, round ${round}: ${withRisk ? 'the whole-diff reviewer and the risk reviewer (a changed file carries a risk signal)' : 'the whole-diff reviewer'}.`, '',
    ...(engine === 'codex'
      ? ['## Re-check, whole diff (Codex) — Bash, run_in_background', '', ...codex('', `${whole} ${roleSentence(CODEX_ROLE.whole)}${tail}`, CODEX_ROLE.whole),
        ...(withRisk ? ['## Re-check, risk files (Codex) — Bash, run_in_background', '', ...codex('-risk', [`${riskPrompt[0]} ${roleSentence(CODEX_ROLE.risk)}${tail}`, ...riskPrompt.slice(1)].join('\n'), CODEX_ROLE.risk)] : [])]
      : ['## Re-check, whole diff (Claude) — Agent routine-reviewer, run_in_background', '', whole, '',
        ...(withRisk ? ['## Re-check, risk files (Claude) — Agent independent-reviewer, run_in_background', '', ...riskPrompt, ''] : [])]),
  ].join('\n');
}

// 2026-11-18 (finding 1): the task's engine is kept in the notes folder (engine.txt, the folder of --out). The tool runs
// twice per task and the written command carries no --engine: a given value is saved, an absent one is read back
// (default claude), and a given value that differs from the saved one is refused, never silently replaced.
export function resolveEngine(notesDir, given) {
  const file = path.join(notesDir, 'engine.txt');
  let saved = '';
  // 2026-11-18: only a missing file means "nothing saved"; an unreadable or empty one is refused.
  try { saved = fs.readFileSync(file, 'utf8').trim(); if (!saved) throw new Error(`${file} is empty; it must hold one of ${ENGINES.join(', ')}. Fix or delete the file.`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (saved && !ENGINES.includes(saved)) throw new Error(`${file} holds "${saved}"; it must be one of ${ENGINES.join(', ')}. Fix or delete the file.`);
  if (given && saved && given !== saved) throw new Error(`this task's engine is ${saved} (saved in ${file}); --engine ${given} differs. Keep ${saved}, or delete the file to start a new task.`);
  if (given && !saved) fs.writeFileSync(file, given + '\n');
  return given || saved || 'claude';
}

// 2026-11-18 (audit finding 2): the size given with --size is kept in the notes folder (size.txt), as engine.txt keeps the
// engine. The tool runs twice per task and the written command has no --size, so a chosen Big review became the measured
// size's plan. A later run reads it back; the size used is never smaller than the saved one (chooseSize still raises it
// to the measured size). An unreadable saved value is refused, never ignored.
export function resolveSize(notesDir, given) {
  const file = path.join(notesDir, 'size.txt');
  let saved = '';
  // 2026-11-18: only a missing file means "nothing saved"; an unreadable or empty one is refused.
  try { saved = fs.readFileSync(file, 'utf8').trim(); if (!saved) throw new Error(`${file} is empty; it must hold one of ${SIZES.join(', ')}. Fix or delete the file.`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (saved && !SIZES.includes(saved)) throw new Error(`${file} holds "${saved}"; it must be one of ${SIZES.join(', ')}. Fix or delete the file.`);
  const used = given && saved ? SIZES[Math.max(SIZES.indexOf(given), SIZES.indexOf(saved))] : given || saved || undefined;
  if (given && used !== saved) fs.writeFileSync(file, used + '\n');
  return used;
}

function parse(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    // The one option with no value (2026-11-17).
    if (k === '--designer-done') { o['designer-done'] = true; continue; }
    // 2026-11-19: the options of a pinned round, each with no value.
    if (['--pin', '--recheck', '--drop-pins', '--no-frozen'].includes(k)) { o[k.slice(2)] = true; continue; }
    if (!['--out', '--ticket', '--lines', '--check', '--repo', '--base', '--outside', '--places', '--missed', '--size', '--proof-log', '--engine', '--notes'].includes(k) || argv[i + 1] === undefined) throw new Error('Unknown or empty option: ' + k);
    // --proof-log may come more than once: a server proof and a page proof give two logs.
    // 2026-11-20 (timed task: a page proof and a server proof made two logs, and the printed command took one): a comma list
    // is several logs. A value that is itself a file stays one log, so a comma inside a folder name still works.
    if (k === '--proof-log') { const v = argv[++i]; (o['proof-log'] ||= []).push(...(fs.existsSync(v) ? [v] : v.split(',').map((s) => s.trim()).filter(Boolean))); }
    else o[k.slice(2)] = argv[++i];
  }
  // 2026-11-19: --notes <dir> stands for --out, --ticket, --lines, --check and --places, by the names of the notes
  // folder (notes-dir.mjs). An option given beside it wins; the places list is used when its file is there.
  if (o.notes) {
    const p = notePaths(o.notes);
    o.out ||= p.brief; o.ticket ||= p.ticket; o.lines ||= p.lines; o.check ||= p.check;
    if (!o.places && fs.existsSync(p.places)) o.places = p.places;
  }
  if (o['drop-pins']) { if (!o.out) throw new Error('--drop-pins needs --notes <dir> (or --out <brief.md>) to name the task'); return o; }
  for (const need of ['out', 'ticket', 'lines', 'check']) if (!o[need]) throw new Error('--' + need + ' is required');
  if (o.size && !SIZES.includes(o.size)) throw new Error('--size must be one of ' + SIZES.join(', '));
  // 2026-11-18: the task's engine; no saved file names it (engines.md keeps it in the task record), so absent means claude.
  if (o.engine !== undefined && !ENGINES.includes(o.engine)) throw new Error('--engine must be one of ' + ENGINES.join(', '));
  return o;
}

// `--coverage --lines <file> --check <file>`: only the Check lines' cover of the ticket, for pre-review (2026-11-16:
// a Check line in the wrong shape passed both pre-review runs and was refused only here, after the proof).
function coverageMain(argv) {
  const at = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  if (!at('--lines') || !at('--check')) throw new Error('--coverage needs --lines <file> and --check <file>');
  const checks = checkLines(fs.readFileSync(at('--check'), 'utf8'));
  const ticketLines = readLines(fs.readFileSync(at('--lines'), 'utf8'));
  const gaps = !checks.length ? ['the check file has no lines'] : coverageProblems(ticketLines, checks);
  process.stdout.write(gaps.length ? gaps.join('\n') + '\n' : `CHECK LINES: ${checks.length} line(s), each with its source; T1..T${ticketLines.length} covered\n`);
  process.exitCode = gaps.length ? 1 : 0;
}

if (isMain(import.meta.url) && process.argv.includes('--coverage')) {
  try { coverageMain(process.argv.slice(2)); }
  catch (error) { process.stderr.write('REVIEW-BRIEF: ' + error.message + '\n'); process.exitCode = 2; }
} else if (isMain(import.meta.url)) {
  // 2026-11-19: the run is one async function (the notes tool is loaded only by a re-check), so an early end is a return.
  try { await (async () => {
    const o = parse(process.argv.slice(2));
    const repo = git(path.resolve(o.repo || process.cwd()), ['rev-parse', '--show-toplevel']);
    if (!repo) throw new Error('not inside a git repository: ' + (o.repo || process.cwd()));
    const notesDir = path.dirname(path.resolve(o.out));
    const task = pinTask(notesDir);
    if (o['drop-pins']) {
      const refs = git(repo, ['for-each-ref', '--format=%(refname)', `refs/sanad/review/${task}/`]).split(/\r?\n/).filter(Boolean);
      for (const ref of refs) execFileSync('git', ['update-ref', '-d', ref], { cwd: repo, windowsHide: true, stdio: 'ignore' });
      let copies = 0;
      try { copies = dropCopies(task); } catch { /* a folder in use stays; the refs are gone */ }
      process.stdout.write(`PINS DROPPED: ${refs.length} ref(s) under refs/sanad/review/${task}/, ${copies} copy folder(s). The saved rounds stay in ${notePaths(notesDir).pins}.\n`);
      return;
    }
    const base = o.base || 'origin/' + (git(repo, ['config', '--get', 'sanad.integration']) || 'staging');
    const mergeBase = git(repo, ['merge-base', base, 'HEAD']);
    if (!mergeBase) throw new Error('no merge base with ' + base);
    // A pinned round (--pin, --recheck) reviews HEAD and nothing else: code that is not in that commit stops it.
    const pinning = Boolean(o.pin || o.recheck);
    const head = pinning ? git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']) : '';
    if (pinning && !head) throw new Error('--pin: there is no commit to pin yet');
    const set = pinning ? changeSet(repo, base, { at: head }) : null;
    const pinStop = set ? pinRefusal(set) : '';
    if (pinStop) throw new Error(pinStop.startsWith('FOREIGN?') ? '--pin: no brief was written\n' + pinStop : pinStop);
    // 2026-11-22 (owner): the round limit is this tool's refusal (see roundLimitRefusal). It is asked right before a
    // round is saved, with the kind that save uses, so a repeat at one commit and a new round are told apart the way
    // addPin tells them (attack: a --pin after a re-check at one commit). Each pin keeps the count of notes known then
    // (`notes`), so the next check can tell the last round's notes.
    let taskList = null;
    const taskNotes = async () => (taskList ||= await readSessionNotes(repo, notesDir, { taskOnly: true }));
    const guardRound = async (kind) => {
      const pins = readPins(notesDir);
      if (!pins.length) return;
      const last = pins[pins.length - 1];
      const again = last.kind === kind && last.commit === head && last.tree === git(repo, ['rev-parse', head + '^{tree}']);
      const round = again ? last.round : pins.reduce((max, x) => Math.max(max, Number.isInteger(x.round) ? x.round : 0), 0) + 1;
      const stop = stopRound(git(repo, ['config', '--get', 'sanad.stopRound']));
      if (round <= stop) return;
      const refusal = roundLimitRefusal({ round, stop, notes: await taskNotes(), since: Number.isInteger(last.noteCount) ? last.noteCount : undefined });
      if (refusal) throw new Error(refusal);
    };
    const noteCount = async () => { const got = await taskNotes(); return got.failed ? undefined : got.list.reduce((max, n) => Math.max(max, Number(n.n) || 0), 0); };
    const checks = checkLines(fs.readFileSync(o.check, 'utf8'));
    if (!checks.length) throw new Error('the check file has no lines');
    const linesText = fs.readFileSync(o.lines, 'utf8');
    const ticketLines = readLines(linesText);
    if (!ticketLines.length) throw new Error('the ticket lines file has no lines');
    // The lines the owner dropped (lines.mjs --drop): no Check line is asked for them, and the briefs list them.
    const dropped = (typeof ticketLinesTool.droppedLines === 'function' ? ticketLinesTool.droppedLines(linesText) : [])
      .map(d => Number(String(d && typeof d === 'object' ? d.n ?? d.number : d).replace(/^T/i, ''))).filter(n => Number.isInteger(n) && n >= 1 && n <= ticketLines.length)
      .map(n => ({ n, text: ticketLines[n - 1] }));
    const gaps = coverageProblems(ticketLines, checks, dropped.map(d => d.n));
    if (gaps.length) throw new Error('the Check lines do not cover the ticket:\n  ' + gaps.join('\n  '));
    // 2026-11-18: a requested --outside file that is missing is refused; the git-config default stays lenient.
    if (o.outside && !fs.existsSync(o.outside)) throw new Error('--outside file not found: ' + o.outside);
    const listFile = (flag, key) => { const f = flag || git(repo, ['config', '--get', key]); return f && fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''; };
    // With a pin the changed files are the pinned commit's own (changeSet); nothing untracked is under review.
    const tracked = set ? set.files : git(repo, ['diff', '--name-only', '-z', mergeBase]).split('\0').filter(Boolean);
    const untracked = set ? [] : git(repo, ['ls-files', '-z', '--others', '--exclude-standard']).split('\0').filter(Boolean);
    const changedFiles = [...tracked.map(name => ({ name })), ...untracked.filter(n => !tracked.includes(n)).map(name => ({ name, untracked: true }))];
    const changed = changedFiles.map(f => f.name);
    const outsideText = listFile(o.outside, 'sanad.outsideList');
    // This task's own decisions (decisions.json). A broken file stops the brief by name; it is never read as "none".
    const decisions = decisionLines(readDecisions(notesDir));
    const outside = { ...splitOutside(outsideItems(outsideText), changed), decided: decidedItems(outsideText), decisions };
    // 2026-11-18 (audit finding 4): a proof log that was asked for and is not there is a usage error, never skipped.
    const missingLog = (o['proof-log'] || []).find(f => !fs.existsSync(f));
    if (missingLog) throw new Error('--proof-log file not found: ' + missingLog);
    const logs = (o['proof-log'] || []).map(f => ({ name: path.basename(f), text: fs.readFileSync(f, 'utf8') }));
    const proof = proofLines(logs, logs.length ? treeId(repo) : '');
    const lightLane = !proof.length && onLightLane(repo, base);
    const facts = sizeFacts(repo, base);
    const signalKeys = Object.keys(facts.signals || {}).filter(k => TRACE[k]);
    const keepPin = (round) => {
      const ref = pinRef(task, round);
      try { execFileSync('git', ['update-ref', ref, head], { cwd: repo, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' }); return ''; }
      catch (e) { return `NOTE: the ref ${ref} could not be written (${String(e.stderr || e.message).trim().split(/\r?\n/)[0]}): commit ${head.slice(0, 12)} is not kept alive after an amend.\n`; }
    };
    let tooLargeLine = '';
    if (o.recheck) {
      const pins = readPins(notesDir);
      if (!pins.some(p => p.kind === 'full')) throw new Error(`--recheck needs a full review round first, and ${notePaths(notesDir).pins} holds none: run the review with --pin, make the fix, commit it, then --recheck`);
      // The brief made twice at one commit is one round: the fix still starts at the pin before it.
      const again = pins.length > 1 && pins[pins.length - 1].kind === 'recheck' && pins[pins.length - 1].commit === head;
      const last = pins[pins.length - (again ? 2 : 1)];
      if (last.commit === head) throw new Error(`--recheck: nothing to re-check, HEAD is still commit ${head.slice(0, 12)} of round ${last.round}. Commit the fix first.`);
      if (!git(repo, ['rev-parse', '--verify', '--quiet', last.commit + '^{commit}'])) throw new Error(`--recheck: commit ${last.commit.slice(0, 12)} of round ${last.round} is not in this repository any more (its ref ${pinRef(task, last.round)} is gone), so the fix cannot be told from the rest. Run a full round with --pin.`);
      const files = rangeFiles(repo, last.commit, head);
      const before = Array.isArray(last.signals) ? last.signals : null;
      const tooLarge = recheckTooLarge({ files, newSignals: before ? signalKeys.filter(k => !before.includes(k)) : [] });
      if (tooLarge.length) {
        tooLargeLine = `Re-check too large (${tooLarge.join('; ')}): this is the full brief for the next round, from the pinned commit.`;
        // Not a re-check any more: the full briefs are written below, pinned to HEAD, as a new full round.
        process.stdout.write(`RECHECK TOO LARGE: ${tooLarge.join('; ')}. This round gets the full brief; launch every line of launch.md.\n`);
      } else {
        // The callers of what the fix changed, from the size check's range form. No answer is said, never shown as "none".
        const range = sizeFacts(repo, base, { extra: ['--from', last.commit, '--at', head] });
        const notes = await readSessionNotes(repo, notesDir);
        // With no signals (the size check failed) the risk reviewer re-checks too: nothing says the fix is free of risk.
        const risk = facts.signals ? fixSignals(facts.signals, files) : null;
        const withRisk = risk === null || Object.keys(risk).length > 0;
        await guardRound('recheck');
        const saved = addPin(notesDir, { kind: 'recheck', commit: head, tree: git(repo, ['rev-parse', head + '^{tree}']), mergeBase, seats: ['whole diff', ...(withRisk ? ['risk files'] : [])], frozen: '', signals: signalKeys, noteCount: await noteCount() });
        const refNote = keepPin(saved.round);
        const branchNow = git(repo, ['branch', '--show-current']) || '(detached)';
        const briefFile = path.join(notesDir, `brief-recheck-${saved.round}.md`), launchFile = path.join(notesDir, 'launch.md');
        const engineNow = resolveEngine(notesDir, o.engine);
        fs.writeFileSync(briefFile, buildRecheckBrief({ repo, branch: branchNow, from: last.commit, to: head, code: codeBlock({ repo, mergeBase: last.commit, pin: head, rows: range.rows }), round: saved.round, fromRound: last.round, files, callers: range.failed ? { failed: range.failed } : { text: range.callers }, notes, decided: outside.decided, decisions, notesDir: notesDir.replace(/\\/g, '/') }));
        fs.writeFileSync(launchFile, buildRecheckLaunch({ brief: briefFile.replace(/\\/g, '/'), repo, round: saved.round, engine: engineNow, risk, files }));
        const code = files.filter(f => isCodeFile(f.name) && !TEST_FILE.test(f.name));
        process.stdout.write(refNote + (facts.failed ? `SIZE CHECK FAILED: ${facts.failed}\n` : '') + `ENGINE: ${engineNow}\n` +
          `RECHECK: round ${saved.round} · git diff ${last.commit.slice(0, 12)} ${head.slice(0, 12)} · ${files.length} file(s), ${code.reduce((s, f) => s + f.lines, 0)} code line(s) in ${code.length} code file(s) · seats: ${saved.seats.join(', ')} · notes: ${notes.failed ? 'not read (' + notes.failed + ')' : notes.list.length} · callers: ${range.failed ? 'not given' : range.callers ? 'yes' : 'none found'}\n` +
          `BRIEF: ${briefFile}\nLAUNCH: ${launchFile}\n`);
        return;
      }
    }
    // The places list is searched again in this folder first, so a place that appeared after it was written
    // is on it (and open) before any brief is written.
    const placesFile = o.places && path.resolve(o.places);
    const places = placesFile ? refreshPlaces(placesFile, { repo }) : null;
    const refusal = placesRefusal({ measured: measuredSize(facts), list: places, file: placesFile, checkCount: checks.length, repo });
    if (refusal) throw new Error(refusal);
    const placesState = places && checkPlaces(places, { checkCount: checks.length });
    const branch = git(repo, ['branch', '--show-current']) || '(detached)';
    const ticket = fs.readFileSync(o.ticket, 'utf8');
    const out = path.resolve(o.out), fresh = out.replace(/(\.md)?$/, '-fresh.md'), launch = path.join(path.dirname(out), 'launch.md');
    const routed = resolveSize(path.dirname(out), o.size);
    const chosen = chooseSize(facts, routed);
    const engine = resolveEngine(path.dirname(out), o.engine);
    // A pinned round is saved before its briefs are written, and its commit is kept alive under a local ref. Big
    // only (or a size not known): one read-only folder of the commit, so the author may fix early notes while the
    // reviewers read. When it cannot be made, the pinned diff stays and one NOTE line says so.
    let pinLines = '', copy = '';
    if (pinning) {
      const one = Boolean(ONE_REVIEW[chosen.size]);
      await guardRound('full');
      const pin = { kind: 'full', commit: head, tree: git(repo, ['rev-parse', head + '^{tree}']), mergeBase, seats: one ? ['fresh eyes'] : ['fresh eyes', 'risk files', 'whole diff', 'other engine'], frozen: '', signals: signalKeys, noteCount: await noteCount() };
      let saved = addPin(notesDir, pin);
      pinLines = keepPin(saved.round);
      if (!one && !o['no-frozen']) {
        try { copy = makeCopy({ repo, commit: head, task, round: saved.round }); saved = addPin(notesDir, { ...pin, frozen: copy }); }
        catch (e) { pinLines += `NOTE: the read-only copy of commit ${head.slice(0, 12)} could not be made (${String(e.message || e).split(/\r?\n/)[0]}): the reviewers read the pinned commit in the work folder, so no source edit while they read.\n`; }
      }
      pinLines += `PIN: round ${saved.round} · commit ${head} · ref ${pinRef(task, saved.round)}${copy ? ` · copy ${copy}` : ''}\n`;
    }
    // 2026-11-22: the code under review, read at the pinned commit, goes into both briefs.
    const code = codeBlock({ repo, mergeBase, pin: head, rows: facts.rows });
    // 2026-11-22: the second look's hints and how the author answered each one (a not: carries its reason).
    let hints = [];
    try { const sf = notePaths(notesDir).siblings; if (fs.existsSync(sf)) hints = hintsBlock(fs.readFileSync(sf, 'utf8')); } catch { /* no list: no hints */ }
    fs.writeFileSync(out, buildBrief({ repo, branch, base, mergeBase, ticket, ticketLines, checks, outside, facts, size: routed, proof, changed: changedFiles, places, pin: head, copy, dropped, lightLane, code, hints }));
    // The check lines the second look never read (siblings.md in the notes folder). No list, or a list of an earlier
    // release, gives none.
    let lateChecks = [];
    try {
      const siblingsFile = notePaths(notesDir).siblings;
      if (fs.existsSync(siblingsFile)) {
        lateChecks = lateCheckLines(fs.readFileSync(siblingsFile, 'utf8'), fs.readFileSync(o.check, 'utf8')) || [];
      }
    } catch { /* a list that cannot be read is the second look's own check to report */ }
    const outsideFile = (o.outside || git(repo, ['config', '--get', 'sanad.outsideList']) || '').replace(/\\/g, '/');
    fs.writeFileSync(fresh, buildFreshBrief({ repo, branch, base, mergeBase, ticket, outside: { ...outside, file: outsideFile }, facts, size: routed, changed: changedFiles, places, checks, pin: head, copy, dropped, lateChecks, code, hints }));
    // 2026-11-17: the notes folder is the folder of --out; a saved report names itself, the flag only says so.
    const reqTime = Math.max(fs.statSync(o.lines).mtimeMs, fs.statSync(o.check).mtimeMs);
    const designerDone = designerReport(path.dirname(out), reqTime) || (o['designer-done'] ? '--designer-done' : '');
    // With a copy, the launch lines name it: the reviewers (and the Codex -C path) read the pinned commit there.
    fs.writeFileSync(launch, buildLaunch({ brief: out.replace(/\\/g, '/'), fresh: fresh.replace(/\\/g, '/'), repo: copy || repo, branch, size: chosen.size, sizeNote: chosen.note, facts, changed: changedFiles, designerDone, engine }));
    // The first line of each brief names the re-check, so the round count (P9) and the guards see it.
    if (tooLargeLine) for (const f of [out, fresh]) { try { fs.writeFileSync(f, tooLargeLine + '\n\n' + fs.readFileSync(f, 'utf8')); } catch { /* a brief that was not written has no first line to mark */ } }
    process.stdout.write((chosen.note ? chosen.note + '\n' : '') + (facts.failed ? `SIZE CHECK FAILED: ${facts.failed}\n` : '') + `ENGINE: ${engine}\n` + pinLines +
      `BRIEF: ${out} · ${checks.length} check line(s) C1..C${checks.length} · ${outside.other.length + outside.touched.length} known item(s), ${outside.touched.length} in touched files, ${outside.decided.length + decisions.length} decided · callers: ${facts.failed ? 'SIZE CHECK FAILED' : facts.callers ? 'yes' : 'none yet'} · proof: ${proof.length ? 'yes' : lightLane ? 'none (light path)' : 'none yet'} · ${changedFiles.length} changed file(s), ${changedFiles.length - tracked.length} new untracked · places: ${placesState ? `${placesState.count}, ${placesState.open.length} open` : 'none (text-only change)'}\n` +
      `FRESH: ${fresh}\nLAUNCH: ${launch}\n`);
  })(); } catch (error) {
    process.stderr.write('REVIEW-BRIEF: ' + error.message + '\nUsage: node review-brief.mjs (--notes <dir> | --out <brief.md> --ticket <file> --lines <file> --check <file>) [--repo <path>] [--base <ref>] [--outside <file>] [--places <file>] [--size <size>] [--proof-log <file>] [--designer-done] [--engine claude|codex] [--pin [--no-frozen] | --recheck | --drop-pins]\n');
    process.exitCode = 2;
  }
}
