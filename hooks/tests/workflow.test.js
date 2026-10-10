'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = process.env.WORKFLOW_HOOKS_ROOT || path.resolve(__dirname, '..');
const repo = 'C:/repos/example';
const transcriptPath = 'C:/virtual/transcript.jsonl';
const source = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const msg = (role, content, rest = {}) => ({ type: role, message: { role, content }, ...rest });
const call = (id, name, input) => msg('assistant', [{ type: 'tool_use', id, name, input }]);
const result = (id, content = '', is_error = false, toolUseResult) => msg('user', [{ type: 'tool_result', tool_use_id: id, content, is_error }], { toolUseResult });
const edit = (file = repo + '/src/App.cs') => [call('edit', 'Edit', { file_path: file }), result('edit', 'File updated.')];
const command = (id, command, content = 'Completed.', isError = false, extra) => [call(id, 'PowerShell', { command }), result(id, content, isError, extra)];
const verdict = (text) => msg('assistant', [{ type: 'text', text }]);
// A completed independent reviewer run as this host records it: an Agent launch
// whose prompt carries the reviewer marker, its async result with the agent id,
// then the task-notification attachment when the agent finishes.
let reviewerCount = 0;
const reviewerRun = (id = 'reviewer' + (++reviewerCount), status = 'completed', prompt = 'You are the independent reviewer (read-only). Review the diff.') => [
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: id + '-call', name: 'Agent', input: { description: 'Independent review', prompt } }] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id + '-call', content: 'Async agent launched successfully.', is_error: false }] }, toolUseResult: { isAsync: true, status: 'async_launched', agentId: id } },
  { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: '<task-notification>\n<task-id>' + id + '</task-id>\n<status>' + status + '</status>\n<summary>Agent "Independent review" ' + status + '</summary>\n</task-notification>' } },
];
const reviewedPass = () => [...reviewerRun(), verdict('REVIEW: PASS')];
const reviewHead = 'a'.repeat(40);
// Happy paths use a source-bound evidence check; the independent review is the
// written REVIEW verdict that must follow the last edit and precede the gate.
const boundCheck = (id = 'bound') => command(id, evidenceCommand(id), 'CHECK_COMPLETED ' + JSON.stringify(checkRecord()));
const reviewReason = r => r.output.hookSpecificOutput?.permissionDecisionReason || '';

// Execute the installed hook code with a synthetic transcript. No child process,
// repository mutation, or network operation is allowed by this harness.
function invoke(hook, entries, options = {}) {
  const transcript = entries.map(JSON.stringify).join('\n');
  const input = { cwd: repo, transcript_path: transcriptPath, hook_event_name: hook === 'stop-gate.js' ? 'Stop' : 'PreToolUse', tool_name: 'PowerShell', tool_input: { command: 'git push origin feature/check' }, ...options.input };
  const fakeFs = {
    readFileSync(p) { if (p === 0) return JSON.stringify(input); if (p === transcriptPath) return transcript; if (options.outputFiles && Object.hasOwn(options.outputFiles, String(p))) return options.outputFiles[p]; if (String(p).replace(/\\/g, '/') === 'C:/checks/run/metadata.json') { if (options.missingCheckRecord) throw Error('Missing check record'); return JSON.stringify(checkRecord(options.savedCheckChange)); } if (options.tsconfig && path.resolve(p) === path.resolve(options.configCwd || repo, 'tsconfig.json')) return JSON.stringify(options.tsconfig); throw Error('Unexpected read: ' + p); },
    existsSync(p) { return p === transcriptPath; },
    statSync(p) { if (options.tsconfig && path.resolve(p) === path.resolve(options.configCwd || repo, 'tsconfig.json')) return { isDirectory: () => false, isFile: () => true }; if (options.tsconfig && path.resolve(p) === path.resolve(options.configCwd || repo)) return { isDirectory: () => true, isFile: () => false }; if (p !== transcriptPath) throw Error('Unexpected stat'); return { size: Buffer.byteLength(transcript), isFile: () => true }; },
  };
  const verificationTarget = { exports: {} };
  if (fs.existsSync(path.join(root, 'lib/verification-target.cjs'))) vm.runInNewContext(source('lib/verification-target.cjs'), { require: n => n === 'fs' ? fakeFs : require(n), module: verificationTarget }, { timeout: 1000 });
  const shellCommand = { exports: {} };
  vm.runInNewContext(source('lib/shell-command.cjs'), { require: n => n === 'path' ? path : n === './verification-target.cjs' ? verificationTarget.exports : assert.fail('Unexpected shell-command require: ' + n), module: shellCommand }, { timeout: 1000 });
  const module = { exports: {} };
  vm.runInNewContext(source('lib/transcript-scan.js'), { require: n => n === 'fs' ? fakeFs : n === './verification-target.cjs' ? verificationTarget.exports : n === './shell-command.cjs' ? shellCommand.exports : require(n), module, Buffer }, { timeout: 1000 });
  let stdout = '';
  const halt = Symbol('exit');
  const gitReads = [];
  try {
    vm.runInNewContext(source(hook), {
      __dirname: root, Buffer,
      require(n) {
        if (n === 'fs') return fakeFs;
        if (n === 'path') return path;
        if (n === 'os') return { homedir: () => 'C:/Users/Asus', tmpdir: () => 'C:/Users/Asus/AppData/Local/Temp' };
        if (n.endsWith('verification-target.cjs')) return verificationTarget.exports;
        if (n.endsWith('shell-command.cjs')) return shellCommand.exports;
        if (n.endsWith('transcript-scan.js')) return module.exports;
        if (n === 'child_process') return { execFileSync(exe, args, opts) {
          assert.equal(exe, 'git'); gitReads.push({ args, cwd: opts.cwd });
          if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) return repo;
          if (args[0] === 'rev-parse' && args[1] === 'HEAD') return options.reviewHead || reviewHead;
          if (args[0] === 'ls-tree') return '100644 blob ' + '2'.repeat(40) + '\t' + args.at(-1);
          if (options.diffError && args[0] === 'diff') throw Error('Git diff failed.');
          if (args[0] === 'diff' && args.includes('--name-only')) return (options.codePaths || ((options.codeCwd ? path.resolve(opts.cwd) !== path.resolve(options.codeCwd) : options.docsOnly) ? ['README.md'] : ['src/App.cs'])).join('\0') + '\0';
          if (args[0] === 'diff' && args.includes('--binary')) return options.reviewPatch || '';
          if (options.alternateSource && args[0] === 'rev-parse' && args[2] === options.alternateSource + '^{commit}') return 'another-commit';
          if (args[0] === 'rev-parse' && args[2]?.endsWith('^{commit}')) return options.reviewHead || reviewHead;
          if (args[0] === 'rev-parse' && args[1]?.endsWith('^{tree}')) return options.changedTree ? args[1] : '1'.repeat(40);
          if (args[0] === 'diff' && args.includes('--unified=0')) return options.relationalPatch || (options.relationalDiff ? '+++ b/src/App.cs\n+        await rows.ExecuteUpdateAsync(u => u);' : '');
          if (args[0] === 'diff' && options.smallDiff) return '10\t0\tsrc/App.cs';
          if (args[0] === 'diff') return (options.codeCwd ? path.resolve(opts.cwd) !== path.resolve(options.codeCwd) : options.docsOnly) ? '10\t0\tREADME.md' : '100\t0\tsrc/App.cs';
          if (args[0] === 'merge-base') return 'synthetic-base';
          if (args[0] === 'rev-parse') return 'origin/feature/check';
          throw Error('Unexpected git call: ' + args.join(' '));
        } };
        throw Error('Unexpected require: ' + n);
      },
      process: { cwd: () => repo, stdout: { write: (s) => { stdout += s; } }, exit: () => { throw halt; } },
    }, { timeout: 1000 });
  } catch (e) { if (e !== halt) throw e; }
  const output = stdout ? JSON.parse(stdout) : {};
  return { decision: output.decision || output.hookSpecificOutput?.permissionDecision || 'allow', output, gitReads };
}

