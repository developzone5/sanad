// 2026-11-12: "before code, list every place that uses the rule or data you change, by search" was text
// only, and was skipped: a date rule was fixed on the "schedule" path and missed on the "publish now"
// path, and a teammate found it. places.mjs makes the list by search and checks every place has an outcome.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'places.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'places-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

// A repo where dueAfterPublish is used by two tracked files, one untracked file and one test; an ignored
// file, a binary file and a longer name (dueAfterPublishNow) also hold the word and are not places.
function fixture() {
  const repo = fs.mkdtempSync(path.join(root, 'repo-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (n, t) => { fs.mkdirSync(path.dirname(path.join(repo, n)), { recursive: true }); fs.writeFileSync(path.join(repo, n), t); };
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'core.autocrlf', 'false');
  write('.gitignore', 'build/\n');
  write('src/rules.ts', 'export function dueAfterPublish(due, publish) { return due > publish; }\n');
  write('src/schedule.ts', "import { dueAfterPublish } from './rules';\nconst x = 1;\nif (dueAfterPublish(a, b)) x;\n");
  write('src/publish.ts', 'export const p = dueAfterPublishNow;\n');
  write('src/rules.test.ts', "it('dueAfterPublish', () => {});\n");
  write('img.bin', Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(' dueAfterPublish ')]));
  git('add', '-A'); git('commit', '-qm', 'base');
  write('build/out.js', 'dueAfterPublish();\n');
  write('src/draft.ts', 'dueAfterPublish(1, 2);\n');
  return { repo, git, write };
}
const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true });
// A folder's real name: on CI the temp folder is RUNNER~1 to Node and runneradmin to git (2026-11-13).
const real = (p) => fs.realpathSync.native(p).toLowerCase();
const fill = (file, map) => {
  let text = fs.readFileSync(file, 'utf8');
  for (const [n, outcome] of Object.entries(map)) text = text.replace(new RegExp(`^(${n}(?: \\((?:new|gone)\\))? · .*→).*$`, 'm'), `$1 ${outcome}`);
  fs.writeFileSync(file, text);
};

