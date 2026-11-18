import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// 2026-11-18, the promise of the stop gate and the scanner behind it: a final message that claims a pass, or hands
// over a push command, while code changed after the last passing test (or a check failed, or still runs) is blocked;
// honest flows (edit, test, verdict; a docs-only change) pass. Eight confirmed findings, each with a "must not
// change" test for the nearest normal flow. The real stop-gate.js runs in a child process; state in a temp folder.
const hooks = process.env.WORKFLOW_HOOKS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const scan = require(path.join(hooks, 'lib', 'transcript-scan.js'));
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'stop-promise-')));
const stateDir = path.join(root, 'state');
fs.mkdirSync(stateDir, { recursive: true });
// A folder that is a work tree (a .git folder): files in it are the project even below the temp folder.
const repo = path.join(root, 'repo');
fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
const env = { ...process.env, SANAD_STATE_DIR: stateDir };
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

let seq = 0;
const at = () => new Date(Date.UTC(2026, 10, 18, 6, 0, 0) + (++seq) * 1000).toISOString();
const call = (id, name, input, extra = {}) => ({ type: 'assistant', cwd: repo, timestamp: at(), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }, ...extra });
const done = (id, content = '', toolUseResult, isError = false) => ({ type: 'user', cwd: repo, timestamp: at(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] }, ...(toolUseResult ? { toolUseResult } : {}) });
const say = (text) => ({ type: 'assistant', cwd: repo, timestamp: at(), message: { role: 'assistant', content: [{ type: 'text', text }] } });
const edit = (file) => { const id = 'e' + (++seq); return [call(id, 'Edit', { file_path: path.join(repo, file) }), done(id, 'File updated.')]; };
const shell = (command, output = '', opts = {}) => {
  const id = 'b' + (++seq);
  return [call(id, 'Bash', { command, ...(opts.background ? { run_in_background: true } : {}) }), done(id, output, opts.result, opts.error === true)];
};
const PASS = 'Passed!  - Failed:     0, Passed:     3, Skipped:     0, Total:     3';
const passingTest = () => shell('dotnet test', PASS);
const PUSH = 'GATE: PASS\n\n```\ngit push -u origin fix/probe\n```';

let runs = 0;
function stop(entries, { last, active = false, session } = {}) {
  const file = path.join(root, 'transcript-' + (++runs) + '.jsonl');
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e) + '\n').join(''));
  const input = { hook_event_name: 'Stop', session_id: session || 'promise-' + runs, transcript_path: file, cwd: repo, stop_hook_active: active };
  if (last !== undefined) input.last_assistant_message = last;
  const out = execFileSync(process.execPath, [path.join(hooks, 'stop-gate.js')], { input: JSON.stringify(input), env, cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  const o = out.trim() ? JSON.parse(out) : {};
  return { decision: o.decision || 'allow', text: String(o.reason || o.systemMessage || '') };
}
const scanOf = (entries) => {
  const file = path.join(root, 'scan-' + (++runs) + '.jsonl');
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e) + '\n').join(''));
  return scan.scanTranscript(file);
};
const blocks = (entries, opts) => assert.equal(stop(entries, opts).decision, 'block');
const allows = (entries, opts) => { const r = stop(entries, opts); assert.equal(r.decision, 'allow', r.text); return r; };

