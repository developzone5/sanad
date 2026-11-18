// 2026-11-12: "before code, list every place that uses the rule or data you change, by search" was text
// only, and was skipped: a date rule was fixed on the "schedule" path and missed on the "publish now"
// path, and a teammate found it. places.mjs makes the list by search and checks every place has an outcome.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'places.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'places-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
// 2026-11-17: the git of these fixtures reads no config of this machine, and nothing here writes hook state
// outside the temp folder. Set once: every child process below inherits it.
fs.writeFileSync(path.join(root, 'empty.gitconfig'), '');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: path.join(root, 'empty.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', SANAD_STATE_DIR: path.join(root, 'state') });

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
  // 2026-11-14: each place a --set closed is named under it, so a wrong bulk reason is seen.
  assert.match(r.stdout, /^CLOSED: 1 place\(s\) — file:src\/s\*\.ts → C1\n {2}P\d+ · dueAfterPublish · src\/schedule\.ts · \(file\)$/m);
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

// 2026-11-18 (audit finding 9): the 41-file case is no longer refused (see the finding 9 test below); the rest of this test is kept.
test('a name used in more than 40 product files is listed with one place per file, and a name with no hit is a spelling error', () => {
  const { repo, write } = fixture();
  for (let i = 0; i < 40; i++) write(`wide/f${i}.ts`, 'wideName();\n');
  write('wide/f.test.ts', 'wideName();\n');
  const out = path.join(root, 'list-3.md');
  assert.equal(run(['--repo', repo, '--names', 'wideName', '--out', out]).status, 0, '40 product files are fine; tests do not count');
  write('wide/f40.ts', 'wideName();\n');
  const wide = run(['--repo', repo, '--names', 'wideName', '--out', path.join(root, 'list-3b.md')]);
  assert.equal(wide.status, 0, wide.stderr);
  assert.match(wide.stdout, /WIDE: wideName is used in 41 files/);
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
  // 2026-11-18 (audit finding 2): the three places have no outcome, so they stay open: the name may be renamed.
  assert.equal(refresh.status, 1, refresh.stdout + refresh.stderr);
  assert.equal(fs.readFileSync(out, 'utf8').split(/\r?\n/).filter(l => /^P\d+ \(gone\)/.test(l)).length, 3);
  assert.match(refresh.stdout, /^PLACES: 0 place\(s\), 3 open$/m);
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

// 2026-11-17 (audit, "distinct methods collapse into a single place"): hits were grouped by the bare function
// name, so the schedule path and the publish-now path of one file were ONE place again whenever both functions
// had the same name (Schedule.Apply and PublishNow.Apply), and so were two overloads. A place is one declaration.
const TWO_APPLY = [
  'public class Schedule {',       // 1
  '    public void Apply() {',     // 2
  '        DateRule.Validate();',  // 3
  '    }',                         // 4
  '}',                             // 5
  'public class PublishNow {',     // 6
  '    public void Apply() {',     // 7
  '        DateRule.Validate();',  // 8
  '    }',                         // 9
  '}',                             // 10
  '',
];
const OVERLOADS = [
  'public class Rules',                     // 1
  '{',                                      // 2
  '    public void Apply(int id)',          // 3
  '    {',                                  // 4
  '        Validate(id);',                  // 5
  '    }',                                  // 6
  '',                                       // 7
  '    public void Apply(string name)',     // 8
  '    {',                                  // 9
  '        Validate(name);',                // 10
  '    }',                                  // 11
  '}',                                      // 12
  '',
].join('\n');
const openLines = (r) => r.stdout.split(/\r?\n/).filter(l => l.startsWith('OPEN:'));

test('two functions with one name in one file are two places, each with its own outcome (audit: Schedule.Apply and PublishNow.Apply)', async () => {
  // The audit's input, through the grouping function itself: it gave [["Apply", [3, 8]]].
  const { byFunction } = await import(pathToFileURL(script).href);
  assert.deepEqual([...byFunction('Service.cs', [3, 8], TWO_APPLY)], [['Schedule.Apply', [3]], ['PublishNow.Apply', [8]]]);
  const { repo, write } = fixture();
  // Windows line ends: a declaration's line is the same line whatever ends it.
  write('Api/Service.cs', TWO_APPLY.join('\r\n'));
  const out = path.join(root, 'list-twins.md');
  assert.equal(run(['--repo', repo, '--names', 'Validate', '--out', out]).status, 0);
  assert.deepEqual(lineOf(out), [
    'P1 · Validate · Api/Service.cs · Schedule.Apply · lines 3 → ',
    'P2 · Validate · Api/Service.cs · PublishNow.Apply · lines 8 → ',
  ]);
  fill(out, { P1: 'C1' });
  const r = run(['--check', out]);
  assert.equal(r.status, 1, r.stdout);
  assert.deepEqual(openLines(r), ['OPEN: P2 · Validate · Api/Service.cs · PublishNow.Apply'], 'the outcome of the schedule path does not close the publish-now path');
});

test('overloads, and same-named functions with no type, are told apart by the line they start on; two handlers of one name by their component', () => {
  const { repo, write } = fixture();
  write('Api/Rules.cs', OVERLOADS);
  write('src/paths.ts', [
    'export const schedule = {',     // 1
    '  apply(a, b) {',               // 2
    '    return Validate(a, b);',    // 3
    '  },',                          // 4
    '};',                            // 5
    'export const publishNow = {',   // 6
    '  apply(a, b) {',               // 7
    '    return Validate(a, b);',    // 8
    '  },',                          // 9
    '};',                            // 10
    '',
  ].join('\n'));
  write('src/Forms.tsx', [
    'export function CreateForm() {',    // 1
    '  const handleSubmit = () => {',    // 2
    '    Validate(1);',                  // 3
    '  };',                              // 4
    '  return null;',                    // 5
    '}',                                 // 6
    'export function EditForm() {',      // 7
    '  const handleSubmit = () => {',    // 8
    '    Validate(2);',                  // 9
    '  };',                              // 10
    '  return null;',                    // 11
    '}',                                 // 12
    '',
  ].join('\n'));
  const out = path.join(root, 'list-overloads.md');
  assert.equal(run(['--repo', repo, '--names', 'Validate', '--out', out]).status, 0);
  assert.deepEqual(lineOf(out), [
    'P1 · Validate · Api/Rules.cs · Rules.Apply(int id) · lines 5 → ',
    'P2 · Validate · Api/Rules.cs · Rules.Apply(string name) · lines 10 → ',
    'P3 · Validate · src/Forms.tsx · CreateForm.handleSubmit · lines 3 → ',
    'P4 · Validate · src/Forms.tsx · EditForm.handleSubmit · lines 9 → ',
    'P5 · Validate · src/paths.ts · apply(a, b) (line 2) · lines 3 → ',
    'P6 · Validate · src/paths.ts · apply(a, b) (line 7) · lines 8 → ',
  ]);
  // Each of the six is closed alone: --close by number, and a check that still names the other five.
  const closed = run(['--close', out, '--set', 'P2=C1']);
  assert.equal(closed.status, 0, closed.stdout + closed.stderr);
  assert.match(closed.stdout, /^ {2}P2 · Validate · Api\/Rules\.cs · Rules\.Apply\(string name\)$/m);
  assert.deepEqual(openLines(run(['--check', out])).map(l => l.slice(0, 9)), ['OPEN: P1 ', 'OPEN: P3 ', 'OPEN: P4 ', 'OPEN: P5 ', 'OPEN: P6 ']);
});

test('a list from before one place was one declaration: a place that was two functions is gone, both are open and say why; a place that is still one function keeps its number and outcome', () => {
  const { repo, write } = fixture();
  write('Api/Service.cs', TWO_APPLY.join('\n'));
  // In Other.cs only Schedule.Apply uses Stamp: its old place `Apply` is still exactly one declaration.
  write('Api/Other.cs', TWO_APPLY.join('\n').replace('DateRule.Validate();', 'Clock.Stamp();').replace('DateRule.Validate();', 'Log();'));
  const out = path.join(root, 'list-before.md');
  // The list as places.mjs wrote it before 2026-11-17: one place per function name.
  fs.writeFileSync(out, [
    '# Places that use what this change touches', '', `Repo: ${repo.replace(/\\/g, '/')}`, 'Names: Validate, Stamp', 'Searched: 2026-11-16T08:00:00.000Z', '',
    '## Validate', '',
    'P1 · Validate · Api/Service.cs · Apply · lines 3, 8 → C1', 'Tests that mention it: none', '',
    '## Stamp', '',
    'P2 · Stamp · Api/Other.cs · Apply · lines 3 → C2', 'Tests that mention it: none', '',
  ].join('\n'));
  const refresh = run(['--refresh', out]);
  assert.equal(refresh.status, 0, refresh.stdout + refresh.stderr);
  assert.deepEqual(lineOf(out), [
    'P1 (gone) · Validate · Api/Service.cs · Apply · lines none → C1',
    'P3 (new) · Validate · Api/Service.cs · Schedule.Apply · lines 3 → ',
    'P4 (new) · Validate · Api/Service.cs · PublishNow.Apply · lines 8 → ',
    'P2 · Stamp · Api/Other.cs · Schedule.Apply · lines 3 → C2',
  ], 'the outcome of the split place stays on its gone line and closes neither function; the unsplit place keeps C2');
  const why = [
    'OPEN: P3 · Validate · Api/Service.cs · Schedule.Apply — split from P1 (Apply → C1): 2 functions named Apply use Validate in this file, and each is its own place with its own outcome',
    'OPEN: P4 · Validate · Api/Service.cs · PublishNow.Apply — split from P1 (Apply → C1): 2 functions named Apply use Validate in this file, and each is its own place with its own outcome',
  ];
  // The run that splits the place says why, and so does every check until each function has its outcome.
  assert.deepEqual(openLines(refresh), why);
  assert.match(refresh.stdout, /^PLACES: 3 place\(s\), 2 open — refreshed /m);
  const check = run(['--refresh', out, '--check', out]);
  assert.equal(check.status, 1, check.stdout);
  assert.deepEqual(openLines(check), why);
  fill(out, { P3: 'C1' });
  assert.deepEqual(openLines(run(['--check', out])), [why[1]]);
  fill(out, { P4: 'none: publish now takes no date from the user' });
  const ok = run(['--refresh', out, '--check', out]);
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /^PLACES: 3 place\(s\), 0 open$/m);
  assert.equal(lineOf(out)[0], 'P1 (gone) · Validate · Api/Service.cs · Apply · lines none → C1');
});

test('a refresh keeps each same-named place with its number and outcome when lines move or its twin goes, and never moves an outcome to the twin', () => {
  const { repo, write } = fixture();
  write('Api/Rules.cs', OVERLOADS);
  write('Api/Service.cs', TWO_APPLY.join('\n'));
  const out = path.join(root, 'list-moved.md');
  assert.equal(run(['--repo', repo, '--names', 'Validate', '--out', out]).status, 0);
  fill(out, { P1: 'C1', P2: 'C2', P3: 'C3', P4: 'none: publish now takes no date from the user' });
  // Five lines above both overloads, as many as lie between them: the first now starts on the line the label of
  // the second names, and each still keeps its own outcome. The class PublishNow leaves Service.cs, so one
  // Apply is left there.
  write('Api/Rules.cs', 'using System;\nusing System.Linq;\nusing System.Text;\n\nnamespace App;\n' + OVERLOADS);
  write('Api/Service.cs', TWO_APPLY.slice(0, 5).join('\n') + '\n');
  assert.equal(run(['--refresh', out]).status, 0);
  assert.deepEqual(lineOf(out), [
    'P1 · Validate · Api/Rules.cs · Rules.Apply(int id) · lines 10 → C1',
    'P2 · Validate · Api/Rules.cs · Rules.Apply(string name) · lines 15 → C2',
    'P3 · Validate · Api/Service.cs · Apply · lines 3 → C3',
    'P4 (gone) · Validate · Api/Service.cs · PublishNow.Apply · lines none → none: publish now takes no date from the user',
  ]);
  // The call leaves the second overload and the first keeps its own: no line moved, so the place of the second
  // is gone and its outcome is not handed to the first.
  const lone = path.join(root, 'list-twin.md');
  write('Api/Twin.cs', OVERLOADS.replace('Validate(id);', 'Log(id);').replace('Validate(name);', 'Stamp(name);'));
  assert.equal(run(['--repo', repo, '--names', 'Stamp', '--out', lone]).status, 0);
  assert.deepEqual(lineOf(lone), ['P1 · Stamp · Api/Twin.cs · Rules.Apply(string name) · lines 10 → ']);
  fill(lone, { P1: 'C1' });
  write('Api/Twin.cs', OVERLOADS.replace('Validate(id);', 'Stamp(id);').replace('Validate(name);', 'Log(name);'));
  assert.equal(run(['--refresh', lone]).status, 0);
  assert.deepEqual(lineOf(lone), [
    'P1 (gone) · Stamp · Api/Twin.cs · Rules.Apply(string name) · lines none → C1',
    'P2 (new) · Stamp · Api/Twin.cs · Rules.Apply(int id) · lines 5 → ',
  ]);
  // The call goes back to the second overload and a line is added above: an overload is told by its parameter
  // list, not its line, so the place of the string overload is itself again with its own outcome, and the
  // outcome of the int overload is not handed to it.
  fill(lone, { P2: 'C2' });
  write('Api/Twin.cs', '// moved\n' + OVERLOADS.replace('Validate(id);', 'Log(id);').replace('Validate(name);', 'Stamp(name);'));
  assert.equal(run(['--refresh', lone]).status, 0);
  assert.deepEqual(lineOf(lone), [
    'P1 · Stamp · Api/Twin.cs · Rules.Apply(string name) · lines 11 → C1',
    'P2 (gone) · Stamp · Api/Twin.cs · Rules.Apply(int id) · lines none → C2',
  ]);
});

// 2026-11-17 (audit, bug-detection 3): overloads were told apart by their start line, so a new or replaced
// overload took over the outcome written for another one, and reordering swapped them.
test('a new, a replaced or a reordered overload never takes over the outcome written for another overload', () => {
  const { repo, write } = fixture();
  const part = (sig, arg) => [`    public void Apply(${sig})`, '    {', `        Validate(${arg});`, '    }', ''];
  const INT = part('int id', 'id'), STR = part('string name', 'name'), BOOL = part('bool on', 'on');
  const rules = (...parts) => ['public class Rules', '{', ...parts.flat(), '}', ''].join('\n');
  const start = (name) => {
    write('Api/Rules.cs', rules(INT, STR));
    const list = path.join(root, name);
    assert.equal(run(['--repo', repo, '--names', 'Validate', '--out', list]).status, 0);
    assert.equal(run(['--close', list, '--set', 'P1=C1', '--set', 'P2=C2']).status, 0);
    return list;
  };
  // 1. A bool overload is added above both: the two outcomes stay with their overloads, the new one is open.
  let list = start('list-insert.md');
  write('Api/Rules.cs', rules(BOOL, INT, STR));
  let r = run(['--refresh', list, '--check', list]);
  assert.equal(r.status, 1, r.stdout);
  assert.deepEqual(lineOf(list), [
    'P1 · Validate · Api/Rules.cs · Rules.Apply(int id) · lines 10 → C1',
    'P2 · Validate · Api/Rules.cs · Rules.Apply(string name) · lines 15 → C2',
    'P3 (new) · Validate · Api/Rules.cs · Rules.Apply(bool on) · lines 5 → ',
  ]);
  assert.deepEqual(openLines(r), ['OPEN: P3 · Validate · Api/Rules.cs · Rules.Apply(bool on)']);
  // 2. The int overload is replaced by a bool one below the string one (same count of overloads).
  list = start('list-replace.md');
  write('Api/Rules.cs', rules(STR, BOOL));
  r = run(['--refresh', list, '--check', list]);
  assert.equal(r.status, 1, r.stdout);
  assert.deepEqual(lineOf(list), [
    'P1 (gone) · Validate · Api/Rules.cs · Rules.Apply(int id) · lines none → C1',
    'P2 · Validate · Api/Rules.cs · Rules.Apply(string name) · lines 5 → C2',
    'P3 (new) · Validate · Api/Rules.cs · Rules.Apply(bool on) · lines 10 → ',
  ]);
  assert.deepEqual(openLines(r), ['OPEN: P3 · Validate · Api/Rules.cs · Rules.Apply(bool on)']);
  // 3. The two overloads swap places: each keeps its outcome.
  list = start('list-reorder.md');
  write('Api/Rules.cs', rules(STR, INT));
  r = run(['--refresh', list, '--check', list]);
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(lineOf(list), [
    'P1 · Validate · Api/Rules.cs · Rules.Apply(int id) · lines 10 → C1',
    'P2 · Validate · Api/Rules.cs · Rules.Apply(string name) · lines 5 → C2',
  ]);
});

test('a closed place stays closed when a line is added above it, although a same-named twin in its scope does not use the name (audit: AssignmentVisibility.IsLive)', () => {
  const { repo, write } = fixture();
  const live = (extra = '') => extra + [
    'public static class Visibility', '{',
    '    public static bool IsLive(int id)', '    {', '        return id > 0;', '    }', '',
    '    public static bool IsLive(string name)', '    {', '        return Status(name) == 1;', '    }', '}', '',
  ].join('\n');
  write('Api/Visibility.cs', live());
  const list = path.join(root, 'list-twin-unrelated.md');
  assert.equal(run(['--repo', repo, '--names', 'Status', '--out', list]).status, 0);
  assert.deepEqual(lineOf(list), ['P1 · Status · Api/Visibility.cs · Visibility.IsLive(string name) · lines 10 → ']);
  assert.equal(run(['--close', list, '--set', 'name:Status=C1']).status, 0);
  write('Api/Visibility.cs', live('using System.Globalization;\n'));
  const r = run(['--refresh', list, '--check', list]);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^PLACES: 1 place\(s\), 0 open$/m);
  assert.deepEqual(lineOf(list), ['P1 · Status · Api/Visibility.cs · Visibility.IsLive(string name) · lines 11 → C1']);
});

