import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 2026-11-18: the push guard keeps its promise (guard.json round 2): a push or PR goes out only with
// passing evidence, a reviewer run, REVIEW: PASS, GATE: PASS and answered notes, all for the tree that goes out.
// Real git and real hook processes; nothing is ever pushed. Every "must not change" test names the honest flow.
const hooks = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const msg = (role, content) => ({ type: role, message: { role, content } });
const say = (text) => msg('assistant', [{ type: 'text', text }]);
const call = (id, command) => msg('assistant', [{ type: 'tool_use', id, name: 'Bash', input: { command } }]);
const result = (id, content) => msg('user', [{ type: 'tool_result', tool_use_id: id, content, is_error: false }]);
let n = 0;
const edit = (file) => { const id = 'edit' + (++n); return [msg('assistant', [{ type: 'tool_use', id, name: 'Edit', input: { file_path: file, old_string: 'a', new_string: 'b' } }]), result(id, 'File edited successfully.')]; };
const bash = (command) => { const id = 'b' + (++n); return [call(id, command), result(id, 'ok')]; };
const reviewerRun = () => {
  const id = 'reviewer' + (++n);
  return [
    msg('assistant', [{ type: 'tool_use', id: id + '-call', name: 'Agent', input: { description: 'Independent review', prompt: 'You are the independent reviewer (read-only). Review the diff.' } }]),
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id + '-call', content: 'Async agent launched successfully.', is_error: false }] }, toolUseResult: { isAsync: true, status: 'async_launched', agentId: id } },
    { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: '<task-notification>\n<task-id>' + id + '</task-id>\n<status>completed</status>\n<summary>Agent "Independent review" completed</summary>\n</task-notification>' } },
  ];
};

function fixture(t) {
  // The real path, as Git names it: the temp folder may be reached by another spelling (the CI runner's short
  // name RUNNER~1, a junction), and a receipt's toplevel must equal Git's own (2026-11-18: 7 tests failed on CI).
  const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'push-promise-')));
  t.after(() => { try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* temp */ } });
  const repo = path.join(scratch, 'repo'); fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 }).trim();
  git('init', '-q', '--initial-branch=staging'); git('config', 'user.name', 'developzone5'); git('config', 'user.email', '65265330+developzone5@users.noreply.github.com'); git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'README.md'), 'Fixture only.\n'); git('add', '--', 'README.md'); git('commit', '-q', '-m', 'test: baseline');
  git('update-ref', 'refs/remotes/origin/staging', 'HEAD');
  const write = (file, text = 'export const x = 1;\n') => { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), text); };
  const commit = (branch, files, from) => {
    if (branch) git('switch', '-q', '-c', branch, from || 'origin/staging');
    for (const f of files) { write(f); git('add', '--', f); }
    git('commit', '-q', '-m', 'test: change ' + files.join(','));
    return git('rev-parse', 'HEAD^{tree}');
  };
  const receipt = (tree, top = repo) => {
    const id = 'rc' + (++n);
    const rec = { runId: crypto.randomUUID(), cwd: top, executable: 'node', args: ['--test', 'spec' + n + '.json'], status: 'passed', nativeExitCode: 0, source: { toplevel: top, treeBefore: tree, treeAfter: tree } };
    return [call(id, 'node C:/Users/Asus/.claude/skills/gate/scripts/evidence.mjs --spec fixture' + n + '.json'), result(id, 'CHECK_COMPLETED ' + JSON.stringify(rec))];
  };
  const verdicts = () => [...reviewerRun(), say('REVIEW: PASS'), say('GATE: PASS')];
  const transcript = path.join(scratch, 'transcript.jsonl');
  const inspect = (command, entries = []) => {
    fs.writeFileSync(transcript, entries.map(JSON.stringify).join('\n'));
    const out = execFileSync(process.execPath, [path.join(hooks, 'policy-guard.js')], { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 40000, input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: repo, transcript_path: transcript, tool_input: { command } }) });
    return out ? JSON.parse(out).hookSpecificOutput : { permissionDecision: 'allow', permissionDecisionReason: '' };
  };
  return { repo, git, write, commit, receipt, verdicts, inspect, bash, decision: (...a) => inspect(...a).permissionDecision };
}