// ---- finding 1: one rule of what is code ----------------------------------------------------------------------
test('1. every file but plain prose is code, in the scanner too', () => {
  for (const p of ['index.html', 'nginx.conf', 'data/seed.json', '.eslintrc.json', 'Resources/Strings.resx', 'Makefile', 'build.cmd', 'Templates/Welcome.html',
    'Domain/Specs/ActiveUserSpec.cs', 'e2e/specs/login.spec.ts', 'Infrastructure/Memory/TokenCache.cs', '.claude/hooks/guard.js', 'specs/Foo.cs', 'src/App.ts']) {
    assert.equal(scan.isCodePath(p), true, p);
  }
  for (const p of ['README.md', 'docs/a.md', 'notes.txt', 'a.rst', 'a.adoc', 'logo.png', 'a.jpg', 'a.jpeg', 'a.gif', 'a.webp', 'a.pdf', 'LICENSE', 'docs/CHANGELOG', 'NOTICE', 'AUTHORS',
    'specs/a.md', 'memory/x.md', '.claude/rules.md', 'C:/Users/Asus/.claude/projects/x/memory/MEMORY.md']) {
    assert.equal(scan.isCodePath(p), false, p);
    assert.equal(scan.isProsePath(p), true, p);
  }
  for (const p of ['node_modules/x/index.js', 'app/node_modules/x/index.js', 'a/.git/config', '/tmp/x.js', 'C:/Users/Asus/.claude/state/x.json']) assert.equal(scan.isCodePath(p), false, p);
});
test('1. an edit of index.html or nginx.conf after the tests is an edit the stop gate sees', () => {
  for (const file of ['index.html', 'nginx.conf', 'data/seed.json', 'Makefile']) blocks([...edit('src/Ok.ts'), ...passingTest(), ...edit(file)]);
  blocks([...edit('index.html'), ...edit('nginx.conf')], { last: PUSH });
});
test('1b. .mdx and dependency manifests are code; only notes-kind .txt files are prose', () => {
  for (const p of ['src/Page.mdx', 'requirements.txt', 'constraints.txt', 'CMakeLists.txt', 'robots.txt', 'a/b/requirements-dev.txt', 'READMEfirst.txt', 'todos.txt', 'notesy.txt'])
    assert.equal(scan.isCodePath(p), true, p);
  for (const p of ['README.txt', 'docs/CHANGELOG.txt', 'CHANGES.txt', 'LICENSE.txt', 'NOTICE.txt', 'AUTHORS.txt', 'NOTES.txt', 'TODO.txt', 'notes-2026.txt', 'LICENSE.third-party.txt', 'TODO', 'CHANGES', 'NOTES'])
    assert.equal(scan.isProsePath(p), true, p);
  blocks([...edit('src/App.ts'), ...passingTest(), ...edit('requirements.txt')]);
  blocks([...edit('src/App.ts'), ...passingTest(), ...edit('src/Page.mdx')]);
});
test('1b. must not change: README.txt, notes and .md edits after the tests still pass', () => {
  allows([...edit('src/App.ts'), ...passingTest(), ...edit('README.txt'), ...edit('docs/NOTES.txt'), ...edit('docs/a.md')], { last: PUSH });
});
test('4b. an inline or plain-text push command counts as a claim', () => {
  for (const last of ['GATE: PASS\n\nRun `git push origin HEAD:fix/probe`', 'Done. Now run git push origin HEAD:fix/probe to publish.', 'Use "git push -u origin x" or `gh pr create --draft`.', 'Run:\n```\ngit push\n```'])
    blocks([...edit('src/App.ts')], { last, active: true });
});
test('4b. must not change: a text that names no push command, or code that is verified, is not held', () => {
  allows([...edit('src/App.ts')], { last: 'I changed the source. Tests have not run yet; pushing is not ready.', active: true });
  allows([...edit('src/App.ts'), ...passingTest()], { last: 'GATE: PASS\n\nRun `git push origin HEAD:fix/probe`' });
});
test('1. must not change: prose edits and the normal edit-test-verdict flow pass', () => {
  allows([...edit('README.md')]);
  allows([...edit('docs/logo.png'), ...edit('memory/MEMORY.md'), ...edit('specs/plan.md')]);
  allows([...edit('src/App.ts'), ...passingTest()], { last: PUSH });
});

