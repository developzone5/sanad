import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sizeTask } from '../scripts/size-check.mjs';

// 2026-11-17 (audit 4 and 5): aliased and namespace imports are followed, an unresolved caller count is unknown
// (sizes up), every changed function is analysed, same-named definitions are both counted.
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'size-check.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'size-callers-'));
process.env.SANAD_STATE_DIR = path.join(root, 'state');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const emptyConfig = path.join(root, 'empty.gitconfig');
fs.writeFileSync(emptyConfig, '');
process.env.GIT_CONFIG_GLOBAL = emptyConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';

function change(baseFiles, changed) {
  const repo = fs.mkdtempSync(path.join(root, 'repo-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const write = files => { for (const [n, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, n)), { recursive: true }); fs.writeFileSync(path.join(repo, n), t); } };
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'core.autocrlf', 'false');
  write({ 'README.md': 'base\n', ...baseFiles }); git('add', '-A'); git('commit', '-qm', 'base'); git('branch', 'base');
  write(changed);
  git('add', '-A'); git('commit', '-qm', 'change', '--allow-empty');
  return repo;
}
const size = repo => sizeTask({ repo, base: 'base' });
const rule = v => `export function validate(a) {\n  return a + ${v};\n}\n`;
const calls = (alias, n) => Array.from({ length: n }, (_, i) => `  ${alias}(${i});\n`).join('');

test('eleven aliased callers size the change big with the callers signal', () => {
  const caller = `import { validate as check } from './rule';\nexport function run() {\n${calls('check', 11)}}\n`;
  const r = size(change({ 'src/rule.ts': rule(1), 'src/user.ts': caller }, { 'src/rule.ts': rule(2) }));
  assert.equal(r.size, 'big', JSON.stringify(r));
  assert.ok(r.signals.callersMany, JSON.stringify(r.signals));
  assert.equal(r.callers.find(c => c.name === 'validate').count, 11);
});

test('a few aliased callers stay small', () => {
  const caller = `import { validate as check } from './rule';\nexport function run() {\n${calls('check', 2)}}\n`;
  const r = size(change({ 'src/rule.ts': rule(1), 'src/user.ts': caller }, { 'src/rule.ts': rule(2) }));
  assert.equal(r.size, 'small');
  assert.equal(r.callers.find(c => c.name === 'validate').count, 2);
});

test('Must not change: a namespace import over a plain file is followed', () => {
  const caller = `import * as rule from './rule';\nexport function run() {\n${Array.from({ length: 11 }, (_, i) => `  rule.validate(${i});\n`).join('')}}\n`;
  const r = size(change({ 'src/rule.ts': rule(1), 'src/user.ts': caller }, { 'src/rule.ts': rule(2) }));
  assert.equal(r.size, 'big', JSON.stringify(r));
  assert.equal(r.callers.find(c => c.name === 'validate').count, 11);
});

test('an import path the search cannot resolve makes the count unknown and sizes up', () => {
  const caller = `import { validate as check } from '~/rule';\nexport function run() {\n  check(1);\n}\n`;
  const repo = change({ 'src/rule.ts': rule(1), 'src/user.ts': caller }, { 'src/rule.ts': rule(2) });
  const r = size(repo);
  assert.equal(r.size, 'big', JSON.stringify(r));
  const row = r.callers.find(c => c.name === 'validate');
  assert.deepEqual(row.unresolved, ['src/user.ts']);
  assert.match(r.signals.callersMany[0], /validate ×\?/);
  const out = spawnSync(process.execPath, [script, '--repo', repo, '--base', 'base'], { encoding: 'utf8', env: process.env }).stdout;
  assert.match(out, /validate ×\? \(not resolved: src\/user\.ts\)/, out);
});

test('thirteen changed functions where only the 13th has eleven callers are big', () => {
  const fns = v => Array.from({ length: 13 }, (_, i) => `export function fn${String(i).padStart(2, '0')}(a) {\n  return a + ${v};\n}\n`).join('');
  const caller = `import { fn12 } from './many';\nexport function run() {\n${calls('fn12', 11)}}\n`;
  const r = size(change({ 'src/many.ts': fns(1), 'src/user.ts': caller }, { 'src/many.ts': fns(2) }));
  assert.equal(r.size, 'big', JSON.stringify(r.callers.map(c => [c.name, c.count])));
  assert.deepEqual(r.signals.callersMany, ['fn12 ×11']);
  assert.equal(r.callers.length, 12, 'printed rows are capped');
  assert.equal(r.moreSymbols, 1);
});

test('two changed Apply definitions in different files are both analysed', () => {
  const a = v => `export function Apply(a) {\n  return a + ${v};\n}\n`;
  const users = (file, n) => `import { Apply } from './${file}';\nexport function run${file}() {\n${calls('Apply', n)}}\n`;
  const r = size(change({ 'src/a.ts': a(1), 'src/b.ts': a(1), 'src/ua.ts': users('a', 2), 'src/ub.ts': users('b', 3) }, { 'src/a.ts': a(2), 'src/b.ts': a(2) }));
  const rows = r.callers.filter(c => c.name === 'Apply');
  assert.deepEqual(rows.map(c => [c.file, c.count]).sort(), [['src/a.ts', 2], ['src/b.ts', 3]]);
});

test('printed rows are capped with a "+N more" note', () => {
  const fns = v => Array.from({ length: 15 }, (_, i) => `export function fn${i}(a) {\n  return a + ${v};\n}\n`).join('');
  const repo = change({ 'src/many.ts': fns(1) }, { 'src/many.ts': fns(2) });
  const r = size(repo);
  assert.equal(r.callers.length, 12);
  assert.equal(r.moreSymbols, 3);
  const out = spawnSync(process.execPath, [script, '--repo', repo, '--base', 'base'], { encoding: 'utf8', env: process.env }).stdout;
  assert.match(out, /\(\+3 more changed functions/, out);
});

// 2026-11-17 repair round (audit 4 and 5): barrels, default imports, unresolved paths, text that looks like an alias,
// a local function of the same name, planned paths spelled in another letter case, rows that raised the signal.
const rowOf = r => r.callers.find(c => c.name === 'validate');
const users = (head, alias, n) => `${head}\nexport function run() {\n${calls(alias, n)}}\n`;

test('a barrel that re-exports under another name is followed', () => {
  const r = size(change({ 'src/rule.ts': rule(1), 'src/index.ts': "export { validate as check } from './rule';\n", 'src/user.ts': users("import { check } from './index';", 'check', 11) }, { 'src/rule.ts': rule(2) }));
  assert.equal(r.size, 'big', JSON.stringify(r));
  assert.equal(rowOf(r).count, 11);
});

test('an export-star barrel is followed for importers that use the plain name', () => {
  const r = size(change({ 'src/rule.ts': rule(1), 'src/lib/index.ts': "export * from '../rule';\n", 'src/user.ts': users("import { validate } from './lib';", 'validate', 11) }, { 'src/rule.ts': rule(2) }));
  assert.equal(r.size, 'big', JSON.stringify(r));
  assert.equal(rowOf(r).count, 11);
});

test('a namespace import over an export-star barrel is followed', () => {
  const caller = `import * as lib from './lib';\nexport function run() {\n${Array.from({ length: 11 }, (_, i) => `  lib.validate(${i});\n`).join('')}}\n`;
  const r = size(change({ 'src/rule.ts': rule(1), 'src/lib/index.ts': "export * from '../rule';\n", 'src/user.ts': caller }, { 'src/rule.ts': rule(2) }));
  assert.equal(r.size, 'big', JSON.stringify(r));
  assert.equal(rowOf(r).count, 11);
});

test('a default import under another name is followed', () => {
  const dflt = v => `export default function validate(a) {\n  return a + ${v};\n}\n`;
  const r = size(change({ 'src/rule.ts': dflt(1), 'src/user.ts': users("import check from './rule';", 'check', 11) }, { 'src/rule.ts': dflt(2) }));
  assert.equal(r.size, 'big', JSON.stringify(r));
  assert.equal(rowOf(r).count, 11);
});

test('an import path the search cannot resolve is unknown, whatever its prefix', () => {
  for (const head of ["import { validate } from '@lib/rule';", "import { validate } from 'src/rule';", "import { validate as check } from '@lib/rule';"]) {
    const alias = head.includes(' as ') ? 'check' : 'validate';
    const r = size(change({ 'src/rule.ts': rule(1), 'src/user.ts': users(head, alias, 11) }, { 'src/rule.ts': rule(2) }));
    assert.equal(r.size, 'big', head + ' ' + JSON.stringify(r));
    assert.deepEqual(rowOf(r).unresolved, ['src/user.ts'], head);
  }
});

test('Must not change: a package from package.json or a node built-in is not an unresolved caller', () => {
  const caller = "import { validate } from 'lodash';\nimport { validate as v2 } from 'node:util';\nexport const x = validate(1);\n";
  const r = size(change({ 'package.json': '{"dependencies":{"lodash":"1.0.0"}}\n', 'src/rule.ts': rule(1), 'src/user.ts': caller }, { 'src/rule.ts': rule(2) }));
  assert.equal(r.size, 'small', JSON.stringify(r));
  assert.equal(rowOf(r).unresolved, undefined);
});

test('text that only looks like an alias is not an alias', () => {
  const uses = Array.from({ length: 11 }, (_, i) => `export const u${i} = value + ${i};\n`).join('');
  const variants = {
    key: `import { validate } from './rule';\nexport const rules = { validate: value => validate(value) };\n${uses}`,
    comment: `import { validate } from './rule';\nexport const a = validate(1);\n// validate: value must be positive\n${uses}`,
    type: `import { validate } from './rule';\nexport const a = validate(1);\ninterface Props { validate: boolean; ${Array.from({ length: 11 }, (_, i) => `f${i}: boolean`).join('; ')} }\n${uses}`,
  };
  for (const [k, text] of Object.entries(variants)) {
    const r = size(change({ 'src/rule.ts': rule(1), 'src/form.ts': `const value = 1;\n${text}` }, { 'src/rule.ts': rule(2) }));
    assert.equal(r.size, 'small', k + ' ' + JSON.stringify(r));
    assert.ok(rowOf(r).count <= 2, k + ' ' + rowOf(r).count);
  }
});

test('a require destructuring with an alias counts its uses once', () => {
  const caller = `const { validate: check } = require('./rule');\nfunction run() {\n${calls('check', 10)}}\nmodule.exports = run;\n`;
  const r = size(change({ 'src/rule.ts': rule(1), 'src/user.js': caller }, { 'src/rule.ts': rule(2) }));
  assert.equal(rowOf(r).count, 10, JSON.stringify(r));
  assert.equal(r.size, 'small');
});

test('a file with its own function of the same name is not unknown because of an unrelated import or a comment', () => {
  const user = users("import { validate } from './rule';", 'validate', 1);
  const heads = ["import { thing } from '~/other';", 'export const load = (name) => import(name);', '// Queue the import (returns at once), then poll.', "// validate is done on the server\nimport { thing } from '$lib/other';"];
  for (const head of heads) {
    const page = `${head}\nfunction validate(x) { return x; }\nexport const z = validate(1);\n`;
    const r = size(change({ 'src/rule.ts': rule(1), 'src/user.ts': user, 'src/page.ts': page }, { 'src/rule.ts': rule(2) }));
    assert.equal(r.size, 'small', head + ' ' + JSON.stringify(r));
    assert.equal(rowOf(r).unresolved, undefined, head);
  }
});

test('a plan names a file in another letter case: it is read and counted as git spells it', () => {
  const lib = 'export function formatDate(d) {\n  return String(d);\n}\n';
  const users11 = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`src/u${i}.ts`, `import { formatDate } from './lib';\nexport const v${i} = formatDate(${i});\n`]));
  const repo = change({ 'src/lib.ts': lib, ...users11 }, {});
  for (const spelled of ['src/Lib.ts', 'SRC/lib.ts', 'src/lib.ts']) {
    const r = sizeTask({ repo, files: [spelled], names: ['formatDate'] });
    assert.equal(r.size, 'big', spelled + ' ' + JSON.stringify(r));
    assert.equal(r.callers.find(c => c.name === 'formatDate').count, 11, spelled);
  }
});

test('the rows that raised the callers signal come first among the printed rows', () => {
  const fns = v => Array.from({ length: 13 }, (_, i) => `export function fn${String(i).padStart(2, '0')}(a) {\n  return a + ${v};\n}\n`).join('');
  const caller = `import { fn12 } from './many';\nexport function run() {\n${calls('fn12', 11)}}\n`;
  const r = size(change({ 'src/many.ts': fns(1), 'src/user.ts': caller }, { 'src/many.ts': fns(2) }));
  assert.equal(r.callers[0].name, 'fn12');
  const u = size(change({ 'src/rule.ts': rule(1), 'src/user.ts': "import { validate as check } from '~/rule';\ncheck(1);\n" }, { 'src/rule.ts': rule(2) }));
  assert.equal(u.callers[0].name, 'validate');
});
