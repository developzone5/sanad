// 2026-11-25 (owner, test 4): the places list missed the Settings badges and the view-as strip, which showed the same role
// value by another path than the function names it searched; the review found them two rounds later. places.mjs --data
// takes the data the change touches (`user.roles`: a field on any receiver whose name ends in the owner word; a text key's
// last two parts, `enums.roles`) and lists every function that shows or writes it. The other reads fold into one
// `read only` line that names every file, so none is hidden.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'places.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'places-data-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
fs.writeFileSync(path.join(root, 'empty.gitconfig'), '');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: path.join(root, 'empty.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', SANAD_STATE_DIR: path.join(root, 'state') });
const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true });

// The shapes of test 4, small: the top bar, the view-as strip and the Settings badges show the role; the sidebar only
// checks it; a store writes it; another object has a field of the same name; a comment and a test mention it.
function fixture() {
  const repo = fs.mkdtempSync(path.join(root, 'repo-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (n, t) => { fs.mkdirSync(path.dirname(path.join(repo, n)), { recursive: true }); fs.writeFileSync(path.join(repo, n), t); };
  git('init', '-q'); git('config', 'core.autocrlf', 'false');
  write('src/Topbar.tsx', "export function Topbar({ user }) {\n  const displayRole = user?.roles[0] || 'User';\n  return <span>{displayRole}</span>;\n}\n");
  write('src/UserViewBar.tsx', 'export function UserViewBar({ viewingUser }) {\n  return (\n    <div>\n      {viewingUser.roles.map((r) => <b key={r}>{r}</b>)}\n    </div>\n  );\n}\n');
  write('src/SettingsPage.tsx', "export function SettingsPage({ currentUser, t }) {\n  const roles = currentUser?.roles ?? [];\n  const label = t(`users.enums.roles.${roles[0]}`);\n  return <p>{roles.join(', ')} {label}</p>;\n}\n");
  write('src/Sidebar.tsx', "export function Sidebar({ user }) {\n  const isAdmin = user?.roles.includes('Admin');\n  const kept = user.roles;\n  return isAdmin ? 1 : kept && 0;\n}\n");
  write('src/store.ts', 'export function setRoles(state, next) {\n  state.user.roles = next;\n}\n');
  write('src/copy.tsx', 'export function Copy({ copy }) {\n  return <i>{copy.roles.teacher}</i>;\n}\n');
  write('src/notes.ts', '// the sidebar reads user.roles to show its items\nexport const n = 1;\n');
  write('src/Topbar.test.tsx', "it('shows user.roles', () => {});\n");
  git('add', '-A');
  return { repo };
}

test('--data user.roles lists the functions that show or write the value, and folds the other reads with every file named', () => {
  const { repo } = fixture();
  const out = path.join(root, 'p1', 'places.md');
  const r = run(['--repo', repo, '--names', 'Topbar', '--data', 'user.roles', '--out', out]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const text = fs.readFileSync(out, 'utf8');
  const data = text.split('\n').filter((l) => /^P\d+ · data:user\.roles · /.test(l)).map((l) => l.replace(/^P\d+ · data:user\.roles · /, '').replace(/ →.*$/, ''));
  assert.deepEqual(data, [
    'src/SettingsPage.tsx · SettingsPage · lines 2',
    'src/Topbar.tsx · Topbar · lines 2',
    'src/UserViewBar.tsx · UserViewBar · lines 4',
    'src/store.ts · setRoles · lines 2']);
  // The yes/no check and the value kept but never shown fold; the line names the file. Another object's field, a
  // comment and a test are no reads of the value (the test is listed apart, as for every name).
  assert.match(text, /^F1 · data:user\.roles · read only · 2 use\(s\) in 1 file\(s\) · files: src\/Sidebar\.tsx$/m);
  assert.match(text, /^Tests that mention it: src\/Topbar\.test\.tsx$/m);
  assert.doesNotMatch(text, /copy\.tsx|notes\.ts/);
  assert.match(text, /^Names: Topbar, data:user\.roles$/m);
  assert.match(fs.readFileSync(path.join(root, 'p1', 'places.folded.md'), 'utf8'), /^- src\/Sidebar\.tsx · lines 2, 3$/m);
  assert.match(r.stdout, /PLACES: 5 place\(s\), 5 open, 2 folded/);
  // A refresh keeps the data name and its folded line; --unfold lists the folded reads as open places.
  const again = run(['--refresh', out, '--unfold', 'F1']);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(fs.readFileSync(out, 'utf8'), /^P\d+ \(new\) · data:user\.roles · src\/Sidebar\.tsx · Sidebar · lines 2, 3 → $/m);
});

test('--data enums.roles: a text key inside a quoted text or a template is a read to be shown; a `${…}` hole is code', () => {
  const { repo } = fixture();
  const out = path.join(root, 'p2', 'places.md');
  const r = run(['--repo', repo, '--names', 'Topbar', '--data', 'enums.roles', '--out', out]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(fs.readFileSync(out, 'utf8'), /^P2 · data:enums\.roles · src\/SettingsPage\.tsx · SettingsPage · lines 3 → $/m);
});

// Review (2026-11-25): reads that show or write the value hid in neither list (open or folded): a count on a JSX line, a
// kept value passed into a call on a JSX line, a destructured read, a bracket read, a write in an object built from the
// owner, a C# PascalCase field, and an export column that passes the value on.
test('--data user.roles: the shapes the review found are open places', () => {
  const { repo } = fixture();
  const write = (n, t) => fs.writeFileSync(path.join(repo, n), t);
  write('src/Count.tsx', 'export function Count({ user }) {\n  return <b>{user.roles.length}</b>;\n}\n');
  write('src/Badge.tsx', 'export function Badge({ user }) {\n  const roles = user.roles;\n  return (\n    <div>\n      {renderBadge(roles)}\n    </div>\n  );\n}\n');
  write('src/D.tsx', "export function D({ user }) {\n  const { roles } = user;\n  return <span>{roles.join(', ')}</span>;\n}\n");
  write('src/Br.tsx', "export function Br({ user }) {\n  const r = user['roles'];\n  return <i>{r}</i>;\n}\n");
  write('src/save.ts', 'export function save(user, next) {\n  return { ...user, roles: next };\n}\n');
  write('src/Dto.cs', 'public class Dto {\n  public void Set(UserDto user, string[] next) {\n    user.Roles = next;\n  }\n}\n');
  write('src/x.ts', 'export function rows(data, l) {\n  return data.rows.map(user => [\n    user.name,\n    list(user.roles.map(r => l[r])),\n  ]);\n}\n');
  const out = path.join(root, 'p9', 'places.md');
  const r = run(['--repo', repo, '--names', 'Topbar', '--data', 'user.roles', '--out', out]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const text = fs.readFileSync(out, 'utf8');
  for (const f of ['src/Count.tsx', 'src/Badge.tsx', 'src/D.tsx', 'src/Br.tsx', 'src/save.ts', 'src/Dto.cs', 'src/x.ts']) {
    assert.match(text, new RegExp(`^P\\d+ · data:user\\.roles · ${f.replace(/[.]/g, '\\.')} · `, 'm'), f + '\n' + text);
  }
  // The yes/no check still folds.
  assert.match(text, /^F1 · data:user\.roles · read only · .* · files: src\/Sidebar\.tsx$/m);
});

test('--data refuses a name that is not <owner>.<field>', () => {
  const { repo } = fixture();
  const r = run(['--repo', repo, '--names', 'Topbar', '--data', 'roles', '--out', path.join(root, 'p3', 'places.md')]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--data: "roles" is not <owner>\.<field>/);
});
