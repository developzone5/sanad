import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { runCommand } from '../../skills/gate/scripts/evidence.mjs';

const hooks = process.env.WORKFLOW_HOOKS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const msg = (role, content, rest = {}) => ({ type: role, message: { role, content }, ...rest });
const call = (id, command) => msg('assistant', [{ type: 'tool_use', id, name: 'PowerShell', input: { command } }]);
const result = (id, run) => msg('user', [{ type: 'tool_result', tool_use_id: id, content: run.stdout + run.stderr, is_error: run.exitCode !== 0 }], { toolUseResult: run });
const verdict = text => msg('assistant', [{ type: 'text', text }]);
// A completed independent reviewer run as this host records it: an Agent launch
// whose prompt carries the reviewer marker, its async result with the agent id,
// then the task-notification attachment when the agent finishes.
let reviewerCount = 0;
const reviewerRun = (id = 'reviewer' + (++reviewerCount), status = 'completed', prompt = 'You are the independent reviewer (read-only). Review the diff.') => [
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: id + '-call', name: 'Agent', input: { description: 'Independent review', prompt } }] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id + '-call', content: 'Async agent launched successfully.', is_error: false }] }, toolUseResult: { isAsync: true, status: 'async_launched', agentId: id } },
  { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: '<task-notification>\n<task-id>' + id + '</task-id>\n<status>' + status + '</status>\n<summary>Agent "Independent review" ' + status + '</summary>\n</task-notification>' } },
];

const quoted = words => words.map(word => '"' + word + '"').join(' ');