// ---- finding 2: a run that tests nothing earns no credit ---------------------------------------------------------
test('2. a run that tested nothing is no passing check', () => {
  const runs2 = [
    ['dotnet test --filter "FullyQualifiedName~Nope"', 'No test matches the given testcase filter `FullyQualifiedName~Nope` in C:\\x\\Tests.dll'],
    ['dotnet test -t', 'The following Tests are available:\n    A.B'], ['dotnet test --list-tests', 'The following Tests are available:'],
    ['npx vitest list', 'a.test.ts > one'], ['npx jest --listTests', '/x/a.test.ts'], ['npx playwright test --list', 'Total: 3 tests in 1 file'],
    ['npx tsc --build --clean', ''], ['go test ./... -run Nope', 'ok  \tx/y\t0.01s [no tests to run]'], ['npm test --if-present', ''],
    ['npx vitest run', 'No test files found, exiting with code 1'], ['pytest -k nope', '============ no tests ran in 0.02s ============'],
    ['dotnet test', 'Passed!  - Failed:     0, Passed:     0, Skipped:     0, Total:     0'],
  ];
  for (const [command, output] of runs2) blocks([...edit('src/App.ts'), ...shell(command, output)]);
});
test('2. a receipt of a run that tested nothing is no passing receipt', () => {
  const record = (extra) => 'CHECK_COMPLETED ' + JSON.stringify({ runId: '12345678-1234-1234-1234-123456789abc', cwd: repo, executable: 'dotnet', args: ['test', 'X.csproj'], status: 'passed', nativeExitCode: 0, signal: null, reason: null, source: { toplevel: repo, treeBefore: '1'.repeat(40), treeAfter: '1'.repeat(40) }, ...extra });
  const evidence = 'node C:/Users/Asus/.claude/skills/gate/scripts/evidence.mjs --spec fixture.json';
  const empty = scanOf([...edit('src/App.ts'), ...shell(evidence, record() + '\nNo test matches the given testcase filter `x`')]);
  assert.equal(empty.passingReceipts.length, 0);
  assert.ok(!(empty.lastBoundCheck > empty.lastEdit));
  const real = scanOf([...edit('src/App.ts'), ...shell(evidence, record() + '\n' + PASS)]);
  assert.equal(real.passingReceipts.length, 1);
  assert.ok(real.lastBoundCheck > real.lastEdit);
});
test('2. must not change: real test runs, a name filter and several projects still pass', () => {
  allows([...edit('src/App.ts'), ...passingTest()]);
  allows([...edit('src/App.ts'), ...shell('npx vitest run -t "name"', ' Test Files  1 passed (1)\n      Tests  2 passed (2)')]);
  allows([...edit('src/App.ts'), ...shell('dotnet test', 'No test is available in A.dll.\n' + PASS)]);
  allows([...edit('src/App.ts'), ...shell('go test ./...', 'ok  \tx/y\t0.01s')]);
});

// ---- finding 3: the final text is read for unverified code ----------------------------------------------------------
const helper = () => { const id = 'h' + (++seq); return [call(id, 'Agent', { description: 'Test designer', prompt: 'Write tests.', run_in_background: true }),
  done(id, 'Async agent launched successfully.', { isAsync: true, status: 'async_launched', agentId: 'helper-' + seq })]; };
test('3. a pass claim or a push command is held on a second stop while code is unverified', () => {
  const entries = [...edit('src/App.ts')];
  blocks(entries, { last: PUSH, active: false });
  const second = stop(entries, { last: PUSH, active: true });
  assert.equal(second.decision, 'block');
  assert.match(second.text, /claims a pass/);
  blocks(entries, { last: 'REVIEW: PASS', active: true });
});
test('3. a pass claim is held while a helper or a background check still runs, and after a declared probe', () => {
  blocks([...edit('src/App.ts'), ...helper()], { last: PUSH });
  blocks([...edit('src/App.ts'), ...shell('npx vitest run', 'Command running in background with ID: bg1', { background: true, result: { backgroundTaskId: 'bg1' } })], { last: PUSH });
  const failed = [...edit('src/App.ts'), ...shell('npx vitest run', ' FAIL  a.test.ts > one\nTests  1 failed (1)', { error: true }), say('PROBE EXPECTED: {"command":"npx vitest run","reason":"proves a bug of the PR under review"}')];
  blocks(failed, { last: PUSH });
});
test('3. must not change: a final text that claims nothing keeps the old exits', () => {
  const entries = [...edit('src/App.ts')];
  const again = stop(entries, { last: 'Still working on it.', active: true });
  assert.equal(again.decision, 'allow');
  assert.match(again.text, /NOT verified/);
  assert.equal(stop([...edit('src/App.ts'), ...helper()], { last: 'Waiting for the helper.' }).decision, 'allow');
  assert.equal(stop([...edit('src/App.ts'), ...shell('npx vitest run', 'Command running in background with ID: bg2', { background: true, result: { backgroundTaskId: 'bg2' } })], { last: 'Waiting.' }).decision, 'allow');
  assert.equal(stop([...edit('src/App.ts'), ...passingTest()], { last: PUSH }).decision, 'allow');
});
test('3. the hold is a 5-in-a-row count: the sixth claim only warns, then it starts again', () => {
  const entries = [...edit('src/App.ts'), ...helper()];
  const session = 'claim-count';
  const got = [];
  for (let i = 0; i < 7; i++) got.push(stop(entries, { last: PUSH, active: true, session }).decision);
  assert.deepEqual(got, ['block', 'block', 'block', 'block', 'block', 'allow', 'block']);
});

