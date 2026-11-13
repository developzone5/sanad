import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// transcript-scan.js against real transcript files (2026-11-12 audit items H17, H4, H10, H14, H3, H8/H15).
// The scan cache lives in a temp state folder, never in the live ~/.claude/state.
const hooks = process.env.WORKFLOW_HOOKS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'scan-incremental-')));
const stateDir = path.join(root, 'state');
process.env.SANAD_STATE_DIR = stateDir;
// The reviewer-notes lock's start time (2026-11-12): these sessions' reports come after it. Every state
// folder a test scans with gets the same one, so incremental and from-zero scans agree.
const SINCE = '2026-01-01T00:00:00.000Z';
const writeSince = (dir) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'review-notes-since'), SINCE + '\n'); };
writeSince(stateDir);
const scan = createRequire(import.meta.url)(path.join(hooks, 'lib', 'transcript-scan.js'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const repo = 'C:/repos/example';
const at = (n) => new Date(Date.UTC(2026, 10, 12, 6, 0, 0) + n * 1000).toISOString();
const msg = (role, content, n, rest = {}) => ({ type: role, message: { role, content }, timestamp: at(n), ...rest });
const call = (id, name, input, n) => msg('assistant', [{ type: 'tool_use', id, name, input }], n);
const result = (id, content, n, isError = false, toolUseResult) => msg('user', [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }], n, toolUseResult ? { toolUseResult } : {});
const edit = (id, n, file = repo + '/src/App.cs', name = 'Edit') => [call(id, name, { file_path: file }, n), result(id, 'File updated.', n)];
const shell = (id, command, content, n, isError = false, extra, tool = 'Bash') => [call(id, tool, { command }, n), result(id, content, n, isError, extra)];
const verdict = (text, n) => msg('assistant', [{ type: 'text', text }], n);
const lines = (entries) => entries.map((e) => JSON.stringify(e) + '\n').join('');

let fileCount = 0;
function transcriptFile(entries, name = 't' + (++fileCount)) {
  const file = path.join(root, name + '.jsonl');
  fs.writeFileSync(file, lines(entries));
  return file;
}
// A from-zero scan: an empty state folder, so no cache exists.
function fullScan(file) {
  const saved = process.env.SANAD_STATE_DIR;
  process.env.SANAD_STATE_DIR = fs.mkdtempSync(path.join(root, 'fresh-'));
  writeSince(process.env.SANAD_STATE_DIR);
  try { return scan.scanTranscript(file); } finally { process.env.SANAD_STATE_DIR = saved; }
}
const cacheFiles = () => { try { return fs.readdirSync(path.join(stateDir, 'scan-cache')).filter((n) => n.endsWith('.json')); } catch { return []; } };
const passingDotnet = 'Passed!  - Failed:     0, Passed:     3, Skipped:     0, Total:     3';
const evidenceCommand = (spec) => 'node C:/Users/Asus/.claude/skills/gate/scripts/evidence.mjs --spec "C:/checks/' + spec + '.json"';
const receipt = (overrides = {}) => 'CHECK_COMPLETED ' + JSON.stringify({ runId: '12345678-1234-1234-1234-123456789abc', cwd: 'C:\\repos\\example', executable: 'dotnet', args: ['test', 'Backend.Tests.csproj'], status: 'passed', nativeExitCode: 0, signal: null, reason: null, source: { toplevel: 'C:\\repos\\example', treeBefore: '1'.repeat(40), treeAfter: '1'.repeat(40) }, ...overrides });

// ---------------------------------------------------------------------------
// H17: the whole session, read once, then only what was appended
// ---------------------------------------------------------------------------

function sessionParts(dir) {
  const out = path.join(dir, 'bg-output.txt');
  fs.writeFileSync(out, 'Tests  12 passed (12)\n');
  const part1 = [
    ...edit('e1', 1),
    ...shell('t1', 'dotnet test', 'Failed!  - Failed: 1, Passed: 2', 2, true),
    ...shell('bg1', 'npx vitest run', 'Command running in background with ID: bgA', 3, false, { backgroundTaskId: 'bgA' }),
  ];
  // Reviewer notes (2026-11-12): a report read from a file, the user's words, a reviewer's report in its
  // finish notice, then an outcome line for each note.
  const part2 = [
    { type: 'attachment', timestamp: at(10), attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: '<task-notification>\n<task-id>bgA</task-id>\n<status>completed</status>\n<summary>done (exit code 0)</summary>\n<output-file>' + out + '</output-file>\n</task-notification>' } },
    ...shell('t2', 'dotnet test', passingDotnet, 11),
    call('rv-call', 'Agent', { description: 'review', prompt: 'You are the independent reviewer. Review it.', run_in_background: true }, 12),
    result('rv-call', 'Async agent launched successfully.', 12, false, { isAsync: true, status: 'async_launched', agentId: 'rv1' }),
    ...shell('cx', 'cat C:/tmp/codex-review.md', 'RECOMMEND: FAIL\n\n- Bug — Api/X.cs:4 — the wrong status code for a gone row', 13),
    { type: 'user', message: { role: 'user', content: 'keep the status code as it is for now' }, timestamp: at(14), origin: { kind: 'human' } },
  ];
  const part3 = [
    { type: 'attachment', timestamp: at(20), attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: '<task-notification>\n<task-id>rv1</task-id>\n<status>completed</status>\n<summary>Agent "review" completed</summary>\n<result>RECOMMEND: PASS\n- Gap — Api/X.cs:9 — a stale comment</result>\n</task-notification>' } },
    verdict('NOTE 1: user — "keep the status code as it is"\nNOTE 2: fixed — removed the stale comment at Api/X.cs:9; no behavior change', 21),
    verdict('REVIEW: PASS', 21),
    ...shell('ev1', evidenceCommand('a'), receipt(), 22),
    verdict('GATE: PASS', 23),
    ...edit('e2', 24, repo + '/src/Other.ts', 'Write'),
  ];
  return [part1, part2, part3];
}

