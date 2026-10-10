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

test('Codex workflow entrypoints resolve to one current canonical procedure', () => {
  for (const name of ['sanad', 'braintrust', 'gate', 'ship', 'spec']) {
    const canonical = fs.readFileSync(path.join(canonicalRoot, name, 'SKILL.md'), 'utf8');
    const entry = fs.readFileSync(path.join(entryRoot, name, 'SKILL.md'), 'utf8');
    assert.ok(entry.includes('C:/Users/Asus/.claude/skills/' + name + '/SKILL.md'));
    assert.equal(/^---\r?\n[\s\S]*?\r?\n---/.exec(entry)[0], /^---\r?\n[\s\S]*?\r?\n---/.exec(canonical)[0]);
    assert.match(entry, /stop the dependent stage/);
    assert.match(entry, /Claude hooks do not run automatically in Codex/);
    assert.doesNotMatch(entry, /## Step |## Flow|## Template|built-in \*\*`\/verify`/);
  }
});
test('the security checklist entrypoint resolves to the canonical checklist', () => {
  const entry = fs.readFileSync(path.join(entryRoot, 'gate/security-checklist.md'), 'utf8');
  assert.ok(entry.includes('C:/Users/Asus/.claude/skills/gate/security-checklist.md'));
  assert.match(fs.readFileSync(path.join(canonicalRoot, 'gate/security-checklist.md'), 'utf8'), /Access control/);
});
test('pinned agent types exist with their model, xhigh effort and no write tools', () => {
  const agentRoot = candidate ? path.join(staged, 'claude/agents') : path.join(os.homedir(), '.claude/agents');
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
  const loop = fs.readFileSync(path.join(canonicalRoot, 'sanad/reference/loop.md'), 'utf8');
  for (const line of ['ENTRY POINTS:', 'MEANING:', 'HYGIENE:', 'CI-SKIPPED:']) assert.ok(loop.includes('- `' + line + '`'), line);
  assert.match(loop, /one unit = <before> → <after>/);
  for (const name of ['independent-reviewer', 'routine-reviewer']) {
    const text = fs.readFileSync(path.join(agentRoot, name + '.md'), 'utf8');
    assert.match(text, /CALLERS, ENTRY POINTS, REMOVED, WRITERS, MEANING, FAILURES \/ LOCALES, HYGIENE, CI-SKIPPED, MISSED-BUG CLASSES/, name);
  }
  const proof = fs.readFileSync(path.join(canonicalRoot, 'gate/reference/behavior-proof.md'), 'utf8');
  assert.match(proof, /\*\*Metric, ranking or threshold:\*\*/);
  assert.match(proof, /\*\*Entry points:\*\*/);
  assert.match(proof, /\*\*Opt-in real-provider tests:\*\*/);
  assert.match(fs.readFileSync(path.join(canonicalRoot, 'gate/SKILL.md'), 'utf8'), /CI-skipped proof runs here/);
  assert.match(fs.readFileSync(path.join(canonicalRoot, 'ship/SKILL.md'), 'utf8'), /not run by CI/);
});
