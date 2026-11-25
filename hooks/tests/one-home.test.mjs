// One home per rule. A rule written in two files drifts: three files gave three orders for the proof, the
// checks and the review, and the reviewer files held three copies of the checklist with 27, 24 and 20 items.
// This file keeps three promises:
//   1. a key sentence lives in its one home file and in no second rule file;
//   2. the step headings of loop.md are the steps of the printed steps table (steps.mjs), in the same order;
//   3. every tool option loop.md names is an option of that tool.
// It finds copies, not gaps: a rule that was dropped without a word is for the reviewer who reads the loop.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const staged = path.resolve(here, '../../..');
const candidate = fs.existsSync(path.join(staged, 'claude/skills/sanad/SKILL.md'));
const claudeRoot = candidate ? path.join(staged, 'claude') : path.join(os.homedir(), '.claude');
const codexRoot = candidate ? path.join(staged, 'codex') : path.join(os.homedir(), '.codex');
const LOOP = 'claude/skills/sanad/reference/loop.md';
const CHECKLIST = 'claude/skills/sanad/reference/review-checklist.md';

// The rule files, by one logical name each ("claude/..." or "codex/..."), whatever folder they are read from.
function ruleFiles() {
  const files = new Map();
  const add = (name, file) => { if (fs.existsSync(file)) files.set(name, fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')); };
  add('claude/CLAUDE.md', path.join(claudeRoot, 'CLAUDE.md'));
  add('codex/AGENTS.md', path.join(codexRoot, 'AGENTS.md'));
  const agents = path.join(claudeRoot, 'agents');
  if (fs.existsSync(agents)) for (const f of fs.readdirSync(agents)) if (f.endsWith('.md')) add('claude/agents/' + f, path.join(agents, f));
  const roles = path.join(codexRoot, 'agents');
  if (fs.existsSync(roles)) for (const f of fs.readdirSync(roles)) if (f.endsWith('.toml')) add('codex/agents/' + f, path.join(roles, f));
  // Only the workflow's own skills: another skill's pages are not Sanad rule text. The reviewer cases
  // (skills/gate/reviewer-cases, 2026-11-25) hold old copies of code and pages as data, not rules.
  for (const skill of ['sanad', 'sanad-implementation', 'gate', 'ship', 'braintrust']) {
    const walk = (dir, name) => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) { if (!['scripts', 'tests', 'node_modules', 'reviewer-cases'].includes(e.name)) walk(path.join(dir, e.name), name + '/' + e.name); }
        else if (e.name.endsWith('.md')) add(name + '/' + e.name, path.join(dir, e.name));
      }
    };
    walk(path.join(claudeRoot, 'skills', skill), 'claude/skills/' + skill);
  }
  return files;
}