const PUSH = 'git push origin HEAD:fix/probe';

test('finding 1: a push or PR after a HEAD-changing part of the same command is refused', (t) => {
  const f = fixture(t);
  const tree = f.commit('fix/probe', ['src/App.ts']);
  const ok = [...f.receipt(tree), ...f.verdicts()];
  assert.equal(f.decision(PUSH, ok), 'allow', 'control: the plain push of a verified tree');
  for (const head of ['git merge origin/staging --no-edit', 'git pull origin staging --no-edit', 'git cherry-pick origin/staging', 'git switch staging', 'git checkout staging',
    'git rebase origin/staging', 'git reset --soft HEAD~1', 'git revert HEAD', 'git am x.patch', 'git add index.html && git commit -q -m "feat: page"']) {
    const o = f.inspect(head + ' && ' + PUSH, ok);
    assert.equal(o.permissionDecision, 'deny', head);
    assert.match(o.permissionDecisionReason, /run the push as its own command/, head);
  }
  assert.equal(f.inspect('git commit -q -m x; gh pr create --draft --base staging', ok).permissionDecision, 'deny');
  assert.match(f.inspect('git commit -q -m x; gh pr create --draft --base staging', ok).permissionDecisionReason, /run the push as its own command/);
  // must not change: parts that do not move HEAD, a part after the push, and a dry run
  for (const command of ['git status && ' + PUSH, 'git fetch origin && ' + PUSH, 'git add src/App.ts && git status && ' + PUSH, PUSH + ' && git status']) {
    assert.equal(f.decision(command, ok), 'allow', command);
  }
  assert.equal(f.decision('git commit -q -m x && git push -n origin HEAD:fix/probe', ok), 'allow', 'a dry run publishes nothing');
  assert.equal(f.decision('git add src/App.ts && git commit -q -m x', ok), 'allow', 'a commit alone is no publishing');
});

test('finding 2: the push guard and the scanner agree on what is code', (t) => {
  const f = fixture(t);
  const tree = f.commit('fix/probe', ['index.html', 'nginx.conf', 'data/seed.json', 'Domain/Specs/ActiveUserSpec.cs', 'Infrastructure/Memory/TokenCache.cs', '.claude/hooks/guard.js']);
  const ok = [...f.receipt(tree), ...f.verdicts()];
  assert.equal(f.decision(PUSH, ok), 'allow', 'control: reviewed and verified');
  assert.equal(f.decision(PUSH), 'deny', 'no evidence: the files are code');
  // an edit of such a file after the verdicts needs a new review (the scanner and the guard both call it code)
  f.write('index.html', '<html>late</html>\n'); f.git('add', '--', 'index.html'); f.git('commit', '-q', '-m', 'test: late page change');
  const late = [...ok, ...edit('index.html'), ...f.bash('git add index.html'), ...f.bash('git commit -q -m late'), ...f.receipt(f.git('rev-parse', 'HEAD^{tree}')), say('GATE: PASS')];
  const o = f.inspect(PUSH, late);
  assert.equal(o.permissionDecision, 'deny');
  assert.match(o.permissionDecisionReason, /REVIEW: PASS|reviewer/);
  // must not change: real prose with an executable bit or an instruction file stays code, a plain .md stays prose
  const g = fixture(t);
  g.commit('fix/probe', ['docs/guide.md']);
  assert.equal(g.decision(PUSH), 'allow', 'prose-only push');
  const h = fixture(t);
  h.commit('fix/probe', ['CLAUDE.md']);
  assert.equal(h.decision(PUSH), 'deny', 'CLAUDE.md is an instruction file');
  const k = fixture(t);
  k.commit('fix/probe', ['src/Late.ts']);
  assert.equal(k.decision(PUSH), 'deny', 'code without evidence');
});

