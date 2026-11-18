// 2026-11-17, audit I1 + I2 (workflow-install.sh). I1: both suite commands ended in `|| true` and only
// "fail [1-9]" was searched, so a test runner that could not start read as a clean install. I2: a failed
// install stayed live (the printed restore command left every ADDED file behind), the drift guard ran only
// before the minutes-long end-to-end runs, and two installs could run at once.
// Every destination is a temp folder: the installer's root line is rewritten, HOME is never touched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { describe, it } from 'node:test';
// Every test below owns its fixture (its own temp folders, its own lock), and one install takes seconds on
// Windows, so they run in parallel: `test` only queues, `describe` at the end runs (as in guard-gaps).
const queued = [];
const test = (name, fn) => { queued.push([name, fn]); };

const here = path.dirname(fileURLToPath(import.meta.url));
const installer = path.resolve(here, '../../scripts/workflow-install.sh');
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const slash = value => value.replaceAll('\\', '/');

// Bytes on purpose (CRLF, a lone CR, NUL, 0xFF): "restored byte for byte" must not depend on line endings.
const oldKept = Buffer.concat([Buffer.from('old line one\r\nold line two\n'), Buffer.from([0, 255, 13, 10, 13])]);
const newKept = Buffer.from('new line one\nnew line two\n');
const retired = Buffer.from('retired by this release\r\n');
const passing = 'require("node:test")("fixture", () => {});\n';
// A stand-in for the candidate's end-to-end proof: it can change a live file, or wait for the test, then pass.
const fakeProof = [
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  'const { SANAD_TEST_E2E_WRITE: target, SANAD_TEST_E2E_STARTED: started, SANAD_TEST_E2E_GO: go } = process.env;',
  "if (target) { fs.mkdirSync(path.dirname(target), {recursive:true}); fs.writeFileSync(target, 'edited by hand during the run\\n'); }",
  "if (started) fs.writeFileSync(started, 'started\\n');",
  'const end = Date.now() + 90000;',
  'while (go && !fs.existsSync(go)) {',
  '  if (Date.now() > end) process.exit(1);',
  '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);',
  '}',
  ''
].join('\n');
// A test that fails AND reports what it saw live: the first line of the replaced file, whether the added
// file was there, whether the removed file was gone, and the lock's note. It proves the copy happened
// before the rollback, under the lock.
const brokenTest = [
  'const fs = require("node:fs"); const path = require("node:path");',
  'require("node:test")("the broken one", () => {',
  '  const first = fs.readFileSync(path.join(__dirname, "../kept.js"), "utf8").split(/\\r?\\n/)[0];',
  '  const added = fs.existsSync(path.join(__dirname, "../../skills/fresh/reference/note.md"));',
  '  const removed = !fs.existsSync(path.join(__dirname, "../retired.js"));',
  '  const note = fs.readFileSync(path.join(__dirname, "../../backups/.install.lock/owner"), "utf8").trim();',
  '  throw new Error(`boom, saw ${first} | added ${added} | removed ${removed} | lock: ${note}`);',
  '});',
  ''
].join('\n');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanad-install-rollback-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    const tempRoot = fs.realpathSync(os.tmpdir());
    assert.equal(path.dirname(resolved), tempRoot);
    assert.ok(path.basename(resolved).startsWith('sanad-install-rollback-'));
    fs.rmSync(resolved, {recursive:true, force:true, maxRetries:5, retryDelay:200});
  });
  const base = path.join(root, 'base');
  const cand = path.join(root, 'candidate');
  const live = path.join(root, 'live');
  const put = (folder, rel, content) => {
    const target = path.join(folder, rel);
    fs.mkdirSync(path.dirname(target), {recursive:true});
    fs.writeFileSync(target, content);
  };
  for (const folder of [base, cand, live]) {
    put(folder, 'claude/hooks/tests/fixture.test.cjs', passing);
    put(folder, 'claude/skills/gate/tests/fixture.test.cjs', passing);
    put(folder, 'claude/skills/gate/scripts/red-proof.mjs', fakeProof);
    put(folder, 'agents/skills/sanad/SKILL.md', 'existing mirror\n');
    put(folder, 'codex/config.toml', 'model_reasoning_effort = "xhigh"\n');
  }
  // One replaced file, one removed file, three added files (one in two new folders, one per mirror).
  for (const folder of [base, live]) { put(folder, 'claude/hooks/kept.js', oldKept); put(folder, 'claude/hooks/retired.js', retired); }
  put(cand, 'claude/hooks/kept.js', newKept);
  put(cand, 'claude/skills/fresh/reference/note.md', 'a new note\n');
  put(cand, 'agents/skills/fresh/SKILL.md', 'a new mirror\n');
  put(cand, 'codex/agents/sanad-boss.toml', 'model = "gpt-6-astra"\n');
  const source = fs.readFileSync(installer, 'utf8').replaceAll('\r\n', '\n');
  const rootLine = 'C="$HOME/.claude"; A="$HOME/.agents/skills"; X="$HOME/.codex"';
  assert.equal(source.split(rootLine).length, 2, 'Isolate the installer destinations without changing HOME');
  const quote = value => "'" + slash(value).replaceAll("'", "'\\''") + "'";
  const isolated = source.replace(rootLine, `C=${quote(path.join(live, 'claude'))}; A=${quote(path.join(live, 'agents/skills'))}; X=${quote(path.join(live, 'codex'))}`);
  const script = path.join(root, 'install.sh');
  fs.writeFileSync(script, isolated);
  fs.writeFileSync(path.join(root, 'empty.gitconfig'), '');
  const env = {
    ...process.env,
    SANAD_E2E_RUN: 'none',                                   // never this machine's own end-to-end runs
    GIT_CONFIG_GLOBAL: path.join(root, 'empty.gitconfig'),   // nor its git config
    GIT_CONFIG_NOSYSTEM: '1',
    SANAD_STATE_DIR: path.join(root, 'state'),
    WORKFLOW_TYPESCRIPT_RUNNER: 'fixture'                    // skip the search under ~/source/repos
  };
  delete env.NODE_TEST_CONTEXT;
  // One install; resolves when it has ended (never blocks this process: other installs run beside it).
  const run = (name, extra = {}) => new Promise(resolve => {
    const child = spawn(bash, [script, cand, base, name], {env: {...env, ...extra}, timeout:150000});
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('close', status => resolve({status, stdout, stderr}));
  });
  // Every live file (bytes) and folder, without the backups folder: equal before and after = fully rolled back.
  const snapshot = () => {
    const seen = {};
    const walk = rel => {
      for (const entry of fs.readdirSync(path.join(live, rel), {withFileTypes:true})) {
        const item = rel ? rel + '/' + entry.name : entry.name;
        if (item === 'claude/backups') continue;
        if (entry.isDirectory()) { seen[item + '/'] = 'folder'; walk(item); }
        else seen[item] = fs.readFileSync(path.join(live, item)).toString('hex');
      }
    };
    walk('');
    return seen;
  };
  const backups = path.join(live, 'claude/backups');
  const releases = () => fs.existsSync(path.join(backups, 'RELEASES.md')) ? fs.readFileSync(path.join(backups, 'RELEASES.md'), 'utf8') : '';
  return {root, base, cand, live, put, run, snapshot, backups, releases, lock: path.join(backups, '.install.lock')};
}

