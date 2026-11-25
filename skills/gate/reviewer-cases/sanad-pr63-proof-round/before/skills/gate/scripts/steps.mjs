#!/usr/bin/env node
// steps.mjs — the one table of the loop's steps: id, the loop.md step it belongs to, the sizes that have
// it, its done test and its commands.
//
// 2026-11-19: SKILL.md, loop.md and execution.md gave three orders for the same steps, and the path lists
// of a task were typed three times a round. This table is the order sanad.mjs prints. It holds no rule
// sentence: the rules stay in loop.md.
//
// Every done test here reads a `facts` object that sanad.mjs fills from saved files and records. No done
// test reads a flag, and nothing in this file touches the disk or starts a process, so the table can be
// tested as plain data.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LANES = ['text', 'small', 'medium', 'big'];
// Today's loop.md stop rule. `git config sanad.stopRound <n>` changes it; task.json never does.
export const DEFAULT_STOP_ROUND = 3;
// Review rounds never stop before round 2 (owner switch rule): a 1 or a 0 is not a valid stop round.
export const MIN_STOP_ROUND = 2;
export const GATE_DIR = path.dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/');
const CHECKLIST = path.resolve(GATE_DIR, '..', '..', 'sanad', 'reference', 'review-checklist.md').replace(/\\/g, '/');

