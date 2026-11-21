// 2026-11-19 (speed review, problem 17): every break ran the whole test command, 163 tests per break on day 3 of
// the role-sync task. selectCommand makes the command for one break: only the tests its mustFail names.
// The promise under test: the command made runs every test the break's mustFail names, and when that cannot be
// said for sure the full command comes back, the same array.
// The tests of each case are read from real test text by declaredTests / testSpans (proof-record.mjs), as
// red-proof.mjs reads them. A small matcher stands in for the dotnet filter (~, =, |, &, brackets).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { selectCommand, MAX_TERMS } from '../scripts/proof-select.mjs';
import { declaredTests, testSpans, namedBy } from '../scripts/proof-record.mjs';

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

const CS_FILE = 'EduQuest/EduQuest.Tests/Users/RoleSyncTests.cs';
const CS = `
namespace EduQuest.Tests.Users;

public class RoleSyncTests
{
    [Fact]
    public async Task Sends_role_change_after_save() { await Task.CompletedTask; }

    [Fact(DisplayName = "Role sync: sends [admin, manager] once, in order")]
    public void Sends_once() { }

    [Fact]
    public void Sends_once_more() { }
}

public abstract class BaseSyncTests
{
    [Fact]
    public void Keeps_the_row() { }
}

public class MySqlSyncTests : BaseSyncTests { }

public class Outer
{
    public class Inner
    {
        [Fact]
        public void Nested_rule_holds() { }
    }
}

public class OtherTests
{
    [Fact]
    public void Sends_once() { }
}

public partial class SplitTests
{
    [Fact]
    public void Half_in_this_file() { }
}
`;
const cs = declaredTests(CS, CS_FILE);

const PAGE_FILE = 'eduquest-frontend/src/pages/users/RoleForm.test.tsx';
const LIST_FILE = 'eduquest-frontend/src/pages/users/UserList.test.tsx';
const HARD_TITLE = 'shows "saved" | (twice) for دور المعلم';
const PAGE = `
import { describe, it, expect } from 'vitest';
describe('RoleForm', () => {
  it('sends the role change after the save', () => { expect(1).toBe(1); });
  it('keeps the old role when the save fails', () => { expect(1).toBe(1); });
  it('${HARD_TITLE}', () => { expect(1).toBe(1); });
  it(\`shows \${count} roles\`, () => { expect(1).toBe(1); });
});
`;
const LIST = `
import { it, expect } from 'vitest';
it('sends the role change after the save', () => { expect(1).toBe(1); });
it('lists every user', () => { expect(1).toBe(1); });
`;
const js = [...declaredTests(PAGE, PAGE_FILE), ...declaredTests(LIST, LIST_FILE)];

const NODE20 = 'C:/Users/Asus/tools/node-v20.20.2-win-x64/node.exe';
const VITEST = [NODE20, 'node_modules/vitest/vitest.mjs', 'run'];
const DOTNET = ['dotnet', 'test', 'EduQuest/EduQuest.Tests/EduQuest.Tests.csproj', '--artifacts-path', 'bin/hosttest'];
const WEB = { cwd: 'eduquest-frontend' };

// The dotnet filter, read the way the runner reads it: terms Name~text (holds), Name=text, Name!=text, joined
// with | and &, with brackets. & binds tighter than |.
function filterAccepts(filter, props) {
  const s = String(filter);
  let i = 0;
  const prim = () => {
    if (s[i] === '(') { i++; const v = or(); assert.equal(s[i], ')', 'a bracket closes in ' + s); i++; return v; }
    let j = i;
    while (j < s.length && !'()|&'.includes(s[j])) j++;
    const term = s.slice(i, j);
    i = j;
    const m = /^(\w+)(!=|=|~)(.*)$/.exec(term);
    assert.ok(m, `"${term}" is a filter term in ${s}`);
    const have = String(props[m[1]] ?? '');
    return m[2] === '~' ? have.includes(m[3]) : m[2] === '=' ? have === m[3] : have !== m[3];
  };
  const and = () => { let v = prim(); while (s[i] === '&') { i++; const r = prim(); v = v && r; } return v; };
  const or = () => { let v = and(); while (s[i] === '|') { i++; const r = and(); v = v || r; } return v; };
  const v = or();
  assert.equal(i, s.length, 'the whole filter is read: ' + s);
  return v;
}
const filterOf = (command) => {
  const i = command.indexOf('--filter');
  if (i >= 0) return command[i + 1];
  const joined = command.find(a => /^--filter[=:]/.test(a));
  return joined === undefined ? undefined : joined.slice(9);
};
const NS = 'EduQuest.Tests.Users.';
const sameFull = (r, command, why) => {
  assert.equal(r.narrowed, false, 'not narrowed');
  assert.equal(r.command, command, 'the same array comes back');
  if (why) assert.match(r.why, why);
};