// A fake `node` first on PATH: `node --test …` ends as the case says, any other call is the real node.
// (A script file run by bash: a .cmd cannot be spawned without a shell on Windows.)
function fakeRunner(f, exit, output) {
  const bin = path.join(f.root, 'bin');
  fs.mkdirSync(bin, {recursive:true});
  fs.writeFileSync(path.join(f.root, 'runner-output.txt'), output);
  fs.writeFileSync(path.join(bin, 'node'), [
    '#!/usr/bin/env bash',
    'if [ "${1:-}" = "--test" ]; then cat "$SANAD_TEST_RUNNER_OUTPUT"; exit "$SANAD_TEST_RUNNER_EXIT"; fi',
    'exec "$SANAD_TEST_REAL_NODE" "$@"',
    ''
  ].join('\n'), {mode:0o755});
  const key = Object.keys(process.env).find(name => name.toLowerCase() === 'path') ?? 'PATH';
  return {
    [key]: bin + path.delimiter + process.env[key],
    SANAD_TEST_RUNNER_OUTPUT: slash(path.join(f.root, 'runner-output.txt')),
    SANAD_TEST_RUNNER_EXIT: String(exit),
    SANAD_TEST_REAL_NODE: slash(process.execPath)
  };
}

function assertRolledBack(f, result, name, before) {
  assert.ok(Number.isInteger(result.status) && result.status !== 0, `exit ${result.status}\n${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /^ROLLED BACK: the previous files are live again$/m);
  assert.deepEqual(f.snapshot(), before, 'every live file and folder is as it was before the install');
  assert.ok(fs.existsSync(path.join(f.backups, name, 'tests-hooks.log')), 'the hook suite log is kept');
  assert.ok(fs.existsSync(path.join(f.backups, name, 'tests-gate.log')), 'the gate suite log is kept');
  assert.deepEqual(fs.readFileSync(path.join(f.backups, name, 'claude/hooks/kept.js')), oldKept, 'the backup is kept');
  assert.equal(f.releases(), '', 'no RELEASES.md line for a failed install');
  assert.ok(!fs.existsSync(f.lock), 'the lock is freed');
}

test('I1: a test runner that cannot start (exit 42, no summary) is a failed install: rolled back, exit non-zero', async t => {
  const f = fixture(t);
  const before = f.snapshot();
  const result = await f.run('no-runner', fakeRunner(f, 42, 'SIMULATED: test runner startup failed, native exit 42\n'));
  assertRolledBack(f, result, 'no-runner', before);
  assert.match(result.stdout, /^ {2}suite failed \(tests-hooks\): exit 42, summary: none$/m);
  assert.match(result.stdout, /^ {2}suite failed \(tests-gate\): exit 42, summary: none$/m);
  assert.match(fs.readFileSync(path.join(f.backups, 'no-runner/tests-hooks.log'), 'utf8'), /native exit 42/);
  assert.match(fs.readFileSync(path.join(f.backups, 'no-runner/tests-gate.log'), 'utf8'), /native exit 42/);
});

test('I1: a suite passes only with exit 0, "ℹ fail 0" and a pass count above 0', async t => {
  // One case per condition, each in its own fixture.
  const cases = [
    ['exit 0 and no summary at all', 0, ''],
    ['exit 0 and a summary cut before the fail line', 0, 'ℹ tests 3\nℹ pass 3\n'],
    ['a clean summary and exit 1 (the exit is kept)', 1, 'ℹ tests 3\nℹ pass 3\nℹ fail 0\n'],
    ['exit 0 and no test passed', 0, 'ℹ tests 0\nℹ pass 0\nℹ fail 0\n'],
    ['exit 0, a clean summary and a failed one in the same log', 0, 'ℹ pass 3\nℹ fail 0\nℹ pass 2\nℹ fail 1\n']
  ];
  const failing = cases.map(async ([label, exit, output]) => {
    const f = fixture(t);
    const before = f.snapshot();
    const result = await f.run('strict-suite', fakeRunner(f, exit, output));
    assert.match(result.stdout, /^ {2}suite failed \(tests-hooks\): exit /m, label);
    assertRolledBack(f, result, 'strict-suite', before);
  });
  // The same fake runner with a clean result (CRLF line ends) installs: the cases above fail for their result alone.
  const passes = (async () => {
    const f = fixture(t);
    const clean = await f.run('strict-suite', fakeRunner(f, 0, 'ℹ tests 3\r\nℹ pass 3\r\nℹ fail 0\r\n'));
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    assert.deepEqual(fs.readFileSync(path.join(f.live, 'claude/hooks/kept.js')), newKept);
    assert.match(f.releases(), /strict-suite/);
  })();
  const results = await Promise.allSettled([...failing, passes]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
});

test('I2: a failing test after the copy rolls the install back: added files gone, replaced and removed files restored byte for byte, logs kept, no release line', async t => {
  const f = fixture(t);
  f.put(f.cand, 'claude/hooks/tests/broken.test.cjs', brokenTest);
  const before = f.snapshot();
  const result = await f.run('broken-release');
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout, /^INSTALLED 5 changed, 1 removed\./m);
  assert.match(result.stdout, /^ {2}failed \(tests-hooks\): the broken one$/m);
  assert.match(result.stdout, /^Full test output: .*tests-hooks\.log and .*tests-gate\.log$/m);
  assertRolledBack(f, result, 'broken-release', before);
  assert.deepEqual(fs.readFileSync(path.join(f.live, 'claude/hooks/kept.js')), oldKept, 'replaced file restored');
  assert.deepEqual(fs.readFileSync(path.join(f.live, 'claude/hooks/retired.js')), retired, 'removed file restored');
  for (const added of ['claude/hooks/tests/broken.test.cjs', 'claude/skills/fresh', 'agents/skills/fresh', 'codex/agents'])
    assert.ok(!fs.existsSync(path.join(f.live, added)), added + ' is gone again');
  // The suite really ran on the installed files: the failing test saw the new file, the added one, no removed one.
  const log = fs.readFileSync(path.join(f.backups, 'broken-release/tests-hooks.log'), 'utf8');
  assert.match(log, /boom, saw new line one \| added true \| removed true/);
  // A hard kill is the one case no trap can undo: the lock's note then names the undo list.
  assert.match(log, /lock: broken-release, writing live files since .*if it was killed, undo it by hand from .*broken-release\/manifest\.txt/);
  assert.match(fs.readFileSync(path.join(f.backups, 'broken-release/tests-gate.log'), 'utf8'), /ℹ pass 1/);
  assert.doesNotMatch(result.stdout, /Restore with:/, 'the old hand-restore command left added files behind');
});

test('I2: an install that breaks half way (a copy fails) is rolled back too', async t => {
  const f = fixture(t);
  // A live FILE sits where the candidate needs a folder: the drift guard cannot see it, the copy fails on it
  // after earlier files (agents/…, claude/hooks/kept.js) were already written.
  f.put(f.live, 'claude/skills/zz-blocked', 'a file, not a folder\n');
  f.put(f.cand, 'claude/skills/zz-blocked/note.md', 'cannot land\n');
  const before = f.snapshot();
  const result = await f.run('half-way');
  assert.ok(Number.isInteger(result.status) && result.status !== 0, `exit ${result.status}\n${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /^ROLLED BACK: the previous files are live again$/m);
  assert.doesNotMatch(result.stdout, /^INSTALLED /m);
  assert.deepEqual(f.snapshot(), before, 'the files written before the failure are undone');
  assert.equal(f.releases(), '');
  assert.ok(!fs.existsSync(f.lock), 'the lock is freed');
});