/** One shell word for Git Bash: a space, a dollar sign, a backtick or Arabic letters stay as they are. */
export function q(value) {
  const s = String(value);
  return /^[A-Za-z0-9_\/.:=,@%+~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
const p = (value) => q(String(value).replace(/\\/g, '/'));
const tool = (c, name) => `node ${p(`${c.gate || GATE_DIR}/${name}`)}`;
const note = (c, name) => p(`${c.notes}/${name}`);
const ALL = LANES;
const CODE = ['small', 'medium', 'big'];

/** The stop round: the owner's number when it is a whole number of 2 or more, else today's 3. */
export function stopRound(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= MIN_STOP_ROUND ? n : DEFAULT_STOP_ROUND;
}

// 2026-11-22 (attack): "author" (authors, authored, authoring, authorship) and "accessible" are no security words;
// every other auth… word is (AuthMiddleware, authorize, authentication), and so are access, JWT and session tokens.
const SECURITY = /\b(?:security|auth(?!or(?:s|ed|ing|ship)?\b)\w*|access(?:es|ed)?|permissions?|privileg\w*|roles?|tenants?|inject\w*|xss|csrf|idor|jwts?|secrets?|tokens?|passwords?)\b/i;
// A note on a ticket line: its [Tn] tag, or the words that name one.
const TICKET_LINE = /\[T\d+\]|\bticket line\b|\bT\d+\b(?=[\s:,.)])/i;
/**
 * The notes that go to the owner in one list from the stop round on: every open note of this round except a Blocker,
 * a security note and a note on a ticket line, which still reopen a round. They stay open: only the owner's words
 * close them. (2026-11-22, owner: with the stop round at 2, a re-run still ran 4 rounds, because every note that was
 * not rare opened another one.)
 */
export function askOwner(notes, round, stop = DEFAULT_STOP_ROUND) {
  if (!(round >= stop)) return [];
  return (notes || []).filter((n) => n && n.open !== false && (n.round ?? round) === round && !reopensRound(n));
}

/** A note that still opens a review round past the stop round: a Blocker, a security note or a ticket-line note. */
export function reopensRound(n) {
  if (!n) return false;
  const text = String(n.text || '');
  return /^blocker$/i.test(String(n.kind || '')) || Boolean(n.security) || SECURITY.test(text) || Boolean(n.ticketLine) || TICKET_LINE.test(text);
}

// A side's proof line. `since` makes it the fix round's short form (PARTIAL).
function proofLine(c, side, since) {
  const files = side.fixFiles && side.fixFiles.length ? side.fixFiles.join(',') : 'FIX-FILES';
  const cwd = side.cwd ? ` --cwd ${p(side.cwd)}` : '';
  const scope = since ? ` --changed-since ${q(since)}` : '';
  return `${tool(c, 'red-proof.mjs')} --repo ${p(c.repo)} --old ${q(c.base)} --files ${q(files)} --breaks ${note(c, 'breaks.json')}${scope} --then-green --log ${note(c, `proof-${side.name}.log`)}${cwd} -- ${side.test}`;
}
// The owner's tests-only path: the switch is on and the change is tests only. It has no breaks and no proof step.
const lightLane = (f) => Boolean(f.testsOnly && f.switches && f.switches.testsOnlyLane);
const sidesOf =(c) => (c.sides && c.sides.length ? c.sides : [{ name: 'tests', cwd: '', test: 'TEST-COMMAND', fixFiles: [] }]);
const listFlags = (c) => `--lines ${note(c, 'lines.md')} --check ${note(c, 'check.md')} --places ${note(c, 'places.md')} --siblings ${note(c, 'siblings.md')}`;
const preReview = (c, extra = '') => `${tool(c, 'pre-review.mjs')}${extra} --was ${q(c.size || 'SIZE')} ${listFlags(c)}`;
// A text-path change that adds or changes a test file has the proof steps too (f.textProof). The brief tool
// rejects a --proof-log file that is not there: the text path and the tests-only lane have no proof log.
const noProofStep = (f) => lightLane(f) || (f.lane === 'text' && !f.textProof);
// 2026-11-20 (timed task: a page proof and a server proof made two logs, the printed command named one): every proof
// log of the notes folder (proof*.log) that exists, one quoted --proof-log each (a folder name may hold a comma).
// Fix round: with no log on disk the option is left out, never a name of a file that is not there.
const proofLogs = (f) => (Array.isArray(f.proofLogs) ? f.proofLogs : []).map((l) => ' --proof-log ' + p(l)).join('');
const brief = (c, f, extra) => `${tool(c, 'review-brief.mjs')} ${extra} --out ${note(c, 'brief.md')} --ticket ${note(c, 'ticket.md')} --lines ${note(c, 'lines.md')} --check ${note(c, 'check.md')} --places ${note(c, 'places.md')}${(c.lane === 'text' && !f.textProof) || lightLane(f) ? '' : proofLogs(f)} --engine ${q(c.engine || 'claude')} --size ${q(c.size || 'SIZE')}`;
const suiteLines = (c, f) => (f.suite.ci
  ? [{ text: `left to CI: ${f.suite.ci}`, plain: true }]
  : [{ text: `the full suite, once, through the evidence helper, on this tree: ${f.git.tree ? f.git.tree.slice(0, 10) : 'commit first'}`, plain: true }]);

// True when the ticket text file exists and holds no ticket ID (a word like ABC-123): the task has no ticket.
const noTicketText = (file) => {
  try { return !/\b[A-Z][A-Z0-9]+-\d+\b/.test(fs.readFileSync(file, 'utf8')); } catch { return false; }
};

// `unknown` marks a step that no saved record can show as done (a chat line, a list that could not be read).
// A line is { text, background?, plain? }. `background` is for the host's own background run; `plain`
// is a line to read or to do, not a command. The driver starts none of them.
export const STEPS = [
  { id: 'start', loop: 'Step 1, items 1-2', lanes: ALL,
    done: (f) => f.has.lines,
    lines: (c, f) => [
      { text: `${tool(c, 'lines.mjs')} --from ${p(c.ticket || `${c.notes}/ticket-text.md`)} --out ${note(c, 'lines.md')}${noTicketText(c.ticket || `${c.notes}/ticket-text.md`) ? ` --no-ticket --repo ${p(c.repo)}` : ''}` },
      ...(f.switches.remoteHost ? [{ text: 'bash ~/.claude/scripts/remote/remote-preflight.sh --connect', background: true }] : []),
      ...(f.switches.remoteHost && sidesOf(c).some((s) => s.server) ? [{ text: 'bash ~/.claude/scripts/remote/remote-preflight.sh --db', background: true }] : []),
      ...(f.switches.remoteHost ? sidesOf(c).filter((s) => s.server).map((s) => ({ text: `${tool(c, 'red-proof.mjs')} --repo ${p(c.repo)} --warm${s.cwd ? ` --cwd ${p(s.cwd)}` : ''} -- ${s.test}`, background: true })) : []),
    ] },
  { id: 'places', loop: 'Step 1, item 4', lanes: CODE, light: true,
    done: (f) => f.has.places,
    lines: (c) => [{ text: `${tool(c, 'places.mjs')} --repo ${p(c.repo)} --names NAMES --out ${note(c, 'places.md')}` }] },
  { id: 'check-lines', loop: 'Step 1, item 5', lanes: CODE, beside: 'second-look',
    done: (f) => f.has.check,
    lines: (c) => [{ text: `${tool(c, 'lines.mjs')} --seed-check --notes ${p(c.notes)}` }] },
  { id: 'second-look', loop: 'Step 1, item 6', lanes: CODE, light: true, beside: 'check-lines',
    // Due with the check lines unless the owner set sanad.lateCheckLines false: then only once check.md exists.
    when: (f) => f.has.check || f.switches.lateCheckLines !== false,
    done: (f) => f.has.siblings,
    lines: (c) => [
      { text: `${tool(c, 'siblings.mjs')} --brief --notes ${p(c.notes)} --repo ${p(c.repo)}` },
      { text: 'launch the LAUNCH line it prints, save the answer as siblings-report.md', plain: true },
      { text: `${tool(c, 'siblings.mjs')} --record ${note(c, 'siblings-report.md')} --notes ${p(c.notes)}` },
    ] },
  { id: 'places-closed', loop: 'Step 1, item 7', lanes: CODE, light: true,
    done: (f) => f.has.places && f.open.places === 0 && f.open.siblings === 0,
    lines: (c, f) => [
      { text: `open: ${f.open.places} place(s), ${f.open.siblings} second-look line(s)`, plain: true },
      { text: `${tool(c, 'places.mjs')} --close ${note(c, 'places.md')} --set OUTCOMES` },
    ] },
  { id: 'size', loop: 'Step 1, item 8', lanes: ALL,
    done: (f) => f.has.size,
    lines: (c) => [
      { text: `${tool(c, 'size-check.mjs')} --repo ${p(c.repo)} --files PLANNED-FILES --names NAMES` },
      { text: 'the size line; Medium and Big: the PR plan, then wait for the OK', plain: true },
    ] },
  { id: 'design-choice', loop: 'Step 2', lanes: ['big'], when: (f) => f.switches.designChoice,
    done: (f) => f.decisions.some((d) => d.kind === 'design' && String(d.words || '').trim()),
    lines: (c) => [
      { text: 'ASK: the two designs in six lines (lines of code, new tables, rough hours); the owner picks one', plain: true },
      { text: `${tool(c, 'notes.mjs')} decide --kind design --words OWNER-WORDS --notes ${p(c.notes)}` },
    ] },
  { id: 'tests-fix', loop: 'Step 3, items 1-2', lanes: ALL,
    done: (f) => f.git.ahead > 0 || f.git.changed,
    lines: () => [{ text: 'write the tests, then the fix of the rule in every place that shares it: each place on the list and any other with that rule or data', plain: true }] },
  { id: 'new-tests-once', loop: 'Step 3, item 2', lanes: CODE, beside: 'commit',
    done: (f) => f.git.ahead > 0 && f.git.clean,
    lines: (c) => [
      ...sidesOf(c).map((s) => ({ text: `${s.cwd ? `cd ${p(s.cwd)} && ` : ''}${s.test}` })),
      { text: 'suggestion, not measured: run the new tests once on the fixed code before the commit', plain: true },
    ] },
  { id: 'commit', loop: 'Step 3, item 3', lanes: ALL,
    done: (f) => f.git.ahead > 0 && f.git.clean,
    lines: (c) => [{ text: `git -C ${p(c.repo)} status --short   (then stage the named files and commit)`, plain: true }] },
  // 2026-11-22 (owner, PR 3 item 1): the author reads its own diff first, before the checks, the proof and the review.
  // Never skipped; the record is for the commit read, so a later commit makes the step due again.
  { id: 'self-read', loop: 'Step 3, item 3', lanes: ALL,
    done: (f) => f.git.clean && f.git.ahead > 0 && Boolean(f.selfRead) && f.selfRead === f.git.head,
    lines: (c) => [
      { text: `git -C ${p(c.repo)} diff ${q(c.base || 'BASE')}...HEAD` },
      { text: `read it as a hostile reviewer against the "Every change" lines of ${p(CHECKLIST)}; fix what you find (test first) and commit`, plain: true },
      { text: `${tool(c, 'sanad.mjs')} self-read --repo ${p(c.repo)} --notes ${p(c.notes)} --found FOUND   (FOUND: what you found and fixed, or none)` },
    ] },
  { id: 'checks-before-proof', loop: 'Step 3, item 3', lanes: ALL, beside: 'breaks', unknown: (f) => f.checks.code === undefined,
    done: (f) => f.checks.code === true || f.proof.done || f.pinAtHead,
    lines: (c) => [{ text: preReview(c, ' --before-proof --part code'), background: true }] },
  { id: 'breaks', loop: 'Step 3, item 4', lanes: CODE, light: true,
    done: (f) => f.has.breaks,
    lines: (c) => [
      { text: `${tool(c, 'breaks.mjs')} seed --breaks ${note(c, 'breaks.json')} --repo ${p(c.repo)} --base ${q(c.base)}` },
      { text: `${tool(c, 'breaks.mjs')} add --breaks ${note(c, 'breaks.json')} --repo ${p(c.repo)} --file FILE --line N --put-file REPLACEMENT-FILE --must-fail WORDS` },
    ] },
  { id: 'proof', loop: 'Step 3, item 5', lanes: CODE, light: true,
    done: (f) => f.proof.done,
    lines: (c) => sidesOf(c).map((s) => ({ text: proofLine(c, s) })) },
  { id: 'review', loop: 'Step 3.5, items 1-3', lanes: ALL, early: true,
    done: (f) => f.pinAtHead,
    lines: (c, f) => [
      { text: preReview(c) },
      { text: brief(c, f, '--pin') },
      { text: `launch every line of ${note(c, 'launch.md')} in one message`, plain: true },
      ...(f.lane === 'small' ? [{ text: "suggestion, not measured: start the gate's focused evidence runs while the one reviewer reads", plain: true }] : []),
    ] },
  { id: 'notes', loop: 'Step 3.5, item 4', lanes: ALL, unknown: (f) => !f.notes.known,
    done: (f) => f.notes.known && f.notes.open.length === 0,
    lines: (c, f) => [
      { text: `${tool(c, 'notes.mjs')} list --open --repo ${p(c.repo)}` },
      { text: `${tool(c, 'notes.mjs')} ask --repo ${p(c.repo)}` },
      { text: 'the note check on the open notes (loop-rare-cases.md), then one fix batch, test first', plain: true },
      ...ownerList(f),
    ] },
  { id: 'fix-round', loop: 'Step 3.5, item 6', lanes: ALL,
    // Due when the last pinned commit is not HEAD: a fix was made after the reviewers read.
    when: (f) => f.pins.length > 0 && !f.pinAtHead,
    done: () => false,
    lines: (c, f) => [
      ...(f.git.clean ? [] : [{ text: `git -C ${p(c.repo)} status --short   (commit the fix batch first)`, plain: true }]),
      { text: preReview(c, ' --before-proof'), background: true },
      ...(lightLane(f) ? [] : sidesOf(c).map((s) => ({ text: proofLine(c, s, f.lastPin.ref || f.lastPin.commit) + '   (PARTIAL)' }))),
      { text: brief(c, f, '--recheck') },
      ...(f.last ? [...(lightLane(f) ? [] : sidesOf(c).map((s) => ({ text: proofLine(c, s) + '   (the last round: the full proof)' }))), ...suiteLines(c, f)] : []),
      ...ownerList(f),
    ] },
  { id: 'last-round', loop: 'Step 3.5, item 6', lanes: ALL,
    // After a re-check with no open note: the full proof, the suite once, the full checks.
    when: (f) => f.pinAtHead && f.lastPin.kind === 'recheck',
    done: (f) => (noProofStep(f) || f.proof.done) && f.suite.done && f.checks.all !== false,
    lines: (c, f) => [
      ...(noProofStep(f) || f.proof.done ? [] : sidesOf(c).map((s) => ({ text: proofLine(c, s) }))),
      ...(f.suite.done ? [] : suiteLines(c, f)),
      { text: preReview(c) },
    ] },
  { id: 'verdict', loop: 'Step 3.5, item 7', lanes: ALL, unknown: () => true,
    done: (f) => f.pushed === true,
    lines: (c) => [{ text: `${tool(c, 'notes.mjs')} verdict --review --repo ${p(c.repo)}` }] },
  { id: 'gate', loop: 'Step 4', lanes: ALL, unknown: (f) => Boolean(f.suite.ci),
    done: (f) => Boolean(f.suite.receipt) || f.pushed === true,
    lines: (c, f) => [{ text: '/gate   (the Definition of Done and the security list, each claim with its output)', plain: true }, ...suiteLines(c, f), { text: `${tool(c, 'notes.mjs')} verdict --gate --repo ${p(c.repo)} --notes ${p(c.notes)} --tests <passed>/<run> --build "<real result>" --attack "<real result>" --security "<real result>" --ran "<real result>"` }, { text: 'Each flag carries the real result of that check; without them the line is GATE: INCOMPLETE.', plain: true }] },
  { id: 'ready', loop: 'Step 5', lanes: ALL,
    done: (f) => f.pushed === true,
    lines: (c) => [
      { text: `${tool(c, 'sanad.mjs')} ready --repo ${p(c.repo)}` },
      { text: `${tool(c, 'sanad.mjs')} pr-body --repo ${p(c.repo)}` },
      { text: `${tool(c, 'check-pr-body.mjs')} ${note(c, 'pr-body.md')} --notes ${p(c.notes)}` },
    ] },
  { id: 'after-push', loop: 'Step 5', lanes: ALL, when: (f) => f.pushed === true,
    done: () => false,
    lines: (c) => [
      { text: `${tool(c, 'pr-watch.mjs')} --repo ${p(c.repo)}`, background: true },
      { text: `${tool(c, 'review-brief.mjs')} --drop-pins --notes ${p(c.notes)}` },
      { text: `${tool(c, 'review-score.mjs')} --log` },
      { text: `${tool(c, 'guard-score.mjs')}` },
      { text: `${tool(c, 'sanad-timer.mjs')} report ${p(c.notes)}   (its totals go in the task-metrics line)` },
      { text: `${tool(c, 'sanad.mjs')} owed --repo ${p(c.repo)}` },
    ] },
];

function ownerList(f) {
  const ask = askOwner(f.notes.open, f.round, f.stop);
  if (!ask.length) return [];
  return [{ text: `ASK THE OWNER (round ${f.round}, stop round ${f.stop}): fix now, or a known limit in the PR text`, plain: true },
    ...ask.map((n) => ({ text: `  NOTE ${n.n}: ${String(n.text || '').slice(0, 160)}`, plain: true }))];
}

/** One line per owner switch that is on, with where it came from. f.switchHits is read by sanad.mjs. */
export function switchLines(f) {
  const out = [];
  for (const h of f.switchHits || []) {
    const v = String(h.value || '').trim();
    const where = `${h.scope || 'unknown scope'}; origin: ${h.origin || 'unknown'}`;
    if (h.key === 'stopRound') {
      if (v && stopRound(v) === DEFAULT_STOP_ROUND && Number(v) !== DEFAULT_STOP_ROUND) out.push(`Owner switch invalid: sanad.stopRound = ${v} (${where}) — use a whole number of 2 or more; the stop round stays ${DEFAULT_STOP_ROUND}`);
      else if (v && Number(v) !== DEFAULT_STOP_ROUND) out.push(`Owner switch on: sanad.stopRound = ${v} (${where}) — review rounds stop after round ${v}`);
    } else if (h.key === 'ticketRequired') { if (/^false$/i.test(v)) out.push(`Owner switch on: sanad.ticketRequired = ${v} (${where}) — a commit subject needs no ticket ID`); }
    else if (/^(?:true|yes|on|1)$/i.test(v)) out.push(`Owner switch on: sanad.${h.key} = ${v} (${where})`);
  }
  return out;
}

/** The steps of one size, in order. A tests-only change on the light path has no places list and no second look. */
export function pathFor(lane, { testsOnlyLight = false, designChoice = false, textProof = false } = {}) {
  if (!LANES.includes(lane)) throw new Error(`unknown size "${lane}": one of ${LANES.join(', ')}`);
  return STEPS.filter((s) => (s.lanes.includes(lane) || (textProof && lane === 'text' && (s.id === 'breaks' || s.id === 'proof'))) && !(testsOnlyLight && s.light) && (s.id !== 'design-choice' || designChoice));
}

/**
 * The steps that are due now: the first step of the path that is not done, and the steps that may run
 * beside it. A fix after the last review is the fix round, whatever else is open.
 */
export function due(f) {
  const steps = pathFor(f.lane, { testsOnlyLight: lightLane(f), designChoice: f.switches.designChoice, textProof: Boolean(f.textProof) && !lightLane(f) });
  const active = (s) => !s.when || s.when(f);
  const fix = steps.find((s) => s.id === 'fix-round');
  if (fix && active(fix)) {
    // 2026-11-22 (attack): a fix committed after a review is read by its author too, before the re-check.
    const read = steps.find((s) => s.id === 'self-read');
    return read && f.git.clean && !read.done(f) ? [read] : [fix];
  }
  let open = steps.filter((s) => active(s) && !s.done(f));
  const out = [];
  if (f.pins.length) {
    // The reviewers read this commit: the steps before the review are over. Only a proof that still runs
    // beside a full review is printed with the notes; after a re-check the last round prints the proof.
    const from = steps.findIndex((s) => s.id === 'notes');
    const proof = open.find((s) => s.id === 'proof');
    if (proof && f.lastPin.kind !== 'recheck') out.push(proof);
    open = open.filter((s) => steps.indexOf(s) >= from);
  }
  if (!open.length) return out;
  const first = open[0];
  out.push(first);
  // A step that names the first one as its partner runs beside it, and the other way round.
  for (const s of open.slice(1)) if (s.beside === first.id || first.beside === s.id) out.push(s);
  // A step with no record of its own is printed until a later record exists, with the next step beside it.
  for (let i = open.indexOf(out[out.length - 1]); out[out.length - 1].unknown && out[out.length - 1].unknown(f) && i + 1 < open.length; i++) out.push(open[i + 1]);
  // The review starts when the passing run and the old-code run are in the proof log, while the breaks finish
  // (2026-11-22: the default; the switch sanad.reviewEarly is gone). The proof is often printed beside a step with no
  // record of its own (the cheap checks), so it need not be the first one printed.
  if (out.some((s) => s.id === 'proof') && f.proof.early && f.git.clean) {
    const review = steps.find((s) => s.id === 'review');
    if (review && !review.done(f) && !out.includes(review)) out.push(review);
  }
  return out;
}

/** The printed form of the due steps. */
export function render(steps, c, f) {
  const out = [];
  for (const s of steps) {
    out.push(`STEP ${s.id} — loop.md ${s.loop}`);
    for (const l of s.lines(c, f)) out.push(l.plain ? `  ${l.text}` : `  ${l.background ? 'BACKGROUND ' : ''}$ ${l.text}`);
  }
  return out;
}
