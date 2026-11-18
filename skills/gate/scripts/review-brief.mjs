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
//   --proof-log  a red-proof.mjs --log file; give it once per proof (server, page); the result lines of
//                each go into the framed brief, with a note when the code changed after that proof ran
//   --designer-done  (no value) the Test designer already ran before code, and its report is not saved in the
//                notes folder (the folder of --out) as test-designer.md, test-designer-report.md or test-design.md
// Run it before the Test designer starts, and again after the proof run, before the reviewers:
// the second run adds the callers and the proof. Exit 0: written. 2: usage error.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readLines, TEST_FILE } from './check-ticket-lines.mjs';
import { treeId } from './red-proof.mjs';
import { refreshPlaces, checkPlaces, placeLine } from './places.mjs';
// The size check still runs as a child process (sizeFacts: a timeout ends it); its sizes, signal labels and
// text form come from the module itself, which places.mjs loads anyway.
import { SIZES, SIGNALS, format } from './size-check.mjs';
import { isMain } from './is-main.mjs';

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
export function coverageProblems(ticketLines, checks) {
  const problems = [];
  const covered = new Set();
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

export function checkLines(text) {
  return String(text).split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => l.replace(/^(?:[-*•]|\d+[.)])\s+/, '').replace(/^C\d+\.\s+/, ''));
}

