import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const claudeRoot = path.resolve(here, '../..');
const staged = path.dirname(claudeRoot);
const candidate = fs.existsSync(path.join(staged, 'claude/skills/sanad/SKILL.md'));
const bundle = fs.existsSync(path.join(claudeRoot, 'codex/config.example.toml'));
const codexRoot = candidate ? path.join(staged, 'codex') : bundle ? path.join(claudeRoot, 'codex') : path.join(os.homedir(), '.codex');
const installer = path.resolve(here, '../../scripts/workflow-install.sh');
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const noCodex = fs.existsSync(path.join(codexRoot, 'agents/sanad-boss.toml')) ? false : 'Sanad Codex roles are not installed';
const models = {
  'sanad-boss': 'gpt-6-astra',
  'sanad-risk-reviewer': 'gpt-6-astra',
  'sanad-reviewer': 'gpt-6.1-sol',
  'sanad-expert': 'gpt-6-astra',
  'sanad-practical-expert': 'gpt-6.1-sol',
  'sanad-worker': 'gpt-6-luna'
};

test('every installed Codex role pins xhigh and its assigned Codex model', {skip:noCodex}, () => {
  for (const [name, model] of Object.entries(models)) {
    const text = fs.readFileSync(path.join(codexRoot, 'agents', name + '.toml'), 'utf8');
    assert.match(text, new RegExp(`^name = "${name}"$`, 'm'));
    assert.match(text, new RegExp(`^model = "${model.replaceAll('.', '\\.')}"$`, 'm'));
    assert.match(text, /^model_reasoning_effort = "xhigh"$/m, name);
    assert.match(text, /developer_instructions = """\n[\s\S]+\n"""/);
    assert.match(text, /\[agents\]\nenabled = false/, 'A delegated role cannot grow another panel');
    if (name !== 'sanad-worker') assert.match(text, /^sandbox_mode = "read-only"$/m, name);
    else {
      assert.doesNotMatch(text, /^sandbox_mode = /m, 'The worker must inherit its parent permission boundary');
      assert.match(text, /STOP: not mechanical/);
    }
  }
});

test('Codex parent and unspecified children default to xhigh', {skip:noCodex}, () => {
  const config = fs.readFileSync(path.join(codexRoot, bundle ? 'config.example.toml' : 'config.toml'), 'utf8');
  assert.match(config.split(/^\[/m)[0], /^model_reasoning_effort = "xhigh"$/m);
  const agents = /\[agents\]\r?\n([^[]*)/.exec(config)?.[1];
  assert.match(agents ?? '', /^default_subagent_reasoning_effort = "xhigh"$/m);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanad-engine-install-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    const tempRoot = fs.realpathSync(os.tmpdir());
    assert.equal(path.dirname(resolved), tempRoot);
    assert.ok(path.basename(resolved).startsWith('sanad-engine-install-'));
    fs.rmSync(resolved, {recursive:true, force:true});
  });
  const base = path.join(root, 'base');
  const cand = path.join(root, 'candidate');
  const live = path.join(root, 'live');
  const put = (folder, rel, text) => {
    const target = path.join(folder, rel);
    fs.mkdirSync(path.dirname(target), {recursive:true});
    fs.writeFileSync(target, text);
  };
  for (const folder of [base, cand, live]) {
    put(folder, 'claude/hooks/tests/fixture.test.cjs', 'require("node:test")("fixture", () => {});\n');
    put(folder, 'claude/skills/gate/tests/fixture.test.cjs', 'require("node:test")("fixture", () => {});\n');
    put(folder, 'agents/skills/sanad/SKILL.md', 'existing mirror\n');
    put(folder, 'codex/config.toml', 'model_reasoning_effort = "high"\n');
  }
  put(cand, 'codex/config.toml', 'model_reasoning_effort = "xhigh"\n');
  put(cand, 'codex/agents/sanad-boss.toml', 'model = "gpt-6-astra"\nmodel_reasoning_effort = "xhigh"\n');
  const source = fs.readFileSync(installer, 'utf8').replaceAll('\r\n','\n');
  const rootLine = 'C="$HOME/.claude"; A="$HOME/.agents/skills"; X="$HOME/.codex"';
  assert.equal(source.split(rootLine).length, 2, 'Isolate the installer destinations without changing HOME');
  const quote = value => "'" + value.replaceAll('\\','/').replaceAll("'", "'\\''") + "'";
  const isolated = source.replace(rootLine, `C=${quote(path.join(live,'claude'))}; A=${quote(path.join(live,'agents/skills'))}; X=${quote(path.join(live,'codex'))}`);
  const script = path.join(root, 'install.sh');
  fs.writeFileSync(script, isolated);
  const env = {...process.env};
  delete env.NODE_TEST_CONTEXT;
  const run = name => spawnSync(bash, [script, cand, base, name], {encoding:'utf8', env, timeout:30000});
  return {root, base, cand, live, put, run};
}

test('workflow release installs Codex config and roles, backs up prior config, and logs the release', t => {
  const f = fixture(t);
  const result = f.run('engine-release');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /INSTALLED 2 changed, 0 removed/);
  assert.equal(fs.readFileSync(path.join(f.live,'codex/config.toml'),'utf8'), 'model_reasoning_effort = "xhigh"\n');
  assert.equal(fs.readFileSync(path.join(f.live,'codex/agents/sanad-boss.toml'),'utf8'),fs.readFileSync(path.join(f.cand,'codex/agents/sanad-boss.toml'),'utf8'));
  assert.equal(fs.readFileSync(path.join(f.live,'claude/backups/engine-release/codex/config.toml'),'utf8'), 'model_reasoning_effort = "high"\n');
  assert.match(fs.readFileSync(path.join(f.live,'claude/backups/RELEASES.md'),'utf8'), /engine-release.*codex\/config.toml/);
  assert.notEqual(f.run('engine-release').status, 0, 'A release cannot overwrite its backup');
});