// A key sentence and its one home. `home: null` means the words belong in no rule page at all: their home is
// a tool (the steps table, the brief) or the checklist's own lines, and a copy in a page is the drift this
// test stops.
export const HOMES = [
  { rule: 'the stop rule', key: /\*\*Stop rule:\*\*/, home: LOOP },
  { rule: 'the stop rule (what happens to a rare case)', key: /goes to the user in one list: fix now, or a known limit in the PR text/, home: LOOP },
  { rule: 'the suite rule', key: /A slower suite runs once, on the final tree/, home: LOOP },
  { rule: 'the re-check rule', key: /re-checks the changed lines and their callers/, home: LOOP },
  { rule: 'the note answer forms', key: /NOTE <n>: refuted — <the note check's evidence>/, home: LOOP },
  { rule: 'the report shape', key: /`RECOMMEND: PASS\|FAIL`/, home: CHECKLIST },
  { rule: 'the checklist items', key: /^- `USERS FOUND BY SEARCH:`/m, home: CHECKLIST },
  { rule: 'the checklist items (a list of their names)', key: /COVERAGE, MISSED, HALF-DONE|CALLERS, ENTRY POINTS, REMOVED/, home: null },
  { rule: 'the step order (a chain of step lines)', key: /`▸ [^`\n]+`[^`\n]*→\s*`▸/, home: null },
  { rule: 'the trace list', key: /the duplicate or concurrent request, the replay after an? (?:unclear|ambiguous) commit/, home: null },
];

/** Every way the table is broken for these files: a second copy, or a home that lost its sentence. */
export function homeProblems(table, files) {
  const problems = [];
  for (const { rule, key, home } of table) {
    const found = [...files].filter(([, text]) => key.test(text)).map(([name]) => name);
    if (home && !files.has(home)) { problems.push(`${rule}: its home ${home} is missing`); continue; }
    if (home && !found.includes(home)) problems.push(`${rule}: not found in its home ${home}`);
    for (const name of found) if (name !== home) problems.push(`${rule}: a second copy in ${name}` + (home ? ` (its one home is ${home})` : ' (these words belong in no rule page)'));
  }
  return problems;
}

// "## Step 3.5 — Review" → { name: 'Step 3.5', items: [1, 2, ...] }, in page order.
export function loopSteps(loop) {
  const steps = [];
  for (const line of loop.replace(/\r\n/g, '\n').split('\n')) {
    const head = /^## (Step [\d.]+) —/.exec(line);
    if (head) { steps.push({ name: head[1], items: [] }); continue; }
    const item = /^(\d+)\. \*\*/.exec(line);
    if (item && steps.length) steps[steps.length - 1].items.push(Number(item[1]));
  }
  return steps;
}

// Step headings of loop.md that are done by hand and have no printed step.
export const BY_HAND = ['Step 1.5'];

/**
 * Every way the page and the steps table disagree. A table step names its place as "Step 3, item 5" or
 * "Step 3.5, items 1-3". The table order must be the page order. A step that runs beside another one
 * (`beside`) is due at the same time as its partner, so its own position proves nothing and is not compared.
 */
export function orderProblems(loop, table, byHand = BY_HAND) {
  const problems = [];
  const page = loopSteps(loop);
  const used = new Set();
  let last = null;
  for (const s of table) {
    const m = /^(Step [\d.]+)(?:, items? (\d+)(?:-(\d+))?)?$/.exec(String(s.loop || ''));
    if (!m) { problems.push(`step ${s.id}: "${s.loop}" does not name a step of loop.md`); continue; }
    const at = page.findIndex((p) => p.name === m[1]);
    if (at < 0) { problems.push(`step ${s.id}: loop.md has no heading "## ${m[1]} —"`); continue; }
    used.add(m[1]);
    const first = m[2] ? Number(m[2]) : 0;
    for (let n = first; m[2] && n <= Number(m[3] || m[2]); n++) if (!page[at].items.includes(n)) problems.push(`step ${s.id}: ${m[1]} of loop.md has no item ${n}`);
    if (s.beside) continue;
    if (last && (at < last.at || (at === last.at && first < last.first))) problems.push(`order differs: step ${s.id} (${s.loop}) is printed after ${last.id} (${last.loop}), and loop.md has it before`);
    last = { at, first, id: s.id, loop: s.loop };
  }
  for (const p of page) if (!used.has(p.name) && !byHand.includes(p.name)) problems.push(`loop.md heading "## ${p.name} —" is not a step of the steps table`);
  return problems;
}

/**
 * The options loop.md names, per tool. A code span that names a script gives its options to that script. A
 * span with options and no script name ("`--fixed`") must be an option of one of the tools the page names.
 */
export function namedOptions(loop) {
  const byTool = new Map();
  const bare = new Set();
  for (const [, span] of loop.matchAll(/`([^`\n]+)`/g)) {
    const options = [...span.matchAll(/(?<![\w-])--[a-z][a-z-]*/g)].map((m) => m[0]);
    const tools = [...span.matchAll(/([\w-]+\.(?:mjs|sh))\b/g)].map((m) => m[1]);
    for (const tool of tools) if (!byTool.has(tool)) byTool.set(tool, new Set());
    if (!options.length) continue;
    if (tools.length === 1) for (const o of options) byTool.get(tools[0]).add(o);
    else for (const o of options) bare.add(o);
  }
  return { byTool, bare };
}

function toolFile(tool) {
  for (const dir of ['skills/gate/scripts', 'scripts/remote', 'scripts/eduquest', 'scripts']) {
    const file = path.join(claudeRoot, dir, tool);
    if (fs.existsSync(file)) return file;
  }
  return null;
}
const hasOption = (source, option) => new RegExp('(?<![\\w-])' + option + '(?![\\w-])').test(source);

