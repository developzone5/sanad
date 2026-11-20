import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// 2026-11-19: a red-proof usage refusal (a mistyped option) ended in two seconds with exit 2 and ran nothing.
// The scan read it as a failed check, so the push guard asked for a CHECK RETIRED line. Such a run is no
// result now: no credit, no failure. A refusal that judged the break plan, and every real failing proof,
// stay failed checks. The scan cache lives in a temp state folder, never in the live ~/.claude/state.
const hooks = process.env.WORKFLOW_HOOKS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'proof-refused-')));
const stateDir = path.join(root, 'state');
process.env.SANAD_STATE_DIR = stateDir;
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, 'review-notes-since'), '2026-01-01T00:00:00.000Z\n');
const scan = createRequire(import.meta.url)(path.join(hooks, 'lib', 'transcript-scan.js'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const repo = 'C:/repos/example';
const base = Date.UTC(2026, 10, 19, 6, 0, 0);
const at = (n) => new Date(base + n * 1000).toISOString();
const msg = (role, content, n, rest = {}) => ({ type: role, message: { role, content }, timestamp: at(n), ...rest });
const call = (id, name, input, n) => msg('assistant', [{ type: 'tool_use', id, name, input }], n);
const result = (id, content, n, isError = false, toolUseResult) => msg('user', [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }], n, toolUseResult ? { toolUseResult } : {});
const edit = (id, n, file = repo + '/src/App.cs') => [call(id, 'Edit', { file_path: file }, n), result(id, 'File updated.', n)];
const shell = (id, command, content, n, isError = false, extra, input = {}) => [call(id, 'Bash', { command, ...input }, n), result(id, content, n, isError, extra)];
let files = 0;
function scanOf(entries) {
  const file = path.join(root, 't' + (++files) + '.jsonl');
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e) + '\n').join(''));
  return scan.scanTranscript(file);
}
const judged = (command, content, isError = false, extra) => scanOf([...edit('e', 1), ...shell('c', command, content, 2, isError, extra)]);
const passed = (r) => r.lastVerify > r.lastEdit && r.lastFailedVerify === -1;
const failed = (r) => r.lastFailedVerify > r.lastEdit;
const noResult = (r) => r.lastVerify === -1 && r.lastFailedVerify === -1 && r.lastPendingVerify === -1;

const REFUSED = 'RED-PROOF: REFUSED — nothing ran';
const proof = 'node C:/Users/Asus/.claude/skills/gate/scripts/red-proof.mjs --breaks C:/tmp/breaks.json --then-green --changed-since';
const usage = 'RED-PROOF: --changed-since needs a git ref (a commit, a branch or a tree id). Nothing ran.';
const refusal = 'Exit code 2\n' + usage + '\n' + REFUSED;

test('a usage refusal with exit 2 and the exact last line is no failed check and gives no credit', () => {
  assert.ok(noResult(judged(proof, refusal, true)), 'the host\'s own exit-code line');
  assert.ok(noResult(judged(proof, usage + '\n' + REFUSED + '\n', true, { exitCode: 2, stdout: usage + '\n' + REFUSED + '\n', stderr: '' })), 'the exit code in the result fields');
  assert.ok(noResult(judged('cd C:/repos/example && ' + proof, refusal, true)), 'a leading cd');
  assert.ok(noResult(judged(proof + ' 2>&1', refusal + '\r\n', true)), 'a stream joined to the output, a Windows line end');
  assert.ok(noResult(judged(proof, 'Exit code 2\n\x1b[31m' + usage + '\x1b[0m\n' + REFUSED, true)), 'colour codes around the lines');
});

test('a refusal clears no earlier failure and no pending stop: the real result of the same command stands', () => {
  const r = scanOf([...edit('e', 1),
    ...shell('c1', proof, 'Exit code 1\n  GREEN ✓ the tests pass on the tree as it is\nRED-PROOF: NOT RED — the break was not caught', 2, true),
    ...shell('c2', proof, refusal, 3, true)]);
  assert.ok(failed(r), 'the earlier NOT RED of the same command is still a failed check');
});

