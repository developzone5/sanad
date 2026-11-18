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

// 2026-11-18 (repair round): callers of a function exported at the bottom of its file, a method of an exported
// object, a C# property and a base class method.
const users12 = (imp, use) => Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`src/pages/P${i}.tsx`, `${imp}\nexport const p${i} = () => ${use(i)};\n`]));

test('a function exported at the bottom of its file (export default X; / export { X }) has its callers counted', () => {
  const field = (v) => `function Field(props) {\n  return props.a + ${v};\n}\nexport default Field;\n`;
  const r1 = size(change({ 'src/components/Field.tsx': field(1), ...users12("import Field from '../components/Field';", () => 'Field(1)') }, { 'src/components/Field.tsx': field(2) }));
  assert.equal(r1.size, 'big', JSON.stringify(r1.callers));
  assert.equal(r1.callers.find(c => c.name === 'Field').count, 12);
  const due = (v) => `function useDue(d) {\n  return d + ${v};\n}\nexport { useDue };\n`;
  const r2 = size(change({ 'src/components/useDue.ts': due(1), ...users12("import { useDue } from '../components/useDue';", () => 'useDue(1)') }, { 'src/components/useDue.ts': due(2) }));
  assert.equal(r2.size, 'big', JSON.stringify(r2.callers));
});

test('Must not change: a local function that is not exported keeps only its own file as callers', () => {
  const field = (v) => `function Field(props) {\n  return props.a + ${v};\n}\nexport default Other;\nfunction Other() { return Field(1); }\n`;
  const r = size(change({ 'src/components/Field.tsx': field(1), ...users12("import Other from '../components/Field';", () => 'Field(1)') }, { 'src/components/Field.tsx': field(2) }));
  assert.equal(r.size, 'small', JSON.stringify(r.callers));
});

test('a method of an exported object counts its object.method uses', () => {
  const api = (v) => `export const gradesApi = {\n  list: (classId) => client.get('/g', classId),\n  save: (id, value) => client.put('/g/' + id, { value: ${v} }),\n};\n`;
  const files = users12("import { gradesApi } from '../lib/gradesApi';", () => 'gradesApi.save(1, 5)');
  const r = size(change({ 'src/lib/gradesApi.ts': api('value'), ...files }, { 'src/lib/gradesApi.ts': api('Math.round(value)') }));
  assert.equal(r.size, 'big', JSON.stringify(r.callers));
  assert.equal(r.callers.find(c => c.name === 'gradesApi.save').count, 12);
  const few = Object.fromEntries(Object.entries(files).slice(0, 2));
  const s = size(change({ 'src/lib/gradesApi.ts': api('value'), ...few }, { 'src/lib/gradesApi.ts': api('Math.round(value)') }));
  assert.equal(s.size, 'small', 'Must not change: two callers stay small ' + JSON.stringify(s.callers));
  assert.equal(s.callers.find(c => c.name === 'gradesApi.save').count, 2);
});

test('a changed line in an exported object with no nameable member counts as unknown callers', () => {
  const api = (v) => `export const gradesApi = {\n  ...base,\n  [dyn]: ${v},\n};\n`;
  const r = size(change({ 'src/lib/gradesApi.ts': api('1') }, { 'src/lib/gradesApi.ts': api('2') }));
  assert.equal(r.size, 'big', JSON.stringify(r.callers));
});

test('Must not change: a changed line in a local (not exported) object stays small', () => {
  const page = (v) => `const styles = {\n  box: ${v},\n};\nexport function Box() {\n  return styles.box;\n}\n`;
  const r = size(change({ 'src/Box.tsx': page(1) }, { 'src/Box.tsx': page(2) }));
  assert.equal(r.size, 'small', JSON.stringify(r.callers));
});

