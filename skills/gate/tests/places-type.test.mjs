// 2026-11-19 (release 19b): TryParse, Failed and UpdateAsync gave 439 rows on one task, and 377 of them were closed
// as "none": the bare word matched every other type's member. A name written Type.Member lists as places only the
// uses in files that name its type, a derived type or its interface; every other use is folded under one counted
// line, kept in a file beside the list, and comes back with --unfold. No tool removes or closes a place.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'places.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'places-type-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
// The git of these fixtures reads no config of this machine, and nothing here writes hook state outside the temp folder.
fs.writeFileSync(path.join(root, 'empty.gitconfig'), '');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: path.join(root, 'empty.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', SANAD_STATE_DIR: path.join(root, 'state') });

const cs = (...lines) => ['namespace App;', ...lines, ''].join('\n');
const OTHERS = [1, 2, 3, 4, 5].map(i => `src/Other${i}Service.cs`);
const OWN = ['src/AdminJob.cs', 'src/IRoleService.cs', 'src/RoleService.Extra.cs', 'src/RoleService.cs', 'src/RolesController.cs'];
const NONE = 'none: a fixture place, nothing to test here';

// RoleService.UpdateAsync, reached four ways: in its own file, in a partial class file, through its interface only
// (RolesController) and through a derived class only (AdminJob). Five other types have an UpdateAsync of their own,
// and Hidden calls one on a value whose type it never names.
function fixture() {
  const repo = fs.mkdtempSync(path.join(root, 'repo-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (n, t) => { fs.mkdirSync(path.dirname(path.join(repo, n)), { recursive: true }); fs.writeFileSync(path.join(repo, n), t); };
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'core.autocrlf', 'false');
  write('src/RoleService.cs', cs('public partial class RoleService : BaseService, IRoleService', '{', '    public async Task UpdateAsync(int id)', '    {', '        await Task.CompletedTask;', '    }', '}'));
  write('src/RoleService.Extra.cs', cs('public partial class RoleService', '{', '    public Task Touch()', '    {', '        return UpdateAsync(1);', '    }', '}'));
  write('src/IRoleService.cs', cs('public interface IRoleService', '{', '    Task UpdateAsync(int id);', '}'));
  write('src/RolesController.cs', cs('public class RolesController', '{', '    private readonly IRoleService _roles;', '    public Task Put()', '    {', '        return _roles.UpdateAsync(1);', '    }', '}'));
  write('src/AdminRoleService.cs', cs('public class AdminRoleService : RoleService', '{', '}'));
  write('src/AdminJob.cs', cs('public class AdminJob', '{', '    private readonly AdminRoleService _svc;', '    public Task Run()', '    {', '        return _svc.UpdateAsync(2);', '    }', '}'));
  OTHERS.forEach((file, i) => write(file, cs(`public class Other${i + 1}Service`, '{', '    public Task UpdateAsync(int id)', '    {', '        return Task.CompletedTask;', '    }', '    public Task Go()', '    {', '        return UpdateAsync(1);', '    }', '}')));
  write('src/Hidden.cs', cs('public class Hidden', '{', '    public Task Go(dynamic factory)', '    {', '        var x = factory.Create();', '        return x.UpdateAsync(3);', '    }', '}'));
  git('add', '-A'); git('commit', '-qm', 'base');
  return { repo, git, write };
}
const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true });
const read = (file) => fs.readFileSync(file, 'utf8');
const said = (r) => String(r.stdout).split(/\r?\n/);
// The list's place lines as { n, mark, name, file, uses, outcome }.
const places = (out) => read(out).split(/\r?\n/).filter(l => /^P\d/.test(l)).map((l) => {
  const [head, name, file] = l.split(' · ');
  const m = /^P(\d+)(?: \((\w+)\))?$/.exec(head);
  const tail = /· lines ([^→]*?) ?→ ?(.*)$/.exec(l);
  return { n: Number(m[1]), mark: m[2] || '', name, file, uses: (tail[1].match(/\d+/g) || []).length, outcome: tail[2] };
});
const folds = (out) => read(out).split(/\r?\n/).filter(l => /^F\d/.test(l));
const F1 = 'F1 · RoleService.UpdateAsync · other type · 11 use(s) in 6 file(s) · e.g. src/Hidden.cs, src/Other1Service.cs, src/Other2Service.cs';
const files = (rows) => [...new Set(rows.map(p => p.file))].sort();

