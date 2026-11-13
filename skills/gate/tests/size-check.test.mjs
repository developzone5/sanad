import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sizeTask } from '../scripts/size-check.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'size-check.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'size-check-'));
process.env.SANAD_STATE_DIR = path.join(root, 'state');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

// A base commit with the given files, then the change on top (committed, or left in the work tree).
function change(baseFiles, changed, { commit = true } = {}) {
  const repo = fs.mkdtempSync(path.join(root, 'repo-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const write = files => { for (const [n, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, n)), { recursive: true }); fs.writeFileSync(path.join(repo, n), t); } };
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'core.autocrlf', 'false');
  write({ 'README.md': 'base\n', ...baseFiles }); git('add', '-A'); git('commit', '-qm', 'base'); git('branch', 'base');
  write(changed);
  if (commit) { git('add', '-A'); git('commit', '-qm', 'change', '--allow-empty'); }
  return repo;
}
const size = (repo, extra = {}) => sizeTask({ repo, base: 'base', ...extra });

// 2026-11-12: roles() said "no reviewer" for tiny and three reviewers for small, while launch.md starts
// one review for both (user rule 2026-11-11). The roles now say what launch.md really starts.
test('docs, tests, texts and styles only are tiny, with one review: the fresh eyes', () => {
  const r = size(change({}, { 'docs/a.md': 'x\n', 'src/a.test.ts': "it('x', () => {});\n", 'src/locales/en/a.json': '{"a":"b"}\n', 'src/a.css': '.a{}\n' }));
  assert.equal(r.size, 'tiny');
  assert.equal(r.roles[0], 'one review: fresh eyes (Opus)');
});

test('a plain behavior change is small; its changed functions are listed with their callers', () => {
  const page = 'export function Page() {\n  function pick(next) {\n    return next;\n  }\n  return [pick(1), pick(2)];\n}\n';
  const repo = change({ 'src/Page.tsx': page }, { 'src/Page.tsx': page.replace('return next;', 'return next + 1;') });
  const r = size(repo);
  assert.equal(r.size, 'small');
  assert.equal(r.roles[0], 'one review: fresh eyes (Opus)');
  assert.doesNotMatch(r.roles.join(' '), /whole-diff|Codex/, 'a small change gets one review, as launch.md starts');
  const pick = r.callers.find(c => c.name === 'pick');
  assert.ok(pick, JSON.stringify(r.callers));
  assert.equal(pick.count, 2);
});

test('a change deep in a large component names the component, not a small helper that ended above it', () => {
  const filler = Array.from({ length: 260 }, (_, i) => `      <li key="${i}">{label(${i})}</li>`).join('\n');
  const page = [
    'export default function Panel() {',
    '  const err = (message, id) =>',
    '    message ? <div id={id}>{message}</div> : null;',
    '  return (',
    '    <ul>',
    filler,
    '      <p className="hint">{err("x", "y")}</p>',
    '    </ul>',
    '  );',
    '}',
    '',
  ].join('\n');
  const user = "import Panel from './Panel';\nexport const a = <Panel />;\nexport const b = <Panel />;\n";
  const repo = change({ 'src/Panel.tsx': page, 'src/Use.tsx': user }, { 'src/Panel.tsx': page.replace('className="hint"', 'className="hint is-shown"') });
  const r = size(repo);
  assert.deepEqual(r.callers.map(c => c.name), ['Panel'], JSON.stringify(r.callers));
  // 2026-11-12 (audit C19): the import line is not a caller (this test counted it: ">= 3").
  assert.equal(r.callers[0].count, 2, 'the two uses');
  assert.equal(r.size, 'small');
});

test('a C# method with its brace on the next line is the enclosing function', () => {
  const svc = 'public class S\n{\n    public int Total(int a)\n    {\n        var x = a;\n        return x;\n    }\n}\n';
  const r = size(change({ 'Api/S.cs': svc }, { 'Api/S.cs': svc.replace('return x;', 'return x + 1;') }));
  assert.ok(r.callers.some(c => c.name === 'Total'), JSON.stringify(r.callers));
});

test('a local function counts only its own file; an exported one counts every file', () => {
  const a = 'function helper(x) {\n  return x;\n}\nexport function shared(y) {\n  return y;\n}\nhelper(1); shared(1);\n';
  const b = "import { shared } from './a';\nfunction helper() {}\nhelper(); shared(2); shared(3);\n";
  const repo = change({ 'src/a.ts': a, 'src/b.ts': b }, { 'src/a.ts': a.replace('return x;', 'return x * 2;').replace('return y;', 'return y * 2;') });
  const r = size(repo);
  assert.equal(r.callers.find(c => c.name === 'helper').count, 1, 'b.ts has its own helper');
  assert.ok(r.callers.find(c => c.name === 'shared').count >= 3);
});

test('more than 10 callers of a changed function is big', () => {
  const lib = 'export function formatDate(d) {\n  return d;\n}\n';
  const users = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`src/u${i}.ts`, "import { formatDate } from './lib';\nformatDate(1);\n"]));
  const r = size(change({ 'src/lib.ts': lib, ...users }, { 'src/lib.ts': lib.replace('return d;', 'return String(d);') }));
  assert.equal(r.size, 'big');
  assert.ok(r.signals.callersMany);
});

