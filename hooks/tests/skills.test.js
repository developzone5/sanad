'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const claudeRoot = path.resolve(__dirname, '../..');
const staged = path.dirname(claudeRoot);
const candidate = fs.existsSync(path.join(staged, 'claude/skills/sanad/SKILL.md'));
const bundle = fs.existsSync(path.join(claudeRoot, 'codex/skills/sanad/SKILL.md'));
const canonicalRoot = path.join(claudeRoot, 'skills');
const entryRoot = candidate ? path.join(staged, 'agents/skills') : bundle ? path.join(claudeRoot, 'codex/skills') : path.join(os.homedir(), '.agents/skills');
const canonicalLink = bundle ? '~/.claude/skills/' : canonicalRoot.replaceAll('\\', '/') + '/';
// The Codex mirror is optional and machine-local; without it these two tests have nothing to compare.
const noMirror = fs.existsSync(entryRoot) ? false : 'Codex mirror (' + entryRoot + ') is not installed on this machine';

test('Codex workflow entrypoints resolve to one current canonical procedure', { skip: noMirror }, () => {
  for (const name of ['sanad', 'braintrust', 'gate', 'ship', 'spec']) {
    const canonical = fs.readFileSync(path.join(canonicalRoot, name, 'SKILL.md'), 'utf8').replaceAll('\r\n', '\n');
    const entry = fs.readFileSync(path.join(entryRoot, name, 'SKILL.md'), 'utf8').replaceAll('\r\n', '\n');
    assert.ok(entry.includes(canonicalLink + name + '/SKILL.md') || entry.includes('~/.claude/skills/' + name + '/SKILL.md'));
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
  assert.ok(entry.includes(canonicalLink + 'gate/security-checklist.md') || entry.includes('~/.claude/skills/gate/security-checklist.md'));
  assert.match(fs.readFileSync(path.join(canonicalRoot, 'gate/security-checklist.md'), 'utf8'), /Access control/);
});
test('pinned agent types exist with their model, xhigh effort and no write tools', () => {
  const agentRoot = path.join(claudeRoot, 'agents');
  for (const [name, model] of [['independent-reviewer', 'opus'], ['braintrust-expert', 'opus'], ['routing-boss', 'fable'], ['routine-reviewer', 'sonnet'], ['braintrust-expert-sonnet', 'sonnet']]) {
    const text = fs.readFileSync(path.join(agentRoot, name + '.md'), 'utf8');
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)[1];
    assert.match(front, new RegExp('^name: ' + name + '$', 'm'), name);
    assert.match(front, /^description: \S/m, name);
    assert.match(front, new RegExp('^model: ' + model + '$', 'm'), name);
    assert.match(front, /^effort: xhigh$/m, name);
    assert.match(front, /^disallowedTools: .*\bWrite\b.*\bEdit\b/m, name);
  }
});
// 2026-11-12: the loop is one short page. It had grown to 63 KB in 18 dated layers with rules that
// contradicted each other, and rules written there were skipped. These lines keep it one page: the six
// rules, the three sizes, every step, no history and no list of old bugs.
test('the loop is one short page: six rules, three sizes, every step, no bug list', () => {
  const dir = path.join(canonicalRoot, 'sanad/reference');
  const loop = fs.readFileSync(path.join(dir, 'loop.md'), 'utf8');
  assert.ok(Buffer.byteLength(loop) < 14000, 'loop.md is ' + Buffer.byteLength(loop) + ' bytes: keep it one page; detail belongs in loop-rare-cases.md');
  for (const rule of ['1. **Places first.**', '2. **A test for every ticket line and every place.**', '3. **Every new test fails on the old code.**',
    '4. **Tests, lint, types and the suite pass on the final code.**', '5. **A second AI reviews.', '6. **The user checks in the browser and pushes.**']) assert.ok(loop.includes(rule), rule);
  for (const size of ['- **Small**', '- **Medium**', '- **Big**']) assert.ok(loop.includes(size), size);
  for (const step of ['## Step 1 —', '## Step 1.5 —', '## Step 2 —', '## Step 3 —', '## Step 3.5 —', '## Step 4 —', '## Step 5 —']) assert.ok(loop.includes(step), step);
  for (const tool of ['places.mjs', 'red-proof.mjs', 'pre-review.mjs', 'review-brief.mjs', 'size-check.mjs', '--places <notes>/places.md']) assert.ok(loop.includes(tool), tool);
  assert.match(loop, /NOTE <n>: fixed — /);
  assert.match(loop, /NOTE <n>: user — "/);
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
  const agentRoot = path.join(claudeRoot, 'agents');
  const text = fs.readFileSync(path.join(agentRoot, 'sonnet-worker.md'), 'utf8');
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)[1];
  assert.match(front, /^name: sonnet-worker$/m);
  assert.match(front, /^model: sonnet$/m);
  assert.match(front, /^disallowedTools: .*\bAgent\b/m);
  assert.match(text, /STOP: not mechanical/);
  assert.match(text, /Never stage, commit, push/);
});
test('review template and evidence rules carry entry points, metric meaning, hygiene and CI-skipped proof', () => {
  const agentRoot = path.join(claudeRoot, 'agents');
  // 2026-11-12: the reviewers' checklist moved out of the loop into its own file.
  const checklist = fs.readFileSync(path.join(canonicalRoot, 'sanad/reference/review-checklist.md'), 'utf8');
  for (const line of ['ENTRY POINTS:', 'MEANING:', 'HYGIENE:', 'CI-SKIPPED:', 'USERS FOUND BY SEARCH:']) assert.ok(checklist.includes('- `' + line + '`'), line);
  assert.match(checklist, /one unit = <before> → <after>/);
  for (const name of ['independent-reviewer', 'routine-reviewer']) {
    const text = fs.readFileSync(path.join(agentRoot, name + '.md'), 'utf8');
    assert.match(text, /CALLERS, ENTRY POINTS, REMOVED, WRITERS, MEANING, FAILURES \/ LOCALES, HYGIENE, CI-SKIPPED, USERS FOUND BY SEARCH/, name);
    assert.match(text, /sanad\/reference\/review-checklist\.md/, name);
    assert.match(text, /EXTRA TEST: /, name);
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