test('an incremental scan grown in three steps equals a scan from zero at every step', () => {
  const dir = fs.mkdtempSync(path.join(root, 'grow-'));
  const file = path.join(dir, 'session.jsonl');
  const helperDir = path.join(dir, 'session', 'subagents');
  fs.mkdirSync(helperDir, { recursive: true });
  const helper = path.join(helperDir, 'agent-h1.jsonl');
  const parts = sessionParts(dir);
  const helperParts = [
    [call('h-e1', 'Edit', { file_path: repo + '/src/Helper.cs' }, 4), result('h-e1', 'ok', 5)],
    [call('h-e2', 'Write', { file_path: repo + '/src/Late.cs' }, 15), result('h-e2', 'ok', 15)],
    [msg('assistant', [{ type: 'text', text: 'GATE: PASS' }], 25)],
  ];
  fs.writeFileSync(file, '');
  fs.writeFileSync(helper, '');
  for (let step = 0; step < 3; step++) {
    fs.appendFileSync(file, lines(parts[step]));
    fs.appendFileSync(helper, lines(helperParts[step]));
    const incremental = scan.scanTranscript(file);
    assert.deepEqual(incremental, fullScan(file), 'step ' + (step + 1));
    // A second call with nothing new returns the same answer from the cache alone.
    assert.deepEqual(scan.scanTranscript(file), incremental, 'step ' + (step + 1) + ' again');
  }
  const final = scan.scanTranscript(file);
  assert.equal(final.lastGateVerdict, 'PASS');
  assert.ok(final.lastEdit > final.lastGate, 'the last main edit follows the gate');
  assert.ok(final.lastBoundCheck > 0 && final.lastReviewerRun > 0);
  assert.deepEqual(final.reviewNotes.map((n) => n.kind + ' ' + n.outcome), ['Bug user', 'Gap fixed'], 'notes and outcomes survive the cache');
  assert.deepEqual(final.openReviewNotes, []);
  const cache = cacheFiles().map((n) => JSON.parse(fs.readFileSync(path.join(stateDir, 'scan-cache', n), 'utf8'))).find((c) => c.path && c.path.endsWith('session.jsonl'));
  assert.ok(cache, 'a cache file was written');
  assert.equal(cache.offset, fs.statSync(file).size, 'the cache holds the processed offset');
});