// 2026-11-09: a two-line exam form change was sized "big": 35 hits of `buildSchema` were other
// pages' own local functions of that name, and some were words in docs.
test('a same-named function in a file that does not import the changed one, and a doc, are not callers', () => {
  const lib = 'export function buildSchema(t) {\n  return t;\n}\n';
  const others = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`src/page${i}.tsx`, 'function buildSchema() { return 1; }\nexport const x = buildSchema();\n']));
  const user = "import { buildSchema } from './lib';\nexport const s = buildSchema('t');\n";
  const doc = 'buildSchema buildSchema buildSchema buildSchema buildSchema buildSchema buildSchema buildSchema buildSchema buildSchema buildSchema\n';
  const repo = change({ 'src/lib.ts': lib, 'src/user.tsx': user, 'docs/plan.md': doc, ...others }, { 'src/lib.ts': lib.replace('return t;', 'return t + 1;') });
  const r = size(repo);
  const row = r.callers.find(c => c.name === 'buildSchema');
  // 2026-11-12 (audit C19): the import line is not a caller (this test counted it: 2).
  assert.equal(row.count, 1, 'the one use in src/user.tsx: ' + JSON.stringify(row));
  assert.equal(r.signals.callersMany, undefined);
  assert.equal(r.size, 'small');
});

// 2026-11-09 (TUW-239): rewording a JSX comment in a dialog with eleven callers sized a style fix "big".
test('a change to comments only changes no function; a code line in the same place still does', () => {
  const dialog = [
    "export default function Dialog() {",
    "  return (",
    "    <div>",
    "      {/* The tools show under the text",
    "          while the teacher is in it. */}",
    "      <p>text</p>",
    "    </div>",
    "  );",
    "}",
    "",
  ].join('\n');
  const users = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`src/u${i}.tsx`, "import Dialog from './Dialog';\nexport const x = <Dialog />;\n"]));
  const commentOnly = size(change({ 'src/Dialog.tsx': dialog, ...users }, { 'src/Dialog.tsx': dialog.replace('show under the text', 'show above the text').replace('while the teacher is in it.', 'always.') }));
  assert.equal(commentOnly.callers.find(c => c.name === 'Dialog'), undefined, JSON.stringify(commentOnly.callers));
  assert.equal(commentOnly.signals.callersMany, undefined);
  const codeToo = size(change({ 'src/Dialog.tsx': dialog, ...users }, { 'src/Dialog.tsx': dialog.replace('<p>text</p>', '<p>other</p>') }));
  assert.ok(codeToo.signals.callersMany, JSON.stringify(codeToo.callers));
});

test('codeOnly keeps code and empties strings and comments, in one pass', async () => {
  const { codeOnly } = await import('../scripts/size-check.mjs');
  assert.equal(codeOnly('x = "http://a"; // c'), 'x = ""; ');
  assert.equal(codeOnly("t('homework.uploadFile')"), "t('')");
  assert.equal(codeOnly('var n = 1; /* Select */ y'), 'var n = 1;   y');
  assert.equal(codeOnly("<p>Don't</p>; // don't .Where("), "<p>Don't</p>; ", 'a lone apostrophe in code does not hide the comment');
  assert.equal(codeOnly('[Authorize(Roles = "Admin")]'), '[Authorize(Roles = "")]');
  assert.equal(codeOnly('s = "a \\" b"; z'), 's = ""; z', 'an escaped quote stays inside the string');
});

test('codeLines tells comment-only lines from code', async () => {
  const { codeLines } = await import('../scripts/size-check.mjs');
  assert.deepEqual(codeLines('a();\n// c\n/* b\n still */\n{/* x */}\nx = 1; // y\n\n  {/* open\n close */}'),
    [true, false, false, false, false, true, false, false, false]);
});

test('importers through a re-export still count, so many real callers stay big', () => {
  const lib = 'export function formatDate(d) {\n  return d;\n}\n';
  const barrel = "export { formatDate } from './lib';\n";
  const users = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`src/u${i}.ts`, "import { formatDate } from './barrel';\nformatDate(1);\n"]));
  const r = size(change({ 'src/lib.ts': lib, 'src/barrel.ts': barrel, ...users }, { 'src/lib.ts': lib.replace('return d;', 'return String(d);') }));
  assert.ok(r.signals.callersMany, JSON.stringify(r.callers));
  assert.equal(r.size, 'big');
});

test('a migration, server access rules, server file handling and a new package are big, each with its seat', () => {
  const schema = size(change({}, { 'Api/Migrations/20260101_AddX.cs': 'public partial class AddX : Migration { protected override void Up(MigrationBuilder migrationBuilder) { } }\n' }));
  assert.equal(schema.size, 'big');
  assert.match(schema.roles.join(' '), /Database expert/);
  const ctl = 'public class XController {\n  public IActionResult Get() { return Ok(); }\n}\n';
  const access = size(change({ 'Api/XController.cs': ctl }, { 'Api/XController.cs': ctl.replace('public IActionResult', '[Authorize(Roles = "Admin")]\n  public IActionResult') }));
  assert.equal(access.size, 'big');
  assert.match(access.roles.join(' '), /Security auditor/);
  const svc = 'public class FileService {\n  public void Save() { }\n}\n';
  const files = size(change({ 'Api/FileService.cs': svc }, { 'Api/FileService.cs': svc.replace('Save() { }', 'Save(IFormFile file) { var p = Path.Combine(root, file.FileName); }') }));
  assert.equal(files.size, 'big');
  const dep = size(change({ 'package.json': '{\n  "dependencies": {\n    "react": "19.0.0"\n  }\n}\n' }, { 'package.json': '{\n  "dependencies": {\n    "react": "19.0.0",\n    "left-pad": "1.3.0"\n  }\n}\n' }));
  assert.equal(dep.size, 'big');
  assert.match(dep.roles.join(' '), /user approval/);
});