test('I2: a rollback that cannot finish says so, names the path and exits 4', async t => {
  const f = fixture(t);
  // The failing test deletes one backup copy while the suite runs: that file cannot be put back.
  f.put(f.cand, 'claude/hooks/tests/broken.test.cjs', [
    'const fs = require("node:fs"); const path = require("node:path");',
    'require("node:test")("the broken one", () => {',
    '  fs.rmSync(path.join(__dirname, "../../backups/no-way-back/claude/hooks/kept.js"));',
    '  throw new Error("boom");',
    '});',
    ''
  ].join('\n'));
  const result = await f.run('no-way-back');
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.match(result.stdout, /^ {2}not restored: claude\/hooks\/kept\.js$/m);
  assert.match(result.stdout, /^ROLLBACK NOT COMPLETE: .*manifest\.txt/m);
  assert.doesNotMatch(result.stdout, /^ROLLED BACK:/m);
  // Everything else is still undone, and nothing claims a release.
  assert.deepEqual(fs.readFileSync(path.join(f.live, 'claude/hooks/retired.js')), retired);
  assert.ok(!fs.existsSync(path.join(f.live, 'claude/skills/fresh')));
  assert.ok(!fs.existsSync(path.join(f.live, 'claude/hooks/tests/broken.test.cjs')));
  assert.equal(f.releases(), '');
  assert.ok(!fs.existsSync(f.lock), 'the lock is freed');
});