// ---- dotnet test: real command shapes ----

test('dotnet test with no filter: --filter is added with the class and method of each named test', () => {
  const r = selectCommand(DOTNET, ['Sends_role_change_after_save'], cs);
  assert.equal(r.narrowed, true);
  assert.deepEqual(r.command, [...DOTNET, '--filter', 'FullyQualifiedName~RoleSyncTests.Sends_role_change_after_save']);
  assert.notEqual(r.command, DOTNET, 'a new array');
  assert.deepEqual(DOTNET.length, 5, 'the given command is not changed');
  assert.match(r.why, /1 test name/);
});

test('dotnet test with a filter: the old filter is kept as (old)&(new)', () => {
  for (const shape of [['--filter', 'Category=Fast|Category=Slow'], ['--filter=Category=Fast|Category=Slow'], ['--filter:Category=Fast|Category=Slow']]) {
    const command = ['dotnet', 'test', 'EduQuest/EduQuest.Tests/EduQuest.Tests.csproj', ...shape, '--no-build'];
    const r = selectCommand(command, ['Nested_rule_holds'], cs);
    assert.equal(r.narrowed, true, shape[0]);
    assert.equal(filterOf(r.command), '(Category=Fast|Category=Slow)&(FullyQualifiedName~Inner.Nested_rule_holds)');
    assert.equal(r.command.length, command.length, 'no word is added: ' + shape[0]);
    assert.equal(r.command[r.command.length - 1], '--no-build');
    // The old filter still decides: a test of the right name in another category is not run.
    assert.equal(filterAccepts(filterOf(r.command), { FullyQualifiedName: NS + 'Outer+Inner.Nested_rule_holds', Category: 'Fast' }), true);
    assert.equal(filterAccepts(filterOf(r.command), { FullyQualifiedName: NS + 'Outer+Inner.Nested_rule_holds', Category: 'Db' }), false);
  }
});

test('dotnet test with args after "--": the filter goes before the "--", and a word after it is not read', () => {
  const command = [...DOTNET, '--', 'xunit.parallelizeAssembly=false', '-t', '--filter', 'x'];
  const r = selectCommand(command, ['Sends_role_change_after_save'], cs);
  assert.equal(r.narrowed, true);
  assert.deepEqual(r.command, [...DOTNET, '--filter', 'FullyQualifiedName~RoleSyncTests.Sends_role_change_after_save', '--', 'xunit.parallelizeAssembly=false', '-t', '--filter', 'x']);
});

test('dotnet.exe by a full path is dotnet; another dotnet verb is not a known runner', () => {
  const r = selectCommand(['C:\\Program Files\\dotnet\\dotnet.exe', 'test'], ['Nested_rule_holds'], cs);
  assert.equal(r.narrowed, true);
  const vstest = ['dotnet', 'vstest', 'bin/Tests.dll'];
  sameFull(selectCommand(vstest, ['Nested_rule_holds'], cs), vstest, /runner is not known/);
});

// ---- dotnet test: names ----

test('a DisplayName with brackets, commas and colons never goes into the filter', () => {
  const display = 'Role sync: sends [admin, manager] once, in order';
  assert.ok(cs.some(d => d.titles.includes(display)), 'the test text declares that DisplayName');
  const r = selectCommand(DOTNET, ['sends [admin, manager] once'], cs);
  assert.equal(r.narrowed, true);
  const filter = filterOf(r.command);
  assert.equal(filter, 'FullyQualifiedName~RoleSyncTests.Sends_once');
  for (const ch of ['[', ']', ',', ':', ' ']) assert.ok(!filter.includes(ch), `no "${ch}" in the filter`);
  assert.ok(r.command.every(a => !a.includes('Role sync')), 'the DisplayName is in no word of the command');
});