test('a query change is medium with a database seat only where a database is used', () => {
  const svc = 'public class S {\n  private readonly AppDbContext _context;\n  public object Get() { return _context.Items.ToList(); }\n}\n';
  const q = size(change({ 'Api/S.cs': svc }, { 'Api/S.cs': svc.replace('_context.Items.ToList()', '_context.Items.Where(i => i.Active).OrderBy(i => i.Id).ToList()') }));
  assert.equal(q.size, 'medium');
  // 2026-11-12 (three sizes, user-approved): Medium gets ONE review with the full brief; the boss and the
  // full round are for Big.
  assert.equal(q.roles[0], 'one review: fresh eyes (Opus), full brief');
  assert.match(q.roles.join(' '), /Database expert/);
  assert.doesNotMatch(q.roles.join(' '), /boss|other engine|whole-diff/, 'the boss and the full round are for big');
  const mem = 'public class M {\n  public int Get(List<int> xs) { return xs.Count; }\n}\n';
  assert.equal(size(change({ 'Api/M.cs': mem }, { 'Api/M.cs': mem.replace('xs.Count', 'xs.Where(x => x > 0).Count()') })).size, 'small', 'in-memory LINQ is not a query');
});

test('a DTO and the client type that mirrors it are the shared contract: medium', () => {
  const r = size(change({ 'Api/DTOs/UserDto.cs': 'public class UserDto { public int Id { get; set; } }\n', 'web/src/types/user.ts': 'export interface User { id: number }\n' },
    { 'Api/DTOs/UserDto.cs': 'public class UserDto { public int Id { get; set; } public string Name { get; set; } }\n', 'web/src/types/user.ts': 'export interface User { id: number; name: string }\n' }));
  assert.equal(r.size, 'medium');
  assert.ok(r.signals.contract.length >= 2);
});

test('Next.js: a server action is medium; middleware with access is big', () => {
  const action = size(change({}, { 'app/actions.ts': "'use server';\nexport async function save(form) {\n  return form;\n}\n" }));
  assert.equal(action.size, 'medium');
  assert.match(action.roles.join(' '), /access check in every new server entry/);
  const mw = size(change({}, { 'middleware.ts': 'export function middleware(req) {\n  if (!req.cookies.get("session")) return Response.redirect("/login");\n}\n' }));
  assert.equal(mw.size, 'big');
});

test('a URL or cache change stays small but adds the Client state checks', () => {
  const page = 'export function List() {\n  function pick(next) {\n    setParams(params => { params.set("tab", next); });\n  }\n  return pick;\n}\n';
  const r = size(change({ 'src/List.tsx': page }, { 'src/List.tsx': page.replace('params.set("tab", next);', 'params.set("tab", next); params.delete("count");') }));
  assert.equal(r.size, 'small');
  assert.ok(r.signals.clientState);
  assert.match(r.roles.join(' '), /Client state checks/);
  const server = 'public class C {\n  public void Go() { }\n}\n';
  assert.ok(!size(change({ 'Api/C.cs': server }, { 'Api/C.cs': server.replace('Go() { }', 'Go() { var queryKey = 1; }') })).signals.clientState, 'server code is not client state');
});

test('UI role gating is medium: the server must check too', () => {
  const nav = 'export const menu = [{ path: "/a", roles: ["Teacher"] }];\n';
  const r = size(change({ 'src/router.tsx': '<RoleGuard allowedRoles={["Admin"]} />\n' }, { 'src/router.tsx': '<RoleGuard allowedRoles={["Admin", "Manager"]} />\n', 'src/nav.ts': nav }));
  assert.equal(r.size, 'medium');
  assert.ok(r.signals.accessUi);
});

test('plan mode sizes the planned files by their paths', () => {
  const repo = change({}, {});
  assert.equal(sizeTask({ repo, files: ['Api/Migrations/20260101_X.cs'] }).size, 'big');
  assert.equal(sizeTask({ repo, files: ['web/src/pages/List.tsx'] }).size, 'small');
  assert.equal(sizeTask({ repo, files: ['web/src/types/user.ts'] }).size, 'medium');
});

test('uncommitted work counts; --was fails when the change grew, and usage errors exit 2', () => {
  const svc = 'public class S {\n  private readonly AppDbContext _context;\n  public object Get() { return _context.Items.ToList(); }\n}\n';
  const repo = change({ 'Api/S.cs': svc }, { 'Api/S.cs': svc.replace('.ToList()', '.Where(i => i.Active).ToList()') }, { commit: false });
  const grew = spawnSync(process.execPath, [script, '--repo', repo, '--base', 'base', '--was', 'small'], { encoding: 'utf8', env: process.env });
  assert.equal(grew.status, 1, grew.stdout + grew.stderr);
  assert.match(grew.stdout, /SIZE GREW: small → medium/);
  assert.equal(spawnSync(process.execPath, [script, '--repo', repo, '--base', 'base', '--was', 'big'], { encoding: 'utf8', env: process.env }).status, 0);
  assert.equal(spawnSync(process.execPath, [script, '--repo', repo], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [script, '--repo', repo, '--base', 'base', '--was', 'huge'], { encoding: 'utf8' }).status, 2);
});