test('chat-only stop stays silent', () => assert.equal(invoke('stop-gate.js', []).decision, 'allow'));
test('unverified ordinary code blocks stop', () => assert.equal(invoke('stop-gate.js', edit()).decision, 'block'));
test('absolute worktree code blocks stop', () => assert.equal(invoke('stop-gate.js', edit(repo + '/.claude/worktrees/feature/src/App.cs')).decision, 'block'));
test('Windows worktree path blocks stop', () => assert.equal(invoke('stop-gate.js', edit('C:\\repos\\app\\.claude\\worktrees\\feature\\src\\App.cs')).decision, 'block'));
test('actual Claude config stays exempt', () => assert.equal(invoke('stop-gate.js', edit('C:/Users/example/.claude/hooks/example.js')).decision, 'allow'));
test('Codex config stays exempt', () => assert.equal(invoke('stop-gate.js', edit('C:/Users/example/.codex/config.toml')).decision, 'allow'));
test('completed build allows stop without claiming the full gate passed', () => {
  const r = invoke('stop-gate.js', [...edit(), ...command('build', 'dotnet build', 'Build succeeded.')]);
  assert.equal(r.decision, 'allow'); assert.doesNotMatch(r.output.systemMessage, /Gate: build\/test passed/);
});
test('later failing tests invalidate earlier passing build', () => assert.equal(invoke('stop-gate.js', [...edit(), ...command('build', 'dotnet build', 'Build succeeded.'), ...command('test', 'dotnet test', 'Test Run Failed.', true)]).decision, 'block'));
test('later passing build does not clear failing tests', () => assert.equal(invoke('stop-gate.js', [...edit(), ...command('test', 'dotnet test', 'Test Run Failed.', true), ...command('build', 'dotnet build', 'Build succeeded.')]).decision, 'block'));
test('passing retry clears the same failed test command', () => assert.equal(invoke('stop-gate.js', [...edit(), ...command('test1', 'dotnet test', 'Test Run Failed.', true), ...command('test2', 'dotnet test', 'Passed: 20')]).decision, 'allow'));
test('npm.cmd build is recognized', () => assert.equal(invoke('stop-gate.js', [...edit(), ...command('build', 'npm.cmd run build', 'Build completed.')]).decision, 'allow'));
test('quoted Windows executable is recognized', () => assert.equal(invoke('stop-gate.js', [...edit(), ...command('build', '& "C:\\Program Files\\dotnet\\dotnet.exe" build', 'Build succeeded.')]).decision, 'allow'));
test('an arbitrary script is not build or test evidence', () => assert.equal(invoke('stop-gate.js', [...edit(), ...command('script', 'node helper.js', 'ok')]).decision, 'block'));
test('starting a dev server is not verification', () => assert.equal(invoke('stop-gate.js', [...edit(), ...command('dev', 'npm run dev', 'Server ready')]).decision, 'block'));
const background = () => command('test', 'dotnet test', 'Command running in background with ID: task1', false, { backgroundTaskId: 'task1', stdout: '', stderr: '' });
test('background launch is pending', () => assert.equal(invoke('stop-gate.js', [...edit(), ...background()]).decision, 'block'));
test('completed successful background test counts', () => assert.equal(invoke('stop-gate.js', [...edit(), ...background(), call('wait', 'TaskOutput', { task_id: 'task1' }), result('wait', 'Passed: 20', false, { retrieval_status: 'success', task: { id: 'task1', status: 'completed', exitCode: 0, output: 'Passed: 20' } })]).decision, 'allow'));
test('background failure blocks despite earlier build', () => assert.equal(invoke('stop-gate.js', [...edit(), ...command('build', 'dotnet build', 'Build succeeded.'), ...background(), call('wait', 'TaskOutput', { task_id: 'task1' }), result('wait', '', false, { retrieval_status: 'success', task: { id: 'task1', status: 'failed', exitCode: 1, output: 'Tests failed.' } })]).decision, 'block'));
test('background timeout remains pending', () => assert.equal(invoke('stop-gate.js', [...edit(), ...background(), call('wait', 'TaskOutput', { task_id: 'task1' }), result('wait', '', false, { retrieval_status: 'timeout', task: { id: 'task1', status: 'running' } })]).decision, 'block'));
test('background launched before a newer edit is stale', () => assert.equal(invoke('stop-gate.js', [...background(), ...edit(), call('wait', 'TaskOutput', { task_id: 'task1' }), result('wait', 'Passed: 20', false, { retrieval_status: 'success', task: { id: 'task1', status: 'completed', exitCode: 0 } })]).decision, 'block'));
test('structured nonzero exit code is failure', () => assert.equal(invoke('stop-gate.js', [...edit(), ...command('test', 'dotnet test', '', false, { exitCode: 1 })]).decision, 'block'));
test('an interrupted verification is not a pass', () => assert.equal(invoke('stop-gate.js', [...edit(), ...command('test', 'dotnet test', '', false, { interrupted: true })]).decision, 'block'));
test('stop only blocks once and then warns honestly', () => {
  const r = invoke('stop-gate.js', edit(), { input: { stop_hook_active: true } });
  assert.equal(r.decision, 'allow'); assert.match(r.output.systemMessage, /NOT verified/);
});
test('production push stays denied', () => assert.equal(invoke('policy-guard.js', [], { input: { tool_input: { command: 'git push origin main' } } }).decision, 'deny'));
test('unverified worktree push is denied', () => assert.equal(invoke('policy-guard.js', edit(repo + '/.claude/worktrees/feature/src/App.cs')).decision, 'deny'));
test('push with failed review or gate is denied', () => assert.equal(invoke('policy-guard.js', [...edit(), ...command('test', 'dotnet test'), verdict('REVIEW: FAIL'), verdict('GATE: FAIL')]).decision, 'deny'));
test('push needs actual verification as well as written verdicts', () => assert.equal(invoke('policy-guard.js', [...edit(), ...reviewedPass(), verdict('GATE: PASS')]).decision, 'deny'));
test('new session with outgoing code needs fresh proof', () => assert.equal(invoke('policy-guard.js', []).decision, 'deny'));
test('successful verification and fresh review/gate allow feature push', () => assert.equal(invoke('policy-guard.js', [...edit(), ...command('test', 'dotnet test'), ...boundCheck(), ...reviewedPass(), verdict('GATE: PASS')]).decision, 'allow'));
test('docs-only push requires no code proof', () => assert.equal(invoke('policy-guard.js', [], { docsOnly: true }).decision, 'allow'));
test('quoted verdict examples do not satisfy the push gate', () => assert.equal(invoke('policy-guard.js', [...edit(), ...command('test', 'dotnet test'), verdict('Example: REVIEW: PASS\nExample: GATE: PASS')]).decision, 'deny'));
test('gate written before completed tests is stale', () => assert.equal(invoke('policy-guard.js', [...edit(), ...reviewedPass(), verdict('GATE: PASS'), ...command('test', 'dotnet test')]).decision, 'deny'));
test('ordered review and gate in one message allow push', () => assert.equal(invoke('policy-guard.js', [...edit(), ...command('test', 'dotnet test'), ...boundCheck(), ...reviewerRun(), verdict('REVIEW: PASS\nGATE: PASS')]).decision, 'allow'));
test('reverse-ordered verdicts in one message deny push', () => assert.equal(invoke('policy-guard.js', [...edit(), ...command('test', 'dotnet test'), verdict('GATE: PASS\nREVIEW: PASS')]).decision, 'deny'));