test('finding 3: review, gate and reviewer run belong to the tree that goes out', (t) => {
  const f = fixture(t);
  const treeA = f.commit('fix/a', ['src/A.ts']);
  const treeB = f.commit('fix/b', ['src/B.ts']);
  f.git('switch', '-q', 'fix/a');
  const PA = 'git push origin HEAD:fix/a';
  const flowA = [...edit('src/A.ts'), ...f.receipt(treeA)];
  // false pass: branch B was reviewed, branch A never was
  const falsePass = [...flowA, ...f.bash('git switch -c fix/b origin/staging'), ...edit('src/B.ts'), ...f.receipt(treeB), ...f.verdicts(), ...f.bash('git switch fix/a')];
  const o = f.inspect(PA, falsePass);
  assert.equal(o.permissionDecision, 'deny', 'B verdicts must not let A out');
  // false stop: A fully reviewed, then B started elsewhere
  const reviewedA = [...flowA, ...f.verdicts()];
  { const o2 = f.inspect(PA, reviewedA); assert.equal(o2.permissionDecision, "allow", "control: A reviewed, pushed at once " + o2.permissionDecisionReason); }
  const falseStop = [...reviewedA, ...f.bash('git switch -c fix/b origin/staging'), ...edit('src/B.ts'), ...f.bash('git commit -q -m b'), ...f.bash('git switch fix/a')];
  assert.equal(f.decision(PA, falseStop), 'allow', 'A stays pushable after B was started');
  // must not change: the single-branch flow, an edit after the verdicts, a check of the other tree after the review
  assert.equal(f.decision(PA, [...edit('src/A.ts'), ...f.receipt(treeA), ...f.verdicts()]), 'allow');
  assert.equal(f.decision(PA, [...f.receipt(treeB), ...edit('src/A.ts'), ...f.receipt(treeA), ...f.verdicts()]), 'allow', 'an older check of another tree is no obstacle');
  assert.equal(f.decision(PA, [...flowA, ...f.verdicts().slice(0, 3), ...f.receipt(treeB), say('GATE: PASS')]), 'deny', 'a check of another tree between review and gate');
  // a real change of A after its verdicts (a new tree without a receipt) is refused, with or without branch B around
  f.write('src/A.ts', 'export const late = 2;\n'); f.git('add', '--', 'src/A.ts'); f.git('commit', '-q', '-m', 'test: late change');
  assert.equal(f.decision(PA, [...reviewedA, ...edit('src/A.ts')]), 'deny', 'a late change of A needs a new check and review');
});

test('finding 4: a docs-only change that holds an image, a PDF or a license file is documentation for the push guard too', (t) => {
  for (const files of [['README.md', 'docs/shot.png'], ['LICENSE'], ['CHANGELOG'], ['README'], ['docs/a.pdf', 'docs/b.jpg', 'docs/c.webp', 'docs/d.gif', 'NOTICE']]) {
    const f = fixture(t);
    for (const file of files) f.write(file, 'x\n');
    f.git('switch', '-q', '-c', 'docs/probe');
    for (const file of files) f.git('add', '--', file);
    f.git('commit', '-q', '-m', 'docs: probe');
    assert.equal(f.decision('git push origin HEAD:docs/probe'), 'allow', files.join(','));
  }
  // must not change: a file that only looks like documentation, and real configuration, stay code
  // (.mdx and a .txt that is no notes file are code by the shared rule, lib/code-paths.cjs, 2026-11-18)
  for (const file of ['.gitignore', 'docs/guide.mdx', 'constraints.txt', 'requirements.txt', 'CMakeLists.txt', 'SKILL.md', '.github/pull_request_template.md', 'Makefile']) {
    const f = fixture(t);
    f.commit('fix/probe', [file]);
    assert.equal(f.decision('git push origin HEAD:fix/probe'), 'deny', file);
  }
});

