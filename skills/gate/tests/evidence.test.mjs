import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { runCommand, assertHttp, withCleanup, evidenceLog, redact, rerunSuggestion } from '../scripts/evidence.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-evidence-tests-'));
// Runs bound to a repository take a lock (see checkLockDir); keep them out of the real one.
const lockDir = path.join(root, 'locks');
process.env.SANAD_CHECK_LOCK_DIR = lockDir;
const emptyIgnore = path.join(root, 'empty-ignore');
fs.writeFileSync(emptyIgnore, '');
function sourceFixture() {
  const repo = fs.mkdtempSync(path.join(root, 'repo-'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q'); git('config', 'user.name', 'Evidence fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'core.autocrlf', 'false'); git('config', 'core.excludesFile', emptyIgnore);
  fs.writeFileSync(path.join(repo, 'app.js'), 'export const value = 1;\n');
  git('add', 'app.js'); git('commit', '-qm', 'fixture');
  return { repo, git };
}
test('computed source ignores forged source, preserves the index and survives committing unchanged content', async () => {
  const { repo, git } = sourceFixture();
  fs.writeFileSync(path.join(repo, 'app.js'), 'export const value = 2;\n');
  git('add', 'app.js');
  fs.writeFileSync(path.join(repo, 'app.js'), 'export const value = 3;\n');
  fs.writeFileSync(path.join(repo, 'new.js'), 'export const added = true;\n');
  const index = fs.readFileSync(path.join(repo, '.git', 'index'));
  const result = await runCommand({ executable: process.execPath, args: ['-e', 'console.log("checked")'], cwd: repo, outputRoot: root, source: { toplevel: 'forged', treeBefore: 'fake', treeAfter: 'fake' } });
  assert.equal(result.status, 'passed');
  assert.deepEqual(fs.readFileSync(path.join(repo, '.git', 'index')), index);
  assert.equal(result.source.toplevel, fs.realpathSync.native(repo));
  assert.match(result.source.treeBefore, /^[0-9a-f]{40,64}$/);
  assert.equal(result.source.treeBefore, result.source.treeAfter);
  git('add', 'app.js', 'new.js'); git('commit', '-qm', 'checked content');
  assert.equal(result.source.treeAfter, git('rev-parse', 'HEAD^{tree}'));
});
test('a zero exit cannot pass when the command changes source', async () => {
  const { repo } = sourceFixture();
  const result = await runCommand({ executable: process.execPath, args: ['-e', 'require("node:fs").writeFileSync("app.js", "changed")'], cwd: repo, outputRoot: root });
  assert.equal(result.nativeExitCode, 0);
  assert.equal(result.status, 'failed');
  assert.notEqual(result.source.treeBefore, result.source.treeAfter);
  assert.match(result.reason, /source.*changed/i);
});
test('forced-added ignored source is refreshed from worktree and matches the unchanged commit', async () => {
  const { repo, git } = sourceFixture();
  fs.writeFileSync(path.join(repo, '.gitignore'), 'generated/\n');
  fs.mkdirSync(path.join(repo, 'generated'));
  fs.writeFileSync(path.join(repo, 'generated', 'forced [file].js'), 'first staged bytes\n');
  git('add', '.gitignore'); git('add', '-f', '--', 'generated/forced [file].js');
  fs.writeFileSync(path.join(repo, 'generated', 'forced [file].js'), 'verified worktree bytes\n');
  fs.writeFileSync(path.join(repo, 'generated', 'deleted.js'), 'removed before verification\n');
  git('add', '-f', '--', 'generated/deleted.js');
  fs.unlinkSync(path.join(repo, 'generated', 'deleted.js'));
  git('update-index', '--assume-unchanged', 'app.js');
  fs.writeFileSync(path.join(repo, 'app.js'), 'changed despite assume-unchanged\n');
  const index = fs.readFileSync(path.join(repo, '.git', 'index'));
  const result = await runCommand({ executable: process.execPath, args: ['-e', 'console.log("checked")'], cwd: repo, outputRoot: root });
  assert.equal(result.status, 'passed');
  assert.deepEqual(fs.readFileSync(path.join(repo, '.git', 'index')), index);
  git('update-index', '--no-assume-unchanged', 'app.js');
  git('add', '-u'); git('commit', '-qm', 'checked forced addition');
  assert.equal(result.source.treeAfter, git('rev-parse', 'HEAD^{tree}'));
});
test('inherited Git redirection cannot bind a different repository', async () => {
  const { repo, git } = sourceFixture();
  const other = sourceFixture();
  const previous = Object.fromEntries(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].map(key => [key, process.env[key]]));
  try {
    process.env.GIT_DIR = path.join(other.repo, '.git');
    process.env.GIT_WORK_TREE = other.repo;
    process.env.GIT_INDEX_FILE = path.join(other.repo, '.git', 'index');
    const result = await runCommand({ executable: process.execPath, args: ['-e', 'console.log("checked")'], cwd: repo, outputRoot: root });
    assert.equal(result.status, 'passed');
    assert.equal(result.source.toplevel, fs.realpathSync.native(repo));
    for (const key of Object.keys(previous)) delete process.env[key];
    assert.equal(result.source.treeAfter, git('rev-parse', 'HEAD^{tree}'));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
test('a source-bound run holds a lock on its repository while it runs, and releases it after a pass or a failure', async () => {
  const { repo } = sourceFixture();
  fs.rmSync(lockDir, { recursive: true, force: true });
  const lister = 'const fs=require("node:fs"),p=require("node:path"),d=process.argv[1];console.log(JSON.stringify(fs.existsSync(d)?fs.readdirSync(d).map(n=>JSON.parse(fs.readFileSync(p.join(d,n),"utf8"))):[]))';
  const bound = await runCommand({ executable: process.execPath, args: ['-e', lister, lockDir], cwd: repo, outputRoot: root });
  assert.equal(bound.status, 'passed');
  const seen = JSON.parse(fs.readFileSync(bound.stdout, 'utf8'));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].toplevel, bound.source.toplevel);
  assert.equal(seen[0].runId, bound.runId);
  assert.ok(Number.isInteger(seen[0].pid));
  assert.ok(Date.parse(seen[0].expiresAt) > Date.parse(seen[0].startedAt));
  // 2026-11-13: the lock names when its process started, so a later process given the same id is told apart.
  assert.ok(Date.parse(seen[0].pidStartedAt) <= Date.parse(seen[0].startedAt), 'the lock names its process start: ' + JSON.stringify(seen[0]));
  assert.deepEqual(fs.readdirSync(lockDir), [], 'released when the run ends');
  const failed = await runCommand({ executable: process.execPath, args: ['-e', 'process.exitCode = 3'], cwd: repo, outputRoot: root });
  assert.equal(failed.status, 'failed');
  assert.deepEqual(fs.readdirSync(lockDir), [], 'released after a failure too');
  const unbound = await runCommand({ executable: process.execPath, args: ['-e', lister, lockDir], cwd: root, outputRoot: root });
  assert.equal(fs.readFileSync(unbound.stdout, 'utf8').trim(), '[]', 'a run with no repository takes no lock');
});

test('non-Git checks cannot produce passing publishing evidence', async () => {
  const result = await runCommand({ executable: process.execPath, args: ['-e', 'console.log("utility")'], cwd: root, outputRoot: root, source: { treeBefore: 'forged' } });
  assert.equal(result.nativeExitCode, 0); assert.equal(result.status, 'failed');
  assert.equal(result.source, null); assert.match(result.reason, /source|git/i);
});
test('evidence output inside the source repository is rejected before execution', async () => {
  const { repo } = sourceFixture();
  await assert.rejects(() => runCommand({ executable: process.execPath, args: ['-e', 'require("node:fs").writeFileSync("should-not-run", "bad")'], cwd: repo, outputRoot: path.join(repo, 'evidence') }), /outside.*repository/i);
  assert.equal(fs.existsSync(path.join(repo, 'should-not-run')), false);
});
test('native failure and full stdout/stderr survive summary and literal argv', async () => {
  const arg = 'literal ; & $(not-a-command) `text`';
  const result = await runCommand({ executable: process.execPath, args: ['-e', 'process.stdout.write(process.argv[1]); process.stderr.write("details\\n"); process.exitCode=7;', arg], cwd: root, outputRoot: root });
  assert.equal(result.nativeExitCode, 7); assert.equal(result.status, 'failed');
  assert.equal(fs.readFileSync(result.stdout, 'utf8'), arg);
  assert.equal(fs.readFileSync(result.stderr, 'utf8'), 'details\n');
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.runDir, 'metadata.json'), 'utf8')).nativeExitCode, 7);
});
test('logs redact a secret split across chunks before writing to disk', () => {
  const file = path.join(root, 'secret.log'); const log = evidenceLog(file, { secrets: ['standalone-secret-value'] });
  log.write('TOKEN=split'); log.write('-secret\nstandalone-'); log.write('secret-value\nAuthorization: Bearer abcdefghijk\n'); log.close();
  const saved = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(saved, /split-secret|standalone-secret-value|abcdefghijk/);
  assert.match(saved, /REDACTED/);
});
test('process timeout, spawn failure and output overflow cannot pass', async () => {
  const timed = await runCommand({ executable: process.execPath, args: ['-e', 'console.log("started");setInterval(()=>{},1000)'], cwd: root, outputRoot: root, timeoutMs: 300 });
  assert.equal(timed.status, 'failed'); assert.match(timed.reason, /Timed out/);
  assert.match(fs.readFileSync(timed.stdout, 'utf8'), /started/);
  const missing = await runCommand({ executable: path.join(root, 'missing.exe'), cwd: root, outputRoot: root });
  assert.equal(missing.status, 'failed'); assert.equal(missing.nativeExitCode, null);
  const huge = await runCommand({ executable: process.execPath, args: ['-e', 'console.log("x".repeat(5000))'], cwd: root, outputRoot: root, maxBytes: 100 });
  assert.equal(huge.status, 'failed'); assert.match(huge.reason, /bound/);
});
test('CLI returns the native exit instead of its summary exit', () => {
  const spec = path.join(root, 'spec.json');
  fs.writeFileSync(spec, JSON.stringify({ executable: process.execPath, args: ['-e', 'console.log("before failure");process.exitCode=9'], cwd: root, outputRoot: root }));
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/evidence.mjs', import.meta.url)), '--spec', spec], { encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 9); assert.match(run.stdout, /CHECK_COMPLETED/);
});
// 2026-11-13: a full suite's output was cut in the middle, and its failing test could not be seen.
test('CLI: a failed check prints its totals and failing tests above the receipt line', () => {
  const spec = path.join(root, 'spec-summary.json');
  const body = 'for (let i = 0; i < 400; i++) console.log("  ok " + i); console.log(" FAIL  src/a.test.ts > [C1] names the part"); console.log(" Test Files  1 failed | 9 passed (10)"); process.exitCode = 1';
  fs.writeFileSync(spec, JSON.stringify({ executable: process.execPath, args: ['-e', body], cwd: root, outputRoot: root }));
  const script = fileURLToPath(new URL('../scripts/evidence.mjs', import.meta.url));
  const failed = spawnSync(process.execPath, [script, '--spec', spec], { encoding: 'utf8', windowsHide: true });
  assert.equal(failed.status, 1);
  const lines = failed.stdout.trim().split(/\r?\n/);
  assert.match(lines[0], /^CHECK_SUMMARY — full output: .+stdout\.log$/);
  // This folder is no git repository, so the run also names that reason; the runner's lines follow it.
  assert.deepEqual(lines.slice(1, 4), ['  reason: Cannot bind source: cwd is not an accessible Git repository.',
    '  Test Files  1 failed | 9 passed (10)', '  FAIL  src/a.test.ts > [C1] names the part']);
  assert.ok(!lines.some(l => /ok 3\d\d/.test(l)), 'the 400 passing lines are not repeated');
  assert.match(lines[lines.length - 1], /^CHECK_COMPLETED \{/, 'the receipt stays the last line');
  // A passed check prints no summary: run-summary.test.mjs (summaryLines of a passed receipt is empty).
});

// 2026-11-14: the only failure of a 1759-test Vitest suite was "Test timed out in 5000ms." in
// src/utils/exam-results-export.test.ts, a slow test the task never touched; writing the rerun spec and the
// CHECK RETIRED line by hand cost minutes. The task's repository: a base on origin/staging, one own change.
const SLOW = 'src/utils/exam-results-export.test.ts';
const TIMEOUT = 'Error: Test timed out in 5000ms.\nIf this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".';
const vitestOut = failed => {
  const files = new Set(failed.map(f => f.file)).size;
  return [' ❯ ' + failed[0].file + ' (12 tests | 1 failed) 5123ms', ` Test Files  ${files} failed | ${112 - files} passed (112)`,
    `      Tests  ${failed.length} failed | ${1759 - failed.length} passed (1759)`, '   Duration  412.80s'].join('\n') + '\n';
};
const vitestErr = failed => ['', `⎯⎯⎯⎯⎯⎯⎯ Failed Tests ${failed.length} ⎯⎯⎯⎯⎯⎯⎯`, '',
  ...failed.flatMap((f, i) => [` FAIL  ${f.file} > exportExamResults > ${f.name || 'builds the sheet'}`, f.error || TIMEOUT, ' ❯ ' + f.file + ':41:3', '', `⎯⎯⎯[${i + 1}/${failed.length}]⎯`, ''])].join('\n');
function taskRepo() {
  const { repo, git } = sourceFixture();
  const web = path.join(repo, 'web');
  for (const [file, text] of [[SLOW, 'it("builds the sheet")\n'], ['src/utils/exam-results-export.ts', 'export {};\n'], ['src/feature.ts', 'export const on = false;\n'], ['src/pages/Exam.test.tsx', 'it("x")\n']]) {
    fs.mkdirSync(path.dirname(path.join(web, file)), { recursive: true }); fs.writeFileSync(path.join(web, file), text);
  }
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  git('add', '-A'); git('commit', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/staging', 'HEAD');
  fs.writeFileSync(path.join(web, 'src', 'feature.ts'), 'export const on = true;\n');   // the task's own change
  return { repo, web, git };
}
function failedReceipt(repo, stdout, stderr) {
  const dir = fs.mkdtempSync(path.join(root, 'logs-'));
  fs.writeFileSync(path.join(dir, 'stdout.log'), stdout); fs.writeFileSync(path.join(dir, 'stderr.log'), stderr);
  return { status: 'failed', nativeExitCode: 1, signal: null, reason: null, stdout: path.join(dir, 'stdout.log'), stderr: path.join(dir, 'stderr.log'), source: { toplevel: fs.realpathSync.native(repo) } };
}
const SCRIPT = 'C:/u/.claude/skills/gate/scripts/evidence.mjs';
const vitestSpec = web => ({ executable: process.execPath, args: ['node_modules/vitest/vitest.mjs', 'run'], cwd: web, outputRoot: root });

test('CLI: a suite that failed only by a timeout in a test file the task does not touch gets a rerun spec and a CHECK RETIRED line the stop hook accepts', () => {
  const { web } = taskRepo();
  // A stand-in for vitest: the full run fails by the timeout; it passes only when asked for that file with the longer timeout.
  fs.mkdirSync(path.join(web, 'node_modules', 'vitest'), { recursive: true });
  fs.writeFileSync(path.join(web, 'node_modules', 'vitest', 'vitest.mjs'), `const a = process.argv.slice(2);
if (a.join(' ') === 'run ${SLOW} --testTimeout=60000') console.log(' Test Files  1 passed (1)\\n      Tests  12 passed (12)');
else { process.stdout.write(${JSON.stringify(vitestOut([{ file: SLOW }]))}); process.stderr.write(${JSON.stringify(vitestErr([{ file: SLOW }]))}); process.exitCode = 1; }\n`);
  // The hook credits only the helper under a .claude folder; the spec folder has a space in its name.
  const scripts = path.join(root, 'home', '.claude', 'skills', 'gate', 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  for (const name of ['evidence.mjs', 'run-summary.mjs', 'is-main.mjs']) fs.copyFileSync(fileURLToPath(new URL('../scripts/' + name, import.meta.url)), path.join(scripts, name));
  const script = path.join(scripts, 'evidence.mjs').replace(/\\/g, '/');
  fs.mkdirSync(path.join(root, 'check specs'), { recursive: true });
  const specArg = path.join(root, 'check specs').replace(/\\/g, '/') + '/frontend-full.json';
  const rerunArg = specArg.replace('frontend-full.json', 'frontend-full-rerun-timeouts.json');
  fs.writeFileSync(specArg, JSON.stringify(vitestSpec(web)));
  const cli = spec => spawnSync(process.execPath, [script, '--spec', spec], { encoding: 'utf8', windowsHide: true });
  const red = cli(specArg);
  assert.equal(red.status, 1, 'the native exit stays: ' + red.stderr);
  const lines = red.stdout.trim().split(/\r?\n/);
  assert.equal(JSON.parse(lines.pop().replace(/^CHECK_COMPLETED /, '')).status, 'failed', 'the receipt stays the last line');
  assert.equal(lines.at(-2), 'CHECK_RERUN: only timeouts, in test files this change does not touch: ' + SLOW);
  const typed = spec => `node ${script} --spec "${spec}"`;
  const retire = JSON.parse(/^CHECK RETIRED: (\{.*\})$/.exec(lines.at(-1))[1]);
  assert.deepEqual([retire.failed, retire.replacement], [typed(specArg), typed(rerunArg)]);
  assert.match(retire.reason, /timeout.*exam-results-export\.test\.ts/);
  assert.deepEqual(JSON.parse(fs.readFileSync(rerunArg, 'utf8')), { ...vitestSpec(web), args: ['node_modules/vitest/vitest.mjs', 'run', SLOW, '--testTimeout=60000'] });
  const green = cli(rerunArg);
  assert.equal(green.status, 0, green.stdout + green.stderr);
  // The stop hook's own scanner: the printed line, sent as written, retires the failure once the rerun passes.
  const scan = createRequire(import.meta.url)('../../../hooks/lib/transcript-scan.js');
  const message = (role, content) => ({ type: role, message: { role, content } });
  const run = (id, command, out, isError) => [message('assistant', [{ type: 'tool_use', name: 'Bash', id, input: { command } }]),
    message('user', [{ type: 'tool_result', tool_use_id: id, content: out, is_error: isError }])];
  let n = 0;
  const scanOf = entries => { const file = path.join(root, `transcript-${++n}.jsonl`); fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n'); return scan.scanTranscript(file); };
  const state = process.env.SANAD_STATE_DIR;
  delete process.env.SANAD_STATE_DIR;   // a test transcript writes no hook state
  try {
    const redRun = run('red', typed(specArg), red.stdout, true), greenRun = run('green', typed(rerunArg), green.stdout, false);
    assert.ok(scanOf([...redRun, ...greenRun]).lastFailedVerifyStop >= 0, 'the line in the tool output alone retires nothing');
    assert.equal(scanOf([...redRun, message('assistant', [{ type: 'text', text: lines.at(-1) }]), ...greenRun]).lastFailedVerifyStop, -1);
  } finally { if (state !== undefined) process.env.SANAD_STATE_DIR = state; }
});

test('no rerun suggestion for a timeout in a test file the task changed, next to a source file it changed, or without a base', async () => {
  const { repo, web, git } = taskRepo();
  const ask = (specArg = 'C:/checks/frontend-full.json') => rerunSuggestion({ receipt: failedReceipt(repo, vitestOut([{ file: SLOW }]), vitestErr([{ file: SLOW }])), spec: vitestSpec(web), specArg, script: SCRIPT });
  const offered = await ask();
  assert.deepEqual(offered.lines, ['CHECK_RERUN: only timeouts, in test files this change does not touch: ' + SLOW,
    'CHECK RETIRED: ' + JSON.stringify({ failed: `node ${SCRIPT} --spec C:/checks/frontend-full.json`, replacement: `node ${SCRIPT} --spec C:/checks/frontend-full-rerun-timeouts.json`, reason: JSON.parse(offered.lines[1].slice(15)).reason })]);
  assert.equal(path.basename(offered.file), 'frontend-full-rerun-timeouts.json');
  assert.equal(await ask('C:/checks/frontend-full-rerun-timeouts.json'), null, 'a rerun that timed out again is no load noise');
  fs.appendFileSync(path.join(web, SLOW), '// changed\n');
  assert.equal(await ask(), null, 'the failing test file is changed in the working tree');
  git('add', '-A'); git('commit', '-qm', 'the task changes the slow test');
  assert.equal(await ask(), null, 'the failing test file is changed in a commit after the base');
  git('reset', '-q', '--hard', 'origin/staging');
  assert.ok(await ask(), 'back to the base: offered again');
  fs.appendFileSync(path.join(web, 'src', 'utils', 'exam-results-export.ts'), '// slower now\n');
  assert.equal(await ask(), null, 'the source file the test is named after is changed');
  git('checkout', '--', 'web/src/utils/exam-results-export.ts');
  git('config', 'sanad.integration', 'develop');
  assert.equal(await ask(), null, 'no origin/develop: no base, no suggestion');
  git('update-ref', 'refs/remotes/origin/develop', 'HEAD');
  assert.ok(await ask(), 'the integration branch comes from git config sanad.integration');
});

test('no rerun suggestion when a timeout comes with an assertion, or the check failed for another reason', async () => {
  const { repo, web } = taskRepo();
  const both = [{ file: SLOW }, { file: 'src/pages/Exam.test.tsx', name: 'names no old section', error: "AssertionError: expected 'Part 1' to be null" }];
  const ask = (receipt) => rerunSuggestion({ receipt, spec: vitestSpec(web), specArg: 'C:/checks/frontend-full.json', script: SCRIPT });
  assert.equal(await ask(failedReceipt(repo, vitestOut(both), vitestErr(both))), null);
  const alone = failedReceipt(repo, vitestOut([{ file: SLOW }]), vitestErr([{ file: SLOW }]));
  assert.ok(await ask(alone), 'the timeout alone is offered');
  for (const change of [{ reason: 'Timed out' }, { reason: 'Verified source changed while the command was running.' }, { status: 'passed', nativeExitCode: 0 }, { nativeExitCode: null }, { source: null }]) {
    assert.equal(await ask({ ...alone, ...change }), null, JSON.stringify(change));
  }
  // The CLI refuses a spec over 64 KB: a rerun spec it would refuse is no offer (2026-11-14).
  const big = await rerunSuggestion({ receipt: alone, spec: { ...vitestSpec(web), secrets: ['x'.repeat(64000)] }, specArg: 'C:/checks/frontend-full.json', script: SCRIPT });
  assert.equal(big, null, 'a rerun spec over 64 KB');
  // A run told to stop at the first failure never ran the rest: no rerun of one file can stand for it.
  for (const bail of ['--bail', '--bail=1', '-b']) {
    const stopped = await rerunSuggestion({ receipt: alone, spec: { ...vitestSpec(web), args: [...vitestSpec(web).args, bail] }, specArg: 'C:/checks/frontend-full.json', script: SCRIPT });
    assert.equal(stopped, null, bail);
  }
});

test('ssh form: the files and the longer timeout go at the end of the remote command; a pipe or another runner gives nothing', async () => {
  const { repo, web } = taskRepo();
  const receipt = failedReceipt(repo, vitestOut([{ file: SLOW }]), vitestErr([{ file: SLOW }]));
  const remote = 'cd /d C:\\repos\\app\\web && C:\\tools\\node20\\node.exe node_modules\\vitest\\vitest.mjs run';
  const ask = line => rerunSuggestion({ receipt, spec: { executable: 'C:/Windows/System32/OpenSSH/ssh.exe', args: ['-o', 'BatchMode=yes', 'pc2', line], cwd: web, outputRoot: root, timeoutMs: 1500000 },
    specArg: 'C:/checks/frontend-full-remote.json', script: SCRIPT });
  const offered = await ask(remote);
  assert.deepEqual(offered.spec, { executable: 'C:/Windows/System32/OpenSSH/ssh.exe', args: ['-o', 'BatchMode=yes', 'pc2', `${remote} ${SLOW} --testTimeout=60000`], cwd: web, outputRoot: root, timeoutMs: 1500000 });
  assert.equal(JSON.parse(offered.lines[1].slice(15)).replacement, `node ${SCRIPT} --spec C:/checks/frontend-full-remote-rerun-timeouts.json`);
  assert.equal((await ask(remote + ' 2>&1')).spec.args.at(-1), `${remote} ${SLOW} --testTimeout=60000 2>&1`, 'before a trailing stream merge');
  assert.equal((await ask('cd /d C:\\repos\\app\\web && npm test')).spec.args.at(-1), `cd /d C:\\repos\\app\\web && npm test -- ${SLOW} --testTimeout=60000`, 'npm passes them on after --');
  assert.equal(await ask(remote + ' | findstr FAIL'), null, 'the words would go to the pipe');
  assert.equal(await ask(remote + ' > out.log'), null, 'a redirection');
  assert.equal(await ask(remote + ' --testTimeout=5000'), null, 'a timeout of its own');
  assert.equal(await ask('cd /d C:\\repos\\app\\web && dotnet test'), null, 'not Vitest or Jest');
  assert.equal(await ask('pc2'), null, 'no remote command');
});
test('HTTP asserts expected rejection, code and persisted state and rejects false smoke success', async () => {
  let stored = 'hidden';
  const server = http.createServer((req, res) => {
    if (req.url === '/broken') { req.socket.destroy(); return; }
    if (req.url === '/redirect') { res.writeHead(302, { location: '/hidden' }); res.end(); return; }
    if (req.url === '/slow') return;
    res.setHeader('content-type', 'application/json');
    res.statusCode = req.url === '/wrong-media' ? 415 : 404;
    res.end(JSON.stringify({ code: 'NotFound', payload: req.url === '/huge' ? 'x'.repeat(4000) : undefined }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const result = await assertHttp({ url: base + '/hidden', expectedStatus: 404, expectedCode: 'NotFound', assertState: () => assert.equal(stored, 'hidden') });
    assert.equal(result.status, 404); assert.equal(result.stateChecked, true);
    await assert.rejects(() => assertHttp({ url: base + '/wrong-media', expectedStatus: 404 }), /415/);
    await assert.rejects(() => assertHttp({ url: base + '/broken', expectedStatus: 404 }));
    await assert.rejects(() => assertHttp({ url: base + '/redirect', expectedStatus: 404 }));
    await assert.rejects(() => assertHttp({ url: base + '/hidden', expectedStatus: 404, expectedCode: 'Forbidden' }), /error code/);
    stored = 'unexpectedly-mutated';
    await assert.rejects(() => assertHttp({ url: base + '/hidden', expectedStatus: 404, assertState: () => assert.equal(stored, 'hidden') }));
    await assert.rejects(() => assertHttp({ url: base + '/huge', expectedStatus: 404, maxBytes: 100 }), /bound/);
    await assert.rejects(() => assertHttp({ url: base + '/slow', expectedStatus: 404, timeoutMs: 30 }));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await assert.rejects(() => assertHttp({ url: base + '/closed', expectedStatus: 404 }));
});
test('cleanup never converts failed transport/state assertion into success', async () => {
  let cleaned = false;
  await assert.rejects(() => withCleanup(() => { throw new Error('HTTP 000'); }, () => { cleaned = true; }), /HTTP 000/);
  assert.ok(cleaned);
  await assert.rejects(() => withCleanup(() => { throw new Error('probe'); }, () => { throw new Error('cleanup'); }), error => error instanceof AggregateError && error.errors.length === 2);
  await assert.rejects(() => withCleanup(() => 'ok', () => { throw new Error('cleanup'); }), /cleanup/);
});
test('falsy rejections stay failed and cleanup still runs', async () => {
  for (const failure of [undefined, null, false, 0, '']) {
    let cleaned = false, rejected = false;
    try { await withCleanup(() => Promise.reject(failure), () => { cleaned = true; }); }
    catch (error) { rejected = true; assert.equal(error, failure); }
    assert.ok(rejected && cleaned);
  }
});
test('all cookie credentials and multiline explicit secrets are masked', () => {
  assert.doesNotMatch(redact('Cookie: session=sentinel-one; refresh=sentinel-two'), /sentinel/);
  const file = path.join(root, 'multiline.log'); const log = evidenceLog(file, { secrets: ['first-half\nsecond-half'] });
  log.write('first-half\n'); log.write('second-half\n'); log.close();
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /first-half|second-half/);
});
test('invalid caps fail before execution and an overflow seals the log', async () => {
  for (const maxBytes of ['unbounded', NaN, Infinity, -1, 0]) assert.throws(() => evidenceLog(path.join(root, 'invalid-' + String(maxBytes)), { maxBytes }), /Invalid/);
  const file = path.join(root, 'bounded.log'); const log = evidenceLog(file, { maxBytes: 1 });
  assert.throws(() => log.write('xx')); const size = fs.statSync(file).size;
  for (let i = 0; i < 100; i++) assert.throws(() => log.write('more'));
  log.close(); assert.equal(fs.statSync(file).size, size);
});
test('JSON event redaction preserves metrics, exit status and parseable structure', () => {
  const file = path.join(root, 'events.jsonl'); const log = evidenceLog(file);
  log.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 123, cached_input_tokens: 42, output_tokens: 4 } }) + '\n');
  log.write(JSON.stringify({ type: 'item.completed', item: { aggregated_output: 'Cookie: session=secret-one; refresh=secret-two\nfinished', exit_code: 17 }, password: 'secret-three' }) + '\n');
  log.close();
  const [usage, command] = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(usage.usage, { input_tokens: 123, cached_input_tokens: 42, output_tokens: 4 });
  assert.equal(command.item.exit_code, 17); assert.match(command.item.aggregated_output, /finished/);
  assert.doesNotMatch(JSON.stringify(command), /secret-one|secret-two|secret-three/);
});
test('camelCase, PascalCase and header-style credential keys are masked in every JSON shape', () => {
  const keys = ['accessToken', 'refreshToken', 'idToken', 'clientSecret', 'AccessToken', 'ClientSecret', 'x-api-key', 'private_key',
    'ConnectionStrings', 'secretKey', 'apiKey', 'APIKey', 'passphrase', 'tokens'];
  const value = Object.fromEntries(keys.map((k, i) => [k, 'fixture-value-' + i]));
  const shapes = [JSON.stringify(value), JSON.stringify({ outer: { list: [value] } }), JSON.stringify([value])];
  for (const shape of shapes) assert.doesNotMatch(redact(shape), /fixture-value/, shape);
  const file = path.join(root, 'pretty.jsonl'); const log = evidenceLog(file);
  const pretty = JSON.stringify({ response: value }, null, 2) + '\n';
  for (let i = 0; i < pretty.length; i += 7) log.write(pretty.slice(i, i + 7));   // chunk splits land mid-key and mid-value
  log.close();
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /fixture-value/);
});
test('token counts and other numbers stay readable; number-only env values are never secrets', () => {
  const usage = '{"type":"turn.completed","usage":{"input_tokens":5,"cached_input_tokens":1,"output_tokens":3,"reasoning_output_tokens":2}}';
  assert.equal(redact(usage), usage);
  assert.equal(redact('input_tokens: 12 output_tokens=4 max_tokens: 9'), 'input_tokens: 12 output_tokens=4 max_tokens: 9');
  assert.deepEqual(JSON.parse(redact('{"tokenCount":7,"secretsEnabled":true,"token":null}')), { tokenCount: 7, secretsEnabled: true, token: null });
  process.env.FIXTURE_MAX_OUTPUT_TOKENS = '4096'; process.env.FIXTURE_NUMERIC_TOKEN = '4097';
  try { assert.equal(redact('limit 4096 and 4097 retries'), 'limit 4096 and 4097 retries'); }
  finally { delete process.env.FIXTURE_MAX_OUTPUT_TOKENS; delete process.env.FIXTURE_NUMERIC_TOKEN; }
  // Any credential word masks the value (a hint next to a password is not worth the risk); a merely similar word does not.
  assert.equal(redact('passwordHint: none; accessToken=abc123def; tokenizer=wordpiece'), 'passwordHint: [REDACTED]; accessToken=[REDACTED]; tokenizer=wordpiece');
});