// Redirections after the refspec are shell syntax, not a second source branch.
const proven = () => [...edit(), ...command('test', 'dotnet test'), ...boundCheck(), ...reviewedPass(), verdict('GATE: PASS')];
test('stderr redirection after the refspec is not read as a push source', () => assert.equal(invoke('policy-guard.js', proven(), { input: { tool_input: { command: 'git push origin feature/check 2>&1' } } }).decision, 'allow'));
test('output redirection to a file after the refspec is not read as a push source', () => assert.equal(invoke('policy-guard.js', proven(), { input: { tool_input: { command: 'git push origin feature/check > push.log' } } }).decision, 'allow'));

// Relational code (ExecuteUpdate / raw SQL / migrations) needs a real-provider run after the last edit.
const smoke = (id = 'smoke') => command(id, "docker exec eduquest-mysql sh -c 'mysql -uroot eduquest -e \"SELECT COUNT(*) FROM Attendances WHERE SessionId = 5\"'", '8');
test('relational change without a provider run is denied', () => assert.equal(invoke('policy-guard.js', proven(), { relationalDiff: true }).decision, 'deny'));
test('relational change with a provider run after the edit allows push', () => assert.equal(invoke('policy-guard.js', [...edit(), ...command('test', 'dotnet test'), ...smoke(), ...boundCheck(), ...reviewedPass(), verdict('GATE: PASS')], { relationalDiff: true }).decision, 'allow'));
test('a failure-aware live API request counts as a provider run', () => assert.equal(invoke('policy-guard.js', [...edit(), ...command('test', 'dotnet test'), ...command('api', 'curl --fail -s -o out.json -w "%{http_code}" http://localhost:5050/api/v1/groups/31/members', '200'), ...boundCheck(), ...reviewedPass(), verdict('GATE: PASS')], { relationalDiff: true }).decision, 'allow'));
test('a provider run before the last edit does not count', () => assert.equal(invoke('policy-guard.js', [...smoke('early'), ...edit(), ...command('test', 'dotnet test'), ...boundCheck(), ...reviewedPass(), verdict('GATE: PASS')], { relationalDiff: true }).decision, 'deny'));
test('a provider run that errored does not count', () => assert.equal(invoke('policy-guard.js', [...edit(), ...command('test', 'dotnet test'), ...command('smoke', "docker exec eduquest-mysql sh -c 'mysql -uroot -e \"SELECT 1\"'", 'ERROR 1045', true), ...boundCheck(), ...reviewedPass(), verdict('GATE: PASS')], { relationalDiff: true }).decision, 'deny'));
test('non-relational code needs no provider run', () => assert.equal(invoke('policy-guard.js', proven(), { relationalDiff: false }).decision, 'allow'));
test('a connectivity probe is not provider proof of the changed feature', () => {
  for (const cmd of ["docker exec eduquest-mysql sh -c 'mysql -uroot eduquest -e \"SELECT 1\"'", 'mysql -uroot -h 127.0.0.1 -P 3307 -e "SELECT VERSION()"', "docker exec eduquest-mysql mysql -uroot -e 'SHOW TABLES; SELECT 1'", 'curl --fail http://localhost:5050/health', 'curl --fail http://localhost:5050/swagger/index.html']) {
    assert.equal(invoke('policy-guard.js', [...edit(), ...command('test', 'dotnet test'), ...command('probe', cmd, '1'), ...boundCheck(), ...reviewedPass(), verdict('GATE: PASS')], { relationalDiff: true }).decision, 'deny', cmd);
  }
});

// Git operations that replace working-tree content invalidate earlier evidence.
test('git merge, reset, stash pop and branch switches count as code changes', () => {
  const built = [...edit(), ...command('build', 'dotnet build', 'Build succeeded.')];
  for (const cmd of ['git merge --no-edit origin/staging', 'git pull', 'git reset --hard HEAD~1', 'git stash pop', 'git stash', 'git switch feature/other', 'git checkout feature/other', 'git -C C:/repos/example cherry-pick abc123', 'git rebase origin/staging']) {
    assert.equal(invoke('stop-gate.js', [...built, ...command('git', cmd)]).decision, 'block', cmd);
  }
  for (const cmd of ['git merge-base origin/staging HEAD', 'git status --short', 'git stash list', 'git log --oneline -3', 'git fetch origin', 'git diff --stat']) {
    assert.equal(invoke('stop-gate.js', [...built, ...command('git', cmd)]).decision, 'allow', cmd);
  }
  const r = invoke('policy-guard.js', [...checkedCode(), ...reviewedPass(), verdict('GATE: PASS'), ...command('merge', 'git merge --no-edit origin/staging', 'Merge made.')]);
  assert.equal(r.decision, 'deny', 'evidence and verdicts from before a merge are stale');
  const s = invoke('stop-gate.js', [...built, ...command('merge', 'git merge --no-edit origin/staging', 'Merge made.')]);
  assert.match(s.output.reason, /git merge\/reset\/switch\/stash/);
});