test('Type.Member: only the uses in files that name the type, its interface or a derived type are places; the rest is one counted F line', async () => {
  const { repo } = fixture();
  const out = path.join(root, 'fold-1.md');
  const r = run(['--repo', repo, '--names', 'RoleService.UpdateAsync', '--out', out]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // The interface-only caller, the derived-class caller and the partial class file stay places.
  assert.deepEqual(files(places(out)), OWN);
  assert.ok(places(out).every(p => p.name === 'RoleService.UpdateAsync' && p.outcome === ''));
  assert.deepEqual(folds(out), [F1]);
  // The count on the F line is the number of rows the list does not hold: the whole word search less the places.
  const { searchName } = await import(pathToFileURL(script).href);
  const whole = [...searchName(repo, 'UpdateAsync').product.values()].reduce((n, lines) => n + lines.length, 0);
  assert.equal(whole - places(out).reduce((n, p) => n + p.uses, 0), 11);
  assert.ok(said(r).some(l => l.startsWith('PLACES: 5 place(s), 5 open, 11 folded — written to ')), r.stdout);
  assert.ok(said(r).some(l => l.startsWith(`FOLDED: ${F1} — all in `) && l.includes('fold-1.folded.md') && l.endsWith('--unfold F1 lists them as open places')), r.stdout);
  // Every folded use is kept in the file beside the list: the caller that never names the type can be found there.
  const beside = read(path.join(root, 'fold-1.folded.md'));
  assert.ok(beside.split(/\r?\n/).includes('- src/Hidden.cs · lines 7'), beside);
  for (const file of OTHERS) assert.ok(beside.split(/\r?\n/).includes(`- ${file} · lines 4, 10`), beside);
  // The tool closes no place: the check is open until each place has its own outcome.
  const open = run(['--refresh', out, '--check', out]);
  assert.equal(open.status, 1, open.stdout);
  assert.ok(said(open).includes('PLACES: 5 place(s), 5 open, 11 folded'), open.stdout);
  const closed = run(['--close', out, '--set', `name:RoleService.UpdateAsync=${NONE}`]);
  assert.ok(said(closed).some(l => l.startsWith('PLACES: 5 place(s), 0 open, 11 folded — ')), closed.stdout);
  // The F line is closed by the tool and counted apart; the folded file itself is never a place.
  const done = run(['--refresh', out, '--check', out]);
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.ok(said(done).includes('PLACES: 5 place(s), 0 open, 11 folded'), done.stdout);
  assert.deepEqual(folds(out), [F1]);
  assert.deepEqual(files(places(out)), OWN);
});

test('--unfold brings every folded row back as an open place and keeps the outcomes already written', () => {
  const { repo } = fixture();
  const out = path.join(root, 'fold-2.md');
  run(['--repo', repo, '--names', 'RoleService.UpdateAsync', '--out', out]);
  run(['--close', out, '--set', `name:RoleService.UpdateAsync=${NONE}`]);
  const before = places(out);
  const r = run(['--refresh', out, '--unfold', 'F1', '--check', out]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.deepEqual(folds(out), []);
  assert.match(read(out), /^Unfolded: RoleService\.UpdateAsync$/m);
  assert.equal(fs.existsSync(path.join(root, 'fold-2.folded.md')), false);
  const now = places(out);
  // The five judged places keep their numbers and outcomes.
  assert.deepEqual(now.filter(p => p.outcome).map(p => [p.n, p.file, p.outcome]), before.map(p => [p.n, p.file, NONE]));
  // The 11 folded uses are open places now, in the six files that held them.
  const back = now.filter(p => !p.outcome);
  assert.deepEqual(files(back), ['src/Hidden.cs', ...OTHERS]);
  assert.equal(back.reduce((n, p) => n + p.uses, 0), 11);
  assert.ok(back.every(p => p.mark === 'new'));
  assert.ok(said(r).includes(`PLACES: ${now.length} place(s), ${back.length} open`), r.stdout);
  // It stays unfolded on the next run.
  run(['--refresh', out]);
  assert.deepEqual(folds(out), []);
  assert.equal(places(out).length, now.length);
});

test('a folded name whose type is renamed reopens: its folded uses are open places again', () => {
  const { repo, write } = fixture();
  const out = path.join(root, 'fold-3.md');
  run(['--repo', repo, '--names', 'RoleService.UpdateAsync', '--out', out]);
  run(['--close', out, '--set', `name:RoleService.UpdateAsync=${NONE}`]);
  assert.equal(run(['--refresh', out, '--check', out]).status, 0);
  write('src/RoleService.cs', cs('public partial class RoleSvc : BaseService, IRoleService', '{', '    public async Task UpdateAsync(int id)', '    {', '        await Task.CompletedTask;', '    }', '}'));
  write('src/RoleService.Extra.cs', cs('public partial class RoleSvc', '{', '    public Task Touch()', '    {', '        return UpdateAsync(1);', '    }', '}'));
  write('src/AdminRoleService.cs', cs('public class AdminRoleService : RoleSvc', '{', '}'));
  const r = run(['--refresh', out, '--check', out]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.ok(said(r).some(l => l.startsWith('UNFOLDED: RoleService.UpdateAsync — its type is no longer declared')), r.stdout);
  assert.deepEqual(folds(out), []);
  const open = places(out).filter(p => !p.outcome && p.mark !== 'gone');
  for (const file of ['src/Hidden.cs', ...OTHERS]) assert.ok(open.some(p => p.file === file), file + ' is an open place again');
});

test('an extension method is never folded; a text key and a bare name keep the whole search', () => {
  const { repo, write } = fixture();
  write('src/Money.cs', cs('public static class Money', '{', '    public static decimal Round(this decimal d)', '    {', '        return d;', '    }', '}'));
  write('src/Pay.cs', cs('public class Pay', '{', '    public decimal Total(decimal x)', '    {', '        return x.Round();', '    }', '}'));
  write('web/a.ts', "export const message = t('errors.notFound');\n");
  write('web/b.ts', 'export const notFound = 1;\n');
  // An extension method is called on any value: the caller that never names Money stays a place.
  const ext = path.join(root, 'fold-4a.md');
  const e = run(['--repo', repo, '--names', 'Money.Round', '--out', ext]);
  assert.equal(e.status, 0, e.stdout + e.stderr);
  assert.deepEqual(files(places(ext)), ['src/Money.cs', 'src/Pay.cs']);
  assert.deepEqual(folds(ext), []);
  assert.ok(said(e).some(l => l.startsWith('NOT FOLDED: Money.Round is an extension method')), e.stdout);
  // A dotted name with no such type is a text key: searched whole, as before.
  const key = path.join(root, 'fold-4b.md');
  const k = run(['--repo', repo, '--names', 'errors.notFound', '--out', key]);
  assert.equal(k.status, 0, k.stdout + k.stderr);
  assert.deepEqual(files(places(key)), ['web/a.ts']);
  assert.deepEqual(folds(key), []);
  assert.ok(said(k).some(l => l.startsWith('PLACES: 1 place(s), 1 open — written to ')), k.stdout);
  // A bare name: every use of the word is a place, and nothing is folded.
  const bare = path.join(root, 'fold-4c.md');
  const b = run(['--repo', repo, '--names', 'UpdateAsync', '--out', bare]);
  assert.equal(b.status, 0, b.stdout + b.stderr);
  assert.deepEqual(files(places(bare)), [...OWN, 'src/Hidden.cs', ...OTHERS].sort());
  assert.deepEqual(folds(bare), []);
  assert.equal(fs.existsSync(path.join(root, 'fold-4c.folded.md')), false);
  assert.ok(said(b).every(l => !l.includes('folded')), b.stdout);
});

test('--add-changed adds every changed function that has callers, gives open places and keeps every old outcome', async () => {
  const { repo, git, write } = fixture();
  write('web/calc.ts', 'export function recalc(a: number) {\n  return a + 1;\n}\n');
  write('web/a.ts', "import { recalc } from './calc';\nexport function first() {\n  return recalc(1);\n}\n");
  write('web/b.ts', "import { recalc } from './calc';\nexport function second() {\n  return recalc(2);\n}\n");
  git('add', '-A'); git('commit', '-qm', 'calc');
  const out = path.join(root, 'fold-5.md');
  run(['--repo', repo, '--names', 'RoleService.UpdateAsync', '--out', out]);
  run(['--close', out, '--set', `name:RoleService.UpdateAsync=${NONE}`]);
  const before = places(out);
  // The change edits recalc, which two files call.
  write('web/calc.ts', 'export function recalc(a: number) {\n  return a + 2;\n}\n');
  const r = run(['--refresh', out, '--add-changed', '--base', 'HEAD', '--check', out]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.ok(said(r).some(l => l.startsWith('ADDED: recalc — 1 changed function(s) with callers against HEAD')), r.stdout);
  assert.match(read(out), /^Names: RoleService\.UpdateAsync, recalc$/m);
  const now = places(out);
  assert.deepEqual(now.filter(p => p.name === 'RoleService.UpdateAsync').map(p => [p.n, p.file, p.outcome]), before.map(p => [p.n, p.file, NONE]));
  // Its two callers are open places; the tool wrote no outcome on any place it added.
  const added = now.filter(p => p.name === 'recalc');
  for (const file of ['web/a.ts', 'web/b.ts']) assert.ok(added.some(p => p.file === file), file);
  assert.ok(added.length >= 2 && added.every(p => p.outcome === ''), JSON.stringify(added));
  // Again: nothing new to add, nothing closed, nothing lost.
  const again = run(['--refresh', out, '--add-changed', '--base', 'HEAD', '--check', out]);
  assert.equal(again.status, 1);
  assert.ok(said(again).some(l => l.startsWith('ADDED: no name — 1 changed function(s) with callers against HEAD, all on the list already')), again.stdout);
  assert.deepEqual(places(out), now);
  // A changed C# method is added as Type.Member, so the other types fold.
  write('src/RoleService.cs', cs('public partial class RoleService : BaseService, IRoleService', '{', '    public async Task UpdateAsync(int id)', '    {', '        await Task.Delay(1);', '    }', '}'));
  const { changedNames } = await import(pathToFileURL(script).href);
  assert.ok(changedNames(repo, 'HEAD').names.includes('RoleService.UpdateAsync'), JSON.stringify(changedNames(repo, 'HEAD')));
});

test('the new options are checked: --unfold needs --refresh and an F line of the list; --add-changed needs --base', () => {
  const { repo } = fixture();
  const out = path.join(root, 'fold-6.md');
  run(['--repo', repo, '--names', 'RoleService.UpdateAsync', '--out', out]);
  const refused = (args, text) => { const r = run(args); assert.equal(r.status, 2, args.join(' ') + '\n' + r.stdout); assert.ok(r.stderr.includes(text), r.stderr); };
  refused(['--check', out, '--unfold', 'F1'], '--unfold F<n> goes with --refresh <list>');
  refused(['--refresh', out, '--unfold', 'P1'], 'is not F<n>[,F<m>]');
  refused(['--refresh', out, '--unfold', 'F9'], '--unfold F9: the list has no such folded line');
  refused(['--refresh', out, '--add-changed'], '--add-changed and --base <ref> go together');
  refused(['--check', out, '--add-changed', '--base', 'HEAD'], '--add-changed goes with --out or --refresh');
  // A refused run changes nothing.
  assert.deepEqual(folds(out), [F1]);
});