// ---- 2026-11-18 (audit of the release): findings 2, 3, 8 and 9 ----

test('finding 2: a name renamed in every file leaves its places gone with no outcome: they stay open until none: <reason> is written; with outcomes written they stay closed', () => {
  const { repo, write } = fixture();
  const out = path.join(root, 'list-rename.md');
  assert.equal(run(['--repo', repo, '--names', 'dueAfterPublish', '--out', out]).status, 0);
  for (const f of ['src/rules.ts', 'src/schedule.ts']) write(f, fs.readFileSync(path.join(repo, f), 'utf8').replace(/dueAfterPublish/g, 'dueAfterPublishWindow'));
  fs.rmSync(path.join(repo, 'src/draft.ts'));
  const r = run(['--refresh', out, '--check', out]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^OPEN: P1 · dueAfterPublish · src\/draft\.ts · \(file\) — no longer found: add its new name with --names/m);
  assert.match(r.stdout, /^PLACES: 0 place\(s\), 3 open$/m);
  fill(out, { P1: 'none: the draft file was removed on purpose', P2: 'none: renamed to dueAfterPublishWindow', P3: 'none: renamed to dueAfterPublishWindow' });
  const ok = run(['--check', out]);
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /^PLACES: 0 place\(s\), 0 open$/m);
  // The new name, added, is listed as its own places.
  const added = run(['--repo', repo, '--names', 'dueAfterPublishWindow', '--out', out]);
  assert.equal(added.status, 0, added.stderr);
});

