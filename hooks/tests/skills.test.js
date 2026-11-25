'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const staged = path.resolve(__dirname, '../../..');
const candidate = fs.existsSync(path.join(staged, 'claude/skills/sanad/SKILL.md'));
const canonicalRoot = candidate ? path.join(staged, 'claude/skills') : path.join(os.homedir(), '.claude/skills');
const entryRoot = candidate ? path.join(staged, 'agents/skills') : path.join(os.homedir(), '.agents/skills');
// The Codex mirror is optional and machine-local; without it these two tests have nothing to compare.
const noMirror = fs.existsSync(entryRoot) ? false : 'Codex mirror (' + entryRoot + ') is not installed on this machine';

test('Codex workflow entrypoints resolve to one current canonical procedure', { skip: noMirror }, () => {
  for (const name of ['sanad', 'braintrust', 'gate', 'ship', 'spec']) {
    const canonical = fs.readFileSync(path.join(canonicalRoot, name, 'SKILL.md'), 'utf8');
    const entry = fs.readFileSync(path.join(entryRoot, name, 'SKILL.md'), 'utf8');
    assert.ok(entry.includes('C:/Users/Asus/.claude/skills/' + name + '/SKILL.md'));
    const canonicalFront = /^---\r?\n[\s\S]*?\r?\n---/.exec(canonical)[0];
    const expectedFront = name === 'sanad' ? canonicalFront.replace('effort: medium', 'effort: xhigh') : canonicalFront;
    assert.equal(/^---\r?\n[\s\S]*?\r?\n---/.exec(entry)[0], expectedFront);
    assert.match(entry, /stop the dependent stage/);
    assert.match(entry, /Claude hooks do not run automatically in Codex/);
    assert.doesNotMatch(entry, /## Step |## Flow|## Template|built-in \*\*`\/verify`/);
  }
});
test('the security checklist entrypoint resolves to the canonical checklist', { skip: noMirror }, () => {
  const entry = fs.readFileSync(path.join(entryRoot, 'gate/security-checklist.md'), 'utf8');
  assert.ok(entry.includes('C:/Users/Asus/.claude/skills/gate/security-checklist.md'));
  assert.match(fs.readFileSync(path.join(canonicalRoot, 'gate/security-checklist.md'), 'utf8'), /Access control/);
});
// 2026-11-25 (owner): effort by role. The second look, the note check, the re-check after a fix and the practical
// experts run at high; the fresh eyes and risk reviewer, the whole diff of a Big task, the deep expert seats and the
// boss stay xhigh. Each role that moved shares no agent file with a role that stays.
test('pinned agent types exist with their model, their role effort and no write tools', () => {
  const agentRoot = candidate ? path.join(staged, 'claude/agents') : path.join(os.homedir(), '.claude/agents');
  for (const [name, model, effort] of [['independent-reviewer', 'opus', 'xhigh'], ['braintrust-expert', 'opus', 'xhigh'], ['routing-boss', 'fable', 'xhigh'], ['routine-reviewer', 'sonnet', 'xhigh'],
    ['braintrust-expert-sonnet', 'sonnet', 'high'], ['recheck-reviewer', 'sonnet', 'high'], ['second-look', 'opus', 'high'], ['note-checker', 'opus', 'high']]) {
    const text = fs.readFileSync(path.join(agentRoot, name + '.md'), 'utf8');
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)[1];
    assert.match(front, new RegExp('^name: ' + name + '$', 'm'), name);
    assert.match(front, /^description: \S/m, name);
    assert.match(front, new RegExp('^model: ' + model + '$', 'm'), name);
    assert.match(front, new RegExp('^effort: ' + effort + '$', 'm'), name);
    // The description names the same effort as the setting, so the agent list does not say the old one.
    assert.doesNotMatch(front.match(/^description: .*$/m)[0], new RegExp('\\bat (?!' + effort + '\\b)\\w+ effort\\b'), name);
    assert.match(front, /^disallowedTools: .*\bWrite\b.*\bEdit\b/m, name);
  }
});