test('exit 2 without the refusal line is still a failed check', () => {
  assert.ok(failed(judged(proof, 'Exit code 2\nRED-PROOF: BREAK AMBIGUOUS — break "guard" matches 2 time(s) in src/App.cs; it must match exactly once. Nothing changed.', true)), 'an ambiguous break');
  assert.ok(failed(judged(proof, 'Exit code 2\nRED-PROOF: UNPROVEN — 2 changed lines have no break', true)), 'an unproven change');
  assert.ok(failed(judged(proof, 'Exit code 2\nRED-PROOF: break "guard" matches 0 time(s) in src/App.cs; it must match exactly once. Nothing changed.', true)), 'a break plan the proof judged');
  assert.ok(failed(judged(proof, 'Exit code 2\nRED-PROOF: failed — ENOENT', true)), 'a crash');
  assert.ok(failed(judged(proof, 'Exit code 2', true)), 'no line at all');
});

test('the refusal line counts only as the last line of an exit 2 with nothing else failed', () => {
  assert.ok(failed(judged(proof, 'Exit code 1\n' + usage + '\n' + REFUSED, true)), 'exit 1');
  assert.ok(failed(judged(proof, 'Exit code 2\n' + REFUSED + '\nRED-PROOF: break "guard" matches 2 time(s) in src/App.cs', true)), 'not the last line');
  assert.ok(failed(judged(proof, 'Exit code 2\n' + REFUSED + ' (see the log)', true)), 'not the exact line');
  assert.ok(failed(judged(proof, 'Exit code 2\n  ' + REFUSED, true)), 'an indented copy');
  assert.ok(failed(judged(proof, 'Exit code 2\nRED-PROOF: SETUP — the copy did not build\n' + REFUSED, true)), 'a verdict line beside it');
  assert.ok(failed(judged(proof, 'Exit code 2\n  GREEN ✗ the tests fail on the tree as it is\n' + REFUSED, true)), 'a failed green run beside it');
  assert.ok(failed(judged(proof, 'Exit code 2\n FAIL  src/a.test.ts > case\n' + REFUSED, true)), 'a failed test beside it');
  assert.ok(failed(judged(proof, usage + '\n' + REFUSED, true, { interrupted: true })), 'an interrupted run');
});

test('a real failing proof whose output holds the word REFUSED is still failed', () => {
  const real = 'Exit code 1\n  GREEN ✓ the tests pass on the tree as it is\n ✓ src/a.test.ts > REFUSED requests are logged\n ✓ src/a.test.ts > ' + REFUSED + '\nRED-PROOF: NOT RED — the break was not caught';
  assert.ok(failed(judged(proof, real, true)), 'a test named with the word, and one named with the whole line');
  const lastLine = 'Exit code 1\n  GREEN ✓ the tests pass on the tree as it is\nRED-PROOF: NOT RED — the break was not caught\n' + REFUSED;
  assert.ok(failed(judged(proof, lastLine, true)), 'the line as the last line of a failing proof');
  assert.ok(failed(judged(proof, 'Exit code 2\n  GREEN ✓ the tests pass on the tree as it is\n' + REFUSED, true)), 'a green run happened: something ran');
});