const files = ruleFiles();
const loop = files.get(LOOP) || '';

test('each key sentence is in its one home and in no second rule file', () => {
  assert.ok(files.size > 10, 'the rule files were found (' + files.size + ')');
  assert.deepEqual(homeProblems(HOMES, files), []);
});

test('a copy of the stop rule in a second file fails, and so does a home that lost it', () => {
  const stop = HOMES.filter((h) => h.rule.startsWith('the stop rule'));
  const sentence = /\*\*Stop rule:\*\*[^\n]*?PR text\./.exec(loop);
  assert.ok(sentence, 'the stop rule sentence is in loop.md');
  const copied = new Map(files);
  copied.set('claude/skills/ship/SKILL.md', (files.get('claude/skills/ship/SKILL.md') || '') + '\n' + sentence[0] + '\n');
  const second = homeProblems(stop, copied);
  assert.equal(second.length, 2, second.join('\n'));
  assert.match(second[0], /a second copy in claude\/skills\/ship\/SKILL\.md/);
  const removed = new Map(files);
  removed.set(LOOP, loop.replace(sentence[0], ''));
  const gone = homeProblems(stop, removed);
  assert.equal(gone.length, 2, gone.join('\n'));
  assert.match(gone[0], /not found in its home/);
  // A list of checklist names or a chain of step lines belongs in no page.
  const listed = new Map(files);
  listed.set('claude/agents/routine-reviewer.md', files.get('claude/agents/routine-reviewer.md') + '\nFill COVERAGE, MISSED, HALF-DONE and the rest.\n');
  assert.match(homeProblems(HOMES, listed).join('\n'), /the checklist items \(a list of their names\): a second copy in claude\/agents\/routine-reviewer\.md/);
  const chained = new Map(files);
  chained.set('claude/skills/sanad/SKILL.md', files.get('claude/skills/sanad/SKILL.md') + '\n`▸ red` → `▸ review started` → `▸ checks`\n');
  assert.match(homeProblems(HOMES, chained).join('\n'), /the step order/);
});

test('the order checker: an unknown heading, a missing item and a different order each fail', () => {
  const page = ['## Step 1 — A', '1. **a.**', '2. **b.**', '3. **c.**', '## Step 2 — B', '## Step 3 — C', '1. **d.**'].join('\n');
  const table = [{ id: 'one', loop: 'Step 1, items 1-2' }, { id: 'two', loop: 'Step 2' }, { id: 'three', loop: 'Step 3, item 1' }];
  assert.deepEqual(orderProblems(page, table), []);
  assert.match(orderProblems(page + '\n## Step 4 — D', table).join('\n'), /heading "## Step 4 —" is not a step of the steps table/);
  assert.deepEqual(orderProblems(page + '\n## Step 4 — D', table, ['Step 4']), [], 'a step done by hand is named, not guessed');
  assert.match(orderProblems(page, [...table, { id: 'four', loop: 'Step 9' }]).join('\n'), /loop\.md has no heading "## Step 9 —"/);
  assert.match(orderProblems(page, [{ id: 'one', loop: 'Step 1, items 1-4' }, ...table.slice(1)]).join('\n'), /Step 1 of loop\.md has no item 4/);
  assert.match(orderProblems(page, [table[1], table[0], table[2]]).join('\n'), /order differs: step one/);
  assert.match(orderProblems(page, [{ id: 'late', loop: 'Step 1, item 3' }, { id: 'early', loop: 'Step 1, item 1' }, ...table.slice(1)]).join('\n'), /order differs: step early/);
  assert.deepEqual(orderProblems(page, [{ id: 'late', loop: 'Step 1, item 3', beside: 'early' }, { id: 'early', loop: 'Step 1, item 1' }, ...table.slice(1)]), [], 'a step that runs beside its partner is not compared');
  assert.match(orderProblems(page, [{ id: 'odd', loop: 'the review' }, ...table]).join('\n'), /does not name a step of loop\.md/);
});