test('an inherited test is filtered by its method alone, so the class that derives is selected', () => {
  const r = selectCommand(DOTNET, ['Keeps_the_row'], cs);
  assert.equal(filterOf(r.command), 'FullyQualifiedName~.Keeps_the_row');
  assert.equal(filterAccepts(filterOf(r.command), { FullyQualifiedName: NS + 'MySqlSyncTests.Keeps_the_row' }), true);
});

test('a nested class: the inner class name fits the name the runner prints (Outer+Inner)', () => {
  const r = selectCommand(DOTNET, ['Nested_rule_holds'], cs);
  assert.equal(filterOf(r.command), 'FullyQualifiedName~Inner.Nested_rule_holds');
  assert.equal(filterAccepts(filterOf(r.command), { FullyQualifiedName: NS + 'Outer+Inner.Nested_rule_holds' }), true);
});

test('two classes with the same method name, and a method that starts another method: every named test is selected', () => {
  // "Sends_once" is in the titles of RoleSyncTests.Sends_once, RoleSyncTests.Sends_once_more and OtherTests.Sends_once.
  const r = selectCommand(DOTNET, ['Sends_once'], cs);
  const filter = filterOf(r.command);
  assert.deepEqual(filter.split('|'), ['FullyQualifiedName~RoleSyncTests.Sends_once', 'FullyQualifiedName~RoleSyncTests.Sends_once_more', 'FullyQualifiedName~OtherTests.Sends_once']);
  for (const name of ['RoleSyncTests.Sends_once', 'RoleSyncTests.Sends_once_more', 'OtherTests.Sends_once']) {
    assert.equal(filterAccepts(filter, { FullyQualifiedName: NS + name }), true, name);
  }
  assert.equal(filterAccepts(filter, { FullyQualifiedName: NS + 'RoleSyncTests.Sends_role_change_after_save' }), false, 'a test no part names is left out');
});

test('a method name that starts another: naming the short one alone still selects it (the longer one may run too)', () => {
  const only = cs.filter(d => d.klass === 'OtherTests');
  const r = selectCommand(DOTNET, ['Sends_once'], only);
  assert.equal(filterAccepts(filterOf(r.command), { FullyQualifiedName: NS + 'OtherTests.Sends_once' }), true);
});

test('a test in a partial class whose other half is in another file is filtered by that class', () => {
  const r = selectCommand(DOTNET, ['Half_in_this_file'], cs);
  assert.equal(filterOf(r.command), 'FullyQualifiedName~SplitTests.Half_in_this_file');
});

test('a derived class declared in another test file can run an inherited method', () => {
  const base = declaredTests('class BaseTests { [Fact] public void Checks_the_rule() {} }', 'Tests/BaseTests.cs');
  const derived = declaredTests('class DerivedTests : BaseTests { [Fact] public void Checks_another_rule() {} }', 'Tests/DerivedTests.cs');
  assert.equal(base[0].inherited, undefined);
  const r = selectCommand(DOTNET, ['Checks_the_rule'], [...base, ...derived]);
  assert.equal(filterOf(r.command), 'FullyQualifiedName~.Checks_the_rule');
  assert.equal(filterAccepts(filterOf(r.command), { FullyQualifiedName: 'Tests.DerivedTests.Checks_the_rule' }), true);
});

test('all declarations on one line count even if their method names match', () => {
  const items = declaredTests('class A { [Fact] public void Saves() {} } class B { [Fact] public void Saves() {} }', 'Tests/Two.cs');
  const r = selectCommand(DOTNET, ['Saves'], items);
  assert.equal(filterOf(r.command), 'FullyQualifiedName~A.Saves|FullyQualifiedName~B.Saves');
});