test('the cache is rebuilt when the transcript shrinks, its head changes, or the cache is corrupt', () => {
  const dir = fs.mkdtempSync(path.join(root, 'rebuild-'));
  const file = path.join(dir, 's.jsonl');
  const [part1, part2] = sessionParts(dir);
  fs.writeFileSync(file, lines([...part1, ...part2]));
  scan.scanTranscript(file);
  // Shrunk: a new, shorter session at the same path.
  fs.writeFileSync(file, lines(edit('x1', 1)));
  assert.deepEqual(scan.scanTranscript(file), fullScan(file));
  assert.ok(scan.scanTranscript(file).lastVerify === -1, 'nothing of the old content survives');
  // Same size, other head: the first bytes changed.
  const a = lines([...edit('aa', 1), ...shell('ta', 'dotnet test', passingDotnet, 2)]);
  fs.writeFileSync(file, a);
  scan.scanTranscript(file);
  const b = a.replace('"aa"', '"ab"').replace('"aa"', '"ab"');
  assert.equal(b.length, a.length);
  fs.writeFileSync(file, b + lines(edit('more', 3)));
  assert.deepEqual(scan.scanTranscript(file), fullScan(file));
  // Corrupt cache files are ignored and rewritten.
  for (const n of cacheFiles()) fs.writeFileSync(path.join(stateDir, 'scan-cache', n), '{"v":');
  assert.deepEqual(scan.scanTranscript(file), fullScan(file));
  for (const n of cacheFiles()) fs.writeFileSync(path.join(stateDir, 'scan-cache', n), JSON.stringify({ v: 999, offset: 5 }));
  assert.deepEqual(scan.scanTranscript(file), fullScan(file));
});

test('a torn last line is read again on the next call', () => {
  const file = transcriptFile(edit('e1', 1));
  const whole = JSON.stringify(shell('t1', 'dotnet test', passingDotnet, 2)[0]) + '\n' + JSON.stringify(shell('t1', 'dotnet test', passingDotnet, 2)[1]);
  fs.appendFileSync(file, whole.slice(0, whole.length - 20));          // the result line is half written
  const torn = scan.scanTranscript(file);
  assert.equal(torn.lastVerify, -1, 'half a result is no result');
  fs.appendFileSync(file, whole.slice(whole.length - 20) + '\n');
  const done = scan.scanTranscript(file);
  assert.ok(done.lastVerify > done.lastEdit, 'the completed line counts');
  assert.deepEqual(done, fullScan(file));
});

test('a large transcript is read in pieces and a later call reads only the new part fast', () => {
  const file = path.join(root, 'large.jsonl');
  const filler = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r', content: 'x'.repeat(2 * 1024 * 1024) }] }, timestamp: at(1) }) + '\n';
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, lines(edit('e1', 0)));
  for (let i = 0; i < 12; i++) fs.writeSync(fd, filler);                // ~24 MB of 2 MB lines
  fs.writeSync(fd, filler.replace('x'.repeat(1024), 'x'.repeat(9 * 1024 * 1024)));   // one line longer than a whole read
  fs.writeSync(fd, lines(shell('t1', 'dotnet test', passingDotnet, 2)));
  fs.closeSync(fd);
  const first = scan.scanTranscript(file);
  assert.ok(first.lastVerify > first.lastEdit, 'an edit at the start and a check at the end are both seen');
  fs.appendFileSync(file, lines(edit('e2', 3)));
  const started = process.hrtime.bigint();
  const next = scan.scanTranscript(file);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(next.lastEdit > next.lastVerify);
  assert.ok(ms < 300, 'a later call took ' + ms + ' ms');
});

