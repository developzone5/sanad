import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import scan from '../lib/transcript-scan.js';
import target from '../lib/verification-target.cjs';
import { runCommand } from '../../skills/gate/scripts/evidence.mjs';

// A real TypeScript install is machine-specific: WORKFLOW_TYPESCRIPT_RUNNER names <any>/node_modules/typescript/bin/tsc
// (CI sets it; workflow-install.sh finds one under ~/source/repos). The recognition test needs only the path shape.
const tsc = process.env.WORKFLOW_TYPESCRIPT_RUNNER || '';
const tscShape = tsc || 'C:/work/app/node_modules/typescript/bin/tsc';
const npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const quote = words => words.map(word => '"' + word + '"').join(' ');
const message = (role, content) => ({ type: role, message: { role, content } });

test('native Node package entrypoints are recognized without accepting arbitrary scripts', () => {
  assert.equal(scan.segmentIsVerify(quote([process.execPath, tscShape, '--noEmit', '-p', 'app config.json'])), true);
  assert.equal(scan.segmentIsVerify(quote([process.execPath, npm, 'run', 'check'])), true);
  assert.equal(scan.segmentIsVerify(quote([process.execPath, npm.replace('npm-cli.js', 'npx-cli.js'), 'tsc', '--noEmit'])), true);
  assert.equal(scan.segmentIsVerify(quote([process.execPath, tscShape.replace('/bin/tsc', '/lib/tsc.js'), '--noEmit'])), true);
  assert.equal(scan.segmentIsVerify(quote([process.execPath, tscShape, '--listFilesOnly'])), false);
  assert.equal(scan.segmentIsVerify(quote([process.execPath, 'scripts/tsc.js', '--noEmit'])), false);
  assert.equal(scan.segmentIsVerify(quote([process.execPath, 'scripts/npm-cli.js', 'run', 'check'])), false);
  assert.equal(scan.segmentIsVerify(quote([process.execPath, '-e', 'process.exit(0)', 'run', 'check'])), false);
  // A pinned Node running the package's own vitest entrypoint is a test run; a lookalike script is not.
  assert.equal(scan.segmentIsVerify(quote(['C:/tools/node-v20/node.exe', 'node_modules/vitest/vitest.mjs', 'run'])), true);
  assert.equal(scan.segmentIsVerify(quote([process.execPath, 'C:/work/app/node_modules/vitest/vitest.mjs', 'run', 'src/a.test.tsx'])), true);
  assert.equal(scan.segmentIsVerify(quote([process.execPath, 'scripts/vitest.mjs', 'run'])), false);
  assert.deepEqual(target.nativeVerificationTarget('node.exe', ['node_modules\\vitest\\vitest.mjs', 'run']), { executable: 'vitest', args: ['run'] });
});