// 2026-11-12 (audit C3): the access-file rule ran in plan mode only, so a change in
// Api/Auth/LocalUserViewAuthorizer.cs with no access word on the changed line sized small.
test('diff mode: a file named like an access file, or under an Auth or Security folder, is an access change', () => {
  const plain = 'public class X {\n  public int Pick(int a) { return a; }\n}\n';
  const named = size(change({ 'Api/Auth/LocalUserViewAuthorizer.cs': plain }, { 'Api/Auth/LocalUserViewAuthorizer.cs': plain.replace('return a;', 'return a + 1;') }));
  assert.equal(named.size, 'big');
  assert.ok(named.signals.access, JSON.stringify(named.signals));
  const folder = size(change({ 'Api/Security/Hasher.cs': plain }, { 'Api/Security/Hasher.cs': plain.replace('return a;', 'return a + 1;') }));
  assert.ok(folder.signals.access, 'a file under a Security folder: ' + JSON.stringify(folder.signals));
  const store = 'export const keep = (a: number) => a;\n';
  const client = size(change({ 'web/src/stores/auth-store.ts': store }, { 'web/src/stores/auth-store.ts': store.replace('=> a;', '=> a + 1;') }));
  assert.ok(client.signals.accessUi, 'client code gets the UI access signal: ' + JSON.stringify(client.signals));
  assert.equal(client.signals.access, undefined);
});

// 2026-11-12: "Policy" names business rules as often as access rules. EduQuest's ExamPolicy.cs (exam
// settings) would size "big" on every edit once the name rule ran in diff mode.
test('diff mode: a file named Policy is an access change only when its text speaks of authorization', () => {
  const rules = 'public class ExamPolicy {\n  public int MaxAttempts(int a) { return a; }\n}\n';
  const business = size(change({ 'Domain/ExamPolicy.cs': rules }, { 'Domain/ExamPolicy.cs': rules.replace('return a;', 'return a + 1;') }));
  assert.equal(business.signals.access, undefined, JSON.stringify(business.signals));
  assert.equal(business.size, 'small');
  const access = 'public class GradePolicy : IAuthorizationRequirement {\n  public int Level(int a) { return a; }\n}\n';
  const real = size(change({ 'Api/GradePolicy.cs': access }, { 'Api/GradePolicy.cs': access.replace('return a;', 'return a + 1;') }));
  assert.ok(real.signals.access, JSON.stringify(real.signals));
  const both = size(change({ 'Api/AuthorizationPolicyProvider.cs': rules }, { 'Api/AuthorizationPolicyProvider.cs': rules.replace('return a;', 'return a + 1;') }));
  assert.ok(both.signals.access, 'a name that also says Authorization needs no text: ' + JSON.stringify(both.signals));
});

test('a test file whose name says Auth is not an access change', () => {
  const t = 'public class AuthTests {\n  [Fact] public void A() { Assert.True(true); }\n}\n';
  const r = size(change({ 'Api.Tests/AuthTests.cs': t, 'Api.Tests/Auth/LoginTests.cs': t }, { 'Api.Tests/AuthTests.cs': t.replace('true); }', 'true); var x = 1; }'), 'Api.Tests/Auth/LoginTests.cs': t.replace('true); }', 'true); var y = 1; }') }));
  assert.equal(r.signals.access, undefined, JSON.stringify(r.signals));
  assert.equal(r.size, 'tiny');
});

// 2026-11-12 (audit C4a): BulkImportWorker.cs takes its AppDbContext from the service provider into a
// local `context`; the old pattern needed `_context` or a bare `DbContext`, so its queries never counted.
test('a file that takes an AppDbContext from the service provider, or a context factory, is a database file', () => {
  const worker = [
    'public class Worker {',
    '  public async Task<long?> Next() {',
    '    var context = scope.ServiceProvider.GetRequiredService<AppDbContext>();',
    '    return await context.Jobs.Select(j => (long?)j.Id).FirstOrDefaultAsync();',
    '  }',
    '}',
    '',
  ].join('\n');
  const r = size(change({ 'Api/Worker.cs': worker }, { 'Api/Worker.cs': worker.replace('context.Jobs.Select', 'context.Jobs.Where(j => j.Pending).Select') }));
  assert.ok(r.signals.query, JSON.stringify(r.signals));
  assert.equal(r.size, 'medium');
  const factory = 'public class F {\n  private readonly IDbContextFactory<Ctx> _f;\n  public int N(List<int> xs) { return xs.Count; }\n}\n';
  const viaFactory = size(change({ 'Api/F.cs': factory }, { 'Api/F.cs': factory.replace('xs.Count', 'xs.Where(x => x > 0).Count()') }));
  assert.ok(viaFactory.signals.query, 'a file with a context factory is a database file: ' + JSON.stringify(viaFactory.signals));
});

// 2026-11-12 (audit C4b): only changed lines holding `.Where(` counted, so a changed predicate on the
// wrapped line under `.Where(a =>` was no query change.
test('a changed predicate on the wrapped line under .Where( is a query change', () => {
  const svc = [
    'public class S {',
    '  private readonly AppDbContext _db;',
    '  public Task<List<Item>> Get(int campusId) {',
    '    return _db.Items',
    '      .Where(a =>',
    '        a.Active',
    '        && a.Year == 1)',
    '      .ToListAsync();',
    '  }',
    '}',
    '',
  ].join('\n');
  const r = size(change({ 'Api/S.cs': svc }, { 'Api/S.cs': svc.replace('&& a.Year == 1)', '&& a.Year == 2)') }));
  assert.ok(r.signals.query, JSON.stringify(r.signals));
  assert.equal(r.size, 'medium');
});

