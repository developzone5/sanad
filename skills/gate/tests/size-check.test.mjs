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

test('docs, tests, texts and styles only are tiny, with no reviewer', () => {
  const r = size(change({}, { 'docs/a.md': 'x\n', 'src/a.test.ts': "it('x', () => {});\n", 'src/locales/en/a.json': '{"a":"b"}\n', 'src/a.css': '.a{}\n' }));
  assert.equal(r.size, 'tiny');
  assert.match(r.roles[0], /no reviewer/);
});

test('a plain behavior change is small; its changed functions are listed with their callers', () => {
  const page = 'export function Page() {\n  function pick(next) {\n    return next;\n  }\n  return [pick(1), pick(2)];\n}\n';
  const repo = change({ 'src/Page.tsx': page }, { 'src/Page.tsx': page.replace('return next;', 'return next + 1;') });
  const r = size(repo);
  assert.equal(r.size, 'small');
  assert.match(r.roles.join(' '), /whole-diff \(Sonnet\), fresh eyes \(Opus\), other engine \(Codex\)/);
  const pick = r.callers.find(c => c.name === 'pick');
  assert.ok(pick, JSON.stringify(r.callers));
  assert.equal(pick.count, 2);
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
  assert.match(q.roles.join(' '), /boss answers the open question first/);
  assert.match(q.roles.join(' '), /Database expert/);
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