test('I2: a clean install still installs, writes the release line, keeps a manifest and frees the lock', async t => {
  const f = fixture(t);
  const result = await f.run('clean-release');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^INSTALLED 4 changed, 1 removed\. Backup: /m);
  assert.match(result.stdout, /^hooks: ℹ pass 1 ℹ fail 0/m);
  assert.match(result.stdout, /^gate: ℹ pass 1 ℹ fail 0/m);
  assert.doesNotMatch(result.stdout, /ROLLED BACK|suite failed/);
  assert.deepEqual(fs.readFileSync(path.join(f.live, 'claude/hooks/kept.js')), newKept);
  assert.ok(!fs.existsSync(path.join(f.live, 'claude/hooks/retired.js')));
  assert.equal(fs.readFileSync(path.join(f.live, 'claude/skills/fresh/reference/note.md'), 'utf8'), 'a new note\n');
  assert.equal(fs.readFileSync(path.join(f.live, 'agents/skills/fresh/SKILL.md'), 'utf8'), 'a new mirror\n');
  assert.equal(fs.readFileSync(path.join(f.live, 'codex/agents/sanad-boss.toml'), 'utf8'), 'model = "gpt-6-astra"\n');
  assert.deepEqual(fs.readFileSync(path.join(f.backups, 'clean-release/claude/hooks/kept.js')), oldKept);
  assert.deepEqual(fs.readFileSync(path.join(f.backups, 'clean-release/claude/hooks/retired.js')), retired);
  const lines = f.releases().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /clean-release · changed: .*claude\/hooks\/kept\.js.* · removed: claude\/hooks\/retired\.js · hooks: ℹ pass 1 ℹ fail 0 · gate: ℹ pass 1 ℹ fail 0/);
  const manifest = fs.readFileSync(path.join(f.backups, 'clean-release/manifest.txt'), 'utf8').split(/\r?\n/);
  for (const line of ['replaced claude/hooks/kept.js', 'removed claude/hooks/retired.js', 'added claude/skills/fresh/reference/note.md', 'added agents/skills/fresh/SKILL.md', 'added codex/agents/sanad-boss.toml'])
    assert.ok(manifest.includes(line), 'manifest line: ' + line);
  assert.ok(!fs.existsSync(f.lock), 'the lock is freed');
});