// Needs a real TypeScript install; point WORKFLOW_TYPESCRIPT_RUNNER at <any>/node_modules/typescript/bin/tsc.
const noTsc = tsc && fs.existsSync(tsc) ? false : 'set WORKFLOW_TYPESCRIPT_RUNNER to an installed node_modules/typescript/bin/tsc';
test('installed native TypeScript and npm runners produce usable source-bound receipts', { skip: noTsc }, async t => {
  assert.ok(fs.existsSync(npm), 'Installed npm Node entrypoint is required.');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'native-runner-proof-'));
  const repo = path.join(scratch, 'project with spaces');
  fs.mkdirSync(repo);
  const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    fs.writeFileSync(path.join(repo, 'source.ts'), 'export const value: number = 1;\n');
    fs.writeFileSync(path.join(repo, 'app config.json'), JSON.stringify({ compilerOptions: { noEmit: true, strict: true, types: [] }, files: ['source.ts'] }));
    fs.writeFileSync(path.join(repo, 'tsconfig.json'), JSON.stringify({ files: [], references: [{ path: './app config.json' }] }));
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'native-runner-fixture', private: true, scripts: { check: 'node --check check.cjs' } }));
    fs.writeFileSync(path.join(repo, 'check.cjs'), 'module.exports = 1;\n');
    git(['init', '--initial-branch=staging']); git(['config', 'user.name', 'developzone5']); git(['config', 'user.email', '65265330+developzone5@users.noreply.github.com']);
    git(['add', '--', 'source.ts', 'app config.json', 'tsconfig.json', 'package.json', 'check.cjs']); git(['commit', '-m', 'test: native runners fixture']);
    const empty = execFileSync(process.execPath, [tsc, '--noEmit', '-p', '.'], { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.equal(empty, '', 'Native tsc really exits zero without examining referenced source.');
    assert.match(target.invalidVerificationTarget(process.execPath, [tsc, '--noEmit', '-p', '.'], repo), /no source files/);
    for (const [label, args] of [['empty-typescript', [tsc, '--noEmit', '-p', '.']], ['typescript', [tsc, '--noEmit', '-p', 'app config.json']], ['npm', [npm, 'run', 'check']]]) {
      const record = await runCommand({ executable: process.execPath, args, cwd: repo, outputRoot: path.join(scratch, 'checks') });
      assert.equal(record.status, 'passed', record.reason);
      assert.equal(record.nativeExitCode, 0);
      assert.equal(record.source.treeBefore, record.source.treeAfter);
      const transcript = path.join(scratch, label + '.jsonl');
      fs.writeFileSync(transcript, [
        message('assistant', [{ type: 'tool_use', name: 'Bash', id: label, input: { command: 'node C:/Users/Asus/.claude/skills/gate/scripts/evidence.mjs --spec fixture.json' } }]),
        message('user', [{ type: 'tool_result', tool_use_id: label, content: 'CHECK_COMPLETED ' + JSON.stringify(record), is_error: false }]),
      ].map(JSON.stringify).join('\n'));
      const observed = scan.scanTranscript(transcript, repo);
      if (label === 'empty-typescript') {
        assert.equal(observed.completedCheck, null, 'Native zero-source success must not establish verification.');
        assert.ok(observed.lastFailedVerify >= 0);
        t.diagnostic('Empty TypeScript root: native exit 0, source-bound receipt rejected as verification.');
        continue;
      }
      assert.equal(observed.completedCheck?.runId, record.runId, label + ' native receipt must count as completed verification.');
      assert.equal(observed.lastFailedVerify, -1);
      t.diagnostic(label + ': native exit 0, unchanged source tree, completed source-bound receipt recognized.');
    }
  } finally {
    assert.equal(path.dirname(scratch).toLowerCase(), os.tmpdir().toLowerCase());
    assert.ok(path.basename(scratch).startsWith('native-runner-proof-'));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

// 2026-11-11 (TUW-242): a proof that ended GREEN left the stop asking for tests on every turn; a NOT PROVED
// proof behind `| tail` (exit 0) must still read as failed.
test('a red-proof run with --then-green is a test run; its other modes are not; its own NOT PROVED is a failure', () => {
  const proof = 'node C:/u/.claude/skills/gate/scripts/red-proof.mjs --repo C:/r --old origin/staging --files a.cs';
  assert.equal(scan.segmentIsVerify(proof + ' --then-green --parallel 4 -- dotnet test x.csproj'), true);
  assert.equal(scan.segmentIsVerify(quote([process.execPath, 'C:/u/red-proof.mjs', '--repo', 'C:/r', '--then-green', '--', 'dotnet', 'test'])), true);
  assert.equal(scan.segmentIsVerify(proof + ' -- dotnet test x.csproj'), false, 'no green run: the fixed tree is not tested');
  assert.equal(scan.segmentIsVerify('node C:/u/red-proof.mjs --repo C:/r --warm -- dotnet test --then-green'), false, 'a flag after -- belongs to the test command');
  assert.equal(scan.segmentIsVerify('node C:/u/red-proof.mjs --repo C:/r --drop-copies --then-green'), false);
  assert.equal(scan.verifyFailed('  GREEN ✗ the tests fail on the fixed tree\nRED-PROOF: NOT PROVED ✗ — see the lines above'), true);
  assert.equal(scan.verifyFailed('RED-PROOF: SETUP ✗ — the fixed tree does not compile'), true);
  assert.equal(scan.verifyFailed('  ran old code: exit 1 (161 s)\nRED-PROOF: RED ✓ — the tests fail on origin/staging (exit 1; 3 of 3 failing test(s) by an assertion)\n  GREEN ✓ the tests pass on the fixed tree\nRED-PROOF: PROVED ✓ — red on the old code'), false);
});

// 2026-11-11: every backend run on the test machine read as FAILED. Its remote command has quotes of its own
// (the database settings: `(for /f "usebackq …" %a in (…) do @set "%a=%b")`), and the receipt's words were
// rebuilt as one quoted line and split again, which never split at `&&`.
test('a passing receipt of a run on the test machine counts, with quotes inside its remote command; the timer sees a run still working', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-remote-'));
  try {
    const remote = 'cd /d C:\repos\App\Api && (for /f "usebackq tokens=1,* delims==" %a in (C:\Users\t\test.env) do @set "%a=%b") && dotnet test App.sln --artifacts-path bin/hosttest -v q --nologo';
    const record = (status) => ({ runId: '2a5a1133-7fbb-4602-844d-0da4d416fb10', executable: 'C:/Windows/System32/OpenSSH/ssh.exe', args: ['-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=30', 'pc2', remote],
      cwd: 'C:\repos\App\Api', source: { toplevel: 'C:\repos\App', treeBefore: 'a'.repeat(40), treeAfter: 'a'.repeat(40) }, status, nativeExitCode: status === 'passed' ? 0 : 1, signal: null, reason: null });
    const evidence = 'node C:/Users/Asus/.claude/skills/gate/scripts/evidence.mjs --spec backend-full.json';
    const edit = [message('assistant', [{ type: 'tool_use', name: 'Edit', id: 'e1', input: { file_path: 'C:/repos/App/Api/Service.cs' } }]), message('user', [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok', is_error: false }])];
    const scanOf = (name, entries) => { const file = path.join(scratch, name + '.jsonl'); fs.writeFileSync(file, entries.map(JSON.stringify).join('\n')); return scan.scanTranscript(file); };

    // In the foreground: the receipt is the tool result.
    const front = scanOf('front', [...edit,
      message('assistant', [{ type: 'tool_use', name: 'Bash', id: 'v1', input: { command: evidence } }]),
      message('user', [{ type: 'tool_result', tool_use_id: 'v1', content: 'CHECK_COMPLETED ' + JSON.stringify(record('passed')), is_error: false }])]);
    assert.equal(front.lastFailedVerify, -1, 'a passing remote run is not a failure');
    assert.ok(front.lastVerify > front.lastEdit, 'it verifies the edit before it');
    assert.equal(front.completedCheck?.runId, record('passed').runId);
    assert.equal(front.workRunning, false);

    // In the background: running until its finish notice, then judged from its saved output.
    const output = path.join(scratch, 'task.output');
    fs.writeFileSync(output, 'CHECK_COMPLETED ' + JSON.stringify(record('passed')) + '\n\n[exited with code 0]\n');
    const launch = [...edit,
      message('assistant', [{ type: 'tool_use', name: 'Bash', id: 'v2', input: { command: evidence, run_in_background: true } }]),
      { ...message('user', [{ type: 'tool_result', tool_use_id: 'v2', content: 'Command running in background with ID: b1a2c3. Output is being written to: ' + output, is_error: false }]), toolUseResult: { backgroundTaskId: 'b1a2c3' } }];
    const running = scanOf('running', launch);
    assert.equal(running.workRunning, true, 'the timer sees a check still working');
    assert.ok(running.lastPendingVerifyStop > running.lastEdit);
    const note = { type: 'user', message: { role: 'user', content: `<task-notification>\n<task-id>b1a2c3</task-id>\n<output-file>${output}</output-file>\n<status>completed</status>\n<summary>Background command "x" completed (exit code 0)</summary>\n</task-notification>` } };
    const done = scanOf('done', [...launch, note]);
    assert.equal(done.lastFailedVerify, -1, 'a passing background run on the test machine is not a failure');
    assert.ok(done.lastVerify > done.lastEdit);
    assert.equal(done.workRunning, false);

    // A failed run still fails, and a remote command that runs no test is no receipt.
    assert.ok(scanOf('failed', [...edit,
      message('assistant', [{ type: 'tool_use', name: 'Bash', id: 'v3', input: { command: evidence } }]),
      message('user', [{ type: 'tool_result', tool_use_id: 'v3', content: 'CHECK_COMPLETED ' + JSON.stringify(record('failed')), is_error: true }])]).lastFailedVerify > -1);
    const noTest = { ...record('passed'), args: ['pc2', 'cd /d C:\repos\App && echo "a && dotnet test"'] };
    assert.equal(scanOf('no-test', [...edit,
      message('assistant', [{ type: 'tool_use', name: 'Bash', id: 'v4', input: { command: evidence } }]),
      message('user', [{ type: 'tool_result', tool_use_id: 'v4', content: 'CHECK_COMPLETED ' + JSON.stringify(noTest), is_error: false }])]).completedCheck, null, 'quoted words are not a test run');
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

// 2026-11-11 (TUW-243): a stop after a passing check, while the full suite still ran on the test machine,
// started a wait on the task timer: ten minutes of machine work read as "waiting for the user".
test('the stop hook starts no wait on the task timer while a background check of the work still runs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-timer-'));
  try {
    const state = path.join(root, 'state'), notes = path.join(root, 'notes');
    const transcript = path.join(root, '.claude', 'projects', 'p', 'sid-1.jsonl');
    for (const d of [state, notes, path.dirname(transcript)]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(notes, 'timer.tsv'), `${new Date(Date.now() - 60000).toISOString()}\tstep\ttests\n`);
    fs.writeFileSync(path.join(state, 'sanad-timer-active-sid-1'), notes);
    const record = { runId: '2a5a1133-7fbb-4602-844d-0da4d416fb11', executable: 'C:/Windows/System32/OpenSSH/ssh.exe', args: ['pc2', 'cd /d C:\repos\App\web && node node_modules/typescript/bin/tsc -b --noEmit'],
      cwd: 'C:\repos\App\web', source: { toplevel: 'C:\repos\App', treeBefore: 'b'.repeat(40), treeAfter: 'b'.repeat(40) }, status: 'passed', nativeExitCode: 0, signal: null, reason: null };
    const evidence = (spec) => `node C:/Users/Asus/.claude/skills/gate/scripts/evidence.mjs --spec ${spec}`;
    const output = path.join(root, 'suite.output');
    const entries = [
      message('assistant', [{ type: 'tool_use', name: 'Edit', id: 'e1', input: { file_path: 'C:/repos/App/web/src/a.ts' } }]), message('user', [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok', is_error: false }]),
      message('assistant', [{ type: 'tool_use', name: 'Bash', id: 'bg', input: { command: evidence('full-suite.json'), run_in_background: true } }]),
      { ...message('user', [{ type: 'tool_result', tool_use_id: 'bg', content: 'Command running in background with ID: suite1. Output is being written to: ' + output, is_error: false }]), toolUseResult: { backgroundTaskId: 'suite1' } },
      message('assistant', [{ type: 'tool_use', name: 'Bash', id: 'fg', input: { command: evidence('types.json') } }]),
      message('user', [{ type: 'tool_result', tool_use_id: 'fg', content: 'CHECK_COMPLETED ' + JSON.stringify(record), is_error: false }]),
    ];
    const stop = () => {
      fs.writeFileSync(transcript, entries.map(JSON.stringify).join('\n'));
      execFileSync(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'stop-gate.js')],
        { input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'sid-1', transcript_path: transcript, cwd: root }), encoding: 'utf8', windowsHide: true, timeout: 20000, env: { ...process.env, SANAD_STATE_DIR: state } });
      return fs.readFileSync(path.join(notes, 'timer.tsv'), 'utf8').trim().split('\n').map(l => l.split('\t')[1]);
    };
    assert.deepEqual(stop(), ['step'], 'the suite still runs: the stop is work time, not a wait');
    fs.writeFileSync(output, 'CHECK_COMPLETED ' + JSON.stringify({ ...record, runId: '2a5a1133-7fbb-4602-844d-0da4d416fb12', args: ['pc2', 'cd /d C:\repos\App\web && node node_modules/vitest/vitest.mjs run'] }) + '\n');
    entries.push({ type: 'user', message: { role: 'user', content: `<task-notification>\n<task-id>suite1</task-id>\n<output-file>${output}</output-file>\n<status>completed</status>\n<summary>Background command "x" completed (exit code 0)</summary>\n</task-notification>` } });
    assert.deepEqual(stop(), ['step', 'wait'], 'the suite finished: the next stop is a wait');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