// The independent Claude reviewer's verdict is the written REVIEW line: it must follow the last edit and precede the gate.
const checkedCode = () => [...edit(), ...command('test', 'dotnet test'), ...boundCheck()];
test('a REVIEW: PASS after the last edit and before the gate allows push', () => assert.equal(invoke('policy-guard.js', [...checkedCode(), ...reviewedPass(), verdict('GATE: PASS')]).decision, 'allow'));
test('verified code with a gate but no review verdict is denied for the review', () => {
  const r = invoke('policy-guard.js', [...checkedCode(), verdict('GATE: PASS')], { smallDiff: true });
  assert.equal(r.decision, 'deny'); assert.match(reviewReason(r), /REVIEW: PASS/);
});
test('a REVIEW: PASS written before the last edit is stale', () => {
  const r = invoke('policy-guard.js', [...reviewedPass(), ...checkedCode(), verdict('GATE: PASS')]);
  assert.equal(r.decision, 'deny'); assert.match(reviewReason(r), /REVIEW: PASS/);
});
test('a REVIEW: FAIL verdict is denied even with a passing gate', () => {
  const r = invoke('policy-guard.js', [...checkedCode(), verdict('REVIEW: FAIL'), verdict('GATE: PASS')]);
  assert.equal(r.decision, 'deny'); assert.match(reviewReason(r), /REVIEW: PASS/);
});
test('a review verdict after the gate is denied', () => {
  const r = invoke('policy-guard.js', [...checkedCode(), verdict('GATE: PASS'), ...reviewedPass()]);
  assert.equal(r.decision, 'deny'); assert.match(reviewReason(r), /REVIEW: PASS/);
});
test('a Codex helper command is no longer review evidence', () => {
  const codex = command('codex', 'node C:/Users/Asus/.claude/skills/codex-review/scripts/run-review.mjs --repo "' + repo + '" --request "C:/request.md" --risk deep', 'CODEX_COMPLETED {}');
  const r = invoke('policy-guard.js', [...checkedCode(), ...codex, verdict('GATE: PASS')]);
  assert.equal(r.decision, 'deny'); assert.match(reviewReason(r), /REVIEW: PASS/);
});
test('worktree locale JSON requires verification', () => assert.equal(invoke('stop-gate.js', edit(repo + '/.claude/worktrees/feature/src/i18n/ar.json')).decision, 'block'));
test('test in another directory cannot clear a failure', () => assert.equal(invoke('stop-gate.js', [...edit(), ...command('backend', 'cd backend; npm test', '1 failed', true), ...command('frontend', 'cd frontend; npm test', 'Tests passed.')]).decision, 'block'));
test('retrying only the last test in a bundle cannot clear its failure', () => assert.equal(invoke('stop-gate.js', [...edit(), ...command('both', 'dotnet test Backend.Tests.csproj; dotnet test Frontend.Tests.csproj', '1 failed'), ...command('front', 'dotnet test Frontend.Tests.csproj', 'Tests passed.')]).decision, 'block'));
test('one completed background test cannot hide another pending task', () => assert.equal(invoke('stop-gate.js', [...edit(), ...background(), ...command('test2', 'dotnet test', 'Command running in background with ID: task2', false, { backgroundTaskId: 'task2' }), call('wait', 'TaskOutput', { task_id: 'task2' }), result('wait', 'Passed: 20', false, { task: { id: 'task2', status: 'completed', exitCode: 0 } })]).decision, 'block'));
test('git -C checks outgoing code in its target worktree', () => {
  const codeCwd = repo + '/.claude/worktrees/code';
  const r = invoke('policy-guard.js', [], { codeCwd, input: { tool_input: { command: 'git -C "' + codeCwd + '" push origin feature/check' } } });
  assert.equal(r.decision, 'deny');
  assert.equal(path.resolve(r.gitReads.find(r => r.args[0] === 'diff').cwd), path.resolve(codeCwd));
});
test('push of another source branch cannot use current docs-only proof', () => assert.equal(invoke('policy-guard.js', [], { docsOnly: true, alternateSource: 'feature/code', input: { tool_input: { command: 'git push origin feature/code:feature/code' } } }).decision, 'deny'));
test('remote deletion retains its explicit approval without requiring code proof', () => assert.equal(invoke('policy-guard.js', [], { input: { tool_input: { command: 'git push origin --delete feature/obsolete' } } }).decision, 'ask'));
test('mixed deletion and publication still require code proof', () => assert.equal(invoke('policy-guard.js', [], { input: { tool_input: { command: 'git push origin :feature/obsolete HEAD:feature/new' } } }).decision, 'deny'));
test('colon deletion alone retains explicit approval', () => assert.equal(invoke('policy-guard.js', [], { input: { tool_input: { command: 'git push origin :feature/obsolete' } } }).decision, 'ask'));
test('matching-branch colon refspec is not treated as a deletion', () => assert.equal(invoke('policy-guard.js', [], { input: { tool_input: { command: 'git push origin :' } } }).decision, 'deny'));
test('forced matching-branch refspec is not treated as a deletion', () => assert.equal(invoke('policy-guard.js', [], { input: { tool_input: { command: 'git push origin +:' } } }).decision, 'deny'));

const preflight = (command, options = {}) => invoke('policy-guard.js', [], { ...options, input: { tool_input: { command } } });
test('unrelated node commands keep their existing behavior', () => assert.equal(preflight('node scripts/read-report.mjs').decision, 'allow'));
test('empty reference-root typecheck is rejected before wasting a run', () => assert.equal(preflight('npx tsc --noEmit', { tsconfig: { files: [], references: [{ path: './tsconfig.app.json' }] } }).decision, 'deny'));
test('typecheck preflight follows a preceding directory change', () => assert.equal(preflight('cd frontend && npx tsc --noEmit', { configCwd: path.resolve(repo, 'frontend'), tsconfig: { files: [], references: [{ path: './tsconfig.app.json' }] } }).decision, 'deny'));
test('explicit app and build-mode typechecks remain allowed', () => {
  for (const cmd of ['npx tsc --noEmit -p tsconfig.app.json', 'npx tsc -b']) assert.equal(preflight(cmd, { tsconfig: { files: [], references: [{ path: './tsconfig.app.json' }] } }).decision, 'allow');
});
test('ordinary projects can still use bare tsc', () => assert.equal(preflight('npx tsc --noEmit', { tsconfig: { include: ['src'] } }).decision, 'allow'));
test('listing compiler inputs is not a passing typecheck', () => assert.equal(invoke('stop-gate.js', [...edit(), ...command('files', 'npx tsc --listFilesOnly', 'src/App.ts')]).decision, 'block'));
test('printing compiler config is not a passing typecheck', () => assert.equal(invoke('stop-gate.js', [...edit(), ...command('config', 'npx tsc --showConfig', '{}')]).decision, 'block'));
const fullProof = () => [...checkedCode(), ...reviewedPass(), verdict('GATE: PASS')];
test('recorded compiler or linter exit failures cannot be masked by the display command', () => {
  for (const marker of ['TSC_EXIT=2', 'ESLINT_EXIT=1']) assert.equal(invoke('stop-gate.js', [...edit(), ...command('check', 'npx tsc --noEmit -p tsconfig.app.json', marker)]).decision, 'block');
});
test('compiler input inspection remains available on an empty root', () => assert.equal(preflight('npx tsc --listFilesOnly', { tsconfig: { files: [], references: [{ path: './tsconfig.app.json' }] } }).decision, 'allow'));

const rangeDiff = () => command('range-diff', 'git range-diff ' + 'b'.repeat(40) + '..' + 'c'.repeat(40) + ' ' + 'd'.repeat(40) + '..HEAD', '1:  1111111 = 1:  2222222 feat: example');
test('a reused review never waives current verification or production protection', () => {
  const reused = [...checkedCode(), ...rangeDiff(), verdict('REVIEW: PASS — original review reused; target context checked'), verdict('GATE: PASS')];
  assert.equal(invoke('policy-guard.js', reused).decision, 'allow');
  assert.equal(invoke('policy-guard.js', [...reused, ...command('bad', 'dotnet test', '1 failed')]).decision, 'deny');
  assert.equal(invoke('policy-guard.js', reused, { input: { tool_input: { command: 'git push origin HEAD:main' } } }).decision, 'deny');
  assert.equal(invoke('policy-guard.js', [...checkedCode(), verdict('REVIEW: PASS — original review reused'), verdict('GATE: PASS')]).decision, 'deny', 'reuse needs a range-diff after the last change');
  assert.equal(invoke('policy-guard.js', [...rangeDiff(), ...checkedCode(), verdict('REVIEW: PASS — original review reused'), verdict('GATE: PASS')]).decision, 'deny', 'a range-diff before the last change is stale');
});