test('finding 2, must not change: one place of a name that has others lost its file: it is gone and needs no outcome', () => {
  const { repo } = fixture();
  const out = path.join(root, 'list-one-gone.md');
  assert.equal(run(['--repo', repo, '--names', 'dueAfterPublish', '--out', out]).status, 0);
  fs.rmSync(path.join(repo, 'src/draft.ts'));
  fill(out, { P2: 'C1', P3: 'C1' });
  const r = run(['--refresh', out, '--check', out]);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^PLACES: 2 place\(s\), 0 open$/m);
});

const API_TS = [
  'export const assignmentsApi = {',                                            // 1
  '  create: (body: { dueDate: string }) => api.post("/a", body),',            // 2
  '  schedule: (id: number, dueDate: string) => api.put("/s", { dueDate }),',   // 3
  '  publishNow: (id: number, dueDate: string) => {',                           // 4
  '    return api.post("/p", { dueDate });',                                    // 5
  '  },',                                                                        // 6
  '};',                                                                          // 7
  '',
].join('\n');
const CONTROLLER = [
  'public class HomeworkController : ControllerBase',   // 1
  '{',                                                  // 2
  '    [HttpPost]',                                     // 3
  '    [Authorize(Policy = Policies.TeacherOrAdmin)]',  // 4
  '    public IActionResult Create()',                  // 5
  '    {',                                              // 6
  '        return Ok();',                               // 7
  '    }',                                              // 8
  '',                                                   // 9
  '    [Authorize(Policy = Policies.TeacherOrAdmin)]',  // 10
  '    public IActionResult PublishNow() { return Ok(); }', // 11
  '',                                                   // 12
  '    [Authorize(Policy = Policies.TeacherOrAdmin)]',  // 13
  '    [HttpDelete]',                                   // 14
  '    public IActionResult Delete() { return Ok(); }', // 15
  '}',                                                  // 16
  '',
].join('\n');