test('one place per name, product file and function, with its lines; tests listed apart; the header stores the search', () => {
  const { repo } = fixture();
  const out = path.join(root, 'list-1.md');
  const r = run(['--repo', repo, '--names', 'dueAfterPublish', '--out', out]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const text = fs.readFileSync(out, 'utf8');
  assert.match(text, /^Repo: .+$/m);
  assert.equal(real(/^Repo: (.+)$/m.exec(text)[1]), real(repo));
  assert.match(text, /^Names: dueAfterPublish$/m);
  assert.match(text, /^Searched: \d{4}-\d{2}-\d{2}T/m);
  const places = text.split(/\r?\n/).filter(l => /^P\d/.test(l));
  // A hit on a function's own definition line is that function's place; top-level hits are the file's.
  assert.deepEqual(places, [
    'P1 · dueAfterPublish · src/draft.ts · (file) · lines 1 → ',
    'P2 · dueAfterPublish · src/rules.ts · dueAfterPublish · lines 1 → ',
    'P3 · dueAfterPublish · src/schedule.ts · (file) · lines 1, 3 → ',
  ], 'untracked files count; ignored, binary and longer names do not');
  assert.match(text, /^Tests that mention it: src\/rules\.test\.ts$/m);
  assert.match(r.stdout, /PLACES: 3 place\(s\), 3 open/);
});

test('a second run keeps numbers and outcomes, marks new and gone places, and refreshes the lines', () => {
  const { repo, write } = fixture();
  const out = path.join(root, 'list-2.md');
  assert.equal(run(['--repo', repo, '--names', 'dueAfterPublish', '--out', out]).status, 0);
  fill(out, { P1: 'none: a draft file the user deletes before review', P3: 'C2' });
  fs.rmSync(path.join(repo, 'src/draft.ts'));
  write('src/schedule.ts', "// moved down\nimport { dueAfterPublish } from './rules';\nconst x = 1;\nif (dueAfterPublish(a, b)) x;\n");
  write('src/publish.ts', 'export const p = dueAfterPublishNow;\nif (dueAfterPublish(a, b)) p;\n');
  const again = run(['--repo', repo, '--names', 'dueAfterPublish', '--out', out]);
  assert.equal(again.status, 0, again.stderr);
  let places = fs.readFileSync(out, 'utf8').split(/\r?\n/).filter(l => /^P\d/.test(l));
  assert.deepEqual(places, [
    'P1 (gone) · dueAfterPublish · src/draft.ts · (file) · lines none → none: a draft file the user deletes before review',
    'P2 · dueAfterPublish · src/rules.ts · dueAfterPublish · lines 1 → ',
    'P3 · dueAfterPublish · src/schedule.ts · (file) · lines 2, 4 → C2',
    'P4 (new) · dueAfterPublish · src/publish.ts · (file) · lines 2 → ',
  ]);
  // --refresh runs the stored search again, with no names given.
  write('src/other.ts', 'dueAfterPublish(3, 4);\n');
  write('src/draft.ts', 'dueAfterPublish(1, 2);\n');
  const refresh = run(['--refresh', out]);
  assert.equal(refresh.status, 0, refresh.stderr);
  places = fs.readFileSync(out, 'utf8').split(/\r?\n/).filter(l => /^P\d/.test(l));
  assert.equal(places[0], 'P1 · dueAfterPublish · src/draft.ts · (file) · lines 1 → none: a draft file the user deletes before review', 'found again: no longer gone');
  assert.equal(places[4], 'P5 (new) · dueAfterPublish · src/other.ts · (file) · lines 1 → ');
  assert.equal(places.length, 5);
});

// 2026-11-13: 14 places in other components needed one outcome each, written by a hand-made script.
test('--close writes one outcome on many places: file: and name: fill open places only, P<n> replaces, a miss or a bad outcome is refused', () => {
  const { repo } = fixture();
  const out = path.join(root, 'list-close.md');
  assert.equal(run(['--repo', repo, '--names', 'dueAfterPublish', '--out', out]).status, 0);
  const placesNow = () => fs.readFileSync(out, 'utf8').split(/\r?\n/).filter(l => /^P\d/.test(l));
  const byFile = (f) => placesNow().find(l => l.includes(` · ${f} · `));
  let r = run(['--close', out, '--set', 'file:src/s*.ts=C1']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^CLOSED: 1 place\(s\) — file:src\/s\*\.ts → C1$/m);
  assert.match(byFile('src/schedule.ts'), /→ C1$/);
  r = run(['--close', out, '--set', 'name:dueAfterPublish=none: only a draft that never ships']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^CLOSED: 2 place\(s\) — name:dueAfterPublish → none: only a draft that never ships$/m);
  assert.match(r.stdout, /^PLACES: 3 place\(s\), 0 open/m);
  assert.match(byFile('src/schedule.ts'), /→ C1$/, 'name: does not overwrite a written outcome');
  const scheduleN = /^P(\d+)/.exec(byFile('src/schedule.ts'))[1];
  r = run(['--close', out, '--set', `P${scheduleN}=C2, C3`]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(byFile('src/schedule.ts'), /→ C2, C3$/, 'a P-number replaces the outcome');
  const before = fs.readFileSync(out, 'utf8');
  r = run(['--close', out, '--set', 'file:src/nothing.ts=C1']);
  assert.equal(r.status, 2, 'a selector that matches no open place is a usage error');
  assert.match(r.stderr, /no open place matches/);
  r = run(['--close', out, '--set', `P${scheduleN}=none: short`]);
  assert.equal(r.status, 2, 'an outcome --check would refuse is refused here too');
  assert.equal(fs.readFileSync(out, 'utf8'), before, 'a refused --close writes nothing');
  assert.equal(run(['--close', out]).status, 2, '--close needs a --set');
});

test('a name used in more than 40 product files is too wide, and a name with no hit is a spelling error', () => {
  const { repo, write } = fixture();
  for (let i = 0; i < 40; i++) write(`wide/f${i}.ts`, 'wideName();\n');
  write('wide/f.test.ts', 'wideName();\n');
  const out = path.join(root, 'list-3.md');
  assert.equal(run(['--repo', repo, '--names', 'wideName', '--out', out]).status, 0, '40 product files are fine; tests do not count');
  write('wide/f40.ts', 'wideName();\n');
  const wide = run(['--repo', repo, '--names', 'wideName', '--out', path.join(root, 'list-3b.md')]);
  assert.equal(wide.status, 2);
  assert.match(wide.stderr, /too wide: wideName is used in 41 files; name the rule, function, code or key instead/);
  const none = run(['--repo', repo, '--names', 'dueAfterPublish,dueMayEqualPublish', '--out', path.join(root, 'list-3c.md')]);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /no place uses dueMayEqualPublish: check the spelling/);
  assert.equal(fs.existsSync(path.join(root, 'list-3c.md')), false, 'nothing written on an error');
  assert.equal(run(['--repo', repo, '--out', path.join(root, 'x.md')]).status, 2, 'no names: usage error');
});

test('--check: every place not gone needs C<n> or none: <reason>; open places are named', () => {
  const { repo, write } = fixture();
  write('src/publish.ts', 'if (dueAfterPublish(a, b)) p;\n');
  write('src/other.ts', 'dueAfterPublish(3, 4);\n');
  const out = path.join(root, 'list-4.md');
  assert.equal(run(['--repo', repo, '--names', 'dueAfterPublish', '--out', out]).status, 0);
  // P1 draft, P2 other, P3 publish, P4 rules, P5 schedule
  fs.rmSync(path.join(repo, 'src/draft.ts'));
  assert.equal(run(['--refresh', out]).status, 0);
  fill(out, { P2: 'none: too short', P3: 'C9', P4: 'C2', P5: 'fixed it' });
  const checkFile = path.join(root, 'check-4.md');
  fs.writeFileSync(checkFile, '- [T1] one\n- [T1] two\n- [change] three\n');
  const r = run(['--check', out, '--check-lines', checkFile]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const open = r.stdout.split(/\r?\n/).filter(l => l.startsWith('OPEN:'));
  assert.equal(open.length, 3, r.stdout);
  assert.match(open[0], /^OPEN: P2 · dueAfterPublish · src\/other\.ts · \(file\) — the reason after none: needs at least 12 characters/);
  assert.match(open[1], /^OPEN: P3 · dueAfterPublish · src\/publish\.ts · \(file\) — C9 is not a check line \(C1\.\.C3\)/);
  assert.match(open[2], /^OPEN: P5 · dueAfterPublish · src\/schedule\.ts · \(file\)/);
  assert.doesNotMatch(r.stdout, /OPEN: P1/, 'a gone place needs no outcome');
  assert.match(r.stdout, /^PLACES: 4 place\(s\), 3 open$/m);
  // Without --check-lines any C<n> is taken.
  assert.equal(run(['--check', out]).stdout.split(/\r?\n/).filter(l => l.startsWith('OPEN:')).length, 2);
  fill(out, { P2: 'none: only reads the stored value for a log line', P3: 'C3', P5: 'C1, C2' });
  const ok = run(['--check', out, '--check-lines', checkFile]);
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /^PLACES: 4 place\(s\), 0 open$/m);
  assert.equal(run(['--check', path.join(root, 'missing.md')]).status, 2, 'a missing file is a usage error');
  fs.writeFileSync(path.join(root, 'not-places.md'), '# notes\n');
  assert.equal(run(['--check', path.join(root, 'not-places.md')]).status, 2, 'a file with no header is not a places list');
});

test('the list itself is not a place; a name only tests use gives no place; a name gone everywhere marks its places gone', () => {
  const { repo, write } = fixture();
  write('src/onlyTests.test.ts', 'testOnlyName();\n');
  const out = path.join(repo, 'notes', 'places.md');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const r = run(['--repo', repo, '--names', 'dueAfterPublish,testOnlyName', '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  const text = fs.readFileSync(out, 'utf8');
  assert.doesNotMatch(text, /notes\/places\.md · /, 'the list, untracked inside the repo, is not a place');
  assert.match(text, /## testOnlyName\n\nNo product file uses it\.\nTests that mention it: src\/onlyTests\.test\.ts/);
  write('src/rules.ts', 'export function renamed(due, publish) { return due > publish; }\n');
  write('src/schedule.ts', 'const x = 1;\n');
  fs.rmSync(path.join(repo, 'src/draft.ts'));
  fs.rmSync(path.join(repo, 'src/rules.test.ts'));
  const refresh = run(['--refresh', out, '--check', out]);
  assert.equal(refresh.status, 0, refresh.stdout + refresh.stderr);
  assert.equal(fs.readFileSync(out, 'utf8').split(/\r?\n/).filter(l => /^P\d+ \(gone\)/.test(l)).length, 3);
  assert.match(refresh.stdout, /^PLACES: 0 place\(s\), 0 open$/m);
});

// 2026-11-13: on CI the temp folder has a short spelling (RUNNER~1) while git names the long one. The same
// folder under two names is one folder, or the list counts itself as a place (PR #43 broke CI this way).
test('the list reached through another name of the repo folder is still not a place', () => {
  const { repo } = fixture();
  const link = path.join(root, 'alias-' + path.basename(repo));
  fs.symlinkSync(repo, link, process.platform === 'win32' ? 'junction' : 'dir');
  const out = path.join(link, 'notes', 'places.md');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const first = run(['--repo', repo, '--names', 'dueAfterPublish', '--out', out]);
  assert.equal(first.status, 0, first.stderr);
  const again = run(['--refresh', out, '--repo', repo]);
  assert.equal(again.status, 0, again.stderr);
  assert.doesNotMatch(fs.readFileSync(out, 'utf8'), /notes\/places\.md · /, 'the list, named through the other folder name, is not a place');
});

test('--refresh --repo searches another folder of the same repository (a task worktree)', () => {
  const { repo, git } = fixture();
  const out = path.join(root, 'list-6.md');
  assert.equal(run(['--repo', repo, '--names', 'dueAfterPublish', '--out', out]).status, 0);
  const tree = path.join(root, 'tree-6');
  git('worktree', 'add', '-q', tree);
  fs.writeFileSync(path.join(tree, 'src', 'late.ts'), 'dueAfterPublish(9, 9);\n');
  const r = run(['--refresh', out, '--repo', tree]);
  assert.equal(r.status, 0, r.stderr);
  const text = fs.readFileSync(out, 'utf8');
  assert.match(text, /^P\d+ \(new\) · dueAfterPublish · src\/late\.ts · \(file\) · lines 1 → $/m);
  assert.match(text, /^P1 \(gone\) · dueAfterPublish · src\/draft\.ts/m, 'the worktree has no untracked draft');
  assert.equal(real(/^Repo: (.+)$/m.exec(text)[1]), real(tree), 'the new folder is stored');
});

// 2026-11-12: one place per FILE let one outcome close every call in it. The original miss was two call
// sites of one rule in ONE file: the schedule path and the publish-now path of AssignmentService.cs.
const SERVICE = [
  'namespace App;',
  'public class AssignmentService',
  '{',
  '    public async Task CreateAsync(int id)',
  '    {',
  '        EnsurePublishInput(id);',
  '        Save();',
  '        EnsurePublishInput(id + 1);',
  '    }',
  '',
  '    public async Task PublishNowAsync(int id)',
  '    {',
  '        EnsurePublishInput(id);',
  '    }',
  '',
  '    private static void EnsurePublishInput(int id)',
  '    {',
  '    }',
  '}',
  '',
].join('\n');
const lineOf = (text) => fs.readFileSync(text, 'utf8').split(/\r?\n/).filter(l => /^P\d/.test(l));

test('two calls of one name in two methods of one C# file are two places, each with its own outcome', () => {
  const { repo, write } = fixture();
  write('Api/AssignmentService.cs', SERVICE);
  const out = path.join(root, 'list-7.md');
  assert.equal(run(['--repo', repo, '--names', 'EnsurePublishInput', '--out', out]).status, 0);
  assert.deepEqual(lineOf(out), [
    'P1 · EnsurePublishInput · Api/AssignmentService.cs · CreateAsync · lines 6, 8 → ',
    'P2 · EnsurePublishInput · Api/AssignmentService.cs · PublishNowAsync · lines 13 → ',
    'P3 · EnsurePublishInput · Api/AssignmentService.cs · EnsurePublishInput · lines 16 → ',
  ], 'two hits in one method are one place; the definition line is its own function\'s place');
  fill(out, { P1: 'C1', P3: 'none: the definition itself is the change' });
  const r = run(['--check', out]);
  assert.equal(r.status, 1, r.stdout);
  assert.deepEqual(r.stdout.split(/\r?\n/).filter(l => l.startsWith('OPEN:')), ['OPEN: P2 · EnsurePublishInput · Api/AssignmentService.cs · PublishNowAsync'],
    'the publish-now path is open although the schedule path in the same file is covered');
});

test('a TS file with a top-level use and a use inside a function gives a (file) place and a function place', () => {
  const { repo, write } = fixture();
  write('src/form.ts', "import { dueAfterPublish } from './rules';\nexport const FIRST = dueAfterPublish(1, 2);\nexport function onPublish(a, b) {\n  if (!dueAfterPublish(a, b)) return;\n}\n");
  const out = path.join(root, 'list-8.md');
  assert.equal(run(['--repo', repo, '--names', 'dueAfterPublish', '--out', out]).status, 0);
  const form = lineOf(out).filter(l => l.includes('src/form.ts'));
  assert.deepEqual(form.map(l => l.replace(/^P\d+ /, '')), [
    '· dueAfterPublish · src/form.ts · (file) · lines 1, 2 → ',
    '· dueAfterPublish · src/form.ts · onPublish · lines 4 → ',
  ]);
});

test('a refresh keeps number and outcome per function when lines move, marks a function that lost its hit gone, and adds a new one', () => {
  const { repo, write } = fixture();
  write('Api/AssignmentService.cs', SERVICE);
  const out = path.join(root, 'list-9.md');
  assert.equal(run(['--repo', repo, '--names', 'EnsurePublishInput', '--out', out]).status, 0);
  fill(out, { P1: 'C1', P2: 'C2', P3: 'none: the definition itself is the change' });
  write('Api/AssignmentService.cs', SERVICE
    .replace('namespace App;', 'using System;\nnamespace App;')
    .replace('        EnsurePublishInput(id);\n    }\n\n    private', '        Log(id);\n    }\n\n    public void ScheduleAsync(int id)\n    {\n        EnsurePublishInput(id);\n    }\n\n    private'));
  assert.equal(run(['--refresh', out]).status, 0);
  assert.deepEqual(lineOf(out), [
    'P1 · EnsurePublishInput · Api/AssignmentService.cs · CreateAsync · lines 7, 9 → C1',
    'P2 (gone) · EnsurePublishInput · Api/AssignmentService.cs · PublishNowAsync · lines none → C2',
    'P3 · EnsurePublishInput · Api/AssignmentService.cs · EnsurePublishInput · lines 22 → none: the definition itself is the change',
    'P4 (new) · EnsurePublishInput · Api/AssignmentService.cs · ScheduleAsync · lines 19 → ',
  ]);
});

// 2026-11-12 (real trial, AssignmentService.cs): CSharpier writes a long signature over several lines, `)` and
// `{` each alone, and an expression body under its `=>`. All three call sites fell into one (file) place.
test('C# methods with a signature over several lines, and expression-bodied members, are named too', () => {
  const { repo, write } = fixture();
  write('Api/Formatted.cs', [
    'public class AssignmentService',                                              // 1
    '{',                                                                          // 2
    '    public async Task<(AssignmentDto? Assignment, string? Error)> CreateAsync(', // 3
    '        CreateAssignmentDto dto,',                                            // 4
    '        CancellationToken cancellationToken = default',                       // 5
    '    )',                                                                      // 6
    '    {',                                                                      // 7
    '        if (dto.Now)',                                                       // 8
    '        {',                                                                  // 9
    '            EnsurePublishInput(dto);',                                        // 10
    '        }',                                                                  // 11
    '    }',                                                                      // 12
    '',                                                                           // 13
    '    public async Task<(AssignmentDto? Assignment, string? Error)> PublishNowAsync(', // 14
    '        long id',                                                            // 15
    '    )',                                                                      // 16
    '    {',                                                                      // 17
    '        await Strategy.ExecuteAsync(async () =>',                             // 18
    '        {',                                                                  // 19
    '            EnsurePublishInput(',                                             // 20
    '                null',                                                       // 21
    '            );',                                                             // 22
    '        });',                                                                // 23
    '    }',                                                                      // 24
    '',                                                                           // 25
    '    private static BadRequestException DeadlineAfterPublish() =>',            // 26
    '        new("Deadline must be after the publish date.", EnsurePublishInput);', // 27
    '',                                                                           // 28
    '    private const string Name = nameof(EnsurePublishInput);',                 // 29
    '}',                                                                          // 30
    '',
  ].join('\n'));
  const out = path.join(root, 'list-11.md');
  assert.equal(run(['--repo', repo, '--names', 'EnsurePublishInput', '--out', out]).status, 0);
  assert.deepEqual(lineOf(out), [
    'P1 · EnsurePublishInput · Api/Formatted.cs · CreateAsync · lines 10 → ',
    'P2 · EnsurePublishInput · Api/Formatted.cs · PublishNowAsync · lines 20 → ',
    'P3 · EnsurePublishInput · Api/Formatted.cs · DeadlineAfterPublish · lines 27 → ',
    'P4 · EnsurePublishInput · Api/Formatted.cs · (file) · lines 29 → ',
  ], 'a class field is the file\'s own place');
});

test('a place line in the old shape (no function part) is read as the file-level place of that file', () => {
  const { repo } = fixture();
  const out = path.join(root, 'list-10.md');
  fs.writeFileSync(out, [
    '# Places that use what this change touches', '', `Repo: ${repo.replace(/\\/g, '/')}`, 'Names: dueAfterPublish', 'Searched: 2026-11-12T08:00:00.000Z', '',
    '## dueAfterPublish', '',
    'P1 · dueAfterPublish · src/schedule.ts · lines 1, 3 → C1',
    'P2 · dueAfterPublish · src/rules.ts · lines 1 → C1',
    'P3 · dueAfterPublish · src/draft.ts · lines 1 → ', '',
  ].join('\n'));
  const before = run(['--check', out]);
  assert.match(before.stdout, /^OPEN: P3 · dueAfterPublish · src\/draft\.ts · \(file\)$/m);
  assert.equal(run(['--refresh', out]).status, 0);
  assert.deepEqual(lineOf(out), [
    'P1 · dueAfterPublish · src/schedule.ts · (file) · lines 1, 3 → C1',
    'P2 (gone) · dueAfterPublish · src/rules.ts · (file) · lines none → C1',
    'P3 · dueAfterPublish · src/draft.ts · (file) · lines 1 → ',
    'P4 (new) · dueAfterPublish · src/rules.ts · dueAfterPublish · lines 1 → ',
  ], 'the use inside a function is a new, open place: the old file-wide outcome does not close it');
});