// The verdict must rest on a completed reviewer run after the last change.
test('REVIEW: PASS requires a completed reviewer run launched after the last change', () => {
  const needsReviewer = (entries) => {
    const r = invoke('policy-guard.js', entries);
    assert.equal(r.decision, 'deny');
    assert.match(reviewReason(r), /REVIEW: PASS/);
  };
  needsReviewer([...checkedCode(), verdict('REVIEW: PASS'), verdict('GATE: PASS')]);
  needsReviewer([...reviewerRun(), ...checkedCode(), verdict('REVIEW: PASS'), verdict('GATE: PASS')]);
  needsReviewer([...checkedCode(), ...reviewerRun().slice(0, 2), verdict('REVIEW: PASS'), verdict('GATE: PASS')]);
  needsReviewer([...checkedCode(), ...reviewerRun('rk', 'killed'), verdict('REVIEW: PASS'), verdict('GATE: PASS')]);
  needsReviewer([...checkedCode(), ...reviewerRun('rx', 'completed', 'Summarize this file for me.'), verdict('REVIEW: PASS'), verdict('GATE: PASS')]);
  needsReviewer([...checkedCode(), verdict('REVIEW: PASS'), ...reviewerRun(), verdict('GATE: PASS')]);
  assert.equal(invoke('policy-guard.js', [...checkedCode(), ...reviewerRun(), verdict('REVIEW: PASS'), verdict('GATE: PASS')]).decision, 'allow');
});
test('a follow-up message to the same reviewer after a fix counts as a new run', () => {
  const first = reviewerRun('rv-follow');
  const followUp = [call('follow', 'SendMessage', { to: 'rv-follow', message: 'Re-check the fix diff.' }), result('follow', 'Message queued.'),
    { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: '<task-notification>\n<task-id>rv-follow</task-id>\n<status>completed</status>\n<summary>Agent finished</summary>\n</task-notification>' } }];
  assert.equal(invoke('policy-guard.js', [...first, ...checkedCode(), ...followUp, verdict('REVIEW: PASS'), verdict('GATE: PASS')]).decision, 'allow');
  assert.equal(invoke('policy-guard.js', [...first, ...checkedCode(), ...followUp.slice(0, 2), verdict('REVIEW: PASS'), verdict('GATE: PASS')]).decision, 'deny', 'the follow-up must finish');
});

test('warnings-only ESLint exit zero is not a command failure', () => {
  assert.equal(invoke('stop-gate.js', [...edit(), ...command('lint', 'npx eslint src', '✖ 2 problems (0 errors, 2 warnings)\nESLINT_EXIT=0')]).decision, 'allow');
});
test('ESLint errors and a warning-limit nonzero exit still block', () => {
  for (const output of ['✖ 2 problems (1 error, 1 warning)\nESLINT_EXIT=1', '✖ 2 problems (0 errors, 2 warnings)\nESLINT_EXIT=1']) {
    assert.equal(invoke('stop-gate.js', [...edit(), ...command('lint', 'npx eslint src', output)]).decision, 'block');
  }
});
test('legacy compound failures stay unresolved when step provenance is unavailable', () => {
  assert.equal(invoke('stop-gate.js', [...edit(),
    ...command('red', 'git stash push; dotnet test Backend.Tests.csproj; git stash pop', 'SETUP_EXIT=0\nFailed! - Failed: 1, Passed: 0\nTEST_EXIT=1\nCLEANUP_EXIT=0'),
    ...command('green', 'dotnet test Backend.Tests.csproj', 'Passed: 1\nTEST_EXIT=0')]).decision, 'block');
});
test('a red test never excuses failed or unproven restoration', () => {
  for (const [text, isError, extra] of [
    ['Failed! - Failed: 1, Passed: 0\nCONFLICT (content): Merge conflict', true],
    ['SETUP_EXIT=0\nFailed! - Failed: 1, Passed: 0\nCLEANUP_EXIT=1', false],
    ['SETUP_EXIT=0\nFailed! - Failed: 1, Passed: 0\nCLEANUP_EXIT=0', false, { interrupted: true }],
    ['Failed! - Failed: 1, Passed: 0', false],
  ]) assert.equal(invoke('stop-gate.js', [...edit(),
    ...command('red', 'git stash push; dotnet test Backend.Tests.csproj; git stash pop', text, isError, extra),
    ...command('green', 'dotnet test Backend.Tests.csproj', 'Passed: 1')]).decision, 'block');
});
test('an identical complete retry clears an attributed compound failure', () => {
  const cmd = 'git stash push; dotnet test Backend.Tests.csproj; git stash pop';
  assert.equal(invoke('stop-gate.js', [...edit(), ...command('red', cmd, 'SETUP_EXIT=0\nFailed! - Failed: 1, Passed: 0\nCLEANUP_EXIT=0'), ...command('green', cmd, 'Passed: 1')]).decision, 'allow');
});
test('environment overrides are part of the verification identity', () => {
  assert.equal(invoke('stop-gate.js', [...edit(),
    ...command('red', 'git stash push; ASPNETCORE_ENVIRONMENT=Integration dotnet test Backend.Tests.csproj; git stash pop', 'SETUP_EXIT=0\nFailed! - Failed: 1, Passed: 0\nCLEANUP_EXIT=0'),
    ...command('green', 'dotnet test Backend.Tests.csproj', 'Passed: 1')]).decision, 'block');
});
test('native setup and cleanup failures cannot be hidden by the final display', () => {
  for (const marker of ['SETUP_EXIT=1', 'CLEANUP_EXIT=1']) assert.equal(invoke('stop-gate.js', [...edit(),
    ...command('red', 'dotnet test Backend.Tests.csproj', 'Failed! - Failed: 1, Passed: 0'),
    ...command('green', 'git stash push; dotnet test Backend.Tests.csproj; git stash pop', 'Passed: 1\nTEST_EXIT=0\n' + marker, false, { exitCode: 0 })]).decision, 'block');
});
const evidenceCommand = spec => 'node C:/Users/Asus/.claude/skills/gate/scripts/evidence.mjs --spec "C:/checks/' + spec + '.json"';
const checkRecord = (overrides = {}) => ({ runId: '12345678-1234-1234-1234-123456789abc', cwd: repo, executable: 'dotnet', args: ['test', 'Backend.Tests.csproj'], status: 'passed', nativeExitCode: 0, signal: null, reason: null, runDir: 'C:/checks/run', source: { toplevel: repo, treeBefore: '1'.repeat(40), treeAfter: '1'.repeat(40) }, ...overrides });
test('saved native red and matching green use check identity across evidence files', () => {
  assert.equal(invoke('stop-gate.js', [...edit(),
    ...command('red', evidenceCommand('red'), 'CHECK_COMPLETED ' + JSON.stringify(checkRecord({ status: 'failed', nativeExitCode: 1 })), true),
    ...command('green', evidenceCommand('green'), 'CHECK_COMPLETED ' + JSON.stringify(checkRecord()))]).decision, 'allow');
});
test('the evidence helper counts under any user\'s .claude folder, and only there', () => {
  const elsewhere = 'node /home/dev/.claude/skills/gate/scripts/evidence.mjs --spec "/tmp/checks/green.json"';
  assert.equal(invoke('stop-gate.js', [...edit(), ...command('green', elsewhere, 'CHECK_COMPLETED ' + JSON.stringify(checkRecord()))]).decision, 'allow');
  const windowsUser = 'node "C:\\Users\\Other User\\.claude\\skills\\gate\\scripts\\evidence.mjs" --spec "C:/checks/green.json"';
  assert.equal(invoke('stop-gate.js', [...edit(), ...command('green', windowsUser, 'CHECK_COMPLETED ' + JSON.stringify(checkRecord()))]).decision, 'allow');
  const stray = 'node C:/tools/evidence.mjs --spec "C:/checks/green.json"';
  assert.equal(invoke('stop-gate.js', [...edit(), ...command('green', stray, 'CHECK_COMPLETED ' + JSON.stringify(checkRecord()))]).decision, 'block');
});
test('saved native failures cannot be cleared by another check or directory', () => {
  for (const change of [{ cwd: 'C:/elsewhere' }, { args: ['build'] }, { args: ['test', 'Other.Tests.csproj'] }, { status: 'failed', nativeExitCode: 4 }]) {
    assert.equal(invoke('stop-gate.js', [...edit(),
      ...command('red', evidenceCommand('red'), 'CHECK_COMPLETED ' + JSON.stringify(checkRecord({ status: 'failed', nativeExitCode: 1 })), true),
      ...command('green', evidenceCommand('green'), 'CHECK_COMPLETED ' + JSON.stringify(checkRecord(change)))]).decision, 'block');
  }
});
test('echoed or malformed native receipts are not verification', () => {
  assert.equal(invoke('stop-gate.js', [...edit(), ...command('fake', 'echo receipt', 'CHECK_COMPLETED ' + JSON.stringify(checkRecord()))]).decision, 'block');
  assert.equal(invoke('stop-gate.js', [...edit(), ...command('fake', evidenceCommand('bad'), 'CHECK_COMPLETED {}')]).decision, 'block');
});
test('completed background evidence clears its own launch pending state', () => {
  const launch = command('check', evidenceCommand('background'), 'running in background', false, { backgroundTaskId: 'saved-check' });
  const collect = [call('collect', 'TaskOutput', { task_id: 'saved-check' }), result('collect', 'CHECK_COMPLETED ' + JSON.stringify(checkRecord()), false, { task: { status: 'completed', exitCode: 0 } })];
  assert.equal(invoke('stop-gate.js', [...edit(), ...launch, ...collect]).decision, 'allow');
  const other = command('other', evidenceCommand('other'), 'running in background', false, { backgroundTaskId: 'other-check' });
  assert.equal(invoke('stop-gate.js', [...edit(), ...launch, ...other, ...collect]).decision, 'block');
});
// This host reports a finished background command as a task-notification attachment
// (no TaskOutput call); the saved output file carries the command's result.
const notification = (id, status, exitCode, file = 'C:/tasks/' + id + '.output') => ({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification',
  prompt: '<task-notification>\n<task-id>' + id + '</task-id>\n<output-file>' + file + '</output-file>\n<status>' + status + '</status>\n<summary>Background command "check" ' + status + (exitCode === undefined ? '' : ' (exit code ' + exitCode + ')') + '</summary>\n</task-notification>' } });