// ---- finding 4: a rewrite through an interpreter or a less common command is an edit ------------------------------------
test('4. a rewrite after the last passing test is seen', () => {
  const rewrites = [
    "python - <<'EOF'\nopen('src/App.ts', 'w').write('x')\nEOF",
    `node -e "require('fs').writeFileSync('src/App.ts','x')"`,
    "perl -pi -e 's/a/b/' src/App.ts", 'git clean -fd', 'Rename-Item src/App.ts App2.ts',
    "(Get-Content src/App.ts) -replace 'a','b' | sc src/App.ts", 'curl -sSo src/vendor.js https://example.invalid/v.js', 'wget -O src/vendor.js https://example.invalid/v.js',
  ];
  for (const command of rewrites) blocks([...edit('src/App.ts'), ...passingTest(), ...shell(command)]);
});
test('4. must not change: reading and reporting commands, scripts run by name, a dry run and a log are no edit', () => {
  const harmless = [
    `node -e "console.log(require('fs').readFileSync('src/App.ts','utf8').length)"`, 'node scripts/report.mjs src', 'python -c "print(1)"', 'git clean -n', 'git clean -nd',
    'curl -s https://example.invalid/x -o out/result.md', `node -e "require('fs').writeFileSync(process.env.TEMP + '/x.json','x')"`, 'cp -r src dst',
  ];
  for (const command of harmless) allows([...edit('src/App.ts'), ...passingTest(), ...shell(command)]);
  allows([...edit('src/App.ts'), ...shell('npx vitest run 2>&1 | tee build.log', 'Tests  3 passed (3)')]);
  allows([...edit('src/App.ts'), ...shell('dotnet test > out.log', PASS)]);
});

// ---- finding 5: an honest evidence run is read in its common forms ------------------------------------------------------
const EVIDENCE = 'node C:/Users/Asus/.claude/skills/gate/scripts/evidence.mjs';
const record = () => 'CHECK_COMPLETED ' + JSON.stringify({ runId: '12345678-1234-1234-1234-123456789abc', cwd: repo, executable: 'dotnet', args: ['test', 'X.csproj'], status: 'passed', nativeExitCode: 0, signal: null, reason: null, source: { toplevel: repo, treeBefore: '1'.repeat(40), treeAfter: '1'.repeat(40) } });
test('5. evidence.mjs is read with 2>&1, a display tail, a leading cd, --spec=file and a redirect', () => {
  const forms = [EVIDENCE + ' --spec fixture.json', EVIDENCE + ' --spec fixture.json 2>&1', EVIDENCE + ' --spec fixture.json | tail -20', EVIDENCE + ' --spec fixture.json 2>&1 | head -40',
    'cd ' + repo + ' && ' + EVIDENCE + ' --spec fixture.json', EVIDENCE + ' --spec=fixture.json', EVIDENCE + ' --spec fixture.json > check.log', EVIDENCE + ' --spec fixture.json | tee check.log'];
  for (const command of forms) {
    const r = scanOf([...edit('src/App.ts'), ...shell(command, record() + '\n' + PASS)]);
    assert.equal(r.passingReceipts.length, 1, command);
    assert.ok(r.lastBoundCheck > r.lastEdit, command);
  }
  allows([...edit('src/App.ts'), ...shell(EVIDENCE + ' --spec fixture.json 2>&1', record() + '\n' + PASS)]);
});
test('5. an evidence run whose output went to a file is no failure, only no credit', () => {
  const r = stop([...edit('src/App.ts'), ...shell(EVIDENCE + ' --spec fixture.json > check.log', '')]);
  assert.equal(r.decision, 'block');
  assert.match(r.text, /no build\/test has run since the last edit/);
});
test('5. must not change: a stray evidence.mjs, a second command beside it, or no receipt line is no evidence', () => {
  for (const command of ['node other/evidence.mjs --spec fixture.json', EVIDENCE + ' --spec fixture.json && echo done', EVIDENCE + ' --spec a.json --spec b.json']) {
    const r = scanOf([...edit('src/App.ts'), ...shell(command, record() + '\n' + PASS)]);
    assert.equal(r.passingReceipts.length, 0, command);
  }
  assert.equal(scanOf([...edit('src/App.ts'), ...shell(EVIDENCE + ' --spec fixture.json', 'no receipt here')]).passingReceipts.length, 0);
  assert.ok(scanOf([...edit('src/App.ts'), ...shell(EVIDENCE + ' --spec fixture.json', 'no receipt here')]).lastFailedVerify > -1);
});