test('finding 3: an attribute line belongs to the method under it: three actions of one controller are three places', () => {
  const { repo, write } = fixture();
  write('Api/Controllers/HomeworkController.cs', CONTROLLER);
  const out = path.join(root, 'list-attr.md');
  assert.equal(run(['--repo', repo, '--names', 'TeacherOrAdmin', '--out', out]).status, 0);
  assert.deepEqual(lineOf(out), [
    'P1 · TeacherOrAdmin · Api/Controllers/HomeworkController.cs · Create · lines 4 → ',
    'P2 · TeacherOrAdmin · Api/Controllers/HomeworkController.cs · PublishNow · lines 10 → ',
    'P3 · TeacherOrAdmin · Api/Controllers/HomeworkController.cs · Delete · lines 13 → ',
  ]);
  // One outcome closes one action only.
  fill(out, { P1: 'C1' });
  const r = run(['--check', out]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^PLACES: 3 place\(s\), 2 open$/m);
});

test('finding 3: the members of an exported API object are their own places; a top-level call stays the file\'s own place', () => {
  const { repo, write } = fixture();
  write('src/api/assignments.ts', API_TS);
  const out = path.join(root, 'list-members.md');
  assert.equal(run(['--repo', repo, '--names', 'dueDate', '--out', out]).status, 0);
  assert.deepEqual(lineOf(out), [
    'P1 · dueDate · src/api/assignments.ts · assignmentsApi.create · lines 2 → ',
    'P2 · dueDate · src/api/assignments.ts · assignmentsApi.schedule · lines 3 → ',
    'P3 · dueDate · src/api/assignments.ts · assignmentsApi.publishNow · lines 4, 5 → ',
  ]);
  // Same labels after a line is added above them: numbers and outcomes stay.
  fill(out, { P1: 'C1', P2: 'C2' });
  write('src/api/assignments.ts', '// header\n' + API_TS);
  assert.equal(run(['--refresh', out]).status, 0);
  assert.deepEqual(lineOf(out), [
    'P1 · dueDate · src/api/assignments.ts · assignmentsApi.create · lines 3 → C1',
    'P2 · dueDate · src/api/assignments.ts · assignmentsApi.schedule · lines 4 → C2',
    'P3 · dueDate · src/api/assignments.ts · assignmentsApi.publishNow · lines 5, 6 → ',
  ]);
});