test('zero-line code changes require proof in a fresh session', async t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-process-'));
  const repo = path.join(scratch, 'repo');
  fs.mkdirSync(repo);
  const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git(['init', '--initial-branch=staging']);
    git(['config', 'user.name', 'developzone5']);
    git(['config', 'user.email', '65265330+developzone5@users.noreply.github.com']);
    fs.writeFileSync(path.join(repo, 'App.cs'), '// Source fixture.\n');
    git(['add', '--', 'App.cs']);
    git(['commit', '-m', 'test: establish zero-line fixture']);
    git(['update-ref', 'refs/remotes/origin/staging', 'HEAD']);
    const baseline = git(['rev-parse', 'HEAD']).trim();
    const transcript = path.join(scratch, 'transcript.jsonl');
    fs.writeFileSync(transcript, '');
    const cases = [
      ['rename', 'deny', () => git(['mv', 'App.cs', 'App.txt'])],
      ['mode', 'deny', () => git(['update-index', '--chmod=+x', 'App.cs'])],
      ['empty', 'deny', () => { fs.writeFileSync(path.join(repo, 'Empty.cs'), ''); git(['add', '--', 'Empty.cs']); }],
      ['binary', 'deny', () => { fs.writeFileSync(path.join(repo, 'Binary.cs'), Buffer.from([0, 1, 2])); git(['add', '--', 'Binary.cs']); }],
      ['docs', 'allow', () => { fs.writeFileSync(path.join(repo, 'README.md'), 'Documentation.\n'); git(['add', '--', 'README.md']); }],
    ];
    for (const [name, expected, change] of cases) await t.test(name, () => {
      git(['switch', '-c', 'fixture/' + name, baseline]);
      change();
      git(['commit', '-m', 'test: record ' + name + ' fixture']);
      for (const transcriptPath of [transcript, undefined]) {
        const output = execFileSync(process.execPath, [path.join(hooks, 'policy-guard.js')], {
          cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 20000,
          input: JSON.stringify({ cwd: repo, transcript_path: transcriptPath, tool_name: 'PowerShell', tool_input: { command: 'git push origin HEAD:fix/probe' } }),
        });
        const actual = output ? JSON.parse(output).hookSpecificOutput.permissionDecision : 'allow';
        assert.equal(actual, expected, name + ' with ' + (transcriptPath ? 'empty' : 'missing') + ' transcript');
      }
    });
  } finally {
    const resolved = fs.realpathSync(scratch);
    assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.match(path.basename(resolved), /^workflow-process-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

async function run(exe, args, cwd) {
  const child = spawn(exe, args, { cwd, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const timer = setTimeout(() => child.kill(), 20000);
  try {
    const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.notEqual(exitCode, null, 'Native probe must complete, not time out.');
    return { exitCode, stdout, stderr, interrupted: false };
  } finally { clearTimeout(timer); }
}

test('real hook processes bind checked content and preserve native HTTP failures', async t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-process-'));
  const repo = path.join(scratch, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
  let responseStatus = 500;
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === '/health' ? 200 : responseStatus, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: req.url === '/health' ? 200 : responseStatus }));
  });
  try {
    git(['init', '--initial-branch=staging']);
    git(['config', 'user.name', 'developzone5']);
    git(['config', 'user.email', '65265330+developzone5@users.noreply.github.com']);
    fs.writeFileSync(path.join(repo, 'src/App.cs'), '// Fixture: no application database is used.\n');
    git(['add', '--', 'src/App.cs']);
    git(['commit', '-m', 'test: establish workflow fixture']);
    git(['update-ref', 'refs/remotes/origin/staging', 'HEAD']);
    git(['switch', '-c', 'fix/probe']);
    fs.appendFileSync(path.join(repo, 'src/App.cs'), '// Provider-sensitive diff fixture: rows.ExecuteUpdateAsync(update);\n');
    fs.writeFileSync(path.join(repo, 'src/probe.test.cjs'), "const {test}=require('node:test'); const assert=require('node:assert/strict'); test('fixture runtime',()=>assert.equal(2+2,4));\n");
    git(['add', '--', 'src/App.cs', 'src/probe.test.cjs']);
    git(['commit', '-m', 'test: commit checked fixture contents']);
    const bound = await runCommand({ executable: process.execPath, args: ['--test', 'src/probe.test.cjs'], cwd: repo, outputRoot: path.join(scratch, 'checks') });
    const testRun = { exitCode: bound.nativeExitCode, stdout: fs.readFileSync(bound.stdout, 'utf8'), stderr: fs.readFileSync(bound.stderr, 'utf8') };
    assert.equal(bound.status, 'passed', bound.reason);
    assert.equal(testRun.exitCode, 0, testRun.stderr);
    const tested = [call('test', 'node C:/Users/Asus/.claude/skills/gate/scripts/evidence.mjs --spec fixture.json'), result('test', { ...testRun, stdout: 'CHECK_COMPLETED ' + JSON.stringify(bound) })];
    const claimed = [...reviewerRun(), verdict('REVIEW: PASS'), verdict('GATE: PASS')];
    const transcript = path.join(scratch, 'transcript.jsonl');
    let lastReason = '';
    function decision(entries, command = 'git push origin HEAD:fix/probe') {
      fs.writeFileSync(transcript, entries.map(JSON.stringify).join('\n'));
      const output = execFileSync(process.execPath, [path.join(hooks, 'policy-guard.js')], {
        cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 20000,
        input: JSON.stringify({ cwd: repo, transcript_path: transcript, tool_name: 'PowerShell', tool_input: { command } }),
      });
      const verdict = output ? JSON.parse(output).hookSpecificOutput : null;
      lastReason = verdict?.permissionDecisionReason || '';
      return verdict?.permissionDecision || 'allow';
    }
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const url = `http://127.0.0.1:${server.address().port}/flow`;
    const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
    async function probe(id, failAware, endpoint = url) {
      const args = [...(failAware ? ['--fail-with-body'] : []), '--silent', '--show-error', '--max-time', '5', '--write-out', '\\n%{http_code}', endpoint];
      const native = await run(curl, args, repo);
      return { native, entries: [call(id, quoted([curl, ...args])), result(id, native)] };
    }
    const plain = await probe('plain', false);
    assert.equal(plain.native.exitCode, 0);
    assert.match(plain.native.stdout, /500$/);
    assert.equal(decision([...tested, ...plain.entries, ...claimed]), 'deny');
    const multiArgs = ['--fail-with-body', '--silent', '--show-error', '--write-out', '%{http_code}', url, url.replace('/flow', '/health')];
    const multi = await run(curl, multiArgs, repo);
    assert.equal(multi.exitCode, 0);
    assert.match(multi.stdout, /500.*200/);
    assert.equal(decision([...tested, call('multi', quoted([curl, ...multiArgs])), result('multi', multi), ...claimed]), 'deny', 'An HTTP 500 must not be masked by a later transfer.');
    const failed = await probe('failed', true);
    assert.equal(failed.native.exitCode, 22);
    assert.equal(decision([...tested, ...failed.entries, ...claimed]), 'deny');
    const health = await probe('health', true, url.replace('/flow', '/health'));
    assert.equal(health.native.exitCode, 0);
    assert.equal(decision([...tested, ...failed.entries, ...health.entries, ...claimed]), 'deny');
    responseStatus = 200;
    const passed = await probe('retry', true);
    assert.equal(passed.native.exitCode, 0);
    assert.match(passed.native.stdout, /200$/);
    const complete = [...tested, ...failed.entries, ...passed.entries, ...claimed];
    assert.equal(decision(complete), 'allow', lastReason);
    const staleCheck = { ...bound, source: { ...bound.source, treeAfter: '0'.repeat(40) } };
    assert.equal(decision([call('stale','node C:/Users/Asus/.claude/skills/gate/scripts/evidence.mjs --spec fixture.json'), result('stale',{exitCode:0,stdout:'CHECK_COMPLETED '+JSON.stringify(staleCheck),stderr:''}), ...passed.entries, ...claimed]), 'deny');
    git(['remote','add','origin',path.join(scratch,'not-contacted.git')]);
    git(['update-ref','refs/remotes/origin/fix/probe','HEAD']);
    git(['config','branch.fix/probe.remote','origin']);
    git(['config','branch.fix/probe.merge','refs/heads/fix/probe']);
    assert.equal(decision(complete,'gh pr create --base staging --draft --head fix/probe'),'allow',lastReason);
    assert.equal(decision(complete,'gh pr create --base staging --draft --head other'),'deny');
    assert.equal(decision(complete,'gh pr create --base staging --draft --head other --title "--head=fix/probe" --body x'),'deny', 'A title must not override the actual PR head.');
    assert.equal(decision(complete,'gh pr create --base staging --draft --head other --body "--head=fix/probe" --title x'),'deny');
    assert.equal(decision(complete,'gh pr create --base staging --draft --head fix/probe --title "--head=other" --body x'),'allow', 'Option-shaped title text is data.');
    assert.equal(decision(complete,'gh api repos/fixture/repo/pulls -X POST'),'deny');
    for (const options of ['-XPOST -fhead=other -fbase=staging -ftitle=x', '-Fhead=other -Fbase=staging -Ftitle=x']) {
      assert.equal(decision(complete,'gh api repos/fixture/repo/pulls ' + options),'deny', 'Attached short API options cannot bypass the publishing gate.');
    }
    assert.equal(decision(complete,'gh api graphql -f query="mutation { createPullRequest }"'),'deny');
    assert.equal(decision([...tested, ...passed.entries, verdict('GATE: PASS')]), 'deny', 'A two-line behavior diff still needs independent review.');
    assert.match(lastReason, /REVIEW: PASS/);
    assert.equal(decision(complete, 'git push origin HEAD:main'), 'deny');
    assert.equal(decision(complete, 'gh pr merge 1 --merge'), 'deny');
    assert.equal(decision(complete, 'git reset --hard'), 'ask');
    t.diagnostic('Real CLI: plain curl HTTP 500 exited 0 -> deny; failure-aware curl exited 22 -> deny; same-command HTTP 200 retry -> allow. No push or PR executed.');
    fs.appendFileSync(path.join(repo, 'src/App.cs'), '// Unchecked later content.\n');
    git(['add', '--', 'src/App.cs']);
    git(['commit', '-m', 'test: introduce unchecked fixture content']);
    assert.equal(decision(complete), 'deny', 'A later commit must invalidate the source-bound check.');
    t.diagnostic('Real Git: checked tree -> allowed; later content -> denied.');
  } finally {
    await new Promise(resolve => server.close(resolve));
    const resolved = fs.realpathSync(scratch);
    const temp = fs.realpathSync(os.tmpdir());
    assert.equal(path.dirname(resolved).toLowerCase(), temp.toLowerCase());
    assert.match(path.basename(resolved), /^workflow-process-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