test('a first read stopped half way leaves its progress, and the next call continues from it', () => {
  const dir = fs.mkdtempSync(path.join(root, 'stopped-'));
  const file = path.join(dir, 'long.jsonl');
  const big = (n) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r' + n, content: 'y'.repeat(1024 * 1024) }] }, timestamp: at(n) }) + '\n';
  fs.writeFileSync(file, lines(edit('e1', 0)));
  for (let i = 0; i < 20; i++) fs.appendFileSync(file, big(i + 1));
  fs.appendFileSync(file, lines(shell('t1', 'dotnet test', passingDotnet, 30)));
  const state = fs.mkdtempSync(path.join(root, 'stopped-state-'));
  // Every chunk is "two seconds later" (a checkpoint each time); the 4th disk read fails like a killed hook.
  const child = 'const fs = require("fs"); let now = 0, reads = 0; Date.now = () => (now += 3000); const real = fs.readSync;' +
    'fs.readSync = (...a) => { if (++reads === 4) throw new Error("stopped"); return real(...a); };' +
    'try { require(process.argv[1]).scanTranscript(process.argv[2]); process.stdout.write("finished"); } catch (e) { process.stdout.write("stopped"); }';
  const out = execFileSync(process.execPath, ['-e', child, path.join(hooks, 'lib', 'transcript-scan.js'), file], { env: { ...process.env, SANAD_STATE_DIR: state }, encoding: 'utf8', windowsHide: true });
  assert.equal(out, 'stopped');
  const [name] = fs.readdirSync(path.join(state, 'scan-cache')).filter((n) => n.endsWith('.json'));
  const progress = JSON.parse(fs.readFileSync(path.join(state, 'scan-cache', name), 'utf8')).offset;
  assert.ok(progress > 0 && progress < fs.statSync(file).size, 'a checkpoint inside the file: ' + progress);
  const saved = process.env.SANAD_STATE_DIR;
  process.env.SANAD_STATE_DIR = state;
  try {
    const resumed = scan.scanTranscript(file);
    assert.deepEqual(resumed, fullScan(file));
    assert.ok(resumed.lastVerify > resumed.lastEdit);
  } finally { process.env.SANAD_STATE_DIR = saved; }
});

test('hooks scanning the same transcript at the same moment leave a whole, correct cache', async () => {
  const dir = fs.mkdtempSync(path.join(root, 'race-'));
  const file = path.join(dir, 'race.jsonl');
  const [part1, part2, part3] = sessionParts(dir);
  fs.writeFileSync(file, lines(part1));
  scan.scanTranscript(file);
  fs.appendFileSync(file, lines([...part2, ...part3]));
  const { spawn } = await import('node:child_process');
  const one = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(require(process.argv[1]).scanTranscript(process.argv[2])))', path.join(hooks, 'lib', 'transcript-scan.js'), file],
      { env: { ...process.env, SANAD_STATE_DIR: stateDir }, windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(JSON.parse(out)) : reject(new Error('exit ' + code)));
  });
  const results = await Promise.all([one(), one(), one(), one(), one()]);
  const expected = JSON.parse(JSON.stringify(fullScan(file)));
  for (const r of results) assert.deepEqual(r, expected);
  for (const n of cacheFiles()) JSON.parse(fs.readFileSync(path.join(stateDir, 'scan-cache', n), 'utf8'));
  assert.deepEqual(scan.scanTranscript(file), fullScan(file), 'the cache left behind continues correctly');
  assert.equal(fs.readdirSync(path.join(stateDir, 'scan-cache')).filter((n) => n.endsWith('.tmp')).length, 0, 'no temp file is left');
});

// ---------------------------------------------------------------------------
// H4: a check whose exit code something after it hides
// ---------------------------------------------------------------------------

const judged = (command, content, isError = false, extra) => scan.scanTranscript(transcriptFile([...edit('e', 1), ...shell('c', command, content, 2, isError, extra)]));
const passed = (r) => r.lastVerify > r.lastEdit && r.lastFailedVerify === -1;
const failed = (r) => r.lastFailedVerify > r.lastEdit;
const notRun = (r) => r.lastVerify === -1 && r.lastFailedVerify === -1;

