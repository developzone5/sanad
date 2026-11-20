import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { redOldTests } from '../scripts/red-proof.mjs';
import { readRecord, writeRunFacts } from '../scripts/proof-record.mjs';

// 2026-11-20 (Z3): parameterized C# names, a failure in another test file, a second old-code run, a busy record lock.
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'red-proof.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'red-proof-z3-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const emptyConfig = path.join(root, 'empty.gitconfig');
fs.writeFileSync(emptyConfig, ['[user]', '\tname = Fixture', '\temail = fixture@example.invalid', ''].join('\n'));
process.env.SANAD_STATE_DIR = path.join(root, 'state');
process.env.GIT_CONFIG_GLOBAL = emptyConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';

test('a failing parameterized C# name credits the new test of that method', () => {
  const t = { file: 'Totals.Tests/CartTests.cs', line: 10, titles: ['CartTests', 'RendersTotal'] };
  assert.deepEqual(redOldTests([t], ['App.Tests.CartTests.RendersTotal(quantity: 2)']).map(x => x.title), ['RendersTotal']);
  assert.deepEqual(redOldTests([t], ['App.Tests.CartTests.RendersTotal(role: "a (b)")']).map(x => x.title), ['RendersTotal']);
  assert.deepEqual(redOldTests([t], ['App.Tests.CartTests.RendersTotal']).map(x => x.title), ['RendersTotal']);
  assert.deepEqual(redOldTests([t], ['App.Tests.CartTests.RendersTotalLabel(quantity: 2)']), []);
});

test('a failure in one test file never credits a test of another file', () => {
  const inNew = { file: 'src/new.test.js', line: 3, titles: ['suite', 'works'] };
  assert.deepEqual(redOldTests([inNew], ['src/old.test.js > suite > works']), []);
  assert.deepEqual(redOldTests([inNew], ['src' + String.fromCharCode(92) + 'new.test.js > suite > works']).map(x => x.title), ['works']);
  assert.deepEqual(redOldTests([inNew], ['new.test.js > suite > works']).map(x => x.title), ['works']);
  // No file in the name: the old rule stays.
  assert.deepEqual(redOldTests([inNew], ['suite > works']).map(x => x.title), ['works']);
});

function repoWith(name) {
  const repo = path.join(root, name);
  fs.mkdirSync(repo);
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.test.js'), 'x\n');
  git('add', '--all'); git('commit', '-qm', 'base');
  return repo;
}
const red = (title, line = 1) => ({ file: 'a.test.js', line, title });

test('a second old-code run on the same tree and old commit adds its red tests and drops none', () => {
  const repo = repoWith('merge');
  const tree = 't'.repeat(40), old = 'o'.repeat(40);
  writeRunFacts(repo, 'k', { tree, run: 'r1', green: true, redOld: [red('one', 1)], old });
  // Same run, a second old-code run.
  writeRunFacts(repo, 'k', { tree, run: 'r1', redOld: [red('two', 2)], old });
  let facts = readRecord(repo).runs.k[tree];
  assert.deepEqual(facts.redOld['a.test.js'].map(t => t.title).sort(), ['one', 'two']);
  assert.equal(facts.green, true);
  // Another run on the same old commit: still adds.
  writeRunFacts(repo, 'k', { tree, run: 'r2', green: true, redOld: [red('three', 3)], old });
  facts = readRecord(repo).runs.k[tree];
  assert.deepEqual(facts.redOld['a.test.js'].map(t => t.title).sort(), ['one', 'three', 'two']);
  // Another old commit starts again.
  writeRunFacts(repo, 'k', { tree, run: 'r3', green: true, redOld: [red('four', 4)], old: 'p'.repeat(40) });
  facts = readRecord(repo).runs.k[tree];
  assert.deepEqual(facts.redOld['a.test.js'].map(t => t.title), ['four']);
});

test('a run with a busy record lock does not start: one line, REFUSED as the last line, exit 2', () => {
  const repo = repoWith('busy');
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('checkout', '-q', '-b', 'task');
  fs.writeFileSync(path.join(repo, 'a.test.js'), 'y\n');
  fs.writeFileSync(path.join(repo, 'check.cjs'), 'process.exit(0);\n');
  fs.writeFileSync(path.join(repo, 'app.cjs'), 'module.exports = 2;'+String.fromCharCode(10));
  git('add', '--all'); git('commit', '-qm', 'task');
  // Take the lock myself, in the record folder, with my own live pid.
  const top = fs.realpathSync(repo);
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import('${new URL('../scripts/proof-record.mjs', import.meta.url).href}').then(m => { m.writeEntry(${JSON.stringify(repo)}, 'probe', { ok: true }); });`],
  { encoding: 'utf8', windowsHide: true, env: process.env });
  assert.equal(probe.status, 0, probe.stderr);
  const dir = path.join(root, 'state');
  const jsons = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.json')) jsons.push(p); } };
  walk(dir);
  const mine = jsons.find(p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')).entries?.probe; } catch { return false; } });
  assert.ok(mine, 'record file found');
  const lock = mine + '.lock';
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
  try {
    const r = spawnSync(process.execPath, [script, '--repo', repo, '--base', 'main', '--old', 'main', '--files', 'app.cjs', '--then-green', '--', process.execPath, 'check.cjs'],
      { encoding: 'utf8', windowsHide: true, timeout: 120000, env: process.env });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    const lines = r.stdout.trim().split(/\r?\n/);
    assert.equal(lines[lines.length - 1], 'RED-PROOF: REFUSED — nothing ran');
    assert.match(lines[lines.length - 2], /cannot be withdrawn: the proof record is busy/);
    assert.ok(!/GREEN/.test(r.stdout), 'no test run started');
  } finally { fs.rmSync(lock, { recursive: true, force: true }); }
  void top; void crypto;
});
