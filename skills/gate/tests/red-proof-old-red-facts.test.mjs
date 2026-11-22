import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evidenceOf } from '../scripts/proof-record.mjs';
import { oldRedLine, readOldRedLine, redOldTests, markNewTests } from '../scripts/red-proof.mjs';

// 2026-11-19: nothing saved "this new test was red on the old code", so the checks before review said NOT PROVEN
// TEST after an honest --old proof. The proof now saves it beside the green fact.
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'red-proof.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'red-proof-oldred-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const emptyConfig = path.join(root, 'empty.gitconfig');
fs.writeFileSync(emptyConfig, ['[user]', '\tname = Fixture', '\temail = fixture@example.invalid', ''].join('\n'));
const state = path.join(root, 'state');
process.env.SANAD_STATE_DIR = state;
process.env.GIT_CONFIG_GLOBAL = emptyConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';

const TITLE = 'app is fixed';
const testText = (extra = '') => `describe('app', () => {\n  it('${TITLE}', () => {\n    expect(1).toBe(1);\n  });\n${extra}});\n`;

test('a proof with --old that is red on the old code leaves facts from which evidenceOf says "old code"', () => {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'app.cjs'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(repo, 'app.test.cjs'), testText().replace(TITLE, 'older test'));
  git('add', '--all'); git('commit', '-qm', 'base');
  git('checkout', '-q', '-b', 'task');
  fs.writeFileSync(path.join(repo, 'app.cjs'), 'module.exports = 2;\n');
  fs.writeFileSync(path.join(repo, 'app.test.cjs'), testText().replace(TITLE, 'older test') + '\n' + testText().replace('describe(\'app\'', "describe('app2'"));
  // The runner: a vitest-style failure line for the new test while app.cjs says 1.
  fs.writeFileSync(path.join(repo, 'check.cjs'), [
    'if (require("./app.cjs") !== 2) { console.log(" FAIL  app.test.cjs > app2 > ' + TITLE + '" + String.fromCharCode(10) + "AssertionError: expected 1 to be 2"); process.exit(1); }',
    'process.exit(0);', ''].join('\n'));
  const r = spawnSync(process.execPath, [script, '--repo', repo, '--base', 'main', '--old', 'main', '--files', 'app.cjs', '--then-green', '--', process.execPath, 'check.cjs'],
    { encoding: 'utf8', windowsHide: true, timeout: 120000, env: process.env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /TEST ✓ app is fixed: old code RED/);
  const row = evidenceOf(repo, { base: 'main' }).find(e => e.title === TITLE);
  assert.ok(row, 'the new test is a row');
  assert.equal(row.evidence, 'old code');
});

test('the old-red line crosses the test machine link and only the new tests named by a failing name are kept', () => {
  const names = ['app.test.cjs > app > keeps the total', 'x > other'];
  assert.deepEqual(readOldRedLine(oldRedLine(names)), names);
  assert.equal(readOldRedLine('RED-PROOF-OLDRED: !!'), null);
  assert.equal(readOldRedLine('something else'), null);
  const text = testText().replace(TITLE, 'keeps the total');
  const fresh = markNewTests(text, null, 'app.test.cjs').filter(t => t.isNew);
  assert.deepEqual(redOldTests(fresh, names).map(t => [t.file, t.title]), [['app.test.cjs', 'keeps the total']]);
  assert.deepEqual(redOldTests(fresh, ['x > other']), []);
});

test('a failing name that only holds a new test title gives that test no credit (2026-11-20)', () => {
  const mk = (...titles) => ({ file: 'a.test.js', line: 1, titles });
  const total = mk('suite', 'renders total');
  const label = mk('suite', 'renders total label');
  // Only "renders total label" failed: "renders total" is not credited.
  assert.deepEqual(redOldTests([total, label], ['a.test.js > suite > renders total label']).map(t => t.title), ['renders total label']);
  // The same names, each form a runner uses: whole name, full path, prefix at a separator.
  for (const name of ['renders total', 'suite > renders total', 'suite › renders total', 'suite::renders total', 'a.test.js > suite > renders total', 'suite.renders total']) {
    assert.deepEqual(redOldTests([total, label], [name]).map(t => t.title), ['renders total'], name);
  }
  assert.deepEqual(redOldTests([total], ['my renders total']), []);
});

test('one failing name that fits two new tests credits neither of them (2026-11-20)', () => {
  const a = { file: 'a.test.js', line: 1, titles: ['one', 'works'] };
  const b = { file: 'b.test.js', line: 2, titles: ['two', 'works'] };
  assert.deepEqual(redOldTests([a, b], ['works']), []);
  assert.deepEqual(redOldTests([a, b], ['one > works']).map(t => t.file), ['a.test.js']);
});