test('a hidden exit code counts only the runner\'s own pass marker', () => {
  assert.ok(passed(judged('dotnet test | tail -5', passingDotnet)), 'dotnet summary behind tail');
  assert.ok(notRun(judged('dotnet test | head -40', 'Build succeeded.\n  Restored x')), 'summary cut by head: no credit, no failure');
  assert.ok(failed(judged('dotnet test | head -40', '  Failed Api.Tests.UserTests.Create [12 ms]')), 'a per-test failure line');
  assert.ok(failed(judged('dotnet test || true', '[xUnit.net 00:00:01.20]     Api.Tests.X [FAIL]')), 'xunit [FAIL] behind || true');
  // Seen in a real session: a generator error behind a display chain read as a pass.
  const build = 'dotnet build Api.csproj -v q --nologo 2>&1 | grep -E "error|Build succeeded|warn" | sort -u | head -20';
  assert.ok(failed(judged(build, 'C:\\r\\Api\\Mapper.cs(23,5): error RMG012: The member All could not be mapped')), 'MSBuild error line');
  assert.ok(passed(judged('dotnet build Api.csproj -v q 2>&1 | tail -3', '    14 Warning(s)\n    0 Error(s)')), 'MSBuild summary without errors');
  assert.ok(passed(judged('npx vitest run; echo done', ' Test Files  3 passed (3)\n      Tests  42 passed (42)\ndone')), 'vitest summary before ; echo');
  assert.ok(notRun(judged('npx vitest run; echo done', 'done')), 'no summary: no credit');
  assert.ok(failed(judged('npx vitest run | tail -3', '   × src/a.test.ts > case 12ms\n')), 'vitest × line');
  assert.ok(passed(judged('node --test x.test.mjs | tail -3', 'ℹ tests 4\nℹ pass 4\nℹ fail 0')), 'node:test summary');
  assert.ok(failed(judged('node --test x.test.mjs | tail -3', 'ℹ tests 4\nℹ pass 2\nℹ fail 2')), 'node:test failures');
  assert.ok(notRun(judged('npm run build | tail -3', 'built in 2s', true)), 'a display tail exit code is not a failure either');
  // The H4 example: a remote suite behind a redirect, ; and a display chain, eight FAIL lines and no summary.
  const remote = 'ssh pc2 "cd /d C:\\repos\\app\\web && npx vitest run 2>&1" > "C:/x/full.log" 2>&1; sed \'s/a/b/\' "C:/x/full.log" | grep -aE "Test Files|Tests  | FAIL " | head -8';
  assert.ok(failed(judged(remote, Array.from({ length: 8 }, (_, i) => ' FAIL  src/f' + i + '.test.ts > t').join('\n'))), 'FAIL lines behind head');
  assert.ok(passed(judged(remote, ' Test Files  9 passed (9)\n      Tests  120 passed (120)')), 'the same command with a passing summary');
  // A pipe inside the remote command hides the remote exit code too.
  assert.ok(notRun(judged('ssh pc2 "cd /d C:\\repos\\app && dotnet test | tail -3"', 'Build succeeded.')), 'remote pipe');
  // Only the hidden check needs its marker; a check whose exit code the tool sees is proved by it.
  assert.ok(passed(judged('npx vitest run | tail -3; npx eslint src', '      Tests  4 passed (4)')), 'hidden vitest with its summary, visible eslint');
  assert.ok(notRun(judged('npx vitest run | tail -3; npx eslint src', 'done')), 'hidden vitest without its summary');
  assert.ok(failed(judged('npx vitest run | tail -3; npx eslint src', '      Tests  4 passed (4)', true)), 'the visible last check failed');
  // A real last step (a stash pop) that fails is a failure even when the test before it is hidden.
  assert.ok(failed(judged('git stash push; dotnet test; git stash pop', 'CONFLICT (content)', true)), 'cleanup failed');
  // A visible exit code is judged as before.
  assert.ok(passed(judged('dotnet test && echo ok', 'ok')), '&& keeps the exit code');
  assert.ok(passed(judged('cd backend; dotnet test', 'whatever')), 'a ; before the check does not hide it');
  assert.ok(passed(judged('npx eslint src', '✖ 3 problems (0 errors, 3 warnings)')), 'eslint warnings are still no failure');
  assert.ok(failed(judged('npx vitest run', ' FAIL  src/a.test.ts > case')), 'a FAIL line fails a visible run as well');
});