test('finding 5: a + refspec asks like --force and a refs/tags destination asks like a tag push', (t) => {
  const f = fixture(t);
  const tree = f.commit('fix/a', ['src/A.ts']);
  const ok = [...f.receipt(tree), ...f.verdicts()];
  assert.equal(f.decision('git push origin HEAD:fix/a', ok), 'allow', 'control');
  assert.equal(f.decision('git push --force origin HEAD:fix/a', ok), 'ask', 'control: --force asks');
  assert.equal(f.decision('git push origin +HEAD:fix/a', ok), 'ask');
  assert.equal(f.decision('git push origin +HEAD:refs/heads/fix/a', ok), 'ask');
  assert.equal(f.decision('git push origin HEAD:refs/tags/v9.9.9', ok), 'ask');
  assert.match(f.inspect('git push origin HEAD:refs/tags/v9.9.9', ok).permissionDecisionReason, /tag/i);
  assert.equal(f.decision('git push origin HEAD:refs/heads/fix/a', ok), 'allow', 'a branch under refs/heads stays silent');
  assert.equal(f.decision('git push origin HEAD:fix/tags/a', ok), 'allow', 'a branch whose name holds "tags" is no tag');
  // a + refspec is still judged as a push of this tree: no evidence -> deny, not ask
  assert.equal(f.decision('git push origin +HEAD:fix/a'), 'deny');
});

// ---------------------------------------------------------------------------
// Round 2 (2026-11-18): the repairs of round 1 let some other trees and parts through.
// ---------------------------------------------------------------------------

test('round 2, findings 1 and 2: the verdicts of another branch, another check order or another work tree never let this tree out', (t) => {
  const f = fixture(t);
  const treeA = f.commit('fix/a', ['src/A.ts']);
  const treeB = f.commit('fix/b', ['src/B.ts']);
  f.git('switch', '-q', 'fix/a');
  const PA = 'git push origin HEAD:fix/a';
  // finding 1: three shapes, each used to allow
  const a1 = [...edit('src/A.ts'), ...f.receipt(treeA), ...f.bash('git switch -c fix/b origin/staging'), ...edit('src/B.ts'), ...f.verdicts(), ...f.bash('git switch fix/a')];
  assert.equal(f.decision(PA, a1), 'deny', 'review given on another branch without a check of B');
  const a2 = [...edit('src/A.ts'), ...f.receipt(treeA), ...edit('src/B.ts'), ...f.verdicts()];
  assert.equal(f.decision(PA, a2), 'deny', 'an edit between the check and the review');
  const a3 = [...f.receipt(treeA), ...edit('src/A.ts'), ...f.bash('git commit -q -am more'), ...f.verdicts(), ...f.bash('git revert --no-edit HEAD')];
  assert.equal(f.decision(PA, a3), 'deny', 'a change reverted after the verdicts');
  // finding 2 shape 1: the check of B ran before the check of A, then a switch to B and back
  const s1 = [...edit('src/B.ts'), ...f.receipt(treeB), ...f.bash('git switch fix/a'), ...edit('src/A.ts'), ...f.receipt(treeA), ...f.bash('git switch fix/b'), ...f.verdicts(), ...f.bash('git switch fix/a')];
  assert.equal(f.decision(PA, s1), 'deny', 'a switch between the check and the gate');
  // shape 2: the other tree lives in a second work tree of the same repository
  const dir = path.join(path.dirname(f.repo), 'wt-c');
  f.git('worktree', 'add', '-q', dir, '-b', 'fix/c', 'origin/staging');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true }); fs.writeFileSync(path.join(dir, 'src', 'C.ts'), 'export const c = 3;\n');
  const gitC = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  gitC('add', '--', 'src/C.ts'); gitC('commit', '-q', '-m', 'test: c');
  const treeC = gitC('rev-parse', 'HEAD^{tree}');
  const w = [...edit('src/A.ts'), ...f.receipt(treeA), ...edit(path.join(dir, 'src/C.ts')), ...f.receipt(treeC, dir), ...f.verdicts()];
  assert.equal(f.decision(PA, w), 'deny', 'a check of a second work tree between the check and the gate');
  // must not change: the plain flow, a commit between the check and the review, a switch BEFORE the check, a file checkout
  assert.equal(f.decision(PA, [...edit('src/A.ts'), ...f.receipt(treeA), ...f.verdicts()]), 'allow');
  assert.equal(f.decision(PA, [...edit('src/A.ts'), ...f.receipt(treeA), ...f.bash('git add src/A.ts'), ...f.bash('git commit -q -m a'), ...f.verdicts()]), 'allow', 'commit after the check, same tree');
  assert.equal(f.decision(PA, [...f.bash('git switch fix/a'), ...edit('src/A.ts'), ...f.receipt(treeA), ...f.verdicts()]), 'allow', 'a switch before the check');
  assert.equal(f.decision(PA, [...edit('src/A.ts'), ...f.receipt(treeA), ...f.bash('git checkout -- src/A.ts'), ...f.verdicts()]), 'allow', 'a file checkout is no branch switch');
  // finding 6, first part: a check of another tree AFTER A was reviewed and gated no longer stops A
  assert.equal(f.decision(PA, [...edit('src/A.ts'), ...f.receipt(treeA), ...f.verdicts(), ...f.bash('git switch fix/b'), ...edit('src/B.ts'), ...f.receipt(treeB), ...f.bash('git switch fix/a')]), 'allow', 'B checked after A was gated');
});