test('30 generated cases: the filter accepts the full name of every declared test a mustFail part names', () => {
  // A fixed seed (mulberry32), so a failure shows the same case every time.
  let seed = 20261119;
  const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const CLASSES = ['RoleSyncTests', 'UserTests', 'UserTestsExtra', 'GradeRules', 'Sync', 'SyncTests'];
  const METHODS = ['Saves', 'Saves_twice', 'Refuses_a_stranger', 'Refuses', 'Sends_after_save', 'Sends', 'Keeps_the_row', 'Returns_404', 'Returns_404_for_other_school'];
  const DISPLAYS = ['Saves: [a, b] once', 'Refuses (role: "x, y")', 'Sends, then stops: [done]'];
  let checked = 0;
  for (let n = 0; n < 30; n++) {
    const declared = [], fullNames = new Map();
    const classCount = 2 + Math.floor(rnd() * 3);
    for (let c = 0; c < classCount; c++) {
      const klass = pick(CLASSES), inherited = rnd() < 0.25, nested = rnd() < 0.25;
      const printedClass = (nested ? 'Holder+' : '') + (inherited ? klass + 'OnMySql' : klass);
      const methodCount = 1 + Math.floor(rnd() * 4);
      for (let m = 0; m < methodCount; m++) {
        const method = pick(METHODS);
        const item = { file: `Tests/${klass}${c}.cs`, line: 10 + m * 5, titles: [method, ...(rnd() < 0.4 ? [pick(DISPLAYS)] : [])], klass, ...(inherited ? { inherited: true } : {}) };
        declared.push(item);
        fullNames.set(item, `App.Tests.${printedClass}.${method}`);
      }
    }
    const parts = [];
    for (let p = 0, count = 1 + Math.floor(rnd() * 3); p < count; p++) {
      const title = pick(pick(declared).titles);
      // A whole title, or a piece of it, in any case: a part is matched without case.
      const from = rnd() < 0.5 ? 0 : Math.floor(rnd() * Math.max(1, title.length - 3));
      const piece = title.slice(from, from + 3 + Math.floor(rnd() * title.length));
      parts.push(rnd() < 0.3 ? piece.toUpperCase() : piece);
    }
    const old = rnd() < 0.4 ? pick(['Category=Fast', 'Category!=Slow', 'FullyQualifiedName~App.Tests|Category=Fast']) : null;
    const command = ['dotnet', 'test', 'Api.Tests/Api.Tests.csproj', ...(old ? ['--filter', old] : []), ...(rnd() < 0.3 ? ['--', 'xunit.parallelizeAssembly=false'] : [])];
    const r = selectCommand(command, parts, declared);
    assert.equal(r.narrowed, true, `case ${n}: ${r.why}`);
    const filter = filterOf(r.command);
    for (const display of DISPLAYS) assert.ok(!filter.includes(display), `case ${n}: no DisplayName in ${filter}`);
    for (const d of declared) {
      if (!namedBy(parts, d)) continue;
      assert.equal(filterAccepts(filter, { FullyQualifiedName: fullNames.get(d), Category: 'Fast' }), true, `case ${n}: ${fullNames.get(d)} is selected by ${filter} for parts ${JSON.stringify(parts)}`);
      checked++;
    }
  }
  assert.ok(checked >= 30, `${checked} named tests were checked`);
});

// ---- vitest and jest: real command shapes ----

test('vitest with no file args: the files that hold the named tests go after "run", and -t gets the title', () => {
  const r = selectCommand(VITEST, ['keeps the old role'], js, WEB);
  assert.equal(r.narrowed, true);
  assert.deepEqual(r.command, [...VITEST, 'src/pages/users/RoleForm.test.tsx', '-t', '(?:keeps the old role when the save fails)']);
  assert.match(r.why, /1 title\(s\) in 1 test file/);
});

test('vitest with file args: only the files that hold the named tests stay, options stay where they are', () => {
  const command = [...VITEST, 'src/pages/users/RoleForm.test.tsx', 'src/pages/users/UserList.test.tsx', '--reporter', 'verbose', '--no-coverage'];
  const r = selectCommand(command, ['lists every user'], js, WEB);
  assert.equal(r.narrowed, true);
  assert.deepEqual(r.command, [...VITEST, 'src/pages/users/UserList.test.tsx', '--reporter', 'verbose', '--no-coverage', '-t', '(?:lists every user)']);
});

test('a mustFail part that names tests in two files keeps both files and one title', () => {
  const r = selectCommand(VITEST, ['sends the role change'], js, WEB);
  assert.deepEqual(r.command, [...VITEST, 'src/pages/users/RoleForm.test.tsx', 'src/pages/users/UserList.test.tsx', '-t', '(?:sends the role change after the save)']);
  // The same part, with only the changed file read (the other file is unchanged): the changed file's test still runs.
  const changedOnly = selectCommand(VITEST, ['sends the role change'], declaredTests(PAGE, PAGE_FILE), WEB);
  assert.deepEqual(changedOnly.command, [...VITEST, 'src/pages/users/RoleForm.test.tsx', '-t', '(?:sends the role change after the save)']);
});