test('a changed C# property is counted by its .Name uses; an auto-property line is not a function', () => {
  const sub = (e) => `namespace D;\npublic class Submission\n{\n    public bool IsLate => ${e};\n}\n`;
  const users = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`Api/U${i}.cs`, `public class U${i}\n{\n    public bool Go(Submission s) { return s.IsLate; }\n}\n`]));
  const r = size(change({ 'Domain/Submission.cs': sub('SubmittedAt > DueAt'), ...users }, { 'Domain/Submission.cs': sub('SubmittedAt > DueAt.AddMinutes(5)') }));
  assert.equal(r.size, 'big', JSON.stringify(r.callers));
  assert.equal(r.callers.find(c => c.name === 'IsLate').count, 12);
  const dto = 'public class Row\n{\n    public int Id { get; set; }\n}\n';
  const d = size(change({ 'Api/Row.cs': dto, ...users }, { 'Api/Row.cs': dto.replace('public int Id', 'public string Status { get; set; }\n    public int Id') }));
  assert.equal(d.size, 'small', 'Must not change: ' + JSON.stringify(d.callers));
});

test('a base class method is counted through the types and interfaces that derive from it', () => {
  const baseCs = (e) => `public abstract class RepositoryBase<T>\n{\n    public virtual T Load(int id)\n    {\n        return ${e};\n    }\n}\n`;
  const derived = 'public class UserRepository : RepositoryBase<User>, IUserRepository\n{\n}\n';
  const users = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`Api/U${i}.cs`, `public class U${i}\n{\n    private readonly IUserRepository _users;\n    public User Go(int id) { return _users.Load(id); }\n}\n`]));
  const r = size(change({ 'Domain/RepositoryBase.cs': baseCs('Find(id)'), 'Domain/UserRepository.cs': derived, ...users }, { 'Domain/RepositoryBase.cs': baseCs('Find(id + 0)') }));
  assert.equal(r.size, 'big', JSON.stringify(r.callers));
  assert.equal(r.callers.find(c => c.name === 'Load').count, 12);
});

// 2026-11-18 (repair round 3).
test('a C# property is counted only in files that name its declaring type, not every same-named read', () => {
  const badge = (e) => `namespace D;\npublic class Badge\n{\n    public bool IsActive => ${e};\n}\n`;
  const user = 'namespace D;\npublic class User\n{\n    public bool IsActive { get; set; }\n}\n';
  const users = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`Api/U${i}.cs`, `public class U${i}\n{\n    public bool Ok(User user) { return user.IsActive; }\n}\n`]));
  const r = size(change({ 'Domain/Badge.cs': badge('EndsAt == null'), 'Domain/User.cs': user, ...users }, { 'Domain/Badge.cs': badge('EndsAt == null || EndsAt > DateTime.UtcNow') }));
  assert.equal(r.size, 'small', JSON.stringify(r.callers));
  assert.ok(!r.signals.callersMany);
  // Must not change: readers that do name the declaring type still count.
  const badgeUsers = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`Api/B${i}.cs`, `public class B${i}\n{\n    public bool Ok(Badge b) { return b.IsActive; }\n}\n`]));
  const q = size(change({ 'Domain/Badge.cs': badge('EndsAt == null'), 'Domain/User.cs': user, ...badgeUsers }, { 'Domain/Badge.cs': badge('EndsAt == null || EndsAt > DateTime.UtcNow') }));
  assert.equal(q.size, 'big', JSON.stringify(q.callers));
  assert.equal(q.callers.find(c => c.name === 'IsActive').count, 12);
});