test('a comment-only change, or a line in another statement next to a query, stays small in a database file', () => {
  const svc = [
    'public class S {',
    '  private readonly AppDbContext _db;',
    '  public async Task<string> Get(int id) {',
    '    var item = await _db.Items.FirstOrDefaultAsync(i => i.Id == id);',
    '    // Pick the newest item first.',
    '    if (item == null)',
    '      return "none";',
    '    return item.Name;',
    '  }',
    '}',
    '',
  ].join('\n');
  const comment = size(change({ 'Api/S.cs': svc }, { 'Api/S.cs': svc.replace('Pick the newest item first.', 'Select the newest .Where( item first.') }));
  assert.equal(comment.signals.query, undefined, 'comment only: ' + JSON.stringify(comment.signals));
  assert.equal(comment.size, 'small');
  const near = size(change({ 'Api/S.cs': svc }, { 'Api/S.cs': svc.replace('return "none";', 'return "missing";') }));
  assert.equal(near.signals.query, undefined, 'a plain line after a finished query statement: ' + JSON.stringify(near.signals));
  assert.equal(near.size, 'small');
});

// 2026-11-12 (audit C17): every .ts under i18n/ counted as text, so the i18next setup code (i18n/index.ts)
// sized "tiny"; locale data modules under locales/ (EduQuest keeps 277 of them as .ts) stay text.
// 2026-11-12 (three sizes, user-approved): "Small: one side only (page or server)". A change with logic on
// both sides is Medium: its page rule and its server rule must agree (PR #773: a date rule fixed in the
// validator, the service and the form was sized small, and a teammate found the paths it missed).
test('server and page code in one change is medium; one side with its tests and texts stays small', () => {
  const svc = 'public class S {\n  public int Get(int x) { return x; }\n}\n';
  const page = 'export function rule(x) {\n  return x;\n}\n';
  const both = size(change({ 'Api/S.cs': svc, 'web/src/rule.ts': page }, { 'Api/S.cs': svc.replace('return x;', 'return x + 1;'), 'web/src/rule.ts': page.replace('return x;', 'return x + 1;') }));
  assert.equal(both.size, 'medium');
  assert.deepEqual(both.signals.bothSides, ['S.cs', 'rule.ts']);
  assert.match(both.roles.join(' '), /the page rule and the server rule agree/);
  const oneSide = size(change({ 'Api/S.cs': svc }, { 'Api/S.cs': svc.replace('return x;', 'return x + 1;'), 'Api.Tests/STests.cs': 'public class STests { }\n', 'web/src/rule.test.ts': "it('x', () => {});\n", 'web/src/locales/en/a.ts': "export default { a: 'b' };\n", 'web/src/a.css': '.a{}\n' }));
  assert.equal(oneSide.size, 'small', 'tests, texts and styles of the other side are not logic');
  assert.equal(oneSide.signals.bothSides, undefined);
  const repo = change({}, {});
  assert.equal(sizeTask({ repo, files: ['Api/Services/S.cs', 'web/src/pages/List.tsx'] }).size, 'medium', 'planned files are sized by name');
  assert.equal(sizeTask({ repo, files: ['web/src/pages/List.tsx', 'web/src/pages/Other.tsx'] }).size, 'small');
});

test('i18n setup code is code; locale data under a locales folder is text', () => {
  const setup = "export function getInitialLanguage() {\n  return 'ar';\n}\n";
  const code = size(change({ 'web/src/i18n/index.ts': setup }, { 'web/src/i18n/index.ts': setup.replace("'ar'", "'en'") }));
  assert.equal(code.size, 'small');
  assert.equal(code.codeFiles, 1);
  const text = size(change({ 'web/src/i18n/locales/en/actions.ts': "export default { save: 'Save' };\n", 'web/src/locales/ar/a.json': '{"a":"b"}\n', 'Api/Resources/messages.en.json': '{"a":"b"}\n' },
    { 'web/src/i18n/locales/en/actions.ts': "export default { save: 'Save it' };\n", 'web/src/locales/ar/a.json': '{"a":"c"}\n', 'Api/Resources/messages.en.json': '{"a":"c"}\n' }));
  assert.equal(text.size, 'tiny', JSON.stringify(text));
});