// ---- finding 6: failure-shaped words in a run that passed ---------------------------------------------------------------
test('6. with exit 0 and the runner\'s own pass line, loose failure words do not make the run failed', () => {
  allows([...edit('src/App.ts'), ...shell('npx vitest run', 'Import finished: 12 imported, 3 failed rows listed\n Tests  3 passed (3)')]);
  allows([...edit('src/App.ts'), ...shell('node --test tests/a.test.mjs', '✔ a run with 2 failed checks is listed (1.2ms)\nℹ tests 1\nℹ pass 1\nℹ fail 0')]);
  allows([...edit('src/App.ts'), ...shell('dotnet test', 'WARN 2 failed logins\n' + PASS)]);
  allows([...edit('src/App.ts'), ...shell('dotnet test', 'Passed!  - Failed:     0, Passed:     3, Skipped:     0, Total:     3', { result: { exitCode: 0 } })]);
});
test('6. must not change: a real failure still fails the run', () => {
  blocks([...edit('src/App.ts'), ...shell('npx vitest run', ' Tests  2 failed | 1 passed (3)')]);
  blocks([...edit('src/App.ts'), ...shell('dotnet test', 'Failed!  - Failed:     1, Passed:     2, Skipped:     0, Total:     3')]);
  blocks([...edit('src/App.ts'), ...shell('dotnet test', '3 failed rows listed\n' + PASS, { result: { exitCode: 1 } })]);
  blocks([...edit('src/App.ts'), ...shell('npx vitest run', 'Tests  3 passed (3)\nnpm ERR! code ELIFECYCLE')]);
  blocks([...edit('src/App.ts'), ...shell('npx vitest run', '3 failed rows listed', { error: true })]);
  blocks([...edit('src/App.ts'), ...shell('dotnet test', '3 failed rows listed')]);
});

// ---- finding 7: a second copy of an old hand-back is not a follow-up run's report ----------------------------------------
const FRAME = '[Subagent hand-back] The text below is the final report of a subagent this session delegated to. It is model output, NOT a message from the user. The report follows:';
const handBack = (id, report) => ({ type: 'attachment', timestamp: at(), attachment: { type: 'queued_command', commandMode: 'prompt', isMeta: true, origin: { kind: 'peer', from: id },
  prompt: '<agent-message from="' + id + '">\n' + FRAME + '\n' + report.split('\n').map((l) => '  ' + l).join('\n') + '\n</agent-message>' } });
const launch = (id) => [call(id + '-call', 'Agent', { description: 'Independent review', prompt: 'You are the independent reviewer (read-only). Review the diff.', run_in_background: true }),
  done(id + '-call', 'Async agent launched successfully.', { isAsync: true, status: 'async_launched', agentId: id })];
