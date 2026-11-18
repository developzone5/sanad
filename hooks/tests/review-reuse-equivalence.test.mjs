import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {runCommand} from '../../skills/gate/scripts/evidence.mjs';

// Audit H1: a "reused" review needs a git range-diff whose OUTPUT shows every pair equal.
const hooks = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const msg = (role, content) => ({type: role, message: {role, content}});
const say = text => msg('assistant', [{type: 'text', text}]);
const call = (id, command) => msg('assistant', [{type: 'tool_use', id, name: 'Bash', input: {command}}]);
const result = (id, content) => msg('user', [{type: 'tool_result', tool_use_id: id, content, is_error: false}]);

test('a reused review needs a range-diff whose output proves equal patches', async t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'review-reuse-'));
  const repo = path.join(scratch, 'repo'); fs.mkdirSync(repo);
  const git = args => execFileSync('git', args, {cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000});
  const transcript = path.join(scratch, 'transcript.jsonl');
  try {
    git(['init', '--initial-branch=staging']); git(['config', 'user.name', 'developzone5']); git(['config', 'user.email', '65265330+developzone5@users.noreply.github.com']);
    fs.writeFileSync(path.join(repo, 'README.md'), 'Fixture.\n'); git(['add', '--', 'README.md']); git(['commit', '-m', 'test: baseline']);
    const base0 = git(['rev-parse', 'HEAD']).trim();
    fs.writeFileSync(path.join(repo, 'other.txt'), 'x\n'); git(['add', '--', 'other.txt']); git(['commit', '-m', 'test: base moves']);
    const base1 = git(['rev-parse', 'HEAD']).trim();
    git(['update-ref', 'refs/remotes/origin/staging', 'HEAD']);
    git(['switch', '-c', 'old', base0]);
    fs.mkdirSync(path.join(repo, 'src')); fs.writeFileSync(path.join(repo, 'src/App.ts'), 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n'); git(['add', '--', 'src/App.ts']); git(['commit', '-m', 'feat: a']);
    const oldHead = git(['rev-parse', 'HEAD']).trim();
    git(['switch', '-c', 'new', base1]); git(['cherry-pick', oldHead]);
    const equalOut = git(['range-diff', `${base0}..${oldHead}`, `${base1}..HEAD`]);
    const equalHead = git(['rev-parse', 'HEAD']).trim();
    // a clean cherry-pick with -x: the message gains a trailer, the patch is the same
    git(['switch', '-c', 'dashx', base1]); git(['cherry-pick', '-x', oldHead]);
    const dashxOut = git(['range-diff', `${base0}..${oldHead}`, `${base1}..HEAD`]);
    git(['switch', 'new']);
    fs.writeFileSync(path.join(repo, 'src/B.ts'), 'export const b = 2;\n'); git(['add', '--', 'src/B.ts']); git(['commit', '-m', 'feat: b']);
    const extraOut = git(['range-diff', `${base0}..${oldHead}`, `${base1}..HEAD`]);
    git(['branch', 'extra', 'HEAD']); git(['switch', '-q', '-C', 'new', equalHead]);
    git(['switch', '-c', 'changed', equalHead]);
    fs.writeFileSync(path.join(repo, 'src/App.ts'), 'l1\nl2\nl3\nCHANGED\nl5\nl6\nl7\nl8\n'); git(['commit', '-a', '--amend', '--no-edit']);
    const changedOut = git(['range-diff', `${base0}..${oldHead}`, `${base1}..HEAD`]);
    const pathOut = git(['range-diff', `${base0}..${oldHead}`, `${base1}..extra`, '--', 'src/App.ts']);
    const selfOut = git(['range-diff', `${base1}..extra`, `${base1}..extra`]);
    const belowOut = git(['range-diff', `${base0}..${oldHead}`, `${base1}..${equalHead}`]);
    assert.match(dashxOut, /!/); assert.match(pathOut, /=/); assert.doesNotMatch(pathOut, />/); assert.match(selfOut, /=/); assert.match(belowOut, /=/);
    assert.match(equalOut, /=/); assert.match(extraOut, />/); assert.match(changedOut, /!/);

    // 2026-11-18 (audit finding 2): a "reused" verdict also needs a completed review of the OLD commits on record.
    // These tests are about the equal series, so the old commit is recorded here as reviewed (the child inherits the state folder).
    process.env.SANAD_STATE_DIR = path.join(scratch, 'state');
    const store = createRequire(import.meta.url)('../lib/review-store.cjs');
    assert.equal(store.write(transcript, {repo: store.identity(repo), head: oldHead, commits: [oldHead]}, 'earlier-review'), true);

    // The evidence check is bound to a tree: one per branch under test; decide() puts it in front of the entries (the `bound` marker).
    const boundBy = {};
    for (const b of ['new', 'dashx', 'extra', 'changed']) {
      git(['switch', '-q', b]);
      const check = await runCommand({executable: process.execPath, args: ['--check', 'src/App.ts'], cwd: repo, outputRoot: path.join(scratch, 'checks-' + b)});
      boundBy[b] = [call('bound', 'node C:/Users/Asus/.claude/skills/gate/scripts/evidence.mjs --spec fixture.json'), result('bound', 'CHECK_COMPLETED ' + JSON.stringify(check))];
    }
    const bound = [];
    const verdicts = [say('REVIEW: PASS — reused'), say('GATE: PASS')];
    const rd = `git range-diff ${base0}..${oldHead} ${base1}..HEAD`;
    const decide = (entries, branch = 'new') => {
      git(['switch', '-q', branch]);
      fs.writeFileSync(transcript, [...boundBy[branch], ...entries].map(JSON.stringify).join('\n'));
      const out = execFileSync(process.execPath, [path.join(hooks, 'policy-guard.js')], {cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 20000,
        input: JSON.stringify({hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: repo, transcript_path: transcript, tool_input: {command: 'git push origin HEAD:fix/probe'}})});
      
      return out ? JSON.parse(out).hookSpecificOutput : {permissionDecision: 'allow', permissionDecisionReason: ''};
    };
    await t.test('equal series (cherry-pick onto a new base) is allowed', () => {
      assert.equal(decide([...bound, call('rd', rd), result('rd', equalOut), ...verdicts]).permissionDecision, 'allow');
    });
    await t.test('the same with 2>&1 on the command is allowed', () => {
      { const d = decide([...bound, call('rd', rd + ' 2>&1'), result('rd', equalOut), ...verdicts]); assert.equal(d.permissionDecision, 'allow', d.permissionDecisionReason); }
    });
    await t.test('a cherry-pick -x (message trailer only) is allowed', () => {
      { const d = decide([...bound, call('rd', rd), result('rd', dashxOut), ...verdicts], 'dashx'); assert.equal(d.permissionDecision, 'allow', d.permissionDecisionReason); }
    });
    await t.test('an extra commit is denied', () => {
      const d = decide([...bound, call('rd', rd), result('rd', extraOut), ...verdicts], 'extra');
      assert.equal(d.permissionDecision, 'deny'); assert.match(d.permissionDecisionReason, /changed or new commit/);
    });
    await t.test('a rewritten commit is denied', () => {
      const d = decide([...bound, call('rd', rd), result('rd', changedOut), ...verdicts], 'changed');
      assert.equal(d.permissionDecision, 'deny'); assert.match(d.permissionDecisionReason, /changed or new commit/);
    });
    await t.test('no range-diff is denied', () => {
      const d = decide([...bound, ...verdicts]);
      assert.equal(d.permissionDecision, 'deny'); assert.match(d.permissionDecisionReason, /needs a range-diff/);
    });
    await t.test('a piped range-diff is denied', () => {
      assert.equal(decide([...bound, call('rd', rd + ' | head -5'), result('rd', equalOut), ...verdicts]).permissionDecision, 'deny');
    });
    const denied = (entries, branch) => { const d = decide(entries, branch); assert.equal(d.permissionDecision, 'deny', d.permissionDecisionReason); };
    await t.test('a redirect, a one-sided filter or a path limiter hide commits and are denied', () => {
      denied([...bound, call('rd', rd + ' > rd.txt'), result('rd', equalOut), ...verdicts]);
      denied([...bound, call('rd', rd + ' --right-only'), result('rd', equalOut), ...verdicts]);
      denied([...bound, call('rd', rd + ' -- src/App.ts'), result('rd', pathOut), ...verdicts], 'extra');
      denied([...bound, call('rd', rd + ' src/App.ts'), result('rd', pathOut), ...verdicts], 'extra');
    });
    await t.test('an equal run is no proof for a head with a commit the run did not list', () => {
      denied([...bound, call('rd', rd), result('rd', equalOut), ...verdicts], 'extra');          // a commit added after the run
      denied([...bound, call('rd', rd), result('rd', belowOut), ...verdicts], 'extra');          // range stops below HEAD
    });
    await t.test('a range compared with itself is denied', () => {
      denied([...bound, call('rd', `git range-diff ${base1}..HEAD ${base1}..HEAD`), result('rd', selfOut), ...verdicts], 'extra');
    });
    await t.test('a later run that shows a new commit cancels an earlier equal run', () => {
      denied([...bound, call('rd1', rd), result('rd1', belowOut), call('rd2', rd), result('rd2', extraOut), ...verdicts], 'extra');
    });
    await t.test('an empty range-diff output is denied', () => {
      assert.equal(decide([...bound, call('rd', rd), result('rd', ''), ...verdicts]).permissionDecision, 'deny');
    });
  } finally { delete process.env.SANAD_STATE_DIR; fs.rmSync(scratch, {recursive: true, force: true}); }
});