test('JSON fixtures, snapshots, SVG and binary files are not logic lines; renames and binaries are listed by name', () => {
  const many = n => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n') + '\n';
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 1, 2, 3]);
  const lib = 'export function f(a) {\n  return a;\n}\n';
  const moved = 'export const moved = 1;\n';
  const repo = change({ 'src/lib.ts': lib, 'src/old-name.ts': moved, 'src/logo.png': png }, {
    'src/lib.ts': lib.replace('return a;', 'return a + 1;'),
    'src/fixtures/exam.json': JSON.stringify({ rows: many(450).split('\n') }, null, 1),
    'src/__snapshots__/a.test.tsx.snap': many(450),
    'src/icon.svg': '<svg>\n' + many(450) + '</svg>\n',
  }, { commit: false });
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  fs.writeFileSync(path.join(repo, 'src/logo.png'), Buffer.concat([png, Buffer.from([9, 9, 0, 9])]));
  fs.writeFileSync(path.join(repo, 'src/new-photo.png'), Buffer.concat([png, Buffer.from(many(500))]));
  fs.renameSync(path.join(repo, 'src/old-name.ts'), path.join(repo, 'src/new-name.ts'));
  git('add', 'src/old-name.ts', 'src/new-name.ts');
  const r = size(repo);
  assert.equal(r.signals.split, undefined, JSON.stringify(r.signals));
  assert.equal(r.codeFiles, 1, 'only src/lib.ts holds logic lines');
  assert.ok(r.lines <= 4, 'logic lines: ' + r.lines);
  assert.deepEqual(r.renamed, ['src/old-name.ts → src/new-name.ts']);
  assert.deepEqual([...r.binary].sort(), ['src/logo.png', 'src/new-photo.png']);
  const out = spawnSync(process.execPath, [script, '--repo', repo, '--base', 'base'], { encoding: 'utf8', env: process.env }).stdout;
  assert.match(out, /^ {2}renamed: src\/old-name\.ts → src\/new-name\.ts$/m);
  assert.match(out, /^ {2}binary: src\/logo\.png, src\/new-photo\.png$/m);
});

// 2026-11-12 (audit C16): `git grep` without --untracked missed callers in new files, and only the first
// 12 changed functions were kept without a word.
test('callers in new untracked files count', () => {
  const lib = 'export function formatDate(d) {\n  return d;\n}\n';
  const repo = change({ 'src/lib.ts': lib }, { 'src/lib.ts': lib.replace('return d;', 'return String(d);') }, { commit: false });
  fs.writeFileSync(path.join(repo, 'src/NewPage.tsx'), "import { formatDate } from './lib';\nexport const a = formatDate(1);\nexport const b = formatDate(2);\n");
  const row = size(repo).callers.find(c => c.name === 'formatDate');
  assert.equal(row && row.count, 2, 'both calls in the new file (its import line is no caller): ' + JSON.stringify(row));
});

test('more than 12 changed functions says how many were not counted', () => {
  const fns = n => Array.from({ length: n }, (_, i) => `export function fn${i}(a) {\n  return a + ${i};\n}\n`).join('');
  const repo = change({ 'src/many.ts': fns(15) }, { 'src/many.ts': fns(15).replace(/return a \+ (\d+);/g, 'return a - $1;') });
  const r = size(repo);
  assert.equal(r.callers.length, 12);
  assert.equal(r.moreSymbols, 3);
  const out = spawnSync(process.execPath, [script, '--repo', repo, '--base', 'base'], { encoding: 'utf8', env: process.env }).stdout;
  assert.match(out, /^ {2}callers: .*\+3 more changed functions not counted$/m);
});

// 2026-11-12 (audit M6): TUW-243 changed AssignmentPublishRules.Apply; the bare name `Apply` matched every
// other class's Apply (18 "callers", sized big). A C# caller is a line in a file that names the class.
test('C#: a changed method counts callers only in files that name its class (two rule classes with an Apply each)', () => {
  const rules = n => `internal static class ${n}\n{\n    public static void Apply<T>(Validator<T> v)\n    {\n        v.Rule(1);\n    }\n}\n`;
  const validator = n => `public class ${n} : Validator<Dto>\n{\n    public ${n}()\n    {\n        PublishRules.Apply(this);\n        SettingsRules.Apply(this);\n    }\n}\n`;
  const others = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`Api/Days/Day${i}.cs`, `public class Day${i}\n{\n    public int Run(int q) => OnlineScope.Apply(q);\n}\n`]));
  const baseFiles = {
    'Api/Rules/PublishRules.cs': rules('PublishRules'), 'Api/Rules/SettingsRules.cs': rules('SettingsRules'),
    'Api/Rules/OnlineScope.cs': 'public static class OnlineScope\n{\n    public static int Apply(int q)\n    {\n        return q;\n    }\n}\n',
    'Api/CreateValidator.cs': validator('CreateValidator'), 'Api/UpdateValidator.cs': validator('UpdateValidator'),
    'Api/Seed.cs': 'public class Seed\n{\n    public string Text = "Apply core concepts";\n}\n', ...others,
  };
  for (const n of ['PublishRules', 'SettingsRules']) {
    const r = size(change(baseFiles, { [`Api/Rules/${n}.cs`]: rules(n).replace('v.Rule(1);', 'v.Rule(2);') }));
    const row = r.callers.find(c => c.name === 'Apply');
    assert.equal(row && row.count, 2, `${n}.Apply: one call in each validator, not the other classes' Apply: ` + JSON.stringify(row));
    assert.equal(r.signals.callersMany, undefined);
    assert.equal(r.size, 'small');
  }
});