test('a title with a quote, |, ( and Arabic letters goes into -t escaped and matches itself', () => {
  const r = selectCommand(VITEST, ['دور المعلم'], js, WEB);
  assert.equal(r.narrowed, true);
  const pattern = r.command[r.command.length - 1];
  assert.equal(r.command[r.command.length - 2], '-t');
  assert.equal(pattern, '(?:shows "saved" \\| \\(twice\\) for دور المعلم)');
  assert.equal(new RegExp(pattern).test('RoleForm ' + HARD_TITLE), true, 'the full name the runner makes');
  assert.equal(new RegExp(pattern, 'i').test(HARD_TITLE), true, 'jest reads it without case');
  assert.equal(new RegExp(pattern).test('RoleForm shows "saved" for دور المعلم'), false, 'the | is text, not a choice');
});

test('a filter and a title with spaces, quotes, | and & reach a process started without a shell as they are', () => {
  const echo = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
  const page = selectCommand(VITEST, ['دور المعلم', 'keeps the old role'], js, WEB);
  const server = selectCommand([...DOTNET, '--filter', 'DisplayName~"a b"|Category=Fast'], ['Sends_once'], cs);
  for (const r of [page, server]) {
    assert.equal(r.narrowed, true);
    const words = r.command.slice(1);
    const ran = spawnSync(process.execPath, ['-e', echo, '--', ...words], { shell: false, encoding: 'utf8', windowsHide: true });
    assert.equal(ran.status, 0, ran.stderr);
    assert.deepEqual(JSON.parse(ran.stdout), words);
  }
});

test('the runner itself as the command, and jest: a file is given to jest as an escaped pattern', () => {
  const direct = selectCommand(['vitest', 'run'], ['lists every user'], js, WEB);
  assert.deepEqual(direct.command, ['vitest', 'run', 'src/pages/users/UserList.test.tsx', '-t', '(?:lists every user)']);
  const odd = declaredTests("it('opens the page', () => {});", 'web/app/(admin)/[id]/page.test.tsx');
  const jest = selectCommand(['node', 'node_modules/jest/bin/jest.js', '--ci'], ['opens the page'], odd, { cwd: 'web' });
  assert.deepEqual(jest.command, ['node', 'node_modules/jest/bin/jest.js', 'app/\\(admin\\)/\\[id\\]/page\\.test\\.tsx', '--ci', '-t', '(?:opens the page)']);
  assert.equal(new RegExp(jest.command[2]).test('C:/repo/web/app/(admin)/[id]/page.test.tsx'), true);
});

test('the folder the command runs in: the top, a subfolder, an absolute copy folder; a file outside it is not narrowed', () => {
  const top = selectCommand(VITEST, ['lists every user'], js);
  assert.equal(top.command[3], LIST_FILE);
  const copy = selectCommand(VITEST, ['lists every user'], js, { cwd: 'C:\\Temp\\red-proof-copies\\ab12\\0\\eduquest-frontend' });
  assert.equal(copy.command[3], 'src/pages/users/UserList.test.tsx');
  // An absolute top folder: nothing of it heads the file, so the whole path is kept (the runner matches a tail).
  const copyTop = selectCommand(VITEST, ['lists every user'], js, { cwd: '/tmp/red-proof-copies/ab12/0' });
  assert.equal(copyTop.command[3], LIST_FILE);
  sameFull(selectCommand(VITEST, ['lists every user'], js, { cwd: 'EduQuest' }), VITEST, /not under the folder/);
});

// ---- the full command, unchanged ----

test('a mustFail part that names no declared test: the full command', () => {
  sameFull(selectCommand(DOTNET, ['Sends_once', 'No_such_test'], cs), DOTNET, /"No_such_test" names no declared test/);
  sameFull(selectCommand(VITEST, ['RoleForm'], js, WEB), VITEST, /names no declared test/);
  sameFull(selectCommand(DOTNET, [], cs), DOTNET, /no mustFail part/);
  sameFull(selectCommand(DOTNET, ['Sends_once'], []), DOTNET, /names no declared test/);
});