const bgLaunch = command('bg', evidenceCommand('bg'), 'Command running in background with ID: bg1', false, { backgroundTaskId: 'bg1' });
const bgOutput = { 'C:/tasks/bg1.output': 'CHECK_COMPLETED ' + JSON.stringify(checkRecord()) };
test('a background evidence check is collected from its task notification', () => {
  assert.equal(invoke('stop-gate.js', [...edit(), ...bgLaunch, notification('bg1', 'completed', 0)], { outputFiles: bgOutput }).decision, 'allow');
  assert.equal(invoke('policy-guard.js', [...edit(), ...bgLaunch, notification('bg1', 'completed', 0), ...claimedPass()], { outputFiles: bgOutput }).decision, 'allow');
});
test('a failed, foreign or exit-less task notification does not collect the check', () => {
  for (const note of [notification('bg1', 'completed', 1), notification('bg1', 'failed', 1), notification('bg1', 'killed'), notification('other', 'completed', 0), notification('bg1', 'completed')]) {
    assert.equal(invoke('stop-gate.js', [...edit(), ...bgLaunch, note], { outputFiles: bgOutput }).decision, 'block', JSON.stringify(note.attachment.prompt));
  }
  assert.equal(invoke('stop-gate.js', [...edit(), ...bgLaunch, notification('bg1', 'completed', 0, 'C:/tasks/missing.output')], { outputFiles: bgOutput }).decision, 'block', 'An unreadable output file has no receipt.');
});
test('a background check launched before the last edit stays stale after its notification', () => {
  assert.equal(invoke('policy-guard.js', [...bgLaunch, ...edit(), notification('bg1', 'completed', 0), ...claimedPass()], { outputFiles: bgOutput }).decision, 'deny');
});
// A copy writes its destination only. Installing workflow files from a scratch
// variable path must not count as an application edit (2026-09-28 push block).
test('a copy counts its destination as the edit, never its source', () => {
  const built = [...edit(), ...command('build', 'dotnet build', 'Build succeeded.')];
  for (const cmd of ['cp "$W/tests/workflow.test.js" C:/Users/example/.claude/hooks/tests/workflow.test.js', 'cp ' + repo + '/src/App.cs C:/Users/example/AppData/Local/Temp/backup.cs', 'Copy-Item -Path ' + repo + '/src/App.cs -Destination C:/Users/example/AppData/Local/Temp/App.cs']) {
    assert.equal(invoke('stop-gate.js', [...built, ...command('copy', cmd)]).decision, 'allow', cmd);
  }
  for (const cmd of ['cp C:/Users/example/AppData/Local/Temp/new.cs ' + repo + '/src/App.cs', 'cp C:/Users/example/AppData/Local/Temp/New.cs ' + repo + '/src/Services/', 'Copy-Item C:/Users/example/AppData/Local/Temp/New.cs -Destination ' + repo + '/src/', 'cp -t ' + repo + '/src C:/Users/example/AppData/Local/Temp/New.cs', 'mv ' + repo + '/src/Old.cs C:/Users/example/AppData/Local/Temp/Old.cs', 'cp "$W/New.cs"', 'sudo cp C:/Users/example/AppData/Local/Temp/new.cs ' + repo + '/src/App.cs']) {
    assert.equal(invoke('stop-gate.js', [...built, ...command('copy', cmd)]).decision, 'block', cmd);
  }
});
test('variables assigned earlier in the same command resolve to their real location', () => {
  const built = [...edit(), ...command('build', 'dotnet build', 'Build succeeded.')];
  for (const cmd of ['B=C:/Users/example/.claude/backups/b; cp -p C:/Users/example/.claude/hooks/x.js "$B/tests/"', 'export T="C:/Users/example/AppData/Local/Temp/wf" && cp ' + repo + '/src/App.cs "${T}/App.cs"']) {
    assert.equal(invoke('stop-gate.js', [...built, ...command('copy', cmd)]).decision, 'allow', cmd);
  }
  for (const cmd of ['D=' + repo + '/src; cp C:/Users/example/AppData/Local/Temp/New.cs "$D/"', '$D = "' + repo + '/src"; Copy-Item C:/Users/example/AppData/Local/Temp/New.cs -Destination "$D/App.cs"', 'cp C:/Users/example/AppData/Local/Temp/New.cs "$UNKNOWN/"', 'D=C:/Users/example/AppData/Local/Temp; D=' + repo + '/src; cp C:/Users/example/AppData/Local/Temp/New.cs "$D/"','B=C:/Users/example/.claude/b; echo "$B/x.cs" > ' + repo + '/src/App.cs']) {
    assert.equal(invoke('stop-gate.js', [...built, ...command('copy', cmd)]).decision, 'block', cmd);
  }
});
test('a setup or cleanup failure is not erased by a successful test', () => {
  assert.equal(invoke('stop-gate.js', [...edit(),
    ...command('setup', 'git stash push; dotnet test Backend.Tests.csproj; git stash pop', 'stash conflict', true),
    ...command('green', 'dotnet test Backend.Tests.csproj', 'Passed: 1')]).decision, 'block');
});

