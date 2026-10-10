import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// One corpus for the shared grammar: every guard decision that depends on
// "which program, which repository, which directory" reads these records.
const hooks = process.env.WORKFLOW_HOOKS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { parseCommand, shellPath, tripwire } = createRequire(import.meta.url)(path.join(hooks, 'lib', 'shell-command.cjs'));
const base = 'C:\\work\\repo';
const opts = tool => ({ cwd: base, tool, home: 'C:\\Users\\dev', tmp: 'C:\\Users\\dev\\AppData\\Local\\Temp' });
const gits = (cmd, tool = 'PowerShell') => parseCommand(cmd, opts(tool)).filter(s => s.git).map(s => s.git);
const ghs = (cmd, tool = 'PowerShell') => parseCommand(cmd, opts(tool)).filter(s => s.gh).map(s => s.gh);

test('Git Bash drive, home and tmp paths resolve the way the shell resolves them', () => {
  assert.equal(shellPath('/c/Users/x', base, opts('Bash')), 'C:\\Users\\x');
  assert.equal(shellPath('/c', base, opts('Bash')), 'C:\\');
  assert.equal(shellPath('~/proj', base, opts('Bash')), 'C:\\Users\\dev\\proj');
  assert.equal(shellPath('/tmp/x', base, opts('Bash')), 'C:\\Users\\dev\\AppData\\Local\\Temp\\x');
  assert.equal(shellPath('/usr/bin', base, opts('Bash')), null);
  assert.equal(shellPath('/c/Users', base, opts('PowerShell')), null);
  assert.equal(shellPath('..\\other', base, opts('PowerShell')), 'C:\\work\\other');
});

test('non-literal and exotic paths are unresolved, never guessed', () => {
  for (const p of ['$HOME/x', '$env:TEMP', '%TEMP%', '`pwd`', 'src,bin', 'bin/*', '\\\\server\\share', '//server/share',
    'Env:\\PATH', 'Microsoft.PowerShell.Core\\FileSystem::C:\\x', 'C:relative', '~other/x', '']) {
    assert.equal(shellPath(p, base, opts('PowerShell')), null, p);
    assert.equal(shellPath(p, base, opts('Bash')), null, p);
  }
});

test('directory changes are tracked across segments, blocks and the location stack', () => {
  assert.equal(gits('cd /c/Users/x && git commit -m y', 'Bash')[0].cwd, 'C:\\Users\\x');
  assert.equal(gits("Set-Location -LiteralPath 'C:\\r'; git commit -m y")[0].cwd, 'C:\\r');
  assert.equal(gits('Set-Location -Path C:\\r; git commit -m y')[0].cwd, 'C:\\r');
  const stack = gits('Push-Location C:\\r; git commit -m y; Pop-Location; git push');
  assert.deepEqual(stack.map(g => [g.sub, g.cwd]), [['commit', 'C:\\r'], ['push', base]]);
  assert.equal(gits('git -C ..\\other commit -m y')[0].cwd, 'C:\\work\\other');
  assert.equal(gits('& "C:\\Program Files\\Git\\cmd\\git.exe" -C C:\\r commit -m y')[0].cwd, 'C:\\r');
  const sub = gits('(cd x && git commit -m y); git push', 'Bash');
  assert.equal(sub[0].cwd, 'C:\\work\\repo\\x');
  assert.equal(sub[1].cwd, null, 'a directory change inside a block makes later segments uncertain');
  assert.equal(sub[1].certain, false);
});

test('unresolvable directories and git retargets are uncertain', () => {
  for (const [cmd, tool] of [['cd $env:X; git commit -m y', 'PowerShell'], ['cd; git commit -m y', 'Bash'], ['cd -; git push', 'Bash'],
    ['GIT_DIR=x git commit -m y', 'Bash'], ['git --git-dir .git push origin HEAD:main', 'Bash'], ['git --work-tree=w commit -m y', 'Bash'],
    ['$env:GIT_DIR = "x"; git commit -m y', 'PowerShell'], ['git -c core.hooksPath=/dev/null commit -m y', 'Bash'],
    ['git -c alias.ship="!git push" ship', 'Bash'], ['popd; git push', 'Bash']]) {
    const g = gits(cmd, tool);
    assert.ok(g.length, cmd);
    assert.equal(g.at(-1).certain, false, cmd);
    assert.ok(g.at(-1).why, cmd);
  }
});