test('the refusal line printed by another command in the same shell line changes nothing', () => {
  const ambiguous = 'RED-PROOF: break "guard" matches 2 time(s) in src/App.cs; it must match exactly once. Nothing changed.';
  // Before the proof: the proof is not the only command, so the result is not read as the proof's own.
  assert.ok(failed(judged('echo "' + REFUSED + '" && ' + proof + ' > C:/tmp/proof.out', 'Exit code 2\n' + REFUSED, true)), 'echo first, the proof\'s output in a file');
  assert.ok(failed(judged('echo "' + REFUSED + '" && ' + proof, 'Exit code 2\n' + REFUSED + '\n' + ambiguous, true)), 'echo first, a judged refusal after it');
  assert.ok(failed(judged('echo "' + REFUSED + '"; ' + proof, 'Exit code 2\n' + ambiguous + '\n' + REFUSED, true)), 'a second command, whatever the order of the lines');
  // A step after the proof that prints the line and exits 2 itself: the proof does not end the command.
  assert.ok(failed(judged(proof + ' && sh -c \'echo "' + REFUSED + '"; exit 2\'', 'Exit code 2\n' + REFUSED, true)), 'a later step behind &&');
  // The proof's own output is in a file: the line in the result cannot be the proof's.
  assert.ok(failed(judged(proof + ' > C:/tmp/proof.out', 'Exit code 2\n' + REFUSED, true)), 'the proof\'s output in a file, no run record');
  // After the proof: the same answer as the same command without the echo's line.
  for (const tail of ['; echo "' + REFUSED + '"', ' || echo "' + REFUSED + '"', ' | tail -3']) {
    const withLine = judged(proof + tail, '  GREEN ✓ the tests pass\nRED-PROOF: NOT RED — the break was not caught\n' + REFUSED);
    assert.ok(failed(withLine), 'a real failure stays failed: ' + tail);
    const judgedRefusal = judged(proof + tail, ambiguous + '\n' + REFUSED), plain = judged(proof + tail, ambiguous);
    assert.deepEqual([judgedRefusal.lastVerify, judgedRefusal.lastFailedVerify], [plain.lastVerify, plain.lastFailedVerify], 'a judged refusal reads the same with and without the line: ' + tail);
    assert.ok(!passed(judgedRefusal), 'and never as a pass: ' + tail);
  }
  // Through ssh, a file read or an echo alone: not a red-proof check at all.
  assert.ok(noResult(judged('cat C:/tmp/proof.out', refusal)), 'a file read is no check');
  assert.ok(noResult(judged('echo "' + REFUSED + '"', REFUSED)), 'an echo is no check');
});

// A run record as red-proof writes it when it ends (skills/gate/scripts/run-record.mjs).
const runsDir = path.join(stateDir, 'proof', 'runs');
function record(argv, startSec, over = {}) {
  fs.mkdirSync(runsDir, { recursive: true });
  const started = base + startSec * 1000;
  const file = path.join(runsDir, started + '-' + (4000 + files) + '.json');
  fs.writeFileSync(file, JSON.stringify({ v: 1, argv, cwd: repo, startedAt: new Date(started).toISOString(), endedAt: new Date(started + 1000).toISOString(),
    exit: 2, green: 'none', treeStart: '1'.repeat(40), treeEnd: '', verdict: REFUSED, ...over }) + '\n');
  return file;
}
const notice = (task, out, n, exit) => ({ type: 'attachment', timestamp: at(n), attachment: { type: 'queued_command', commandMode: 'task-notification',
  prompt: '<task-notification>\n<task-id>' + task + '</task-id>\n<status>' + (exit === 0 ? 'completed' : 'failed') + '</status>\n<summary>Background command "proof" ' + (exit === 0 ? 'completed' : 'failed') + ' (exit code ' + exit + ')</summary>\n<output-file>' + out + '</output-file>\n</task-notification>' } });
// The proof in the background with its output in a file; `tail` is what follows the proof in the shell line.
function background(name, tail, exit, rec) {
  const args = ['--breaks', 'C:/tmp/' + name + '.json', '--then-green', '--changed-since'];
  const out = path.join(root, name + '.output');
  fs.writeFileSync(out, '');
  const command = 'node C:/Users/Asus/.claude/skills/gate/scripts/red-proof.mjs ' + args.join(' ') + ' > "C:/tmp/' + name + '.out" 2>&1' + tail;
  let made = null;
  if (rec) made = record(args, 11, rec === true ? {} : rec);
  const r = scanOf([...edit('e', 1),
    ...shell('bg', command, 'Command running in background with ID: ' + name, 10, false, { backgroundTaskId: name }, { run_in_background: true }),
    notice(name, out, 20, exit)]);
  if (made) fs.rmSync(made, { force: true });
  return r;
}