test('finding 3: C# properties of two DTOs in one file are two places', () => {
  const { repo, write } = fixture();
  write('Api/Dtos.cs', [
    'public class CreateDto', '{', '    public DateTime? DueDate { get; set; }', '}',
    'public class UpdateDto', '{', '    public DateTime? DueDate { get; set; }', '}', '',
  ].join('\n'));
  const out = path.join(root, 'list-props.md');
  assert.equal(run(['--repo', repo, '--names', 'DueDate', '--out', out]).status, 0);
  assert.deepEqual(lineOf(out), [
    'P1 · DueDate · Api/Dtos.cs · CreateDto.DueDate · lines 3 → ',
    'P2 · DueDate · Api/Dtos.cs · UpdateDto.DueDate · lines 7 → ',
  ]);
});

test('finding 3, must not change: top-level hits, a class-level attribute and a plain call stay the file\'s own place', () => {
  const { repo, write } = fixture();
  write('Api/Policies.cs', '[Authorize(Policy = Policies.TeacherOrAdmin)]\npublic class HomeController : ControllerBase\n{\n}\n');
  const out = path.join(root, 'list-toplevel.md');
  assert.equal(run(['--repo', repo, '--names', 'TeacherOrAdmin,dueAfterPublish', '--out', out]).status, 0);
  assert.deepEqual(lineOf(out).filter(l => /TeacherOrAdmin/.test(l)), ['P1 · TeacherOrAdmin · Api/Policies.cs · (file) · lines 1 → ']);
  assert.ok(lineOf(out).includes('P2 · dueAfterPublish · src/draft.ts · (file) · lines 1 → '));
});