// ---------------------------------------------------------------------------
// H10: helper agents' edits are edits
// ---------------------------------------------------------------------------

function withHelpers(main, helpers) {
  const dir = fs.mkdtempSync(path.join(root, 'helpers-'));
  const file = path.join(dir, 'main.jsonl');
  fs.writeFileSync(file, lines(main));
  fs.mkdirSync(path.join(dir, 'main', 'subagents'), { recursive: true });
  for (const [name, entries] of Object.entries(helpers)) fs.writeFileSync(path.join(dir, 'main', 'subagents', name), lines(entries));
  return file;
}

test('a helper agent\'s code edit counts at its own time; its verdicts and checks never count', () => {
  const main = [...edit('e1', 1), ...shell('t1', 'dotnet test', passingDotnet, 10)];
  const late = withHelpers(main, { 'agent-a1.jsonl': [call('h1', 'Edit', { file_path: repo + '/src/Helper.cs' }, 20), result('h1', 'ok', 21)] });
  const r1 = scan.scanTranscript(late);
  assert.ok(r1.lastEdit > r1.lastVerify, 'an edit by a helper after the last check needs a new check');
  assert.equal(r1.lastEditPath, repo + '/src/Helper.cs');
  const early = withHelpers(main, { 'agent-a1.jsonl': [call('h1', 'Edit', { file_path: repo + '/src/Helper.cs' }, 5), result('h1', 'ok', 6)] });
  const r2 = scan.scanTranscript(early);
  assert.ok(r2.lastVerify > r2.lastEdit, 'a helper edit before the check is verified by it');
  const shellEdit = withHelpers(main, { 'agent-a2.jsonl': [call('h2', 'Bash', { command: 'sed -i s/a/b/ src/Api.cs', cwd: repo }, 20), result('h2', '', 21)] });
  assert.ok(scan.scanTranscript(shellEdit).lastEdit > scan.scanTranscript(shellEdit).lastVerify, 'a helper shell write counts');
  const quiet = withHelpers([...edit('e1', 1)], { 'agent-a3.jsonl': [
    call('h3', 'Edit', { file_path: repo + '/README.md' }, 2), result('h3', 'ok', 2),
    call('h4', 'Edit', { file_path: repo + '/src/Err.cs' }, 3), result('h4', 'String not found', 3, true),
    ...shell('h5', 'dotnet test', passingDotnet, 4),
    ...shell('h6', evidenceCommand('h'), receipt(), 5),
    msg('assistant', [{ type: 'text', text: 'REVIEW: PASS\nGATE: PASS' }], 6),
  ] });
  const r3 = scan.scanTranscript(quiet);
  assert.equal(r3.lastEditPath, repo + '/src/App.cs', 'docs and failed edits by helpers are not code edits');
  assert.equal(r3.lastVerify, -1, 'a helper check is not this session\'s check');
  assert.equal(r3.lastGate, -1); assert.equal(r3.lastReview, -1); assert.equal(r3.lastBoundCheck, -1);
  assert.deepEqual(r3.passingReceipts, []);
});

// ---------------------------------------------------------------------------
// H14: deletes and formatters change code; eslint --fix is no check
// ---------------------------------------------------------------------------

test('deleting a code file and running a formatter are edits; eslint --fix is not a check', () => {
  const editOf = (command, tool = 'Bash') => scan.scanTranscript(transcriptFile(shell('c', command, '', 1, false, undefined, tool)));
  for (const [command, tool] of [['rm src/Old.cs'], ['rm -f "src/Old Name.ts"'], ['git rm -q src/Old.cs'], ['git -C C:/repos/example rm src/Old.cs'],
    ['Remove-Item -Path src/Old.cs -Force', 'PowerShell'], ['del src\\Old.cs', 'PowerShell'], ['dotnet format'], ['dotnet csharpier format .'],
    ['npx prettier --write src'], ['npx eslint --fix src'], ['npm run lint -- --fix']]) {
    assert.ok(editOf(command, tool).lastEdit !== -1, command);
  }
  for (const command of ['rm -rf node_modules/.vite', 'rm notes.md', 'git rm --cached src/Old.cs', 'dotnet format --verify-no-changes', 'dotnet csharpier check .', 'npx prettier --check src', 'rm -f C:/Users/x/AppData/Local/Temp/scratch/a.ts']) {
    assert.equal(editOf(command).lastEdit, -1, command);
  }
  const fixed = scan.scanTranscript(transcriptFile([...edit('e1', 1), ...shell('lint', 'npx eslint --fix src', '', 2)]));
  assert.equal(fixed.lastVerify, -1, 'eslint --fix is not a passing check');
  assert.equal(scan.segmentIsVerify('npx eslint src'), true);
  assert.equal(scan.segmentIsVerify('npx eslint --fix src'), false);
});

