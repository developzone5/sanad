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
//   launch.md      the exact launch lines for the designer and the reviewers, next to <out>: three
//                  reviewers on a big change (or a size not known); on a tiny, small or medium change only
//                  the Claude fresh eyes (tiny and small 2026-11-11; medium 2026-11-12, user-approved sizes).
//                  A medium change keeps the full brief, and its one review gets the checklist sentence.
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
//   --ticket     the ticket and QA text, verbatim
//   --lines      every requirement line of the ticket, one per line (the check-ticket-lines file)
//   --check      what must hold, one line each, each starting with its source tag; numbered C1..Cn
//                here, and each needs a test tagged [Cn]
//   --outside    the project's outside list (default: `git config sanad.outsideList`)
//   --places     the places list from places.mjs; required unless the measured size is tiny
//   --missed     accepted and ignored (2026-11-12)
//   --size       the routed size (tiny, small, medium or big); the larger of it and the size check's
//                answer is used, and tiny or small adds the focused budget and the one-review launch
//   --proof-log  a red-proof.mjs --log file; give it once per proof (server, page); the result lines of
//                each go into the framed brief, with a note when the code changed after that proof ran
// Run it before the Test designer starts, and again after the proof run, before the reviewers:
// the second run adds the callers and the proof. Exit 0: written. 2: usage error.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readLines } from './check-ticket-lines.mjs';
import { treeId } from './red-proof.mjs';
import { refreshPlaces, checkPlaces, placeLine } from './places.mjs';

// The sizes in order, as size-check.mjs names them (kept here: that script runs as a child process).
const SIZES = ['tiny', 'small', 'medium', 'big'];

const here = path.dirname(fileURLToPath(import.meta.url));

// Each Check line's sources: "[T1, T3]", "[change]", "[rule: both languages]" or a mix, at its start — in one
// bracket or several ("[T1] [T2] …", 2026-11-09: only the first bracket was read, so steps needed a line each).
export function checkSources(line) {
  const lead = /^(?:\[[^\]]+\]\s*)+/.exec(String(line).trim());
  if (!lead) return null;
  const parts = [...lead[0].matchAll(/\[([^\]]+)\]/g)].flatMap(m => m[1].split(',')).map(p => p.trim()).filter(Boolean);
  return parts.every(p => /^T\d+$/i.test(p) || /^change$/i.test(p) || /^rule:\s*\S/i.test(p)) ? parts : null;
}