test('C#: an instance method called through its interface counts in a file that names the interface', () => {
  const svc = 'public class ThingService : IThingService\n{\n    public async Task SaveAsync(int id)\n    {\n        await Task.Delay(id);\n    }\n}\n';
  const repo = change({
    'Api/Services/ThingService.cs': svc,
    'Api/Services/IThingService.cs': 'public interface IThingService\n{\n    Task SaveAsync(int id);\n}\n',
    'Api/Controllers/ThingController.cs': 'public class ThingController\n{\n    private readonly IThingService _thing;\n    public async Task Post()\n    {\n        await _thing.SaveAsync(1);\n    }\n}\n',
    'Api/Services/OtherService.cs': 'public class OtherService\n{\n    public Task SaveAsync(int id) => Task.CompletedTask;\n    public void Go()\n    {\n        SaveAsync(2);\n    }\n}\n',
  }, { 'Api/Services/ThingService.cs': svc.replace('Task.Delay(id)', 'Task.Delay(id + 1)') });
  const row = size(repo).callers.find(c => c.name === 'SaveAsync');
  assert.equal(row && row.count, 1, 'the controller call; not the interface declaration, not OtherService: ' + JSON.stringify(row));
  assert.deepEqual(row.where, ['Api/Controllers/ThingController.cs:6']);
  // An interface with another name, listed on the class line, reaches the method too.
  const clock = 'public sealed class SqlClock : ITimeSource, IDisposable\n{\n    public DateTime Now()\n    {\n        return DateTime.UtcNow;\n    }\n}\n';
  const viaOther = size(change({
    'Api/SqlClock.cs': clock,
    'Api/ITimeSource.cs': 'public interface ITimeSource\n{\n    DateTime Now();\n}\n',
    'Api/Report.cs': 'public class Report\n{\n    private readonly ITimeSource _time;\n    public DateTime At() => _time.Now();\n}\n',
  }, { 'Api/SqlClock.cs': clock.replace('DateTime.UtcNow', 'DateTime.UtcNow.AddSeconds(0)') }));
  assert.equal(viaOther.callers.find(c => c.name === 'Now').count, 1, JSON.stringify(viaOther.callers));
});

test('C#: eleven real callers of a method still give callersMany', () => {
  const fmt = 'public static class Fmt\n{\n    public static string Day(int d)\n    {\n        return d.ToString();\n    }\n}\n';
  const users = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`Api/U${i}.cs`, `public class U${i}\n{\n    public string X() => Fmt.Day(${i});\n}\n`]));
  const r = size(change({ 'Api/Fmt.cs': fmt, ...users }, { 'Api/Fmt.cs': fmt.replace('d.ToString()', 'd.ToString("D2")') }));
  assert.equal(r.callers.find(c => c.name === 'Day').count, 11);
  assert.ok(r.signals.callersMany);
  assert.equal(r.size, 'big');
});

// 2026-11-12 (audit C19): the import line, `export default X`, a re-export and the closing tag each counted,
// so a component used in 4 files had 12 "callers" (big).
test('JS: a component rendered with children in 4 files is 4 callers, not 12', () => {
  const card = 'export default function Card({ children }) {\n  return <div className="card">{children}</div>;\n}\n';
  const user = "import Card from './Card';\nexport const a = (\n  <Card>\n    <p>x</p>\n  </Card>\n);\n";
  const users = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`src/User${i}.tsx`, user]));
  const repo = change({ 'src/Card.tsx': card, 'src/cards.ts': "export { default as Card } from './Card';\n", 'src/Wrapped.tsx': "import Card from './Card';\nexport default Card;\n", ...users },
    { 'src/Card.tsx': card.replace('className="card"', 'className="card is-flat"') });
  const r = size(repo);
  assert.equal(r.callers.find(c => c.name === 'Card').count, 4, JSON.stringify(r.callers));
  assert.equal(r.signals.callersMany, undefined);
  assert.equal(r.size, 'small');
});

test('JS: two modules with the same base name do not share callers; ./, ../, @/ and /index specifiers resolve', () => {
  const fn = v => `export function getAll() {\n  return ${v};\n}\n`;
  const typeUsers = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`src/pages/T${i}.tsx`, "import { getAll } from '@/types/users';\nexport const t = getAll();\n"]));
  const files = {
    'package.json': '{"name":"web"}\n', 'src/api/users.ts': fn(1), 'src/types/users.ts': fn(2), ...typeUsers,
    'src/pages/A.tsx': "import { getAll } from '@/api/users';\nexport const a = getAll();\n",
    'src/api/B.ts': "import { getAll } from './users';\nexport const b = getAll();\n",
    'src/pages/C.tsx': "import { getAll } from '../api/users.js';\nexport const c = getAll();\n",
  };
  const r = size(change(files, { 'src/api/users.ts': fn(3) }));
  const row = r.callers.find(c => c.name === 'getAll');
  assert.equal(row.count, 3, 'A (@/), B (./) and C (../ with .js); none of the 12 types/users importers: ' + JSON.stringify(row));
  assert.equal(r.signals.callersMany, undefined);
  const index = size(change({ 'package.json': '{"name":"web"}\n', 'src/lib/index.ts': fn(1), 'src/pages/D.tsx': "import { getAll } from '@/lib';\nexport const d = getAll();\n" }, { 'src/lib/index.ts': fn(2) }));
  assert.equal(index.callers.find(c => c.name === 'getAll').count, 1, 'an import of the folder reaches its index file');
});