test('a title with placeholders: the full command (a template title, and a table test seen through testSpans)', () => {
  sameFull(selectCommand(VITEST, ['roles'], js, WEB), VITEST, /placeholders/);
  const table = "it.each([[1], [2]])('adds %s to the list', (n) => {});\nit('adds nothing to the list when empty', () => {});";
  const spans = testSpans(table, 'eduquest-frontend/src/list.test.ts');
  sameFull(selectCommand(VITEST, ['to the list'], spans, WEB), VITEST, /placeholders/);
  // declaredTests leaves the table test out, so the same part narrows to the plain test alone.
  assert.equal(selectCommand(VITEST, ['to the list'], declaredTests(table, 'eduquest-frontend/src/list.test.ts'), WEB).narrowed, true);
});

test('printed row numbers, object values and escaped percent signs also use the full command', () => {
  for (const hole of ['%$', '%p', '$الدور', '%%']) {
    const table = `it.each([[1]])('lists ${hole} for the user', () => {});`;
    const items = testSpans(table, 'eduquest-frontend/src/list.test.ts');
    sameFull(selectCommand(VITEST, ['for the user'], items, WEB), VITEST, /placeholders/);
  }
});

test('an unknown runner and a shell wrapper: the full command', () => {
  for (const command of [['npx', 'vitest', 'run'], ['python', '-m', 'pytest'], ['node', 'scripts/run-tests.js'], ['node', '--require', 'x.js', 'node_modules/vitest/vitest.mjs', 'run']]) {
    sameFull(selectCommand(command, ['lists every user'], js, WEB), command, /runner is not known/);
  }
  for (const command of [['cmd', '/c', 'dotnet', 'test'], ['C:\\Windows\\System32\\cmd.exe', '/c', 'run-tests.cmd'], ['bash', '-lc', 'dotnet test'], ['./test.sh'], ['node_modules/.bin/vitest.cmd', 'run'], ['pwsh', '-File', 'test.ps1']]) {
    sameFull(selectCommand(command, ['Sends_once'], cs), command, /shell wrapper/);
  }
});

test(`${MAX_TERMS + 1} terms: the full command; ${MAX_TERMS} are still narrowed`, () => {
  assert.equal(MAX_TERMS, 40);
  const many = (n) => Array.from({ length: n }, (_, i) => ({ file: 'Tests/BigTests.cs', line: i + 1, titles: [`Rule_${i}_holds`], klass: 'BigTests' }));
  assert.equal(selectCommand(DOTNET, ['_holds'], many(40)).narrowed, true);
  sameFull(selectCommand(DOTNET, ['_holds'], many(41)), DOTNET, /41 test names, more than 40/);
  const titles = (n) => Array.from({ length: n }, (_, i) => ({ file: 'eduquest-frontend/src/big.test.ts', line: i + 1, titles: [`rule ${i} holds`] }));
  assert.equal(selectCommand(VITEST, [' holds'], titles(40), WEB).narrowed, true);
  sameFull(selectCommand(VITEST, [' holds'], titles(41), WEB), VITEST, /41 titles, more than 40/);
});

test('a command that already holds -t or --list-tests: the full command', () => {
  for (const extra of [['-t'], ['--list-tests']]) {
    const command = [...DOTNET, ...extra];
    sameFull(selectCommand(command, ['Sends_once'], cs), command, /only lists tests/);
  }
  for (const extra of [['-t', 'role'], ['--testNamePattern=role'], ['--testNamePattern', 'role'], ['--changed']]) {
    const command = [...VITEST, ...extra];
    sameFull(selectCommand(command, ['lists every user'], js, WEB), command, /already picks or lists tests/);
  }
  const jestList = ['node', 'node_modules/jest/bin/jest.js', '--listTests'];
  sameFull(selectCommand(jestList, ['lists every user'], js, WEB), jestList, /already picks or lists tests/);
});