const claimedPass = () => [...reviewedPass(), verdict('GATE: PASS')];
const tested = () => [...edit(), ...command('test', 'dotnet test', 'Passed: 20')];
const providerProof = entries => [...tested(), ...entries, ...boundCheck(), ...claimedPass()];
const liveCurl = 'curl --fail-with-body -s http://localhost:5050/api/example';

test('regression: a reviewer launch or failed start is not a review verdict', () => {
  for (const launched of [result('legacy', 'Skill launched (running in the background).'), result('legacy', 'Skill failed to start.', true)]) {
    const r = invoke('policy-guard.js', [...checkedCode(), call('legacy', 'Skill', { skill: 'code-review' }), launched, verdict('GATE: PASS')]);
    assert.equal(r.decision, 'deny'); assert.match(reviewReason(r), /REVIEW: PASS/);
  }
});

test('deleted C# test files stay exempt from provider proof while production deletions require it', () => {
  const entries = [...tested(), ...boundCheck(), ...claimedPass()];
  for (const [file, expected] of [['Project.Tests/UpdateTests.cs', 'allow'], ['src/UpdateService.cs', 'deny']]) {
    const relationalPatch = '--- a/' + file + '\n+++ /dev/null\n- await rows.ExecuteUpdateAsync(u => u);';
    assert.equal(invoke('policy-guard.js', entries, { codePaths: [file], relationalPatch }).decision, expected, file);
  }
});
test('regression: HTTP 500 with curl exit zero does not prove the provider', () => {
  assert.equal(invoke('policy-guard.js', providerProof(command('api', 'curl -s -w "%{http_code}" http://localhost:5050/api/example', 'Internal Server Error\n500', false, { exitCode: 0 })), { relationalDiff: true }).decision, 'deny');
});
test('regression: uncollected provider task is pending', () => {
  assert.equal(invoke('policy-guard.js', providerProof(command('api', liveCurl, 'Command running in background with ID: provider-task', false, { backgroundTaskId: 'provider-task' })), { relationalDiff: true }).decision, 'deny');
});
test('regression: structured provider failure never earns credit', () => {
  assert.equal(invoke('policy-guard.js', providerProof(command('api', liveCurl, '', false, { exitCode: 7 })), { relationalDiff: true }).decision, 'deny');
});
test('provider evidence rejects interrupted, echoed and masked commands', () => {
  for (const [cmd, output, extra] of [[liveCurl, '', { interrupted: true }], ['echo ' + liveCurl, liveCurl, {}], [liveCurl + ' | echo ok', 'ok', {}], [liveCurl + '; echo ok', 'ok', {}], ['curl -H "--fail" http://localhost:5050/api/example', '500', {}], [liveCurl + ' --no-fail', '500', {}], [liveCurl + ' --next http://localhost:5050/health', '500\n200', {}]]) {
    assert.equal(invoke('policy-guard.js', providerProof(command('api', cmd, output, false, extra)), { relationalDiff: true }).decision, 'deny');
  }
});
test('provider failure survives an unrelated success and a later source edit', () => {
  const bad = command('bad-api', liveCurl, '', false, { exitCode: 7 });
  const other = command('health', 'curl --fail http://localhost:5050/health', 'healthy');
  assert.equal(invoke('policy-guard.js', providerProof([...bad, ...other]), { relationalDiff: true }).decision, 'deny');
  assert.equal(invoke('policy-guard.js', [...bad, ...providerProof(other)], { relationalDiff: true }).decision, 'deny');
});
test('same provider retry succeeds and completed background evidence is credited at launch', () => {
  const bad = command('bad-api', liveCurl, '', false, { exitCode: 7 });
  const good = command('good-api', liveCurl, 'ok');
  assert.equal(invoke('policy-guard.js', providerProof([...bad, ...good]), { relationalDiff: true }).decision, 'allow');
  const pending = command('api', liveCurl, 'running in background', false, { backgroundTaskId: 'provider-task' });
  const collect = [call('collect-api', 'TaskOutput', { task_id: 'provider-task' }), result('collect-api', 'ok', false, { task: { status: 'completed', exitCode: 0 } })];
  assert.equal(invoke('policy-guard.js', providerProof([...pending, ...collect]), { relationalDiff: true }).decision, 'allow');
  assert.equal(invoke('policy-guard.js', [...pending, ...providerProof(collect)], { relationalDiff: true }).decision, 'deny');
});
test('a gate written before provider completion is stale', () => {
  const pending = command('api', liveCurl, 'running in background', false, { backgroundTaskId: 'provider-task' });
  const collect = [call('collect-api', 'TaskOutput', { task_id: 'provider-task' }), result('collect-api', 'ok', false, { task: { status: 'completed', exitCode: 0 } })];
  assert.equal(invoke('policy-guard.js', [...providerProof(pending), ...collect], { relationalDiff: true }).decision, 'deny');
});
test('an unreturned launch cannot reuse an earlier passing check', () => {
  assert.equal(invoke('policy-guard.js', [...fullProof(), call('verify', 'PowerShell', { command: 'dotnet test' }), ...claimedPass()]).decision, 'deny');
  assert.equal(invoke('policy-guard.js', [...providerProof(command('api', liveCurl, 'ok')), call('retry', 'PowerShell', { command: liveCurl }), ...claimedPass()], { relationalDiff: true }).decision, 'deny');
});

