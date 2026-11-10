#!/usr/bin/env node
// review-brief.mjs — the task's briefs, from a fixed template, so nothing is copied by hand.
//
//   <out>          the framed brief: the Test designer and the whole-diff reviewer read it (ticket,
//                  numbered Check lines, callers, known items, the proof run's result, the rules).
//   <out>-fresh.md the unframed brief for the fresh-eyes reviewers (Claude and Codex): the ticket,
//                  the pinned diff, the project's missed-bug classes, the known items and the rules,
//                  and nothing the author wrote (no Check lines, no callers, no proof result).
//   launch.md      the exact launch lines for the designer and the three reviewers, next to <out>.
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
// Usage: node review-brief.mjs --out <brief.md> --ticket <file> --lines <file> --check <file>
//          [--repo <path>] [--base <ref>] [--outside <file>] [--missed <file>] [--size <size>] [--proof-log <file>]
//   --ticket     the ticket and QA text, verbatim
//   --lines      every requirement line of the ticket, one per line (the check-ticket-lines file)
//   --check      what must hold, one line each, each starting with its source tag; numbered C1..Cn
//                here, and each needs a test tagged [Cn]
//   --outside    the project's outside list (default: `git config sanad.outsideList`)
//   --missed     the project's missed-bugs list (default: `git config sanad.missedBugs`)
//   --size       tiny or small adds the focused budget (default: the size check's answer)
//   --proof-log  a red-proof.mjs output; its RED/BREAK/GREEN lines go into the framed brief
// Run it before the Test designer starts, and again after the proof run, before the reviewers:
// the second run adds the callers and the proof. Exit 0: written. 2: usage error.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readLines } from './check-ticket-lines.mjs';

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

// The open items of a project's outside list: "- date · what happens · where · status".
export function outsideItems(text) {
  return String(text).split(/\r?\n/).filter(l => /^\s*[-*]\s+/.test(l) && !/\bCLOSED\b/.test(l)).map(l => {
    const parts = l.replace(/^\s*[-*]\s+/, '').split(' · ').map(p => p.trim());
    return parts.length >= 3 ? { what: parts[1], where: parts[2] } : { what: parts.join(' · '), where: '' };
  });
}

// The questions the user already decided (CLOSED lines), so no reviewer asks them again (2026-11-07:
// a reviewer re-asked a QA question the user had closed the day before; the brief had dropped it).
export function decidedItems(text) {
  return String(text).split(/\r?\n/).filter(l => /^\s*[-*]\s+/.test(l) && /\bCLOSED\b/.test(l))
    .map(l => l.replace(/^\s*[-*]\s+/, '').split(' · ').slice(1).join(' · ').trim()).filter(Boolean);
}

// Items whose place names a file this change touches: this change may alter or worsen them.
export function splitOutside(items, changedFiles) {
  const names = changedFiles.map(f => path.basename(f)).filter(Boolean);
  const touched = [], other = [];
  for (const item of items) (names.some(n => item.where.includes(n)) ? touched : other).push(item);
  return { touched, other };
}

export function checkLines(text) {
  return String(text).split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => l.replace(/^(?:[-*•]|\d+[.)])\s+/, '').replace(/^C\d+\.\s+/, ''));
}