// Problems that stop the brief: a ticket line with no Check line, a Check line with no source, or a
// source that names a ticket line that does not exist.
export function coverageProblems(ticketLines, checks) {
  const problems = [];
  const covered = new Set();
  checks.forEach((c, i) => {
    const sources = checkSources(c);
    if (!sources) { problems.push(`C${i + 1} names no source ([T1], [change] or [rule: ...]): ${c}`); return; }
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
export function sizeFacts(repo, base, { script = path.join(here, 'size-check.mjs'), timeout = 60000 } = {}) {
  let out = '', failed = '';
  try { out = execFileSync(process.execPath, [script, '--repo', repo, '--base', base], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout }); }
  catch (e) {
    out = String(e.stdout || '');
    const errLines = String(e.stderr || e.message || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    failed = e.code === 'ETIMEDOUT' ? `timed out after ${Math.round(timeout / 1000)} s`
      : (errLines.find(l => /^(?:SIZE: |\w*Error\b)/.test(l)) || errLines[0] || 'exit ' + e.status).replace(/^SIZE:\s*/, '');
  }
  const line = re => (out.split(/\r?\n/).find(l => re.test(l)) || '').trim();
  const size = line(/^SIZE/);
  if (!failed && !size) failed = 'no SIZE line in its output';
  return { stack: line(/^Stack:/), size, callers: line(/^\s*callers:/).replace(/^callers:\s*/, ''), failed };
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

const ROLE = 'You are a code reviewer. Read-only: no builds, no tests, no edits. Report: `RECOMMEND: PASS|FAIL` first, then the findings, most severe first, one line each: `Blocker|Bug|Gap|Question — file:line — <input> → <wrong result> — <one-line fix>`; or "no findings" and what you checked. Then `OUTSIDE PR:` and `EXTRA TEST:` lines, if any.';
// Three standing rules. A new rule replaces one of these or becomes a script check.
const RULES = [
  '- A `Question` is only for what the ticket lines above leave open: quote the line that leaves it open. A question those lines already answer (an "Expected" line, a rule row) is not listed; check the change against that answer instead.',
  '- A test weakness on a Check line is reported as a concrete break: the change to the product code (file, what changes) that the tests would let through, and the test that should then fail. A case that no Check line covers and the ticket does not name is an `EXTRA TEST:` line (one line: the case and why it matters), not a finding: the user decides it.',
  '- A defect on a path the change neither touches, exposes nor makes reachable goes under `OUTSIDE PR:`. A problem outside the ticket that is already listed is not reported, unless this change alters or worsens it; then it is a finding.',
];

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
const PROOF_LINE = /^(?:RED-PROOF: (?:RED|NOT|PROVED|SETUP|ENVIRONMENT|TIMEOUT|REMOTE)|\s*(?:BREAK|GREEN) )/;
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
    '## Check — each line names its source ([Tn] a ticket line, [change], [rule: ...]); its tests carry the tag [Cn]', '',
    ...checks.map((c, i) => `- C${i + 1}. ${c}`), '',
    ...placesBlock(places),
    ...known(outside),
    ...(proof.length ? ['## Proof run (red-proof.mjs)', '', ...proof.map(p => '    ' + p), ''] : []),
    '## Rules', '', ...RULES, '',
    ...(isFocused(facts, size) ? focusedBlock : []),
  ]);
}

export function buildFreshBrief({ repo, branch, base, mergeBase, ticket, outside, facts, size, changed, places = null }) {
  return tidy([
    ROLE.replace('You are a code reviewer.', 'You are a code reviewer with fresh eyes: judge the change only against the ticket and the code.'), '',
    diffLine({ repo, branch, base, mergeBase }), '', facts.stack || 'Stack: unknown', '',
    ...changedBlock(changed),
    '## Ticket (verbatim)', '', ticket.trim(), '',
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

// `size`: the size used (chooseSize); big or an unknown size gets the full round.
export function buildLaunch({ brief, fresh, repo, branch, size = '', sizeNote = '' }) {
  const one = ONE_REVIEW[size];
  return [
    '# Launch lines (copy as they are)', '',
    ...(sizeNote ? [sizeNote, ''] : []),
    // The Test designer is a Big-task seat (loop-rare-cases.md, the expert panel); a tiny, small or medium change
    // listed it too, and the line looked like a step to run (2026-11-13).
    ...(one ? [] : ['## Test designer — Agent braintrust-expert-sonnet, run_in_background', '',
    `Seat: Test designer. Read your role guide first: ~/.claude/skills/braintrust/experts/test-designer.md. Use the [TEST] lines of the stack's playbooks in ~/.claude/skills/braintrust/playbooks/. Read-only. The task's brief: ${brief} — read its Ticket, Check and Rules sections. Code: ${repo}, branch ${branch}. Area: <the files and the field or endpoint — author fills>. Deliver per your guide.`, '']),
    '## Fresh eyes (Claude) — Agent independent-reviewer, run_in_background', '',
    `You are the independent reviewer — FRESH EYES whole-PR review. Read and follow only the brief at ${fresh}, including its Rules section. Do not open any other file in that folder. ${size === 'medium' ? WHOLE_DIFF_FULL + ' ' : ''}Read-only: no builds, no tests, no edits.`, '',
    ...(one ? [one, ''] : [
      '## Whole diff (Claude) — Agent routine-reviewer, run_in_background', '',
      `You are the independent reviewer — whole-diff pass. Read and follow the brief at ${brief}, including its Rules section. Do not open any other file in that folder. ${WHOLE_DIFF_FULL} Read-only: no builds, no tests, no edits.`, '',
      // No -m: Codex has no "newest" alias, so its model is named once, in ~/.codex/config.toml (2026-11-10).
      '## Fresh eyes (Codex) — Bash, run_in_background', '',
      '```bash', `cd "${repo}" && codex exec -s read-only -c model_reasoning_effort="xhigh" -C "${repo}" -o "${path.join(path.dirname(brief), 'codex-review.md')}" "You are the independent reviewer — FRESH EYES. Read and follow only the brief at ${fresh}, including its Rules section. Do not open any other file in that folder. Read-only: no builds, no tests, no edits. Your final message is the report in the shape the brief gives." < /dev/null > "${path.join(path.dirname(brief), 'codex.log')}" 2>&1`, '```', '',
    ]),
  ].join('\n');
}

function parse(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!['--out', '--ticket', '--lines', '--check', '--repo', '--base', '--outside', '--places', '--missed', '--size', '--proof-log'].includes(k) || argv[i + 1] === undefined) throw new Error('Unknown or empty option: ' + k);
    // --proof-log may come more than once: a server proof and a page proof give two logs.
    if (k === '--proof-log') (o['proof-log'] ||= []).push(argv[++i]);
    else o[k.slice(2)] = argv[++i];
  }
  for (const need of ['out', 'ticket', 'lines', 'check']) if (!o[need]) throw new Error('--' + need + ' is required');
  if (o.size && !SIZES.includes(o.size)) throw new Error('--size must be one of ' + SIZES.join(', '));
  return o;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
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
    const listFile = (flag, key) => { const f = flag || git(repo, ['config', '--get', key]); return f && fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''; };
    const tracked = git(repo, ['diff', '--name-only', '-z', mergeBase]).split('\0').filter(Boolean);
    const untracked = git(repo, ['ls-files', '-z', '--others', '--exclude-standard']).split('\0').filter(Boolean);
    const changedFiles = [...tracked.map(name => ({ name })), ...untracked.filter(n => !tracked.includes(n)).map(name => ({ name, untracked: true }))];
    const changed = changedFiles.map(f => f.name);
    const outsideText = listFile(o.outside, 'sanad.outsideList');
    const outside = { ...splitOutside(outsideItems(outsideText), changed), decided: decidedItems(outsideText) };
    const logs = (o['proof-log'] || []).filter(f => fs.existsSync(f)).map(f => ({ name: path.basename(f), text: fs.readFileSync(f, 'utf8') }));
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
    const chosen = chooseSize(facts, o.size);
    fs.writeFileSync(out, buildBrief({ repo, branch, base, mergeBase, ticket, ticketLines, checks, outside, facts, size: o.size, proof, changed: changedFiles, places }));
    fs.writeFileSync(fresh, buildFreshBrief({ repo, branch, base, mergeBase, ticket, outside, facts, size: o.size, changed: changedFiles, places }));
    fs.writeFileSync(launch, buildLaunch({ brief: out.replace(/\\/g, '/'), fresh: fresh.replace(/\\/g, '/'), repo, branch, size: chosen.size, sizeNote: chosen.note }));
    process.stdout.write((chosen.note ? chosen.note + '\n' : '') + (facts.failed ? `SIZE CHECK FAILED: ${facts.failed}\n` : '') +
      `BRIEF: ${out} · ${checks.length} check line(s) C1..C${checks.length} · ${outside.other.length + outside.touched.length} known item(s), ${outside.touched.length} in touched files, ${outside.decided.length} decided · callers: ${facts.failed ? 'SIZE CHECK FAILED' : facts.callers ? 'yes' : 'none yet'} · proof: ${proof.length ? 'yes' : 'none yet'} · ${changedFiles.length} changed file(s), ${changedFiles.length - tracked.length} new untracked · places: ${placesState ? `${placesState.count}, ${placesState.open.length} open` : 'none (text-only change)'}\n` +
      `FRESH: ${fresh}\nLAUNCH: ${launch}\n`);
  } catch (error) {
    process.stderr.write('REVIEW-BRIEF: ' + error.message + '\nUsage: node review-brief.mjs --out <brief.md> --ticket <file> --lines <file> --check <file> [--repo <path>] [--base <ref>] [--outside <file>] [--places <file>] [--size <size>] [--proof-log <file>]\n');
    process.exitCode = 2;
  }
}