// ---------------------------------------------------------------------------
// H3: the temp folder is exempt only outside a git work tree
// ---------------------------------------------------------------------------

test('an edit inside a git work tree under the temp folder counts; plain temp files do not', () => {
  const tempRepo = path.join(root, 'wt-repo');
  fs.mkdirSync(path.join(tempRepo, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: tempRepo, windowsHide: true });
  const linked = path.join(root, 'wt-linked');
  fs.mkdirSync(path.join(linked, 'src'), { recursive: true });
  fs.writeFileSync(path.join(linked, '.git'), 'gitdir: ' + path.join(tempRepo, '.git', 'worktrees', 'x') + '\n');
  const slash = (p) => p.replace(/\\/g, '/');
  assert.ok(slash(root).includes('AppData/Local/Temp') || process.platform !== 'win32', 'the fixture lives in the temp folder');
  assert.equal(scan.isCodePath(slash(path.join(tempRepo, 'src', 'App.cs'))), true, 'a clone under Temp');
  assert.equal(scan.isCodePath(path.join(tempRepo, 'src', 'App.cs')), true, 'Windows spelling');
  assert.equal(scan.isCodePath(slash(path.join(linked, 'src', 'App.cs'))), true, 'a worktree (.git file) under Temp');
  assert.equal(scan.isCodePath(slash(path.join(tempRepo, 'src', 'not', 'yet', 'New.cs'))), true, 'a new file in a new folder of the work tree');
  assert.equal(scan.isCodePath(slash(path.join(root, 'scratch', 'App.cs'))), false, 'a plain temp file');
  assert.equal(scan.isCodePath(slash(path.join(tempRepo, 'node_modules', 'x', 'i.js'))), false, 'other exemptions still apply inside');
  const r = scan.scanTranscript(transcriptFile(edit('e1', 1, slash(path.join(tempRepo, 'src', 'App.cs')))));
  assert.ok(r.lastEdit !== -1, 'the scan counts it');
});

// ---------------------------------------------------------------------------
// H8/H15: every passing evidence receipt is listed
// ---------------------------------------------------------------------------

test('every passing evidence receipt is listed with its repository, trees and folder', () => {
  const other = { toplevel: 'D:\\work\\other', treeBefore: '2'.repeat(40), treeAfter: '3'.repeat(40) };
  const r = scan.scanTranscript(transcriptFile([
    ...edit('e1', 1),
    ...shell('ev1', evidenceCommand('a'), receipt(), 2),
    ...shell('ev2', evidenceCommand('b'), receipt({ status: 'failed', nativeExitCode: 1 }), 3),
    ...shell('ev3', evidenceCommand('c'), receipt({ cwd: 'D:\\work\\other\\web', source: other }), 4),
  ]));
  assert.deepEqual(r.passingReceipts.map(({ seq, ...rest }) => rest), [
    { toplevel: 'C:/repos/example', treeBefore: '1'.repeat(40), treeAfter: '1'.repeat(40), cwd: 'C:/repos/example' },
    { toplevel: 'D:/work/other', treeBefore: '2'.repeat(40), treeAfter: '3'.repeat(40), cwd: 'D:/work/other/web' },
  ]);
  assert.ok(r.passingReceipts.every((x) => typeof x.seq === 'number'));
  assert.equal(r.completedCheck.cwd, 'D:\\work\\other\\web', 'completedCheck is unchanged: the latest passing receipt as written');
});
