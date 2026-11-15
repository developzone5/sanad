import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runCommand } from '../../skills/gate/scripts/evidence.mjs';

// 2026-11-15: three stops in one task were blocked with "no build/test has run since the last edit" right after
// `node red-proof.mjs … --then-green … -- dotnet test … > proof-run.out 2>&1; echo "exit $?" >> proof-run.out`,
// run in the background, had ended GREEN ✓ / PROVED ✓. Its output went to a file, so the scan saw no line of the
// proof's own. red-proof now leaves a run record (skills/gate/scripts/run-record.mjs); the scan reads it. Real
// git repositories, the real red-proof.mjs, stop-gate.js and policy-guard.js in child processes; state in a
// temp folder, never the live ~/.claude/state.
const hooks = process.env.WORKFLOW_HOOKS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const redProof = path.resolve(hooks, '..', 'skills', 'gate', 'scripts', 'red-proof.mjs').replace(/\\/g, '/');
const slash = (p) => p.replace(/\\/g, '/');
const root = slash(fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'stop-red-proof-'))));
const stateDir = root + '/state';
fs.mkdirSync(stateDir, { recursive: true });
const emptyConfig = root + '/empty.gitconfig';
fs.writeFileSync(emptyConfig, '');
const env = {
  ...process.env, SANAD_STATE_DIR: stateDir, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
};
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const nodeExe = slash(process.execPath);
const runsDir = stateDir + '/proof/runs';

// A repository on a feature branch whose committed code is fixed (app.cjs = 2) and whose test (check.cjs) needs
// the fix. The check prints a named failing test, as a runner does. `check` replaces the test's code.
let cases = 0;
function setup(check) {
  const repo = root + '/case' + (++cases);
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).trim();
  git('init', '-q', '--initial-branch=staging');
  git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(repo + '/README.md', 'Fixture.\n');
  git('add', 'README.md'); git('commit', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/staging', 'HEAD');
  git('switch', '-q', '-c', 'fix/proof');
  fs.writeFileSync(repo + '/app.cjs', 'module.exports = 2;\n');
  fs.writeFileSync(repo + '/check.cjs', check || [
    'if (require("./app.cjs") !== 2) { console.log(" FAIL  src/app.test.cjs > app > is fixed" + String.fromCharCode(10) + "AssertionError: expected 3 to be 2"); process.exit(1); }',
    'process.exit(0);', ''].join('\n'));
  git('add', 'app.cjs', 'check.cjs'); git('commit', '-qm', 'fix');
  return { repo, git };
}

// The proof's arguments, and the shell line that runs it in the background with its output sent to a file.
const proofArgs = (repo, extra = []) => ['--repo', repo, '--break', 'app.cjs', '--find', 'exports = 2', '--put', 'exports = 3', '--then-green', ...extra, '--', nodeExe, 'check.cjs'];
const shellLine = (args, out) => `node "${redProof}" ${args.map((a) => `"${a}"`).join(' ')} > "${out}" 2>&1; echo "exit $?" >> "${out}"`;

// The session's transcript entries.
let ids = 0;
const at = (ms = Date.now()) => new Date(ms).toISOString();
const entry = (role, content, time, extra = {}) => ({ type: role, timestamp: time, message: { role, content }, ...extra });
const edit = (file, time = at(Date.now() - 60000)) => {
  const id = 'e' + (++ids);
  return [entry('assistant', [{ type: 'tool_use', id, name: 'Edit', input: { file_path: file } }], time),
    entry('user', [{ type: 'tool_result', tool_use_id: id, content: 'File updated.', is_error: false }], time)];
};
const notice = (task, out, time, exit = 0) => entry('user', `<task-notification>\n<task-id>${task}</task-id>\n<output-file>${out}</output-file>\n<status>completed</status>\n<summary>Background command "proof" completed (exit code ${exit})</summary>\n</task-notification>`, time);