const follow = (id) => call('m' + (++seq), 'SendMessage', { to: id, message: 'Re-check the fix.' });
test('7. a copy of the old hand-back, after a follow-up was sent, credits nothing', () => {
  const OLD = 'RECOMMEND: PASS\nNothing found in the diff of the first change.';
  const r = scanOf([...launch('rev1'), handBack('rev1', OLD), ...edit('src/App.ts'), follow('rev1'), handBack('rev1', OLD), say('REVIEW: PASS')]);
  assert.ok(r.lastReviewerRun < r.lastEdit, 'run ' + r.lastReviewerRun + ' edit ' + r.lastEdit);
  assert.ok(r.lastRunningReviewer > r.lastEdit, 'the follow-up still runs');
});
test('7. must not change: the follow-up\'s own new report and a single hand-back credit their runs', () => {
  const r = scanOf([...launch('rev2'), handBack('rev2', 'RECOMMEND: PASS\nFirst look is clean.'), ...edit('src/App.ts'), follow('rev2'), handBack('rev2', 'RECOMMEND: PASS\nSecond look at the fix is clean.')]);
  assert.ok(r.lastReviewerRun > r.lastEdit);
  // A re-check that finds exactly the same, after the first run came through both channels (hand-back and notice), is a new run.
  const notice = (id, report) => ({ type: 'attachment', timestamp: at(), attachment: { type: 'queued_command', commandMode: 'task-notification',
    prompt: '<task-notification>\n<task-id>' + id + '</task-id>\n<status>completed</status>\n<summary>Agent "Independent review" completed</summary>\n<result>' + report + '</result>\n</task-notification>' } });
  const SAME = 'RECOMMEND: PASS\nNothing found in the diff.';
  const again = scanOf([...launch('rev4'), handBack('rev4', SAME), notice('rev4', SAME), ...edit('src/App.ts'), follow('rev4'), handBack('rev4', SAME)]);
  assert.ok(again.lastReviewerRun > again.lastEdit);
  const once = scanOf([...edit('src/App.ts'), ...launch('rev3'), handBack('rev3', 'RECOMMEND: PASS\nClean.')]);
  assert.ok(once.lastReviewerRun > once.lastEdit);
});

// ---- finding 8: a commit message that names a git command ---------------------------------------------------------------
test('8. a commit with a heredoc message is no git change, a command substitution in it still is', () => {
  const msg = "git commit -m \"$(cat <<'EOF'\nfix(sync): handle a failed git pull on the test machine\nEOF\n)\"";
  assert.deepEqual(scan.shellEditPaths(msg), []);
  assert.deepEqual(scan.shellEditPaths('git commit -m "fix: handle a failed git pull"'), []);
  assert.deepEqual(scan.shellEditPaths('git tag -a v1 -m "after git reset"'), []);
  allows([...edit('src/App.ts'), ...passingTest(), ...shell(msg)]);
});
test('8. must not change: git changes, and a command substitution, are still changes', () => {
  assert.deepEqual(scan.shellEditPaths('git commit -m "$(git pull -q)"'), ['<git>']);
  assert.deepEqual(scan.shellEditPaths('git pull'), ['<git>']);
  assert.deepEqual(scan.shellEditPaths('git switch main'), ['<git>']);
});