test('round 2, finding 3: a push after any part outside the read-only list is refused, also behind if, while or !', (t) => {
  const f = fixture(t);
  const tree = f.commit('fix/probe', ['src/App.ts']);
  const ok = [...f.receipt(tree), ...f.verdicts()];
  const must = /run the push as its own command/;
  for (const head of [
    'if git merge origin/staging --no-edit; then PUSHNOW; fi',
    '! git merge origin/staging --no-edit; PUSHNOW',
    'while ! git pull origin staging --no-edit; do sleep 1; done; PUSHNOW',
    'git update-ref HEAD origin/staging && PUSHNOW',
    'git symbolic-ref HEAD refs/heads/staging && PUSHNOW',
    'gh pr checkout 12 && PUSHNOW',
    'npm version patch && PUSHNOW',
    'git fetch --update-head-ok . staging:fix/probe && PUSHNOW',
    'git bisect reset && PUSHNOW',
  ]) {
    const command = head.replace('PUSHNOW', PUSH);
    const o = f.inspect(command, ok);
    assert.equal(o.permissionDecision, 'deny', head);
    assert.match(o.permissionDecisionReason, must, head);
  }
  // must not change: read-only parts first, the push alone, work after the push
  for (const command of [PUSH, 'cd ' + f.repo.replace(/\\/g, '/') + ' && git status && ' + PUSH, 'echo go; ' + PUSH, 'git fetch origin && git log -1 && git diff --stat && git rev-parse HEAD && ' + PUSH, PUSH + ' && npm version patch']) {
    assert.equal(f.decision(command, ok), 'allow', command);
  }
});

test('round 2, finding 4: tracked files under .codex, node_modules or .claude state folders are code for the push guard', (t) => {
  for (const file of ['.codex/hooks/guard.js', 'tools/.codex/config.toml', 'node_modules/pkg/index.js', 'src/node_modules/local/index.js', '.claude/tasks/run.js', '.claude/plans/deploy.sh', '.claude/hooks/guard.js']) {
    const f = fixture(t);
    f.commit('fix/probe', [file]);
    assert.equal(f.decision(PUSH), 'deny', file);
  }
  // must not change: a docs-only branch and an image stay documentation
  const g = fixture(t);
  g.commit('docs/probe', ['docs/guide.md', 'docs/shot.png']);
  assert.equal(g.decision('git push origin HEAD:docs/probe'), 'allow');
});

test('round 2, finding 8: a tag named as the source, and --follow-tags, ask like any tag push', (t) => {
  const f = fixture(t);
  const tree = f.commit('fix/probe', ['src/App.ts']);
  f.git('tag', 'v9.9.9');
  const ok = [...f.receipt(tree), ...f.verdicts()];
  for (const command of ['git push origin v9.9.9', 'git push origin v9.9.9:v9.9.9', 'git push --follow-tags origin HEAD:fix/probe', 'git push origin HEAD:refs/tags/v9.9.9', 'git push origin refs/tags/v9.9.9']) {
    assert.equal(f.decision(command, ok), 'ask', command);
  }
  // must not change: a branch pushed by name or by HEAD stays silent, and without evidence a tag push is still denied
  f.git('branch', 'fix/named');
  assert.equal(f.decision('git push origin HEAD:fix/probe', ok), 'allow');
  assert.equal(f.decision('git push origin fix/named', ok), 'allow', 'a branch named as the source');
  assert.equal(f.decision('git push origin v9.9.9'), 'deny', 'no evidence');
});