test('workflow release installs the Codex AGENTS.md rules file and backs up the old one', t => {
  const f = fixture(t);
  for (const folder of [f.base, f.live]) f.put(folder, 'codex/AGENTS.md', 'old rules\n');
  f.put(f.cand, 'codex/AGENTS.md', 'new rules\n');
  const result = f.run('rules-release');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /INSTALLED 3 changed, 0 removed/);
  assert.equal(fs.readFileSync(path.join(f.live,'codex/AGENTS.md'),'utf8'), 'new rules\n');
  assert.equal(fs.readFileSync(path.join(f.live,'claude/backups/rules-release/codex/AGENTS.md'),'utf8'), 'old rules\n');
});

test('changed live Codex config aborts before any file is installed', t => {
  const f = fixture(t);
  f.put(f.live,'codex/config.toml','user changed this\n');
  const result = f.run('drift-release');
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /DRIFT: codex\/config.toml/);
  assert.equal(fs.readFileSync(path.join(f.live,'codex/config.toml'),'utf8'),'user changed this\n');
  assert.equal(fs.existsSync(path.join(f.live,'codex/agents/sanad-boss.toml')),false);
  assert.equal(fs.existsSync(path.join(f.live,'claude/backups/drift-release')),false);
});

test('a newly occupied role path or an unrelated Codex file aborts the whole release', t => {
  for (const kind of ['occupied','unmapped']) {
    const f = fixture(t);
    if(kind === 'occupied') f.put(f.live,'codex/agents/sanad-boss.toml','user role\n');
    else f.put(f.cand,'codex/unrelated.txt','must not install\n');
    const result = f.run(kind);
    assert.notEqual(result.status,0);
    assert.match(result.stdout,kind === 'occupied' ? /DRIFT: codex\/agents\/sanad-boss.toml/ : /UNMAPPED: codex\/unrelated.txt/);
    assert.equal(fs.readFileSync(path.join(f.live,'codex/config.toml'),'utf8'),'model_reasoning_effort = "high"\n');
    assert.equal(fs.existsSync(path.join(f.live,'codex/unrelated.txt')),false);
  }
});