test('I2: live drift that appears during the end-to-end runs aborts before any write', async t => {
  const kinds = [
    ['claude/hooks/kept.js', /^DRIFT: claude\/hooks\/kept\.js changed live since the candidate was made$/m],
    ['claude/skills/fresh/reference/note.md', /^DRIFT: claude\/skills\/fresh\/reference\/note\.md now exists live$/m]
  ];
  const results = await Promise.allSettled(kinds.map(async ([rel, message]) => {
    const f = fixture(t);
    const target = path.join(f.live, rel);
    const result = await f.run('late-drift', {SANAD_E2E_RUN: `${path.join(f.root, 'repo')}|web|node -e 0`, SANAD_TEST_E2E_WRITE: target});
    assert.ok(Number.isInteger(result.status) && result.status !== 0, `exit ${result.status}\n${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /^E2E: .*repo \(web\): node -e 0$/m);
    assert.match(result.stdout, message);
    assert.ok(result.stdout.indexOf('E2E: ') < result.stdout.search(message), 'the second guard ran after the end-to-end run');
    assert.match(result.stdout, /^ABORTED: .*nothing was changed\.$/m);
    assert.doesNotMatch(result.stdout, /^INSTALLED /m);
    assert.equal(fs.readFileSync(target, 'utf8'), 'edited by hand during the run\n', 'the hand edit is not overwritten');
    if (rel !== 'claude/hooks/kept.js') assert.deepEqual(fs.readFileSync(path.join(f.live, 'claude/hooks/kept.js')), oldKept);
    assert.deepEqual(fs.readFileSync(path.join(f.live, 'claude/hooks/retired.js')), retired);
    assert.ok(!fs.existsSync(path.join(f.live, 'agents/skills/fresh')));
    assert.ok(!fs.existsSync(path.join(f.live, 'codex/agents')));
    assert.ok(!fs.existsSync(path.join(f.backups, 'late-drift')), 'no backup folder either');
    assert.equal(f.releases(), '');
    assert.ok(!fs.existsSync(f.lock), 'the lock is freed');
  }));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
});

test('I2: a second install while one holds the lock aborts untouched; the first finishes and frees the lock', async t => {
  const f = fixture(t);
  const started = path.join(f.root, 'e2e-started');
  const go = path.join(f.root, 'e2e-go');
  const before = f.snapshot();
  // The first install waits inside its end-to-end run (after the lock, before any write) until the test says go.
  const first = f.run('first', {SANAD_E2E_RUN: `${path.join(f.root, 'repo')}|web|node -e 0`, SANAD_TEST_E2E_STARTED: started, SANAD_TEST_E2E_GO: go});
  let ended = false;
  first.then(() => { ended = true; });
  try {
    const end = Date.now() + 60000;
    while (!fs.existsSync(started)) {
      assert.ok(!ended && Date.now() < end, 'the first install reached its end-to-end run');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const second = await f.run('second');
    assert.ok(Number.isInteger(second.status) && second.status !== 0, `exit ${second.status}\n${second.stdout}${second.stderr}`);
    assert.match(second.stdout, /^ABORTED: another install is running \(first, started .*\); nothing was changed\./m);
    assert.doesNotMatch(second.stdout, /^INSTALLED /m);
    assert.deepEqual(f.snapshot(), before, 'the second install changed nothing');
    assert.ok(!fs.existsSync(path.join(f.backups, 'second')), 'no backup folder for the second install');
    assert.ok(fs.existsSync(f.lock), 'the aborted install left the first one\'s lock alone');
  } finally {
    fs.writeFileSync(go, 'go\n');   // also on a failed assertion: the first install must end before the cleanup
    await first;
  }
  const done = await first;
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.match(done.stdout, /^INSTALLED 4 changed, 1 removed\./m);
  assert.deepEqual(fs.readFileSync(path.join(f.live, 'claude/hooks/kept.js')), newKept);
  assert.match(f.releases(), /first/);
  assert.doesNotMatch(f.releases(), /second/);
  assert.ok(!fs.existsSync(f.lock), 'the lock is freed when the first install ends');
  // A lock left by a killed install: the next one still aborts untouched, and says which folder to remove.
  fs.mkdirSync(f.lock);
  const stale = await f.run('third');
  assert.ok(Number.isInteger(stale.status) && stale.status !== 0, `exit ${stale.status}\n${stale.stdout}${stale.stderr}`);
  assert.match(stale.stdout, /^ABORTED: another install is running .*\.install\.lock/m);
  assert.ok(fs.existsSync(f.lock), 'a lock this run did not take is never removed by it');
  assert.ok(!fs.existsSync(path.join(f.backups, 'third')));
});

test('I1: FORCE_COLOR set (a colour terminal) does not hide the summary: a green install stays installed', async t => {
  const f = fixture(t);
  const result = await f.run('colour', {FORCE_COLOR: '1'});
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /ROLLED BACK|suite failed/);
  assert.deepEqual(fs.readFileSync(path.join(f.live, 'claude/hooks/kept.js')), newKept);
  assert.match(f.releases(), /colour/);
});

test('I1: only the gate suite fails: that alone fails the install (exit 2, rolled back)', async t => {
  const f = fixture(t);
  f.put(f.cand, 'claude/skills/gate/tests/broken.test.cjs', 'require("node:test")("gate broken", () => { throw new Error("boom"); });\n');
  const before = f.snapshot();
  const result = await f.run('gate-only');
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout, /^ {2}suite failed \(tests-gate\): exit 1/m);
  assert.doesNotMatch(result.stdout, /suite failed \(tests-hooks\)/);
  assertRolledBack(f, result, 'gate-only', before);
});

test('I2: a manifest that cannot be read at rollback time is NOT "rolled back": exit 4', async t => {
  const f = fixture(t);
  f.put(f.cand, 'claude/hooks/tests/broken.test.cjs', [
    'const fs = require("node:fs"); const path = require("node:path");',
    'require("node:test")("the broken one", () => {',
    '  fs.rmSync(path.join(__dirname, "../../backups/no-manifest/manifest.txt"));',
    '  throw new Error("boom");',
    '});',
    ''
  ].join('\n'));
  const result = await f.run('no-manifest');
  assert.equal(result.status, 4, result.stdout + result.stderr);
  assert.match(result.stdout, /manifest missing/);
  assert.match(result.stdout, /^ROLLBACK NOT COMPLETE: /m);
  assert.doesNotMatch(result.stdout, /^ROLLED BACK:/m);
});

describe('workflow-install rollback', { concurrency: 4 }, () => {
  for (const [name, fn] of queued) it(name, fn);
});