test('a hosted service whose base list is on a later line, or comes from a project base class, is background work', () => {
  const loop = (l) => `    protected override async Task ExecuteAsync(CancellationToken ct)\n    {\n        while (!ct.IsCancellationRequested)\n        {\n            ${l}\n        }\n    }\n}\n`;
  const a = (l) => 'public sealed class RoleSyncWorker(IRoleQueue queue, ILogger<RoleSyncWorker> logger)\n    : BackgroundService\n{\n' + loop(l);
  const b = (l) => 'public sealed class RoleSyncWorker(\n    IRoleQueue queue,\n    ILogger<RoleSyncWorker> logger\n) : BackgroundService\n{\n' + loop(l);
  const c = (l) => 'public sealed class RoleSyncWorker : QueueWorkerBase\n{\n' + loop(l);
  const baseCs = 'public abstract class QueueWorkerBase : BackgroundService\n{\n}\n';
  const x = 'await _queue.MarkDoneAsync(item.Id, ct);', y = 'if (item.Tries < 3) await _queue.MarkDoneAsync(item.Id, ct);';
  for (const [name, mk, extra] of [['multi-line base list', a, {}], ['multi-line parameters', b, {}], ['project base class', c, { 'Api/QueueWorkerBase.cs': baseCs }]]) {
    const r = size(change({ 'Api/RoleSyncWorker.cs': mk(x), ...extra }, { 'Api/RoleSyncWorker.cs': mk(y) }));
    assert.ok(r.signals.concurrency, name + ' ' + JSON.stringify(r.signals));
    assert.equal(r.size, 'big', name);
  }
  // Must not change: a plain class with a base class that is no hosted service stays small.
  const plain = (l) => 'public sealed class Mapper : MapperBase\n{\n    public int Go(int a)\n    {\n        ' + l + '\n    }\n}\n';
  const m = size(change({ 'Api/Mapper.cs': plain('return a;'), 'Api/MapperBase.cs': 'public abstract class MapperBase\n{\n}\n' }, { 'Api/Mapper.cs': plain('return a + 1;') }));
  assert.equal(m.size, 'small', JSON.stringify(m.signals));
});

test('a default export through a wrapper call (memo, React.memo, forwardRef) is exported and has its callers counted', () => {
  const field = (v, tail) => `const Field = (props) => {\n  return <input value={props.value}${v} />;\n};\n${tail}\n`;
  const imp = "import Field from '../components/Field';";
  for (const tail of ['export default memo(Field);', 'export default React.memo(Field);', 'export default forwardRef(Field);']) {
    const r = size(change({ 'src/components/Field.tsx': field('', tail), ...users12(imp, () => '<Field />') }, { 'src/components/Field.tsx': field(' disabled', tail) }));
    assert.equal(r.size, 'big', tail + ' ' + JSON.stringify(r.callers));
    assert.equal(r.callers.find(c => c.name === 'Field').count, 12, tail);
  }
  // Must not change: a wrapper around another name leaves Field local.
  const tail2 = 'export default memo(Other);\nconst Other = () => <Field />;';
  const other = size(change({ 'src/components/Field.tsx': field('', tail2), ...users12(imp, () => '<Field />') }, { 'src/components/Field.tsx': field(' disabled', tail2) }));
  assert.equal(other.size, 'small', JSON.stringify(other.callers));
});

test('a C# property whose accessor block starts on a later line has its readers counted', () => {
  const sub = (e) => `namespace D;\npublic class Submission\n{\n    public bool IsLate\n    {\n        get { return SubmittedAt > ${e}; }\n    }\n}\n`;
  const users = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`Api/U${i}.cs`, `public class U${i}\n{\n    public bool Check(Submission s) { return s.IsLate; }\n}\n`]));
  const r = size(change({ 'Domain/Submission.cs': sub('DueAt'), ...users }, { 'Domain/Submission.cs': sub('DueAt.AddMinutes(5)') }));
  assert.equal(r.size, 'big', JSON.stringify(r.callers));
  assert.equal(r.callers.find(c => c.name === 'IsLate').count, 12);
  // Must not change: a multi-line auto-property (get; set; only) with the same readers stays small.
  const dto = (x) => `public class Row\n{\n    public int Id { get; set; }\n    public string Note\n    {\n        get; ${x};\n    }\n}\n`;
  const rowUsers = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`Api/R${i}.cs`, `public class R${i}\n{\n    public string Check(Row s) { return s.Note; }\n}\n`]));
  const d = size(change({ 'Api/Row.cs': dto('set'), ...rowUsers }, { 'Api/Row.cs': dto('init') }));
  assert.equal(d.size, 'small', JSON.stringify(d.callers));
});