// The tools that print a launch line name the agent file of their role, so the role runs at its own effort.
test('the second look, the note check and the re-check launch their own agent files', async () => {
  const scripts = path.join(canonicalRoot, 'gate/scripts');
  const url = (f) => require('node:url').pathToFileURL(path.join(scripts, f)).href;
  const siblings = await import(url('siblings.mjs'));
  const noteCheck = await import(url('note-check.mjs'));
  const brief = await import(url('review-brief.mjs'));
  assert.match(siblings.launchLine('C:/n/siblings-brief.md'), /^LAUNCH: Agent second-look · prompt: Seat: Sibling check/);
  assert.match(noteCheck.launchLine('C:/n/note-check-brief.md'), /^LAUNCH: Agent note-checker · prompt: Seat: Note check/);
  assert.match(noteCheck.launchLine('C:/n/note-check-brief.md', false), /^LAUNCH: Agent note-checker · /);
  assert.match(brief.buildRecheckLaunch({ brief: 'C:/n/b.md', repo: 'C:/r', round: 2, risk: {} }), /Agent recheck-reviewer/);
  const bigWhole = brief.buildLaunch({ brief: 'C:/n/b.md', fresh: 'C:/n/f.md', repo: 'C:/r', branch: 'x', size: 'big' }).split('\n').find((l) => l.startsWith('## Whole diff (Claude)'));
  assert.equal(bigWhole, '## Whole diff (Claude) — Agent routine-reviewer, run_in_background');
});
// 2026-11-12: the loop is one short page. It had grown to 63 KB in 18 dated layers with rules that
// contradicted each other, and rules written there were skipped. These lines keep it one page: the six
// rules, the three sizes, every step, no history and no list of old bugs.
test('the loop is one short page: six rules, three sizes, every step, no bug list', () => {
  const dir = path.join(canonicalRoot, 'sanad/reference');
  const loop = fs.readFileSync(path.join(dir, 'loop.md'), 'utf8');
  // Measured without line-ending bytes (2026-11-16: release 7 passed here with LF and failed on CI and the test
  // machine, whose checkouts use CRLF: the same page, 102 bytes apart).
  const size = Buffer.byteLength(loop.replace(/\r\n/g, '\n'));
  assert.ok(size < 14000, 'loop.md is ' + size + ' bytes: keep it one page; detail belongs in loop-rare-cases.md');
  for (const rule of ['1. **Places first.**', '2. **A test for every ticket line and every place.**', '3. **Every new test fails on the old code.**',
    '4. **Tests, lint, types and the suite pass on the final code.**', '5. **A second AI reviews.', '6. **The user checks in the browser and pushes.**']) assert.ok(loop.includes(rule), rule);
  for (const size of ['- **Small**', '- **Medium**', '- **Big**']) assert.ok(loop.includes(size), size);
  for (const step of ['## Step 1 —', '## Step 1.5 —', '## Step 2 —', '## Step 3 —', '## Step 3.5 —', '## Step 4 —', '## Step 5 —']) assert.ok(loop.includes(step), step);
  // The typed path lists became one option (--notes <notes>); the page names the printed steps and the notes tool.
  for (const tool of ['places.mjs', 'red-proof.mjs', 'pre-review.mjs', 'review-brief.mjs', 'size-check.mjs', 'sanad.mjs next', 'notes.mjs answer', 'breaks.mjs',
    'pre-review.mjs --was <size> --notes <notes>', 'review-brief.mjs --pin --notes <notes>']) assert.ok(loop.includes(tool), tool);
  assert.ok(!loop.includes('--places <notes>/places.md'), 'the path list is not typed any more');
  assert.match(loop, /NOTE <n>: fixed — /);
  assert.match(loop, /NOTE <n>: user — "/);
  assert.match(loop, /NOTE <n>: refuted — /);
  assert.match(loop, /in a message with no tool call/);
  assert.match(loop, /^ {3}`REVIEW: PASS\|FAIL — bugs <found>\/<fixed>, goals tested <k>\/<k> ✓, untested <n>, open: <none\|list>`$/m);
  assert.doesNotMatch(loop, /missed-bug|20\d\d-\d\d-\d\d/i, 'no bug list and no dated history in the loop');
  for (const file of ['review-checklist.md', 'loop-rare-cases.md']) {
    assert.ok(loop.includes('(' + file + ')'), file + ' is linked from the loop');
    assert.doesNotMatch(fs.readFileSync(path.join(dir, file), 'utf8'), /missed-bug/i, file);
  }
  // Every local link in the three files points at a file that exists.
  for (const file of ['loop.md', 'review-checklist.md', 'loop-rare-cases.md']) {
    for (const [, target] of fs.readFileSync(path.join(dir, file), 'utf8').matchAll(/\]\(([^)#]+\.md)\)/g)) assert.ok(fs.existsSync(path.join(dir, target)), file + ' → ' + target);
  }
});
test('sonnet-worker is pinned to Sonnet, cannot spawn agents, and is limited to mechanical edits', () => {
  const agentRoot = candidate ? path.join(staged, 'claude/agents') : path.join(os.homedir(), '.claude/agents');
  const text = fs.readFileSync(path.join(agentRoot, 'sonnet-worker.md'), 'utf8');
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)[1];
  assert.match(front, /^name: sonnet-worker$/m);
  assert.match(front, /^model: sonnet$/m);
  assert.match(front, /^disallowedTools: .*\bAgent\b/m);
  assert.match(text, /STOP: not mechanical/);
  assert.match(text, /Never stage, commit, push/);
});
test('review template and evidence rules carry entry points, metric meaning, hygiene and CI-skipped proof', () => {
  const agentRoot = candidate ? path.join(staged, 'claude/agents') : path.join(os.homedir(), '.claude/agents');
  // 2026-11-12: the reviewers' checklist moved out of the loop into its own file.
  const checklist = fs.readFileSync(path.join(canonicalRoot, 'sanad/reference/review-checklist.md'), 'utf8');
  for (const line of ['ENTRY POINTS:', 'MEANING:', 'HYGIENE:', 'CI-SKIPPED:', 'USERS FOUND BY SEARCH:']) assert.ok(checklist.includes('- `' + line + '`'), line);
  assert.match(checklist, /one unit = <before> → <after>/);
  for (const line of ['BEST DESIGN:', 'OLD CODE TOO:']) assert.ok(checklist.includes('- `' + line + '`'), line);
  assert.match(checklist, /EXTRA TEST: /);
  assert.ok(checklist.includes('`RECOMMEND: PASS|FAIL`'), 'the report shape is in the checklist');
  for (const name of ['independent-reviewer', 'routine-reviewer']) {
    const text = fs.readFileSync(path.join(agentRoot, name + '.md'), 'utf8');
    // The agent files keep the role and the limits. The checklist is the one item list and the one report
    // shape: three copies of the list had 27, 24 and 20 items.
    assert.match(text, /sanad\/reference\/review-checklist\.md/, name);
    assert.doesNotMatch(text, /CALLERS, ENTRY POINTS|COVERAGE, MISSED/, name + ' holds no checklist item list');
    assert.match(text, /check the reason of every `none:` place/, name);
    // The workflow no longer reads a list of old bugs (user 2026-11-12).
    assert.doesNotMatch(text, /missed-bug/i, name);
  }
  const proof = fs.readFileSync(path.join(canonicalRoot, 'gate/reference/behavior-proof.md'), 'utf8');
  assert.match(proof, /\*\*Metric, ranking or threshold:\*\*/);
  assert.match(proof, /\*\*Entry points:\*\*/);
  assert.match(proof, /\*\*Opt-in real-provider tests:\*\*/);
  assert.match(fs.readFileSync(path.join(canonicalRoot, 'gate/SKILL.md'), 'utf8'), /CI-skipped proof runs here/);
  assert.match(fs.readFileSync(path.join(canonicalRoot, 'ship/SKILL.md'), 'utf8'), /not run by CI/);
});