test('git global options and -c aliases never hide the subcommand', () => {
  for (const cmd of ['git --no-optional-locks push origin HEAD:main', 'git --paginate push origin HEAD:main',
    'git -P push origin HEAD:main', 'git -c alias.ship=push ship origin HEAD:main', 'git --git-dir .git push origin HEAD:main']) {
    const [g] = gits(cmd, 'Bash');
    assert.equal(g.sub, 'push', cmd);
    assert.deepEqual(g.args, ['origin', 'HEAD:main'], cmd);
  }
});

test('commands inside PowerShell blocks, subshells, nested shells and xargs are parsed', () => {
  assert.equal(gits('git add a.cs; if ($?) { git commit -m x }')[1].sub, 'commit');
  assert.equal(gits('if (-not $?) { git push origin HEAD:main }')[0].sub, 'push');
  assert.equal(gits('try { git push } catch { Write-Host no }')[0].sub, 'push');
  assert.equal(gits('if [ -f x ]; then git push origin HEAD:main; fi', 'Bash')[0].sub, 'push');
  assert.equal(gits('bash -c "git push origin HEAD:main"')[0].sub, 'push');
  assert.equal(gits('cmd /c "git push origin HEAD:main"')[0].sub, 'push');
  assert.equal(gits('powershell -Command "git push origin HEAD:main"')[0].sub, 'push');
  assert.equal(gits('iex "git push origin HEAD:main"')[0].sub, 'push');
  const xargs = gits('git branch --merged | xargs git branch -d', 'Bash');
  assert.deepEqual(xargs.map(g => [g.sub, g.args]), [['branch', ['--merged']], ['branch', ['-d']]]);
  assert.equal(ghs('(gh pr merge 1)')[0].sub, 'merge');
  assert.equal(ghs('git push -u origin feat/x; if ($?) { gh pr create --base main --fill }')[0].sub, 'create');
});

test('gh inherited repository flags do not shift the command or subcommand', () => {
  for (const cmd of ['gh -R o/r pr merge 1', 'gh pr -R o/r merge 1', 'gh -Ro/r pr merge 1', 'gh --repo=o/r pr merge 1',
    "& 'C:\\Program Files\\GitHub CLI\\gh.exe' pr merge 1", 'bash -c "gh pr merge 1"']) {
    const [g] = ghs(cmd);
    assert.equal(g.command, 'pr', cmd);
    assert.equal(g.sub, 'merge', cmd);
  }
  assert.equal(ghs('gh -R o/r pr merge 1')[0].repo, 'o/r');
  const [api] = ghs('gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc');
  assert.equal(api.command, 'api');
  assert.deepEqual(api.args, ['-X', 'PATCH', 'repos/o/r/git/refs/heads/main', '-f', 'sha=abc']);
});

test('executable spellings normalize to one program name', () => {
  const programs = cmd => parseCommand(cmd, opts('PowerShell')).map(s => s.program);
  assert.deepEqual(programs('npm.cmd publish'), ['npm']);
  assert.deepEqual(programs('"C:\\Program Files\\nodejs\\npm.cmd" publish'), ['npm']);
  assert.deepEqual(programs('node node_modules/npm/bin/npm-cli.js publish'), ['npm']);
  assert.deepEqual(programs('npm.ps1 install left-pad'), ['npm']);
  assert.deepEqual(programs('& C:\\tools\\GH.EXE pr merge 1'), ['gh']);
});

test('the tripwire over-detects; text-only mentions parse to no invocation', () => {
  assert.ok(tripwire('echo "remember to git push later"').has('push'));
  assert.equal(gits('echo "remember to git push later"').length, 0);
  assert.ok(tripwire('git commit -m "x"').has('commit'));
  assert.ok(tripwire('gh api repos/o/r/merges -f base=main').has('gh-merge'));
  assert.ok(tripwire('npm.cmd publish').has('publish'));
  assert.ok(tripwire('Remove-Item -Recurse src').has('delete'));
  assert.equal(tripwire('dotnet test').size, 0);
});