// "CLASS: x · ... · CATCH: y" from each missed-bug line, short.
export function missedClasses(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const cls = /CLASS:\s*([^·]+)/.exec(line), catcher = /CATCH:\s*([^·]+)/.exec(line);
    if (!cls) continue;
    const item = (cls[1].trim() + (catcher ? ' — catch: ' + catcher[1].trim() : '')).slice(0, 180);
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

// The size check's lines that the brief carries: stack, size and callers.
function sizeFacts(repo, base) {
  let out = '';
  try { out = execFileSync(process.execPath, [path.join(here, 'size-check.mjs'), '--repo', repo, '--base', base], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 }); }
  catch (e) { out = String(e.stdout || ''); }
  const line = re => (out.split(/\r?\n/).find(l => re.test(l)) || '').trim();
  return { stack: line(/^Stack:/), size: line(/^SIZE/), callers: line(/^\s*callers:/).replace(/^callers:\s*/, '') };
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
function known({ touched, other, decided = [] }) {
  const fmt = o => `- ${o.what}${o.where ? ` (${o.where})` : ''}`;
  return [
    '## Problems outside the ticket — known, do not report again', '', ...(other.length ? other.map(fmt) : ['- none']), '',
    ...(touched.length ? ['## Problems outside the ticket in the files this change touches — report only if this change alters or worsens them', '', ...touched.map(fmt), ''] : []),
    ...(decided.length ? ['## Decided by the user — do not ask again', '', ...decided.map(d => '- ' + d), ''] : []),
  ];
}
const focusedBlock = ['## Focused brief (small change)', '',
  'Trace the changed hunks, each caller and each Check line; do not re-derive the whole screen or file. About 15 tool calls and 2 minutes; stop once every line is traced.'];
const isFocused = (facts, size) => /^(?:tiny|small)$/.test(size || (/^SIZE(?: GREW)?:\s*(\w+)/.exec(facts.size) || [])[1] || '');
const tidy = lines => lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n') + '\n';

export function buildBrief({ repo, branch, base, mergeBase, ticket, ticketLines = [], checks, outside, facts, size, proof = [] }) {
  return tidy([
    ROLE, '', diffLine({ repo, branch, base, mergeBase }), '',
    facts.stack || 'Stack: unknown', facts.size || '', `Callers: ${facts.callers || 'none yet (no change yet)'}`, '',
    '## Ticket (verbatim)', '', ticket.trim(), '',
    ...(ticketLines.length ? ['## Ticket lines — every one has a Check line', '', ...ticketLines.map((t, i) => `- T${i + 1}. ${t}`), ''] : []),
    '## Check — each line names its source ([Tn] a ticket line, [change], [rule: ...]); its tests carry the tag [Cn]', '',
    ...checks.map((c, i) => `- C${i + 1}. ${c}`), '',
    ...known(outside),
    ...(proof.length ? ['## Proof run (red-proof.mjs)', '', ...proof.map(p => '    ' + p), ''] : []),
    '## Rules', '', ...RULES, '',
    ...(isFocused(facts, size) ? focusedBlock : []),
  ]);
}

export function buildFreshBrief({ repo, branch, base, mergeBase, ticket, outside, missed, facts, size }) {
  return tidy([
    ROLE.replace('You are a code reviewer.', 'You are a code reviewer with fresh eyes: judge the change only against the ticket and the code.'), '',
    diffLine({ repo, branch, base, mergeBase }), '', facts.stack || 'Stack: unknown', '',
    '## Ticket (verbatim)', '', ticket.trim(), '',
    ...(missed.length ? ['## Bug classes this project missed before — check the change for each', '', ...missed.map(m => '- ' + m), ''] : []),
    ...known(outside),
    '## Rules', '', ...RULES, '',
    ...(isFocused(facts, size) ? focusedBlock.map(l => l.replace(', each caller and each Check line', ' and every place that uses the changed code')) : []),
  ]);
}

// On a tiny or small change the whole-diff reviewer gets one narrow job (2026-11-07: with all ten
// Check lines, a checklist and caller searches it was the slowest reviewer every round).
const WHOLE_DIFF_SMALL = 'For this small change do only this: check each Check line against its tagged test and the code, and both locales of every changed text. No coverage checklist and no caller search; the fresh-eyes reviewers cover those.';
const WHOLE_DIFF_FULL = 'Fill the coverage checklist lines that apply (CLIENT STATE, NEW BLOCKS, FAILURES / LOCALES, USERS FOUND BY SEARCH, TESTS CAN FAIL).';

export function buildLaunch({ brief, fresh, repo, branch, focused = false }) {
  return [
    '# Launch lines (copy as they are)', '',
    '## Test designer — Agent braintrust-expert-sonnet, run_in_background', '',
    `Seat: Test designer. Read your role guide first: ~/.claude/skills/braintrust/experts/test-designer.md. Use the [TEST] lines of the stack's playbooks in ~/.claude/skills/braintrust/playbooks/. Read-only. The task's brief: ${brief} — read its Ticket, Check and Rules sections. Code: ${repo}, branch ${branch}. Area: <the files and the field or endpoint — author fills>. Deliver per your guide.`, '',
    '## Fresh eyes (Claude) — Agent independent-reviewer, run_in_background', '',
    `You are the independent reviewer — FRESH EYES whole-PR review. Read and follow only the brief at ${fresh}, including its Rules section. Do not open any other file in that folder. Read-only: no builds, no tests, no edits.`, '',
    '## Whole diff (Claude) — Agent routine-reviewer, run_in_background', '',
    `You are the independent reviewer — whole-diff pass. Read and follow the brief at ${brief}, including its Rules section. Do not open any other file in that folder. ${focused ? WHOLE_DIFF_SMALL : WHOLE_DIFF_FULL} Read-only: no builds, no tests, no edits.`, '',
    // No -m: Codex has no "newest" alias, so its model is named once, in ~/.codex/config.toml (2026-11-10).
    '## Fresh eyes (Codex) — Bash, run_in_background', '',
    '```bash', `cd "${repo}" && codex exec -s read-only -c model_reasoning_effort="xhigh" -C "${repo}" -o "${path.join(path.dirname(brief), 'codex-review.md')}" "You are the independent reviewer — FRESH EYES. Read and follow only the brief at ${fresh}, including its Rules section. Do not open any other file in that folder. Read-only: no builds, no tests, no edits. Your final message is the report in the shape the brief gives." < /dev/null > "${path.join(path.dirname(brief), 'codex.log')}" 2>&1`, '```', '',
  ].join('\n');
}

function parse(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!['--out', '--ticket', '--lines', '--check', '--repo', '--base', '--outside', '--missed', '--size', '--proof-log'].includes(k) || argv[i + 1] === undefined) throw new Error('Unknown or empty option: ' + k);
    o[k.slice(2)] = argv[++i];
  }
  for (const need of ['out', 'ticket', 'lines', 'check']) if (!o[need]) throw new Error('--' + need + ' is required');
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
    const changed = [...git(repo, ['diff', '--name-only', mergeBase]).split(/\r?\n/), ...git(repo, ['ls-files', '--others', '--exclude-standard']).split(/\r?\n/)].filter(Boolean);
    const outsideText = listFile(o.outside, 'sanad.outsideList');
    const outside = { ...splitOutside(outsideItems(outsideText), changed), decided: decidedItems(outsideText) };
    const missed = missedClasses(listFile(o.missed, 'sanad.missedBugs'));
    const proof = o['proof-log'] && fs.existsSync(o['proof-log'])
      ? fs.readFileSync(o['proof-log'], 'utf8').split(/\r?\n/).filter(l => /^(?:RED-PROOF: (?:RED|NOT|PROVED|SETUP)|\s+(?:BREAK|GREEN) )/.test(l)).map(l => l.trim()) : [];
    const facts = sizeFacts(repo, base);
    const branch = git(repo, ['branch', '--show-current']) || '(detached)';
    const ticket = fs.readFileSync(o.ticket, 'utf8');
    const out = path.resolve(o.out), fresh = out.replace(/(\.md)?$/, '-fresh.md'), launch = path.join(path.dirname(out), 'launch.md');
    fs.writeFileSync(out, buildBrief({ repo, branch, base, mergeBase, ticket, ticketLines, checks, outside, facts, size: o.size, proof }));
    fs.writeFileSync(fresh, buildFreshBrief({ repo, branch, base, mergeBase, ticket, outside, missed, facts, size: o.size }));
    fs.writeFileSync(launch, buildLaunch({ brief: out.replace(/\\/g, '/'), fresh: fresh.replace(/\\/g, '/'), repo, branch, focused: isFocused(facts, o.size) }));
    process.stdout.write(`BRIEF: ${out} · ${checks.length} check line(s) C1..C${checks.length} · ${outside.other.length + outside.touched.length} known item(s), ${outside.touched.length} in touched files, ${outside.decided.length} decided · callers: ${facts.callers ? 'yes' : 'none yet'} · proof: ${proof.length ? 'yes' : 'none yet'}\n` +
      `FRESH: ${fresh} · ${missed.length} missed-bug class(es)\nLAUNCH: ${launch}\n`);
  } catch (error) {
    process.stderr.write('REVIEW-BRIEF: ' + error.message + '\nUsage: node review-brief.mjs --out <brief.md> --ticket <file> --lines <file> --check <file> [--repo <path>] [--base <ref>] [--outside <file>] [--missed <file>] [--size <size>] [--proof-log <file>]\n');
    process.exitCode = 2;
  }
}