test('finding 8: an outcome does not move to another class\'s method of the same name', () => {
  const { repo, write } = fixture();
  write('src/Rules.cs', ['public class Schedule {', '    public void Apply() {', '        DateRule.Check(h);', '    }', '}', ''].join('\n'));
  const out = path.join(root, 'list-move-class.md');
  assert.equal(run(['--repo', repo, '--names', 'DateRule', '--out', out]).status, 0);
  assert.deepEqual(lineOf(out), ['P1 · DateRule · src/Rules.cs · Apply · lines 3 → ']);
  fill(out, { P1: 'C1' });
  write('src/Rules.cs', ['public class Schedule {', '    public void Apply() {', '        Other();', '    }', '}',
    'public class PublishNow {', '    public void Apply() {', '        DateRule.Check(h);', '    }', '}', ''].join('\n'));
  const r = run(['--refresh', out, '--check', out]);
  assert.equal(r.status, 1, r.stdout);
  assert.deepEqual(lineOf(out), [
    'P1 (gone) · DateRule · src/Rules.cs · Apply · lines none → C1',
    'P2 (new) · DateRule · src/Rules.cs · PublishNow.Apply · lines 8 → ',
  ]);
  assert.match(r.stdout, /^OPEN: P2 · DateRule · src\/Rules\.cs · PublishNow\.Apply/m);
});