test('a refusal run in the background with its output in a file: no credit, no failure', () => {
  // The shell line also writes a file, which the scan may count as a change after the check: only the check counts here.
  const failedCheck = (r) => r.lastFailedVerify !== -1 && r.lastVerify === -1;
  const echo = '; echo "exit $?" >> "C:/tmp/x.out"';
  assert.ok(noResult(background('bgA', echo, 0, true)), 'the exit code behind ; echo, the run record says refused');
  assert.ok(noResult(background('bgB', '', 2, true)), 'the exit code 2 in the finish notice, the run record says refused');
  assert.ok(noResult(background('bgC', echo, 0, false)), 'no record: nothing is known, as before');
  // The record of a refusal that judged the plan, or of any other end, is still a failed check.
  assert.ok(failedCheck(background('bgD', echo, 0, { verdict: 'RED-PROOF: break "guard" matches 2 time(s) in src/App.cs; it must match exactly once. Nothing changed.' })), 'a judged refusal in the record');
  assert.ok(failedCheck(background('bgE', '', 2, { verdict: 'RED-PROOF: failed — ENOENT' })), 'a crash in the record');
  assert.ok(failedCheck(background('bgF', echo, 0, { exit: 1 })), 'the refusal line with another exit code');
  assert.ok(failedCheck(background('bgG', echo, 0, { green: 'failed' })), 'the refusal line with a failed green run');
  assert.ok(failedCheck(background('bgH', '', 2, false)), 'exit 2 seen and no record: failed, as before');
  assert.ok(failedCheck(background('bgI', '', 1, true)), 'exit 1 seen: the record cannot change it');
  // A real step after the proof failed with exit 2: that is not the proof's exit code, and the record of a
  // refusal does not hide the failed step.
  const args = ['--breaks', 'C:/tmp/fgA.json', '--then-green', '--changed-since'];
  const made = record(args, 11);
  const command = 'node C:/Users/Asus/.claude/skills/gate/scripts/red-proof.mjs ' + args.join(' ') + ' > "C:/tmp/fgA.out" 2>&1; git stash pop';
  const cleanup = scanOf([...edit('e', 1), call('fg', 'Bash', { command }, 10), result('fg', 'Exit code 2\nerror: could not restore untracked files from stash', 20, true)]);
  fs.rmSync(made, { force: true });
  assert.ok(failedCheck(cleanup), 'a failed cleanup step after a refused proof is still a failure');
});

test('--check-plan is a mode that runs no test: no check, with or without --then-green', () => {
  const tool = 'node C:/Users/Asus/.claude/skills/gate/scripts/red-proof.mjs';
  assert.equal(scan.segmentIsVerify(tool + ' --breaks b.json --check-plan'), false);
  assert.equal(scan.segmentIsVerify(tool + ' --breaks b.json --check-plan --then-green -- dotnet test'), false);
  assert.equal(scan.segmentIsVerify(tool + ' --breaks b.json --then-green -- dotnet test'), true, 'a real proof is still a test run');
  assert.equal(scan.segmentIsVerify(tool + ' --breaks b.json --then-green -- dotnet test --check-plan'), true, 'the word after -- belongs to the test command');
  assert.ok(noResult(judged(tool + ' --breaks b.json --check-plan --then-green', 'Exit code 2\nRED-PROOF: break "guard" matches 2 time(s)', true)), 'a failed plan check is no failed test run');
  assert.ok(noResult(judged(tool + ' --breaks b.json --check-plan --then-green', 'RED-PROOF: the plan is fine')), 'a passing plan check gives no credit');
});