test('what cannot be said for sure: the full command', () => {
  const cases = [
    [[...VITEST, '--silent', 'passed-only'], /cannot tell whether passed-only is a file or the value of --silent/],
    [[...VITEST, 'src/pages/grades'], /own file list does not hold src\/pages\/users\/UserList\.test\.tsx/],
    [[...VITEST, '--root', 'packages/web'], /--root moves the folder/],
    [[NODE20, 'node_modules/vitest/vitest.mjs', 'related', 'src/a.ts'], /not a plain run/],
    [[...VITEST, '--', 'x'], /bare --/],
    [[...VITEST, '--reporter'], /--reporter has no value/],
  ];
  for (const [command, why] of cases) sameFull(selectCommand(command, ['lists every user'], js, WEB), command, why);
  // A C# test under vitest, a page test under dotnet, two filters, a filter with no value.
  sameFull(selectCommand(VITEST, ['Sends_once'], cs, WEB), VITEST, /C# test/);
  sameFull(selectCommand(DOTNET, ['lists every user'], js), DOTNET, /no C# class and method name/);
  const two = [...DOTNET, '--filter', 'a=b', '--filter', 'c=d'];
  sameFull(selectCommand(two, ['Sends_once'], cs), two, /more than one --filter/);
  const bare = [...DOTNET, '--filter'];
  sameFull(selectCommand(bare, ['Sends_once'], cs), bare, /--filter has no value/);
  // A first title that is not a method name, or a class that is not a plain name, is never put into a filter.
  const sentence = [{ file: 'Tests/RoleTests.cs', line: 4, titles: ['Role sync: sends [a, b] once'], klass: 'RoleTests' }];
  sameFull(selectCommand(DOTNET, ['sends [a, b]'], sentence), DOTNET, /no C# class and method name/);
  const oddClass = [{ file: 'Tests/RoleTests.cs', line: 4, titles: ['Sends_once'], klass: 'Role|Tests' }];
  sameFull(selectCommand(DOTNET, ['Sends_once'], oddClass), DOTNET, /no C# class and method name/);
  const property = [...DOTNET, '-p:VSTestTestCaseFilter=Category=Fast'];
  sameFull(selectCommand(property, ['Sends_once'], cs), property, /build property/);
  const several = ['node', 'node_modules/jest/bin/jest.js', '--reporters', 'default', 'jest-junit'];
  sameFull(selectCommand(several, ['lists every user'], js, WEB), several, /cannot tell whether default is a file or the value of --reporters/);
  const empty = [];
  sameFull(selectCommand(empty, ['Sends_once'], cs), empty, /no test command/);
  assert.equal(selectCommand(undefined, ['Sends_once'], cs).narrowed, false);
});

test('commands with a shard, ambiguous Node entry or an unknown option stay full', () => {
  for (const command of [
    [...VITEST, '--shard=1/2'],
    [...VITEST, '--silent=passed-only'],
    [...VITEST, '-trole'],
    [NODE20, '--eval=1', 'node_modules/vitest/vitest.mjs', 'run'],
    [NODE20, '-', 'node_modules/vitest/vitest.mjs', 'run'],
  ]) sameFull(selectCommand(command, ['lists every user'], js, WEB), command);
});

test('an existing file word must clearly include the named test file', () => {
  const unrelated = [...VITEST, 'C:/other/src/pages/users/UserList.test.tsx'];
  sameFull(selectCommand(unrelated, ['lists every user'], js, WEB), unrelated, /own file list/);
  const file = 'web/app/(admin)/page.test.tsx';
  const items = declaredTests("it('opens the page', () => {});", file);
  const pattern = ['jest', 'app/(admin)/page.test.tsx'];
  sameFull(selectCommand(pattern, ['opens the page'], items, { cwd: 'web' }), pattern, /own file list/);
  const flagLike = declaredTests("it('opens the page', () => {});", '--debug.test.js');
  sameFull(selectCommand(VITEST, ['opens the page'], flagLike), VITEST, /file path/);
});

test('run settings can have a filter of their own, so the dotnet command stays full', () => {
  for (const args of [['--settings', 'test.runsettings'], ['-s:test.runsettings'], ['--', 'RunConfiguration.TestCaseFilter=Category=Fast']]) {
    const command = [...DOTNET, ...args];
    sameFull(selectCommand(command, ['Sends_once'], cs), command, /run settings/);
  }
});

test('a skipped test is never a named test, and an option with its value is not taken for a file', () => {
  const text = "it.skip('saves the draft later', () => {});\nit('saves the draft', () => {});";
  const spans = testSpans(text, 'eduquest-frontend/src/draft.test.ts');
  const r = selectCommand([...VITEST, '--config', 'vitest.ci.config.ts', '--passWithNoTests'], ['saves the draft'], spans, WEB);
  assert.deepEqual(r.command, [...VITEST, 'src/draft.test.ts', '--config', 'vitest.ci.config.ts', '--passWithNoTests', '-t', '(?:saves the draft)']);
  sameFull(selectCommand(VITEST, ['draft later'], spans, WEB), VITEST, /names no declared test/);
});

// These smoke tests use runners already on the machine. They never install packages.
const dotnetDll = process.env.SANAD_P3_DOTNET_DLL;
const vitestEntry = process.env.SANAD_P3_VITEST_ENTRY;

test('real dotnet test runs both selected validator tests with the existing filter', { skip: dotnetDll ? false : 'set SANAD_P3_DOTNET_DLL to a built EduQuest.Tests.dll' }, t => {
  const names = ['AcademicYearValidatorTests', 'AssignmentValidatorTests'];
  const method = 'Create_ValidData_ShouldPass';
  const items = names.flatMap(klass => declaredTests(`class ${klass} { [Fact] public void ${method}() {} }`, `${klass}.cs`));
  const command = ['dotnet', 'test', dotnetDll, '--nologo', '--logger', 'console;verbosity=normal', '--filter', 'EduQuest.Tests.Validators'];
  const selected = selectCommand(command, [method], items);
  assert.equal(selected.narrowed, true, selected.why);
  const [exe, ...args] = selected.command;
  const run = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  const output = (run.stdout || '') + (run.stderr || '');
  assert.equal(run.status, 0, output || String(run.error));
  for (const klass of names) assert.ok(output.includes(`Passed EduQuest.Tests.Validators.${klass}.${method}`), output);
  const total = output.match(/^Total tests: 2\s*$/m);
  assert.ok(total, output);
  t.diagnostic('dotnet test: ' + total[0].trim());
});

test('real Vitest runs the escaped title in both selected files', { skip: vitestEntry ? false : 'set SANAD_P3_VITEST_ENTRY to an installed vitest.mjs' }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-select-vitest-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = ['one.test.js', 'two.test.js', 'unrelated.test.js'];
  const source = `describe('Role form', () => {
  it(${JSON.stringify(HARD_TITLE)}, () => expect(1).toBe(1));
  it('another test', () => expect(1).toBe(1));
});`;
  for (const file of files) fs.writeFileSync(path.join(dir, file), source);
  const items = files.slice(0, 2).flatMap(file => declaredTests(source, file));
  const command = [process.execPath, vitestEntry, 'run', '--globals', '--no-cache', '--reporter', 'verbose'];
  const selected = selectCommand(command, ['دور المعلم'], items);
  assert.equal(selected.narrowed, true, selected.why);
  const [exe, ...args] = selected.command;
  const run = spawnSync(exe, args, { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 60000, env: { ...process.env, NO_COLOR: '1' } });
  const output = (run.stdout || '') + (run.stderr || '');
  assert.equal(run.status, 0, output || String(run.error));
  for (const file of files.slice(0, 2)) assert.ok(output.split(/\r?\n/).some(line => line.includes(file) && line.includes(HARD_TITLE)), output);
  assert.ok(!output.includes(files[2]), output);
  const total = output.match(/^\s*Tests\s+2 passed[^\r\n]*/m);
  assert.ok(total, output);
  t.diagnostic('Vitest: ' + total[0].trim());
});

// ---- the script itself ----

test('proof-select imports only ./proof-record.mjs, and only names proof-record exports today', async () => {
  const text = fs.readFileSync(path.join(scripts, 'proof-select.mjs'), 'utf8');
  const imports = [...text.matchAll(/^\s*import\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/gm)].map(m => m[1]);
  assert.deepEqual(imports, ['./proof-record.mjs']);
  const record = await import('../scripts/proof-record.mjs');
  for (const m of text.matchAll(/^\s*import\s*\{([^}]*)\}\s*from\s+['"]\.\/proof-record\.mjs['"]/gm)) {
    for (const name of m[1].split(',').map(s => s.trim()).filter(Boolean)) assert.equal(typeof record[name], 'function', name + ' is an export of proof-record.mjs');
  }
  assert.ok(!/\bfs\.|readFileSync|spawn|execFile/.test(text.replace(/^\s*\/\/.*$/gm, '')), 'it reads no file and starts nothing');
});