// ---- round 3 (2026-11-18): five more confirmed problems ----------------------------------------------------------
test('r3-1. an arrow or comparison inside quoted text is no redirection to a file', () => {
  for (const c of [
    `node -e "const r=require('./out.json');console.log(r.notes.filter(n => !n.outcome).length)"`,
    `node -e "console.log([1,2,3].filter(n => n > 1).length)"`,
    `grep -n "items.Where(x => x.IsActive)" src/App.cs`,
    `git commit -m "fix(roles): send role -> core.api through a queue"`,
    "git commit -m \"$(cat <<'EOF'\nmap u => u.name\nEOF\n)\"",
    `sqlcmd -Q "SELECT COUNT(*) FROM Users u WHERE u.Id > u.DepartmentId"`,
    `jq -r '.[] | select(.count > .limit) | .name' "$TEMP/x.json"`,
    `echo "flow: page -> api.service -> db.table"`,
  ]) {
    assert.deepEqual(scan.shellEditPaths(c), [], c);
    allows([...edit('src/App.ts'), ...passingTest(), ...shell(c)]);
  }
});
test('r3-1. must not change: a real redirect to a code file is still an edit', () => {
  assert.deepEqual(scan.shellEditPaths('pip freeze > requirements.txt'), ['requirements.txt']);
  assert.deepEqual(scan.shellEditPaths('echo "a => b.c" > src/map.ts'), ['src/map.ts']);
  assert.deepEqual(scan.shellEditPaths(`printf 'x' >> "src/My File.ts"`), ['src/My File.ts']);
  blocks([...edit('src/App.ts'), ...passingTest(), ...shell('echo "x" > src/map.ts')]);
});
test('r3-2. a copy with a stream redirection names its real destination', () => {
  const tmp = 'C:/Users/Asus/AppData/Local/Temp/claude/x';
  const c = `cp "${tmp}/tasks/b1.output" "${tmp}/scratchpad/proof.log" 2>/dev/null`;
  assert.deepEqual(scan.shellEditPaths(c), []);
  allows([...edit('src/App.ts'), ...passingTest(), ...shell(c)]);
});
test('r3-2. must not change: a code copy with a redirection is still an edit', () => {
  assert.deepEqual(scan.shellEditPaths('cp src/a.ts src/b.ts 2>/dev/null'), ['src/b.ts']);
});
test('r3-3. a reading command saved to a report file is no edit', () => {
  for (const c of ['git diff > diff.txt', 'git status --short > status.txt 2>&1', 'git log --oneline -20 | tee log.txt', 'git diff > build.log', 'gh pr diff 5 > pr.patch', 'ls -la > files.txt']) {
    assert.deepEqual(scan.shellEditPaths(c), [], c);
    allows([...edit('src/App.ts'), ...passingTest(), ...shell(c)]);
  }
});
test('r3-3. must not change: other output to a code or manifest file is still an edit', () => {
  assert.deepEqual(scan.shellEditPaths('git diff > fix.ts'), ['fix.ts']);
  assert.deepEqual(scan.shellEditPaths('pip freeze > requirements.txt'), ['requirements.txt']);
  assert.deepEqual(scan.shellEditPaths('git log | tee src/log.ts'), ['src/log.ts']);
  // 2026-11-18: a .log file is output, no code kind (was: an edit of notes.log)
  assert.deepEqual(scan.shellEditPaths('echo hi | tee notes.log'), []);
  assert.deepEqual(scan.shellEditPaths('mv gate.log logs/gate.log'), []);
  assert.deepEqual(scan.shellEditPaths('echo x > run.log'), []);
  assert.deepEqual(scan.shellEditPaths('mv run.log run.log.1'), []);
  assert.deepEqual(scan.shellEditPaths('mv run.log run.log.old'), []);
  assert.deepEqual(scan.shellEditPaths('echo x > src/app.ts'), ['src/app.ts']);
});
test('r3-4. a push command in more plain-text forms is seen', () => {
  for (const t of [
    'Done. Run **git push origin HEAD:fix/probe** now.',
    'Run \u201cgit push origin HEAD:fix/probe\u201d',
    '```\ngit --no-pager push origin x\n```',
    '/usr/bin/git push origin x',
    '"C:\\Program Files\\Git\\cmd\\git.exe" push origin x',
    '<code>git push origin x</code>',
    '[git push origin x]',
    'C:\\repo>git push origin x',
    '**gh pr create --draft --base staging**',
    'Run `git push origin HEAD:fix/probe`',
  ]) assert.equal(scan.claimsReview(t), true, t);
});
test('r3-4. must not change: other words are not a push', () => {
  for (const t of ['git stash push', 'git subtree push', 'git lfs push', 'legit push', 'see .git push hooks', 'gh pr view 5', 'Tests pass.'])
    assert.equal(scan.claimsReview(t), false, t);
});
test('r3-4. a final text with a push command and unverified code is held on the second stop', () => {
  blocks([...edit('src/App.ts')], { last: 'Done. Run **git push origin HEAD:fix/probe** now.', active: true });
});
test('r3-5. a Python dependency tool rewrites the manifest: an edit', () => {
  for (const c of ['pip-compile --output-file=requirements.txt requirements.in', 'pip-compile -o requirements.txt requirements.in', 'uv pip compile requirements.in -o requirements.txt', 'uv add flask', 'poetry add flask'])
    assert.deepEqual(scan.shellEditPaths(c), ['<generated>'], c);
  blocks([...edit('src/App.ts'), ...passingTest(), ...shell('uv add flask')]);
});
test('r3-5. must not change: a read of a Python tool is no edit', () => {
  for (const c of ['uv --version', 'poetry show', 'pip list', 'uv pip list']) assert.deepEqual(scan.shellEditPaths(c), [], c);
  assert.deepEqual(scan.shellEditPaths('npm install lodash'), ['<generated>']);
});