// The size check's lines that the brief carries: stack, size and callers. A crash or a timeout is `failed`
// (its first error line), so the brief says SIZE CHECK FAILED (2026-11-12: it said "Callers: none yet").
// 2026-11-15: it runs with --json, and `signals` keeps each signal's files for the risk-files line of
// launch.md (that reviewer's prompt was typed by hand); the text lines are the check's own format() of the
// same answer. Output that is not its JSON is read as text, with no signals (null).
export function sizeFacts(repo, base, { script = path.join(here, 'size-check.mjs'), timeout = 60000 } = {}) {
  let out = '', failed = '';
  try { out = execFileSync(process.execPath, [script, '--repo', repo, '--base', base, '--json'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout }); }
  catch (e) {
    out = String(e.stdout || '');
    const errLines = String(e.stderr || e.message || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    failed = e.code === 'ETIMEDOUT' ? `timed out after ${Math.round(timeout / 1000)} s`
      : (errLines.find(l => /^(?:SIZE: |\w*Error\b)/.test(l)) || errLines[0] || 'exit ' + e.status).replace(/^SIZE:\s*/, '');
  }
  let text = out, signals = null;
  try { const r = JSON.parse(out); text = format(r); signals = signalFiles(r); } catch { /* not its JSON: read as text */ }
  const line = re => (text.split(/\r?\n/).find(l => re.test(l)) || '').trim();
  const size = line(/^SIZE/);
  if (!failed && !size) failed = 'no SIZE line in its output';
  return { stack: line(/^Stack:/), size, callers: line(/^\s*callers:/).replace(/^callers:\s*/, ''), failed, signals };
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
const ROLE = 'You are a code reviewer. Read-only: no builds, no tests, no edits. Report: `RECOMMEND: PASS|FAIL` first, then the findings, most severe first, one line each: `Blocker|Bug|Gap|Question — file:line — <input> → <wrong result> — <one-line fix>`; or "no findings" and what you checked. When a finding falls under a line of the review checklist, name that line in round brackets ( ) after the kind, as the checklist names it (CALLERS, CLIENT STATE, DATABASE, FAILURES / LOCALES, USERS FOUND BY SEARCH, …): `Bug (CLIENT STATE) — file:line — …`. Then `OUTSIDE PR:` and `EXTRA TEST:` lines, if any. Last, one line `ONE JOB: yes|no`: does this PR do more than one thing? A yes is also a `Question` finding that names the jobs (user rule 2026-11-15).';
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

function diffLine({ repo, branch, base, mergeBase }) {
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
function known({ touched, other, decided = [] }) {
  const fmt = o => `- ${o.what}${o.where ? ` (${o.where})` : ''}`;
  return [
    ...(touched.length ? ['## Problems outside the ticket in the files this change touches — CHECK each one against the change: report it if this change alters or worsens it', '', ...touched.map(fmt), ''] : []),
    '## Problems outside the ticket — known, do not report again', '', ...(other.length ? other.map(fmt) : ['- none']), '',
    ...(decided.length ? ['## Decided by the user — do not ask again', '', ...decided.map(d => '- ' + d), ''] : []),
  ];
}
const focusedBlock = ['## Focused brief (small change)', '',
  'Trace the changed hunks, each caller and each Check line; do not re-derive the whole screen or file. About 15 tool calls and 2 minutes; stop once every line is traced.'];
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

export function buildBrief({ repo, branch, base, mergeBase, ticket, ticketLines = [], checks, outside, facts, size, proof = [], changed, places = null }) {
  return tidy([
    ROLE, '', diffLine({ repo, branch, base, mergeBase }), '',
    facts.stack || 'Stack: unknown', facts.size || '', callersLine(facts), '',
    ...changedBlock(changed),
    '## Ticket (verbatim)', '', ticket.trim(), '',
    ...(ticketLines.length ? ['## Ticket lines — every one has a Check line', '', ...ticketLines.map((t, i) => `- T${i + 1}. ${t}`), ''] : []),
    '## Check — each line names its source ([Tn] a ticket line, [change], [rule: ...], [design] the author\'s choice); its tests carry the tag [Cn]', '',
    ...checks.map((c, i) => `- C${i + 1}. ${c}`), '',
    ...designBlock(checks),
    ...placesBlock(places),
    ...known(outside),
    ...(proof.length ? ['## Proof run (red-proof.mjs)', '', ...proof.map(p => '    ' + p), ''] : []),
    '## Rules', '', ...RULES, '',
    ...(isFocused(facts, size) ? focusedBlock : []),
  ]);
}

// `checks`: only its [design] lines reach fresh eyes, under "attack these" (an author claim, never a goal).
export function buildFreshBrief({ repo, branch, base, mergeBase, ticket, outside, facts, size, changed, places = null, checks = [] }) {
  return tidy([
    ROLE.replace('You are a code reviewer.', 'You are a code reviewer with fresh eyes: judge the change only against the ticket and the code.'), '',
    diffLine({ repo, branch, base, mergeBase }), '', facts.stack || 'Stack: unknown', '',
    ...changedBlock(changed),
    '## Ticket (verbatim)', '', ticket.trim(), '',
    ...designBlock(checks),
    ...placesBlock(places),
    ...known(outside),
    '## Rules', '', ...RULES, '',
    ...(isFocused(facts, size) ? focusedBlock.map(l => l.replace(', each caller and each Check line', ' and every place that uses the changed code')) : []),
  ]);
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
        if (!labels.includes(SIGNALS[key].label)) labels.push(SIGNALS[key].label);
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
    `You are the independent reviewer — risk files pass (Pass A). Read and follow the brief at ${brief}, including its Rules section. Do not open any other file in that folder. Review the risk files below with their callers and writers: answer each trace question for each file by following real inputs through the changed code. Read-only: no builds, no tests, no edits.`,
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
function codexRun({ repo, out, log, prompt }) {
  // No -m: Codex has no "newest" alias, so its model is named once, in ~/.codex/config.toml (2026-11-10).
  return ['```bash', `cd "${shq(repo)}" && codex exec -s read-only -c model_reasoning_effort="xhigh" -C "${shq(repo)}" -o "${shq(out)}" "${shq(prompt)}" < /dev/null > "${shq(log)}" 2>&1`, '```', ''];
}
function buildCodexLaunch({ brief, fresh, repo, branch, size, sizeNote, facts, changed, designerDone }) {
  const one = ONE_REVIEW[size];
  const dir = path.posix.dirname(String(brief).replace(/\\/g, '/'));
  // The designer's report is saved under the name designerReport() accepts, so its line leaves after it ran (finding 5).
  const run = (name, prompt) => codexRun({ repo, out: `${dir}/${name === 'designer' ? DESIGNER_REPORTS[0] : `codex-${name}.md`}`, log: `${dir}/codex-${name}.log`, prompt });
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
      ...run('risk', [`You are the independent reviewer — risk files pass (Pass A). Read and follow the brief at ${brief}, including its Rules section. Do not open any other file in that folder. ${roleSentence(CODEX_ROLE.risk)} Review the risk files below with their callers and writers: answer each trace question for each file by following real inputs through the changed code. ${tail}`, ...riskBody({ facts, changed })].join('\n')),
      '## Whole diff (Codex) — Bash, run_in_background', '',
      ...run('whole', `You are the independent reviewer — whole-diff pass. Read and follow the brief at ${brief}, including its Rules section. Do not open any other file in that folder. ${roleSentence(CODEX_ROLE.whole)} ${WHOLE_DIFF_FULL} ${tail}`),
      // The Agent tool is Claude Code's; a Codex host runs a shell line (finding 4). `claude -p` prints the report on
      // stdout; plan mode keeps it read-only, and the independent-reviewer agent file bars Write and Edit.
      '## Fresh eyes (Claude) — Bash, run_in_background (claude -p)', '',
      '```bash', `cd "${shq(repo)}" && claude -p --agent independent-reviewer --permission-mode plan "${shq(`You are the independent reviewer — FRESH EYES whole-PR review. Read and follow only the brief at ${fresh}, including its Rules section. Do not open any other file in that folder. Read-only: no builds, no tests, no edits. Your final message is the report in the shape the brief gives.`)}" < /dev/null > "${shq(`${dir}/claude-fresh.md`)}" 2> "${shq(`${dir}/claude-fresh.log`)}"`, '```', '',
    ]),
  ].join('\n');
}

export function buildLaunch({ brief, fresh, repo, branch, size = '', sizeNote = '', facts = null, changed = [], designerDone = '', engine = 'claude' }) {
  if (!ENGINES.includes(engine)) throw new Error('--engine must be one of ' + ENGINES.join(', '));
  if (engine === 'codex') return buildCodexLaunch({ brief, fresh, repo, branch, size, sizeNote, facts, changed, designerDone });
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
      `You are the independent reviewer — whole-diff pass. Read and follow the brief at ${brief}, including its Rules section. Do not open any other file in that folder. ${WHOLE_DIFF_FULL} Read-only: no builds, no tests, no edits.`, '',
      // No -m: Codex has no "newest" alias, so its model is named once, in ~/.codex/config.toml (2026-11-10).
      '## Fresh eyes (Codex) — Bash, run_in_background', '',
      // 2026-11-18 (audit finding 5): every value goes through shq, as in the Codex plan. The folder is escaped first and
      // joined after, so an ordinary path keeps the separators it had.
      '```bash', `cd "${shq(repo)}" && codex exec -s read-only -c model_reasoning_effort="xhigh" -C "${shq(repo)}" -o "${shqPath(path.join(path.dirname(brief), 'codex-review.md'))}" "${shq(`You are the independent reviewer — FRESH EYES. Read and follow only the brief at ${fresh}, including its Rules section. Do not open any other file in that folder. Read-only: no builds, no tests, no edits. Your final message is the report in the shape the brief gives.`)}" < /dev/null > "${shqPath(path.join(path.dirname(brief), 'codex.log'))}" 2>&1`, '```', '',
    ]),
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
    if (!['--out', '--ticket', '--lines', '--check', '--repo', '--base', '--outside', '--places', '--missed', '--size', '--proof-log', '--engine'].includes(k) || argv[i + 1] === undefined) throw new Error('Unknown or empty option: ' + k);
    // --proof-log may come more than once: a server proof and a page proof give two logs.
    if (k === '--proof-log') (o['proof-log'] ||= []).push(argv[++i]);
    else o[k.slice(2)] = argv[++i];
  }
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
  try {
    const o = parse(process.argv.slice(2));
    const repo = git(path.resolve(o.repo || process.cwd()), ['rev-parse', '--show-toplevel']);
    if (!repo) throw new Error('not inside a git repository: ' + (o.repo || process.cwd()));
    const base = o.base || 'origin/' + (git(repo, ['config', '--get', 'sanad.integration']) || 'staging');
    const mergeBase = git(repo, ['merge-base', base, 'HEAD']);
    if (!mergeBase) throw new Error('no merge base with ' + base);
    const checks = checkLines(fs.readFileSync(o.check, 'utf8'));
    if (!checks.length) throw new Error('the check file has no lines');
    const ticketLines = readLines(fs.readFileSync(o.lines, 'utf8'));
    if (!ticketLines.length) throw new Error('the ticket lines file has no lines');
    const gaps = coverageProblems(ticketLines, checks);
    if (gaps.length) throw new Error('the Check lines do not cover the ticket:\n  ' + gaps.join('\n  '));
    // 2026-11-18: a requested --outside file that is missing is refused; the git-config default stays lenient.
    if (o.outside && !fs.existsSync(o.outside)) throw new Error('--outside file not found: ' + o.outside);
    const listFile = (flag, key) => { const f = flag || git(repo, ['config', '--get', key]); return f && fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''; };
    const tracked = git(repo, ['diff', '--name-only', '-z', mergeBase]).split('\0').filter(Boolean);
    const untracked = git(repo, ['ls-files', '-z', '--others', '--exclude-standard']).split('\0').filter(Boolean);
    const changedFiles = [...tracked.map(name => ({ name })), ...untracked.filter(n => !tracked.includes(n)).map(name => ({ name, untracked: true }))];
    const changed = changedFiles.map(f => f.name);
    const outsideText = listFile(o.outside, 'sanad.outsideList');
    const outside = { ...splitOutside(outsideItems(outsideText), changed), decided: decidedItems(outsideText) };
    // 2026-11-18 (audit finding 4): a proof log that was asked for and is not there is a usage error, never skipped.
    const missingLog = (o['proof-log'] || []).find(f => !fs.existsSync(f));
    if (missingLog) throw new Error('--proof-log file not found: ' + missingLog);
    const logs = (o['proof-log'] || []).map(f => ({ name: path.basename(f), text: fs.readFileSync(f, 'utf8') }));
    const proof = proofLines(logs, logs.length ? treeId(repo) : '');
    const facts = sizeFacts(repo, base);
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
    fs.writeFileSync(out, buildBrief({ repo, branch, base, mergeBase, ticket, ticketLines, checks, outside, facts, size: routed, proof, changed: changedFiles, places }));
    fs.writeFileSync(fresh, buildFreshBrief({ repo, branch, base, mergeBase, ticket, outside, facts, size: routed, changed: changedFiles, places, checks }));
    // 2026-11-17: the notes folder is the folder of --out; a saved report names itself, the flag only says so.
    const reqTime = Math.max(fs.statSync(o.lines).mtimeMs, fs.statSync(o.check).mtimeMs);
    const designerDone = designerReport(path.dirname(out), reqTime) || (o['designer-done'] ? '--designer-done' : '');
    fs.writeFileSync(launch, buildLaunch({ brief: out.replace(/\\/g, '/'), fresh: fresh.replace(/\\/g, '/'), repo, branch, size: chosen.size, sizeNote: chosen.note, facts, changed: changedFiles, designerDone, engine }));
    process.stdout.write((chosen.note ? chosen.note + '\n' : '') + (facts.failed ? `SIZE CHECK FAILED: ${facts.failed}\n` : '') + `ENGINE: ${engine}\n` +
      `BRIEF: ${out} · ${checks.length} check line(s) C1..C${checks.length} · ${outside.other.length + outside.touched.length} known item(s), ${outside.touched.length} in touched files, ${outside.decided.length} decided · callers: ${facts.failed ? 'SIZE CHECK FAILED' : facts.callers ? 'yes' : 'none yet'} · proof: ${proof.length ? 'yes' : 'none yet'} · ${changedFiles.length} changed file(s), ${changedFiles.length - tracked.length} new untracked · places: ${placesState ? `${placesState.count}, ${placesState.open.length} open` : 'none (text-only change)'}\n` +
      `FRESH: ${fresh}\nLAUNCH: ${launch}\n`);
  } catch (error) {
    process.stderr.write('REVIEW-BRIEF: ' + error.message + '\nUsage: node review-brief.mjs --out <brief.md> --ticket <file> --lines <file> --check <file> [--repo <path>] [--base <ref>] [--outside <file>] [--places <file>] [--size <size>] [--proof-log <file>] [--designer-done] [--engine claude|codex]\n');
    process.exitCode = 2;
  }
}