const stepsFile = path.join(claudeRoot, 'skills/gate/scripts/steps.mjs');
test('the step headings of loop.md are the steps of the printed steps table, in the same order', { skip: fs.existsSync(stepsFile) ? false : 'steps.mjs is not in this tree yet' }, async () => {
  const { STEPS } = await import(pathToFileURL(stepsFile).href);
  assert.ok(Array.isArray(STEPS) && STEPS.length > 5, 'steps.mjs exports the STEPS table');
  assert.deepEqual(loopSteps(loop).map((s) => s.name), ['Step 1', 'Step 1.5', 'Step 2', 'Step 3', 'Step 3.5', 'Step 4', 'Step 5']);
  assert.deepEqual(orderProblems(loop, STEPS), []);
});

test('every tool option loop.md names is an option of that tool', () => {
  const { byTool, bare } = namedOptions(loop);
  assert.ok(byTool.has('red-proof.mjs') && byTool.get('red-proof.mjs').has('--then-green'), 'the reader finds the options of a command');
  const sources = new Map();
  const problems = [];
  for (const [tool, options] of byTool) {
    const file = toolFile(tool);
    if (!file) { problems.push(`${tool}: loop.md names it and it is not in this tree`); continue; }
    sources.set(tool, fs.readFileSync(file, 'utf8'));
    for (const o of options) if (!hasOption(sources.get(tool), o)) problems.push(`${tool} has no option ${o}`);
  }
  for (const o of bare) if (![...sources.values()].some((s) => hasOption(s, o))) problems.push(`no tool the loop names has the option ${o}`);
  assert.deepEqual(problems, []);
});

test('the option reader: a made-up option is found and reported', () => {
  const { byTool, bare } = namedOptions('Run `node <gate>/places.mjs --repo <repo> --no-such-thing` and then `--also-none`. `a.mjs` or `b.mjs --x`.');
  assert.deepEqual([...byTool.get('places.mjs')], ['--repo', '--no-such-thing']);
  assert.deepEqual([...bare], ['--also-none']);
  assert.deepEqual([...byTool.get('b.mjs')], ['--x']);
  assert.equal(hasOption('  --repo <repo>  --no-such-thing-else', '--no-such-thing'), false);
  assert.equal(hasOption('usage: --close <file> --set "…"', '--set'), true);
});

test('the reviewer agent files and both Codex role files point to the checklist and hold no item list', () => {
  for (const name of ['claude/agents/independent-reviewer.md', 'claude/agents/routine-reviewer.md', 'claude/agents/recheck-reviewer.md', 'codex/agents/sanad-reviewer.toml', 'codex/agents/sanad-risk-reviewer.toml']) {
    // The Codex role files are machine-local: a machine without them has nothing to compare.
    if (name.startsWith('codex/') && !files.has(name)) continue;
    const text = files.get(name);
    assert.ok(text, name + ' exists');
    assert.match(text, /review-checklist\.md/, name);
    assert.doesNotMatch(text, /^\s*(?:- )?`?(?:COVERAGE|MISSED|HALF-DONE|CALLERS|ENTRY POINTS|HYGIENE):/m, name + ' defines no checklist item');
    assert.doesNotMatch(text, /Report contract — nothing else/, name + ' holds no second report contract');
  }
});

// The rule pages of the workflow itself. Another agent's or skill's page on this machine is not checked.
const PAGES = ['claude/CLAUDE.md', 'codex/AGENTS.md', 'claude/agents/independent-reviewer.md', 'claude/agents/routine-reviewer.md',
  'claude/skills/sanad/SKILL.md', 'claude/skills/gate/SKILL.md', 'claude/skills/ship/SKILL.md', 'claude/skills/braintrust/SKILL.md',
  ...['loop.md', 'loop-rare-cases.md', 'execution.md', 'review-checklist.md', 'engines.md', 'remote-host.md'].map((f) => 'claude/skills/sanad/reference/' + f)];

test('every local link in the changed rule files points at a file that exists', () => {
  const missing = [];
  for (const [name, text] of files) {
    if (!PAGES.includes(name)) continue;
    const root = name.startsWith('codex/') ? codexRoot : claudeRoot;
    const dir = path.dirname(path.join(root, name.replace(/^(?:claude|codex)\//, '')));
    for (const [, target] of text.matchAll(/\]\((?!https?:|#|mailto:)([^)#\s]+\.md)(?:#[^)]*)?\)/g)) {
      if (!fs.existsSync(path.resolve(dir, target))) missing.push(name + ' → ' + target);
    }
  }
  assert.deepEqual(missing, []);
});