test('unreadable outgoing diff cannot allow publication', () => assert.equal(invoke('policy-guard.js', fullProof(), { diffError: true }).decision, 'deny'));
test('checked content must match the outgoing tree', () => {
  assert.equal(invoke('policy-guard.js', fullProof(), { reviewHead: 'b'.repeat(40), changedTree: true }).decision, 'deny');
  assert.equal(invoke('policy-guard.js', fullProof(), { reviewHead: 'b'.repeat(40) }).decision, 'allow');
});
test('changed configuration still requires verification', () => {
  for (const file of ['.github/workflows/ci.yml', 'settings.toml', 'web.config']) assert.equal(invoke('stop-gate.js', edit(repo + '/' + file)).decision, 'block');
});
test('multi-transfer curl and PowerShell error-suppression forms earn no provider credit', () => {
  for (const cmd of [liveCurl + ' localhost:5050/health', 'curl --fail http://localhost:5050/{bad,health}', 'Invoke-WebRequest http://localhost:5050/api -SkipHttpErrorCheck:$true', 'Invoke-WebRequest http://localhost:5050/api -SkipHttp:$true', 'Invoke-RestMethod http://localhost:5050/api -ea SilentlyContinue', 'Invoke-RestMethod http://localhost:5050/api -ErrorAction:Ignore', 'Invoke-RestMethod http://localhost:5050/api -ErrorA:Ignore']) {
    assert.equal(invoke('policy-guard.js', providerProof(command('probe', cmd, '500', false, { exitCode: 0 })), { relationalDiff: true }).decision, 'deny', cmd);
  }
  for (const cmd of ['curl --fail -H "X-Note: --fail" --max-time 5 http://localhost:5050/api', 'Invoke-RestMethod http://localhost:5050/api -ErrorAction Stop']) {
    assert.equal(invoke('policy-guard.js', providerProof(command('probe', cmd, '200')), { relationalDiff: true }).decision, 'allow', cmd);
  }
});
test('unrepeatable failures remain blocked with an explicit recovery path', () => {
  const typo = command('typo-test', 'dotnet test Missing.Tests.csproj', '', false, { exitCode: 1 });
  const rejected = invoke('policy-guard.js', [...typo, ...fullProof()]);
  assert.equal(rejected.decision, 'deny');
  assert.match(rejected.output.hookSpecificOutput.permissionDecisionReason, /recovery procedure.*command-evidence/);
  const lost = invoke('policy-guard.js', [call('orphan', 'PowerShell', { command: 'dotnet test' }), ...fullProof()]);
  assert.equal(lost.decision, 'deny');
  assert.equal(invoke('policy-guard.js', fullProof()).decision, 'allow', 'A fresh collected verification/review campaign is usable without copying old failed evidence.');
});
const probe = (cmd, reason = 'Proves the PR under review lets a supervisor edit a class.') => verdict('PROBE EXPECTED: ' + JSON.stringify({ command: cmd, reason }));
test('a declared review probe quiets the stop hook but never the push guard', () => {
  const red = command('probe-run', 'dotnet test --filter SupervisorProbe', 'Failed!  - Failed: 3', true);
  const allowed = invoke('stop-gate.js', [...edit(), ...red, probe('dotnet test --filter SupervisorProbe')]);
  assert.equal(allowed.decision, 'allow');
  assert.match(allowed.output.systemMessage, /probe/i);
  assert.equal(invoke('stop-gate.js', [...edit(), ...red]).decision, 'block', 'undeclared red run still blocks');
  assert.equal(invoke('stop-gate.js', [...edit(), ...red, verdict('PROBE EXPECTED: {"command":"dotnet test --filter SupervisorProbe"}')]).decision, 'block', 'a probe needs a reason');
  assert.equal(invoke('stop-gate.js', [...edit(), ...red, probe('dotnet test --filter Other')]).decision, 'block', 'only the named command is covered');
  assert.equal(invoke('stop-gate.js', [...edit(), probe('dotnet test --filter SupervisorProbe'), ...red]).decision, 'block', 'the declaration must follow the red run');
  assert.equal(invoke('stop-gate.js', [...edit(), ...red, probe('dotnet test --filter SupervisorProbe'), ...command('own', 'dotnet test --filter Mine', 'Failed: 1', true)]).decision, 'block', 'an undeclared failure still blocks');
  assert.equal(invoke('stop-gate.js', [...red, probe('dotnet test --filter SupervisorProbe'), ...edit()]).decision, 'block', 'an edit after the probe needs its own verification');
  assert.equal(invoke('policy-guard.js', [...red, probe('dotnet test --filter SupervisorProbe'), ...fullProof()]).decision, 'deny', 'push stays refused while a probe fails');
});
const retire = (failed, replacement, reason = 'The test project name was mistyped.') => verdict('CHECK RETIRED: ' + JSON.stringify({ failed, replacement, reason }));
test('a retired check clears only after its named replacement passes later', () => {
  const typo = command('typo-test', 'dotnet test Missing.Tests.csproj', '', false, { exitCode: 1 });
  assert.equal(invoke('policy-guard.js', [...typo, retire('dotnet test Missing.Tests.csproj', 'dotnet test'), ...fullProof()]).decision, 'allow');
  assert.equal(invoke('policy-guard.js', [...typo, ...fullProof(), retire('dotnet test Missing.Tests.csproj', 'dotnet test')]).decision, 'deny', 'the replacement must pass after the retirement line');
  assert.equal(invoke('policy-guard.js', [retire('dotnet test Missing.Tests.csproj', 'dotnet test'), ...typo, ...fullProof()]).decision, 'deny', 'a retirement cannot precede the failure');
  assert.equal(invoke('policy-guard.js', [...typo, retire('dotnet test Missing.Tests.csproj', 'dotnet test Real.Tests.csproj'), ...fullProof()]).decision, 'deny', 'the named replacement never ran');
  assert.equal(invoke('policy-guard.js', [...typo, verdict('CHECK RETIRED: {"failed":"dotnet test Missing.Tests.csproj","replacement":"dotnet test"}'), ...fullProof()]).decision, 'deny', 'a retirement needs a reason');
  assert.equal(invoke('policy-guard.js', [...typo, retire('dotnet test Other.Tests.csproj', 'dotnet test'), ...fullProof()]).decision, 'deny', 'only the named failure is retired');
  const running = command('bg', 'dotnet test Other.Tests.csproj', 'running in background', false, { backgroundTaskId: 'bg-x' });
  assert.equal(invoke('policy-guard.js', [...running, retire('dotnet test Other.Tests.csproj', 'dotnet test'), ...fullProof()]).decision, 'deny', 'a still-running check cannot be retired');
});

test('a source-bound receipt cannot certify a different tree or repository', () => {
  for (const source of [null, { toplevel: 'C:/other', treeBefore: '1'.repeat(40), treeAfter: '1'.repeat(40) }, { toplevel: repo, treeBefore: '2'.repeat(40), treeAfter: '1'.repeat(40) }, { toplevel: repo, treeBefore: '1'.repeat(40), treeAfter: '2'.repeat(40) }]) {
    const entries = [...edit(), ...command('bound', evidenceCommand('bound'), 'CHECK_COMPLETED ' + JSON.stringify(checkRecord({ source }))), ...claimedPass()];
    assert.equal(invoke('policy-guard.js', entries).decision, 'deny', JSON.stringify(source));
  }
});