// 2026-11-12 (audit C18): signal words were read in comments, strings and plain field names, so an i18n key
// with "upload", a log text with "Download", a DTO field named CampusId or the word "taxonomy" raised a size.
test('signals read code only: i18n keys, log texts, comments, plain field names and "taxonomy" raise nothing', () => {
  const page = "export function Hw({ t }) {\n  return t('homework.title');\n}\n";
  const ui = size(change({ 'web/src/pages/Hw.tsx': page }, { 'web/src/pages/Hw.tsx': page.replace("'homework.title'", "'homework.uploadFile'") }));
  assert.deepEqual(Object.keys(ui.signals), [], 'an i18n key: ' + JSON.stringify(ui.signals));
  const svc = 'public class S\n{\n    private readonly AppDbContext _db;\n    public int Count(int id)\n    {\n        var n = id; // keep\n        return n;\n    }\n}\n';
  const comment = size(change({ 'Api/S.cs': svc }, { 'Api/S.cs': svc.replace('var n = id; // keep', 'var n = id + 1; // .Where( and .Select( the newest hand-in, then download it') }));
  assert.deepEqual(Object.keys(comment.signals), [], 'a trailing comment in a database file: ' + JSON.stringify(comment.signals));
  const log = 'public class L\n{\n    public void Go(int id)\n    {\n        _logger.LogInformation("Start {Id}", id);\n    }\n}\n';
  const logged = size(change({ 'Api/L.cs': log }, { 'Api/L.cs': log.replace('"Start {Id}"', '"Download started for {Id}, refund later"') }));
  assert.deepEqual(Object.keys(logged.signals), [], 'a log text: ' + JSON.stringify(logged.signals));
  const row = 'public class ItemRow\n{\n    public int Id { get; set; }\n}\n';
  const field = size(change({ 'Api/Models/ItemRow.cs': row }, { 'Api/Models/ItemRow.cs': row.replace('public int Id { get; set; }', 'public int Id { get; set; }\n    public int? CampusId { get; set; }\n    public int OwnerId { get; set; }\n    public string Taxonomy { get; set; }') }));
  assert.deepEqual(Object.keys(field.signals), [], 'plain fields named CampusId and OwnerId, and taxonomy: ' + JSON.stringify(field.signals));
  const map = 'public static class M\n{\n    public static Row To(Item x) => new Row\n    {\n        Id = x.Id,\n    };\n}\n';
  const projection = size(change({ 'Api/M.cs': map }, { 'Api/M.cs': map.replace('Id = x.Id,', 'Id = x.Id,\n        CampusId = x.CampusId,') }));
  assert.equal(projection.signals.access, undefined, 'a projection: ' + JSON.stringify(projection.signals));
  assert.equal(projection.size, 'small');
});

test('signals still raise on real code: a campus filter, [Authorize], an upload, a presigned link, FormData, a tax rate, FOR UPDATE', () => {
  const svc = 'public class S\n{\n    public object Get(int campusId)\n    {\n        return Items;\n    }\n}\n';
  const filter = size(change({ 'Api/S.cs': svc }, { 'Api/S.cs': svc.replace('return Items;', 'return Items.Where(x => x.CampusId == campusId);') }));
  assert.ok(filter.signals.access, 'a campus filter: ' + JSON.stringify(filter.signals));
  const ctl = 'public class XController\n{\n    public IActionResult Get() { return Ok(); }\n}\n';
  assert.ok(size(change({ 'Api/XController.cs': ctl }, { 'Api/XController.cs': ctl.replace('public IActionResult', '[Authorize(Roles = "Admin")]\n    public IActionResult') })).signals.access);
  const up = 'public class U\n{\n    public void Save() { }\n}\n';
  assert.ok(size(change({ 'Api/U.cs': up }, { 'Api/U.cs': up.replace('Save() { }', 'Save(IFormFile file) { }') })).signals.files, 'IFormFile');
  assert.ok(size(change({ 'Api/U.cs': up }, { 'Api/U.cs': up.replace('Save() { }', 'Save(string key) { var u = _storage.GetPresignedUrl(key); }') })).signals.files, 'a presigned link');
  // 2026-11-12: commit ff3b3b0405 copies a stored file (`_fileStorage.CopyAsync`, S3 CopyObjectAsync); its only
  // "files" words were in comments, so reading code only dropped it to medium until these calls counted.
  assert.ok(size(change({ 'Api/U.cs': up }, { 'Api/U.cs': up.replace('Save() { }', 'Save(string a, string b) { var ok = _fileStorage.CopyAsync(a, b); }') })).signals.files, 'a file storage call');
  assert.ok(size(change({ 'Api/U.cs': up }, { 'Api/U.cs': up.replace('Save() { }', 'Save(string k) { _s3.CopyObjectAsync(new CopyObjectRequest { SourceKey = k }); }') })).signals.files, 'an S3 object call');
  const form = "export function send(file) {\n  return post(file);\n}\n";
  assert.ok(size(change({ 'web/src/api/send.ts': form }, { 'web/src/api/send.ts': form.replace('return post(file);', "const body = new FormData();\n  body.append('file', file);\n  return post(body);") })).signals.filesUi, 'FormData');
  const price = 'public class P\n{\n    public decimal Total(decimal a) { return a; }\n}\n';
  assert.ok(size(change({ 'Api/P.cs': price }, { 'Api/P.cs': price.replace('return a;', 'return a * (1 + taxRate);') })).signals.money, 'taxRate');
  const lock = 'public class Q\n{\n    public void Go() { }\n}\n';
  assert.ok(size(change({ 'Api/Q.cs': lock }, { 'Api/Q.cs': lock.replace('Go() { }', 'Go() { var r = Db.Raw("SELECT Id FROM Exams WHERE Id = 1 FOR UPDATE"); }') })).signals.concurrency, 'FOR UPDATE inside the SQL text');
});