// Runs the proof as the host would in the background: the launch (before the run), the run itself (output to
// the file), and the finish notice (after). `between` adds entries while it runs. Returns the entries.
function backgroundProof(repo, { extra = [], between = [], launchAt, doneAt } = {}) {
  const id = 'b' + (++ids), task = 'task' + ids;
  const out = root + '/' + task + '-proof-run.out', taskOut = root + '/' + task + '.output';
  fs.writeFileSync(taskOut, '');
  const args = proofArgs(repo, extra);
  const launched = launchAt || at();
  const run = spawnSync(process.execPath, [redProof, ...args], { env, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  fs.writeFileSync(out, (run.stdout || '') + (run.stderr || '') + `exit ${run.status}\n`);
  return {
    status: run.status, output: fs.readFileSync(out, 'utf8'),
    entries: [
      entry('assistant', [{ type: 'tool_use', id, name: 'Bash', input: { command: shellLine(args, out), run_in_background: true } }], launched),
      entry('user', [{ type: 'tool_result', tool_use_id: id, content: `Command running in background with ID: ${task}. Output is being written to: ${taskOut}`, is_error: false }], launched, { toolUseResult: { backgroundTaskId: task } }),
      ...between,
      notice(task, taskOut, doneAt || at()),
    ],
  };
}

let stops = 0;
function hook(name, entries, input, cwd) {
  const transcript = root + '/transcript-' + (++stops) + '.jsonl';
  fs.writeFileSync(transcript, entries.map((e) => JSON.stringify(e) + '\n').join(''));
  const out = execFileSync(process.execPath, [path.join(hooks, name)], {
    input: JSON.stringify({ session_id: 'red-proof-' + stops, transcript_path: transcript, cwd, ...input }),
    env, cwd, encoding: 'utf8', windowsHide: true, timeout: 60000,
  });
  return out.trim() ? JSON.parse(out) : {};
}
const stop = (entries, cwd) => {
  const o = hook('stop-gate.js', entries, { hook_event_name: 'Stop' }, cwd);
  return { decision: o.decision || 'allow', text: o.reason || o.systemMessage || '' };
};
const records = () => (fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : []).map((n) => JSON.parse(fs.readFileSync(runsDir + '/' + n, 'utf8')));
const latestRecord = () => records().sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];

test('(1) an edit, then a background red-proof with its output in a file that ended green: the stop is allowed', () => {
  const { repo } = setup();
  const proof = backgroundProof(repo);
  assert.equal(proof.status, 0, proof.output);
  assert.match(proof.output, /GREEN ✓/);
  const record = latestRecord();
  assert.equal(record.green, 'passed');
  assert.equal(record.treeStart, record.treeEnd, 'the tree is the same at the start and the end');
  const r = stop([...edit(repo + '/app.cjs'), ...proof.entries], repo);
  assert.equal(r.decision, 'allow', r.text);
  assert.match(r.text, /completed successfully after the last code edit/);
  // Control: the same transcript without the run record reads as no check (the failure seen on 2026-11-15).
  for (const name of fs.readdirSync(runsDir)) fs.renameSync(runsDir + '/' + name, root + '/' + name + '.aside');
  try {
    const blind = stop([...edit(repo + '/app.cjs'), ...proof.entries], repo);
    assert.equal(blind.decision, 'block');
    assert.match(blind.text, /no build\/test has run since the last edit/);
  } finally {
    for (const name of fs.readdirSync(root).filter((n) => n.endsWith('.json.aside'))) fs.renameSync(root + '/' + name, runsDir + '/' + name.replace(/\.aside$/, ''));
  }
});

test('(1) a background proof that ended NOT RED after a passing green run counts as tests run green; the push guard still sees the failure', () => {
  const { repo } = setup('process.exit(0);\n');   // passes with app.cjs broken too: NOT RED
  const proof = backgroundProof(repo);
  assert.equal(proof.status, 1, proof.output);
  assert.match(proof.output, /GREEN ✓/);
  assert.match(proof.output, /NOT RED ✗/);
  const r = stop([...edit(repo + '/app.cjs'), ...proof.entries], repo);
  assert.equal(r.decision, 'allow', r.text);
  assert.match(r.text, /tests ran green after the last code edit \(a red-proof green run\), but the proof itself did not hold/);
});

test('(2) an edit, then a background red-proof whose green run failed: the stop is still blocked', () => {
  const { repo } = setup(' process.stdout.write(" FAIL  src/app.test.cjs > app > is fixed\\nAssertionError: expected 2 to be 5\\n"); process.exit(1);\n');
  const proof = backgroundProof(repo);
  assert.equal(proof.status, 1, proof.output);
  assert.match(proof.output, /GREEN ✗/);
  assert.equal(latestRecord().green, 'failed');
  const r = stop([...edit(repo + '/app.cjs'), ...proof.entries], repo);
  assert.equal(r.decision, 'block');
  assert.match(r.text, /FAILED/);
  assert.match(r.text, /The failed check: `node .*red-proof\.mjs/);
});

test('(3) a red-proof that ran before the last edit, or while an edit was made, does not count', () => {
  const { repo } = setup();
  const before = backgroundProof(repo);
  assert.equal(before.status, 0, before.output);
  const late = stop([...edit(repo + '/app.cjs', at(Date.now() - 120000)), ...before.entries, ...edit(repo + '/app.cjs', at())], repo);
  assert.equal(late.decision, 'block');
  assert.match(late.text, /no build\/test has run since the last edit/);
  const during = backgroundProof(repo, { between: edit(repo + '/app.cjs', at()) });
  assert.equal(during.status, 0, during.output);
  const edited = stop([...edit(repo + '/app.cjs', at(Date.now() - 120000)), ...during.entries], repo);
  assert.equal(edited.decision, 'block', 'an edit after the launch voids the run');
});

test('(3) a run whose tree changed while it ran, by any hand, does not count', () => {
  // The test writes a file into the repository: the tree at the end is not the tree the run started on.
  const { repo } = setup('require("node:fs").writeFileSync(__dirname + "/touched-" + Date.now() + ".txt", "x");\nif (require("./app.cjs") !== 2) { console.log(" FAIL  src/app.test.cjs > app > is fixed" + String.fromCharCode(10) + "AssertionError: expected 3 to be 2"); process.exit(1); }\n');
  const proof = backgroundProof(repo);
  assert.equal(proof.status, 0, proof.output);
  const record = latestRecord();
  assert.equal(record.green, 'passed');
  assert.notEqual(record.treeStart, record.treeEnd);
  const r = stop([...edit(repo + '/app.cjs'), ...proof.entries], repo);
  assert.equal(r.decision, 'block');
  assert.match(r.text, /no build\/test has run since the last edit/);
});

test('a run record counts only for its own launch: other arguments, another time, or two of them are no credit', () => {
  const { repo } = setup();
  const proof = backgroundProof(repo);
  assert.equal(proof.status, 0, proof.output);
  const record = latestRecord();
  // The launch names other arguments (another test filter): not this record.
  const other = proof.entries.map((e) => JSON.parse(JSON.stringify(e).replace('\\"check.cjs\\"', '\\"other.cjs\\"')));
  assert.equal(stop([...edit(repo + '/app.cjs'), ...other], repo).decision, 'block');
  // The launch came after the record's start (an older run of the same command): not this run.
  const later = proof.entries.map((e, i) => (i < 2 ? { ...e, timestamp: at(Date.parse(record.endedAt) + 5000) } : { ...e, timestamp: at(Date.parse(record.endedAt) + 9000) }));
  assert.equal(stop([...edit(repo + '/app.cjs', at(Date.parse(record.endedAt) + 1000)), ...later], repo).decision, 'block');
  // No times on the entries: the record cannot be placed.
  const untimed = proof.entries.map(({ timestamp, ...e }) => e);
  assert.equal(stop([...edit(repo + '/app.cjs'), ...untimed], repo).decision, 'block');
  // Two records of the same command in that time: neither can be told for this run.
  const twin = { ...record, startedAt: at(Date.parse(record.startedAt) + 1), endedAt: record.endedAt };
  const twinFile = `${runsDir}/${Date.parse(record.startedAt) + 1}-1.json`;
  fs.writeFileSync(twinFile, JSON.stringify(twin));
  try { assert.equal(stop([...edit(repo + '/app.cjs'), ...proof.entries], repo).decision, 'block'); }
  finally { fs.rmSync(twinFile, { force: true }); }
  assert.equal(stop([...edit(repo + '/app.cjs'), ...proof.entries], repo).decision, 'allow', 'control: the record alone counts');
});

test('a record of a proof that stopped (SETUP, TIMEOUT, ENVIRONMENT, REMOTE-DOWN) or ran no green gives no credit', () => {
  const { repo } = setup();
  const proof = backgroundProof(repo);
  assert.equal(proof.status, 0, proof.output);
  const record = latestRecord();
  const file = runsDir + '/' + fs.readdirSync(runsDir).find((n) => JSON.parse(fs.readFileSync(runsDir + '/' + n, 'utf8')).startedAt === record.startedAt);
  const original = fs.readFileSync(file, 'utf8');
  try {
    for (const [exit, green] of [[3, 'none'], [5, 'none'], [6, 'none'], [4, 'none'], [0, 'none'], [2, 'passed']]) {
      fs.writeFileSync(file, JSON.stringify({ ...record, exit, green }));
      const r = stop([...edit(repo + '/app.cjs'), ...proof.entries], repo);
      assert.equal(r.decision, 'block', `exit ${exit}, green ${green}`);
    }
  } finally { fs.writeFileSync(file, original); }
});

test('the proof\'s own lines still decide when they reach the result: NOT RED after green passes the stop, GREEN ✗ blocks', () => {
  const { repo } = setup();
  const args = proofArgs(repo);
  const foreground = (text, exit) => {
    const id = 'f' + (++ids);
    return [entry('assistant', [{ type: 'tool_use', id, name: 'Bash', input: { command: `node "${redProof}" ${args.map((a) => `"${a}"`).join(' ')}` } }], at()),
      entry('user', [{ type: 'tool_result', tool_use_id: id, content: (exit ? `Exit code ${exit}\n` : '') + text, is_error: exit !== 0 }], at())];
  };
  const notRed = stop([...edit(repo + '/app.cjs'), ...foreground('  GREEN ✓ the tests pass on the fixed tree\nRED-PROOF: NOT RED ✗ — the test passes with app.cjs broken, so it does not check that code; files restored.', 1)], repo);
  assert.equal(notRed.decision, 'allow', notRed.text);
  assert.match(notRed.text, /proof itself did not hold/);
  const red = stop([...edit(repo + '/app.cjs'), ...foreground('  GREEN ✗ the tests fail on the fixed tree\nRED-PROOF: NOT PROVED ✗ — the fixed tree fails its own tests', 1)], repo);
  assert.equal(red.decision, 'block');
  assert.match(red.text, /FAILED/);
  const timedOut = stop([...edit(repo + '/app.cjs'), ...foreground('  GREEN ✓ the tests pass on the fixed tree\nRED-PROOF: TIMEOUT ✗ — break ran past 15 min', 5)], repo);
  assert.equal(timedOut.decision, 'block', 'a timeout after green is no credit');
  // A probe declared for a failing proof still quiets the stop as a probe (PROBE EXPECTED is unchanged).
  const probeCmd = `node "${redProof}" ${args.map((a) => `"${a}"`).join(' ')}`;
  const probe = entry('assistant', [{ type: 'text', text: 'PROBE EXPECTED: ' + JSON.stringify({ command: probeCmd, reason: 'Proves the PR under review lets a supervisor edit a class.' }) }], at());
  const probed = stop([...edit(repo + '/app.cjs'), ...foreground('  GREEN ✗ the tests fail on the fixed tree\nRED-PROOF: NOT PROVED ✗', 1), probe], repo);
  assert.equal(probed.decision, 'allow', probed.text);
  assert.match(probed.text, /review probe/);
  // The same command text, red and then green, clears the red run (unchanged).
  const cleared = stop([...edit(repo + '/app.cjs'), ...foreground('  GREEN ✗ the tests fail on the fixed tree\nRED-PROOF: NOT PROVED ✗', 1),
    ...foreground('  GREEN ✓ the tests pass on the fixed tree\nRED-PROOF: RED ✓ — the test fails with app.cjs broken', 0)], repo);
  assert.equal(cleared.decision, 'allow', cleared.text);
  assert.match(cleared.text, /completed successfully/);
});

test('(4) the push guard still demands its evidence receipt after a proof; with one it allows', async () => {
  const { repo, git } = setup();
  const proof = backgroundProof(repo);
  assert.equal(proof.status, 0, proof.output);
  assert.equal(git('status', '--porcelain'), '', 'the proof left the tree clean');
  let reviewers = 0;
  const reviewed = () => {
    const id = 'reviewer' + (++reviewers);
    return [
      entry('assistant', [{ type: 'tool_use', id: id + '-call', name: 'Agent', input: { description: 'Independent review', prompt: 'You are the independent reviewer (read-only). Review the diff.' } }], at()),
      entry('user', [{ type: 'tool_result', tool_use_id: id + '-call', content: 'Async agent launched successfully.', is_error: false }], at(), { toolUseResult: { isAsync: true, status: 'async_launched', agentId: id } }),
      { type: 'attachment', timestamp: at(), attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<summary>Agent "Independent review" completed</summary>\n</task-notification>` } },
      entry('assistant', [{ type: 'text', text: 'REVIEW: PASS' }], at()),
      entry('assistant', [{ type: 'text', text: 'GATE: PASS' }], at()),
    ];
  };
  const push = (entries) => {
    const o = hook('policy-guard.js', entries, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin HEAD:fix/proof' } }, repo);
    return o.hookSpecificOutput || { permissionDecision: 'allow', permissionDecisionReason: '' };
  };
  const proved = [...edit(repo + '/app.cjs'), ...proof.entries];
  assert.equal(stop(proved, repo).decision, 'allow', 'the proof counts for the stop');
  const denied = push([...proved, ...reviewed()]);
  assert.equal(denied.permissionDecision, 'deny');
  assert.match(denied.permissionDecisionReason, /requires a completed evidence\.mjs check/);
  // Control: the same session with an evidence.mjs receipt of this tree is allowed, so the receipt was what was missing.
  const check = await runCommand({ executable: process.execPath, args: ['--check', 'app.cjs'], cwd: repo, outputRoot: root + '/checks' });
  assert.equal(check.status, 'passed', check.reason);
  const bound = [entry('assistant', [{ type: 'tool_use', id: 'bound', name: 'Bash', input: { command: 'node C:/Users/Asus/.claude/skills/gate/scripts/evidence.mjs --spec fixture.json' } }], at()),
    entry('user', [{ type: 'tool_result', tool_use_id: 'bound', content: 'CHECK_COMPLETED ' + JSON.stringify(check), is_error: false }], at())];
  assert.equal(push([...proved, ...bound, ...reviewed()]).permissionDecision, 'allow');
});
