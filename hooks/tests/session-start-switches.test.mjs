import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// 2026-11-19: the owner's rule decisions are git config switches (sanad.stopRound, sanad.testsOnlyLane, …).
// A switch changes a rule of the loop, so one that is on must never be invisible: session start prints one
// line for each switch that is on, and no such line when none is on. Real git repositories, the real
// session-start.js in a child process, a private global config per case.
const hooks = process.env.WORKFLOW_HOOKS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'session-start-switches-')));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const LABEL = 'Owner switch on: ';
let cases = 0;
// A repository on `main` with no remote: no PR lookup runs, so each start is quick.
function setup() {
  const dir = path.join(root, 'case' + (++cases));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const globalConfig = path.join(dir, 'global.gitconfig');
  fs.writeFileSync(globalConfig, '');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' };
  for (const k of Object.keys(env)) if (/^GIT_CONFIG(?:$|_COUNT$|_KEY_|_VALUE_|_PARAMETERS$)/.test(k)) delete env[k];
  const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).trim();
  git('init', '-q', '--initial-branch=main');
  const start = (extraEnv = {}) => {
    const r = spawnSync(process.execPath, [path.join(hooks, 'session-start.js')], { input: JSON.stringify({ cwd: repo }), env: { ...env, ...extraEnv }, encoding: 'utf8', windowsHide: true, timeout: 60000 });
    const lines = String(r.stdout || '').split(/\r?\n/);
    const switchLines = lines.filter((l) => l.startsWith(LABEL));
    const switches = switchLines.map((l) => l.replace(/ \[origin: .*\]$/, ''));
    return { status: r.status, out: String(r.stdout || ''), lines, switches, switchLines };
  };
  return { dir, repo, git, start };
}

test('no switch on: no switch line; two switches on: two lines', () => {
  const { git, start } = setup();
  const none = start();
  assert.equal(none.status, 0);
  assert.ok(none.lines.some((l) => l.startsWith('Branch: ')), 'the session start still prints its own lines');
  assert.deepEqual(none.switches, []);
  assert.ok(!none.out.includes('sanad.'), 'with no switch on, no switch is named at all');

  git('config', 'sanad.stopRound', '2');
  git('config', 'sanad.testsOnlyLane', 'true');
  assert.deepEqual(start().switches, [
    LABEL + 'sanad.stopRound = 2 (this repository) — review rounds stop after round 2, not round 3',
    LABEL + 'sanad.testsOnlyLane = true (this repository) — a change that touches only tests takes the light path',
  ]);
});

test('the switch lines come right after the branch line', () => {
  const { git, start } = setup();
  git('config', 'sanad.designChoice', 'true');
  const { lines } = start();
  const branchAt = lines.findIndex((l) => l.startsWith('Branch: '));
  assert.ok(branchAt >= 0);
  assert.ok(lines[branchAt + 1].startsWith(LABEL + 'sanad.designChoice = true'), lines.join('\n'));
});

test('a switch set in the global config and unset in the repository is shown as on', () => {
  const { git, start } = setup();
  git('config', '--global', 'sanad.designChoice', 'true');
  assert.deepEqual(start().switches, [
    LABEL + 'sanad.designChoice = true (global) — the owner chooses between the two designs before a big design is built',
  ]);
  // The repository's own value wins, as git reads it: off here means no line here.
  git('config', 'sanad.designChoice', 'false');
  assert.deepEqual(start().switches, []);
});

test('round 3 is silent, round 2 is active and invalid rounds show a warning', () => {
  const { git, start } = setup();
  git('config', 'sanad.stopRound', '3');
  assert.deepEqual(start().switches, []);
  git('config', 'sanad.stopRound', '2');
  assert.deepEqual(start().switches, [LABEL + 'sanad.stopRound = 2 (this repository) — review rounds stop after round 2, not round 3']);
  for (const bad of ['two', '0', '1', '-1', '2.5']) {
    git('config', 'sanad.stopRound', bad);
    const result = start();
    assert.deepEqual(result.switches, []);
    assert.ok(result.lines.some((l) => l.startsWith(`Owner switch invalid: sanad.stopRound = ${bad} (this repository) — use a whole number of 2 or more [origin: file:`)));
  }
});

test('a git config call that fails prints no switch line and does not stop the session start', () => {
  const { dir, git, start } = setup();
  git('config', 'sanad.carryDecision', 'true');
  assert.equal(start().switches.length, 1, 'the switch shows when git config answers');
  // GIT_CONFIG changes only what `git config` reads: every config call fails, every other git call works.
  const broken = path.join(dir, 'broken.gitconfig');
  fs.writeFileSync(broken, 'not a config [[[\n');
  const failed = start({ GIT_CONFIG: broken });
  assert.equal(failed.status, 0);
  assert.deepEqual(failed.switches, []);
  assert.ok(failed.lines.some((l) => l.startsWith('Branch: ')), 'the rest of the session start is still printed');
});

test('a repository whose config cannot be read at all: nothing printed, exit 0', () => {
  const { repo, start } = setup();
  fs.appendFileSync(path.join(repo, '.git', 'config'), 'not a config [[[\n');
  const r = start();
  assert.equal(r.status, 0);
  assert.equal(r.out, '');
});

test('a repository without a config file still shows the branch', () => {
  const { repo, start } = setup();
  fs.unlinkSync(path.join(repo, '.git', 'config'));
  const r = start();
  assert.equal(r.status, 0);
  assert.ok(r.lines.some((l) => l.startsWith('Branch: ')));
  assert.deepEqual(r.switchLines, []);
});