// 2026-11-18 (audit): past the file limit the list is the same as below it: one place per declaration.
test('a wide name keeps one place per declaration: two functions of one file are two places, as below the limit', () => {
  const { repo, write } = fixture();
  for (let i = 0; i < 41; i++) write(`wide/f${i}.ts`, 'export function run() {\n  pageSize();\n}\n');
  write('wide/two.ts', 'export function schedule() {\n  pageSize();\n}\nexport function publishNow() {\n  pageSize();\n}\n');
  const out = path.join(root, 'list-wide-two.md');
  const r = run(['--repo', repo, '--names', 'pageSize', '--out', out]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const rows = lineOf(out);
  assert.equal(rows.length, 43, rows.join('\n'));
  assert.ok(rows.some(x => /wide\/two\.ts · schedule · lines 2 →/.test(x)), rows.join('\n'));
  assert.ok(rows.some(x => /wide\/two\.ts · publishNow · lines 5 →/.test(x)), rows.join('\n'));
  const c = run(['--close', out, '--set', 'file:wide/two.ts=none: only the schedule path was looked at']);
  assert.match(c.stdout, /CLOSED: 2 place\(s\)/, 'a file: set still fills both: the user chose that');
  assert.match(c.stdout, /PLACES: 43 place\(s\), 41 open/);
  assert.match(r.stdout, /WIDE: pageSize is used in 42 files/);
  const out2 = path.join(root, 'list-wide-two-b.md');
  run(['--repo', repo, '--names', 'pageSize', '--out', out2]);
  const one = run(['--close', out2, '--set', 'P42=none: schedule only']);
  assert.match(one.stdout, /PLACES: 43 place\(s\), 42 open/, 'closing the schedule place leaves publishNow open');
});

test('finding 9: a name used in more than 40 files is never refused: it is listed as any name is', () => {
  const { repo, write } = fixture();
  for (let i = 0; i < 41; i++) write(`wide/f${i}.ts`, 'export function run() {\n  pageSize();\n}\n');
  const out = path.join(root, 'list-wide.md');
  const r = run(['--repo', repo, '--names', 'pageSize', '--out', out]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const rows = lineOf(out);
  assert.equal(rows.length, 41);
  assert.equal(rows[0], 'P1 · pageSize · wide/f0.ts · run · lines 2 → ');
  assert.match(r.stdout, /WIDE: pageSize is used in 41 files \(more than 40\): one place per declaration/);
  // One --set closes all of them.
  const c = run(['--close', out, '--set', 'name:pageSize=none: the page size is read, not changed']);
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.match(c.stdout, /PLACES: 41 place\(s\), 0 open/);
});

// ---- 2026-11-18 (audit, repair round): rename with a leftover mention, and common declarations that were one (file) place ----
function mini(files) {
  const repo = fs.mkdtempSync(path.join(root, 'mini-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'core.autocrlf', 'false');
  const write = (n, t) => { fs.mkdirSync(path.dirname(path.join(repo, n)), { recursive: true }); fs.writeFileSync(path.join(repo, n), t); };
  for (const [n, t] of Object.entries(files)) write(n, t);
  git('add', '-A'); git('commit', '-qm', 'base');
  return { repo, write, git };
}
const placeRows = (file) => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => /^P\d/.test(l));

test('audit 4: a renamed name with one leftover mention (a spec text) still leaves its gone places open; a gone place with an outcome needs nothing', () => {
  const { repo, write } = mini({
    'web/src/rules.ts': 'export const LATE_GRACE = 5;\n',
    'web/src/report1.ts': "import { LATE_GRACE } from './rules';\nexport const r1 = LATE_GRACE;\n",
    'web/src/report2.ts': "import { LATE_GRACE } from './rules';\nexport const r2 = LATE_GRACE;\n",
    'specs/late.md': 'A hand-in is late after LATE_GRACE minutes.\n',
  });
  const out = path.join(root, 'list-a4.md');
  assert.equal(run(['--repo', repo, '--names', 'LATE_GRACE', '--out', out]).status, 0);
  assert.equal(run(['--close', out, '--set', 'file:specs/late.md=none: the spec text only names the constant', '--set', 'file:web/src/report1.ts=C1']).status, 0);
  write('web/src/rules.ts', 'export const LATE_GRACE_MINUTES = 9;\n');
  write('web/src/report1.ts', "import { LATE_GRACE_MINUTES } from './rules';\nexport const r1 = LATE_GRACE_MINUTES;\n");
  write('web/src/report2.ts', "import { LATE_GRACE_MINUTES } from './rules';\nexport const r2 = LATE_GRACE_MINUTES;\n");
  const r = run(['--refresh', out, '--repo', repo, '--check', out]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /OPEN: P\d+ · LATE_GRACE · web\/src\/rules\.ts · \(file\) — no longer found/);
  assert.match(r.stdout, /OPEN: P\d+ · LATE_GRACE · web\/src\/report2\.ts/, 'a gone place with no outcome is open whatever else is live');
  assert.doesNotMatch(r.stdout, /OPEN: P\d+ · LATE_GRACE · web\/src\/report1\.ts/, 'a gone place that has its outcome is closed');
});

test('audit 5a: a C# method with no access modifier, and an explicit interface method, are places of their own', () => {
  const { repo, write } = mini({
    'src/Rules.cs': 'class Schedule\n{\n    void Apply(H h)\n    {\n        DateRule.Check(h);\n    }\n}\n',
    'src/Other.cs': 'class Other : IRule\n{\n    void IRule.Apply(H h) => DateRule.Check(h);\n    void Keep(H h) { DateRule.Check(h); }\n}\n',
  });
  const out = path.join(root, 'list-a5a.md');
  assert.equal(run(['--repo', repo, '--names', 'DateRule', '--out', out]).status, 0);
  assert.deepEqual(placeRows(out).map(l => l.split(' · ')[3]), ['Other.Apply', 'Other.Keep', 'Schedule.Apply']);
  assert.equal(run(['--close', out, '--set', 'name:DateRule=C1']).status, 0);
  // Schedule.Apply is changed to save, and PublishNow.Apply takes over the rule: C1 was written for Schedule.Apply.
  write('src/Rules.cs', 'class Schedule\n{\n    void Apply(H h)\n    {\n        Save(h);\n    }\n}\nclass PublishNow\n{\n    void Apply(H h)\n    {\n        DateRule.Check(h);\n    }\n}\n');
  const r = run(['--refresh', out, '--repo', repo, '--check', out]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /OPEN: P\d+ \(?[^\n]*DateRule · src\/Rules\.cs · PublishNow\.Apply/, 'the new class is its own open place');
});

test('audit 5b: class fields with arrow functions and one-line class methods are places of their own', () => {
  const { repo } = mini({
    'src/api/cls.ts': 'export class AssignmentsApi {\n  create = (dueDate: string) => post(dueDate);\n  schedule = async (dueDate: string) => {\n    return post2(dueDate);\n  };\n  update(dueDate: string) { return post3(dueDate); }\n}\n',
  });
  const out = path.join(root, 'list-a5b.md');
  assert.equal(run(['--repo', repo, '--names', 'dueDate', '--out', out]).status, 0);
  assert.deepEqual(placeRows(out).map(l => l.split(' · ')[3]), ['AssignmentsApi.create', 'AssignmentsApi.schedule', 'AssignmentsApi.update']);
});

test('audit 5, must not change: public methods, statements inside a method and object members keep their rows', () => {
  const { repo } = mini({
    'src/Svc.cs': 'class Svc\n{\n    public void Schedule(H h)\n    {\n        var x = Make(h);\n        DateRule.Check(h);\n        return;\n    }\n    public void Publish(H h)\n    {\n        DateRule.Check(h);\n    }\n}\n',
    'src/api.ts': 'export const api = {\n  create: (dueDate: string) => post(dueDate),\n};\nexport function top(dueDate: string) {\n  return dueDate;\n}\n',
  });
  const out = path.join(root, 'list-a5c.md');
  assert.equal(run(['--repo', repo, '--names', 'DateRule,dueDate', '--out', out]).status, 0);
  assert.deepEqual(placeRows(out).map(l => l.split(' · ')[3]), ['Schedule', 'Publish', 'api.create', 'top']);
});