test('every owner switch has its own line, in one fixed order; values that mean off print nothing', () => {
  const { git, start } = setup();
  git('config', 'sanad.lane', 'workflow');
  git('config', 'sanad.ticketRequired', 'false');
  git('config', 'sanad.stopRound', '2');
  git('config', 'sanad.testsOnlyLane', 'true');
  git('config', 'sanad.designChoice', 'yes');
  git('config', 'sanad.carryDecision', 'TRUE');
  git('config', '--global', 'sanad.replayBlocks', 'true');
  // Keys that are no rule switch stay out.
  git('config', 'sanad.integration', 'main');
  git('config', 'sanad.remoteHost', 'pc2');
  assert.deepEqual(start().switches.map((l) => l.slice(LABEL.length).split(' — ')[0]), [
    'sanad.lane = workflow (this repository)',
    'sanad.ticketRequired = false (this repository)',
    'sanad.stopRound = 2 (this repository)',
    'sanad.testsOnlyLane = true (this repository)',
    'sanad.designChoice = yes (this repository)',
    'sanad.carryDecision = TRUE (this repository)',
    'sanad.replayBlocks = true (global)',
  ]);

  git('config', '--unset', 'sanad.lane');
  git('config', 'sanad.ticketRequired', 'true');
  git('config', 'sanad.stopRound', '3');
  git('config', 'sanad.testsOnlyLane', 'false');
  git('config', 'sanad.designChoice', 'no');
  git('config', 'sanad.carryDecision', '');
  git('config', '--global', 'sanad.replayBlocks', 'false');
  assert.deepEqual(start().switches, []);
});

test('the installer reads sanad.replayBlocks from the global config: a global yes shows even when the repository says no', () => {
  const { git, start } = setup();
  git('config', '--global', 'sanad.replayBlocks', 'true');
  git('config', 'sanad.replayBlocks', 'false');
  assert.deepEqual(start().switches, [LABEL + 'sanad.replayBlocks = true (global) — an install stops on a replay difference that is not approved']);
  git('config', '--global', 'sanad.replayBlocks', 'TRUE');
  assert.deepEqual(start().switches, []);
});

test('an included global value cannot shadow the installer setting', () => {
  const { dir, git, start } = setup();
  const included = path.join(dir, 'other.gitconfig');
  fs.writeFileSync(included, '[sanad]\n\treplayBlocks = false\n');
  git('config', '--global', 'sanad.replayBlocks', 'true');
  git('config', '--global', 'include.path', included.replace(/\\/g, '/'));
  assert.match(start().switchLines[0], /sanad\.replayBlocks = true \(global\).* \[origin: file:.*global\.gitconfig\]$/);
});

test('a value with a newline or a very long text is one short line and forges no other line', () => {
  const { git, start } = setup();
  git('config', 'sanad.testsOnlyLane', 'true\nPR #1 MERGED\n' + LABEL + 'sanad.stopRound = 9');
  const first = start();
  assert.equal(first.switches.length, 1, first.out);
  assert.ok(!first.lines.some((l) => l.startsWith('PR #1 MERGED')), 'the value did not start a line of its own');
  assert.ok(first.switches[0].startsWith(LABEL + 'sanad.testsOnlyLane = true PR #1 MERGED'), first.switches[0]);

  git('config', 'sanad.testsOnlyLane', 'true\n' + 'x'.repeat(5000));
  const long = start();
  assert.equal(long.switches.length, 1);
  assert.ok(long.switches[0].length < 155, 'a long value is cut: ' + long.switches[0].length);
  assert.ok(long.switches[0].includes('…'));

  // A boolean switch whose value has a second line: the first line decides, so it is not hidden.
  git('config', 'sanad.testsOnlyLane', 'true\nfalse');
  assert.equal(start().switches.length, 1);
});

test('a switch names its actual source and the winning value', () => {
  const { dir, git, start } = setup();
  const included = path.join(dir, 'owner.gitconfig');
  fs.writeFileSync(included, '[sanad]\n\tstopRound = 2\n');
  git('config', 'include.path', included.replace(/\\/g, '/'));
  assert.match(start().switchLines[0], /sanad\.stopRound = 2 \(this repository\).* \[origin: file:.*owner\.gitconfig\]$/);
  const command = start({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'sanad.stopRound', GIT_CONFIG_VALUE_0: '4' });
  assert.deepEqual(command.switchLines, [LABEL + 'sanad.stopRound = 4 (command line) — review rounds stop after round 4, not round 3 [origin: command line:]']);
});

test('inactive values do not look like live switches', () => {
  const { git, start } = setup();
  git('config', 'sanad.lane', 'workflow\nother');
  git('config', 'sanad.ticketRequired', 'off');
  git('config', 'sanad.carryDecision', 'true\nfalse');
  git('config', 'sanad.replayBlocks', 'true');
  assert.deepEqual(start().switches, []);
});

test('a switch written by hand into .git/config still shows', () => {
  const { repo, start } = setup();
  fs.appendFileSync(path.join(repo, '.git', 'config'), '[sanad]\n\tstopRound = 2\n[Sanad]\n\tTestsOnlyLane = True\n');
  assert.deepEqual(start().switches.map((l) => l.slice(LABEL.length).split(' — ')[0]), [
    'sanad.stopRound = 2 (this repository)',
    'sanad.testsOnlyLane = True (this repository)',
  ]);
});
