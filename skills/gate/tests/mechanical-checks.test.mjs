import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The project's mechanical check lives outside the gate skill: ~/.claude/scripts/eduquest/.
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'eduquest', 'mechanical-checks.mjs');
const skip = fs.existsSync(script) ? false : 'no scripts/eduquest/mechanical-checks.mjs next to this skill (' + script + ')';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mechanical-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

// A repo with the EduQuest folder shapes and a `base` branch at its first commit.
function fixture(files = {}) {
  const repo = fs.mkdtempSync(path.join(root, 'repo-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (n, t) => { fs.mkdirSync(path.dirname(path.join(repo, n)), { recursive: true }); fs.writeFileSync(path.join(repo, n), t); };
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'core.autocrlf', 'false');
  write('README.md', 'x\n');
  for (const [n, t] of Object.entries(files)) write(n, t);
  git('add', '-A'); git('commit', '-qm', 'base'); git('branch', 'base');
  const commit = () => { git('add', '-A'); git('commit', '-qm', 'work'); };
  return { repo, git, write, commit };
}
const run = (repo) => {
  const r = spawnSync(process.execPath, [script, '--repo', repo, '--base', 'base'], { encoding: 'utf8', windowsHide: true });
  return { code: r.status, out: r.stdout + r.stderr };
};

const CONTROLLER = (name, actions) => [
  'namespace EduQuest.Api.Controllers;',
  '',
  '[ApiController]',
  '[Route("api/v{version:apiVersion}/[controller]")]',
  `public class ${name}Controller : ControllerBase`,
  '{',
  ...actions,
  '}',
  '',
].join('\n');

// 2026-11-12 (audit C2): a new file not yet added to git was in no diff, so every check skipped it.
test('a new untracked controller and locale pair are checked', { skip }, () => {
  const { repo, write } = fixture();
  write('EduQuest/EduQuest.Api/Controllers/WidgetsController.cs', CONTROLLER('Widgets', [
    '    [HttpPost]',
    '    public async Task<IActionResult> Create() => Ok();',
  ]));
  write('eduquest-frontend/src/i18n/locales/en/widgets.ts', "export default {\n  title: 'Widgets',\n  empty: 'No widgets',\n};\n");
  write('eduquest-frontend/src/i18n/locales/ar/widgets.ts', "export default {\n  title: 'Widgets AR',\n};\n");
  const r = run(repo);
  assert.match(r.out, /GAP — EduQuest\/EduQuest\.Api\/Controllers\/WidgetsController\.cs — new \[HttpPost\] WidgetsController\.Create has no test naming it/);
  assert.match(r.out, /BUG — eduquest-frontend\/src\/i18n\/locales\/ar\/widgets\.ts — missing in AR: empty/);
  assert.match(r.out, /MECHANICAL: 1 bugs, 1 gaps/);
  assert.equal(r.code, 1, r.out);
});

// 2026-11-12 (audit C7a): `[HttpPut("{id}")]` left an empty route remainder, and "".includes is always
// true, so no id-only write endpoint was ever flagged; an action name counted as tested when ANY
// controller's test named it.
test('an id-only route or an action named only in another controller\'s test is not a test', { skip }, () => {
  const { repo, write, commit } = fixture();
  write('EduQuest/EduQuest.Api/Controllers/WidgetsController.cs', CONTROLLER('Widgets', [
    '    [HttpPut("{id}")]',
    '    public async Task<IActionResult> Update(long id) => Ok();',
    '',
    '    [HttpPost]',
    '    public async Task<IActionResult> Create() => Ok();',
  ]));
  write('EduQuest/EduQuest.Tests/Controllers/GadgetsControllerTests.cs', [
    'public class GadgetsControllerTests',
    '{',
    '    [Fact] public async Task Update_AnonymousIs401() { var c = new GadgetsController(); }',
    '    [Fact] public async Task Create_WrongRoleIs403() { var c = new GadgetsController(); }',
    '}',
  ].join('\n'));
  commit();
  const r = run(repo);
  assert.match(r.out, /GAP — \S+WidgetsController\.cs — new \[HttpPut\] WidgetsController\.Update has no test naming it/);
  assert.match(r.out, /GAP — \S+WidgetsController\.cs — new \[HttpPost\] WidgetsController\.Create has no test naming it/);
});

test('still passes: a test that names the action and the controller, by class name or by route', { skip }, () => {
  const { repo, write, commit } = fixture();
  write('EduQuest/EduQuest.Api/Controllers/WidgetsController.cs', CONTROLLER('Widgets', [
    '    [HttpPut("{id}")]',
    '    public async Task<IActionResult> Update(long id) => Ok();',
    '',
    '    [HttpPost]',
    '    public async Task<IActionResult> Create() => Ok();',
  ]));
  write('EduQuest/EduQuest.Tests/Controllers/WidgetsControllerTests.cs', [
    'public class WidgetsControllerTests',
    '{',
    '    [Fact] public async Task Update_AnonymousIs401() { var c = new WidgetsController(); }',
    '}',
  ].join('\n'));
  write('EduQuest/EduQuest.Tests/Controllers/WidgetHttpTests.cs', [
    'public class WidgetHttpTests',
    '{',
    '    [Fact] public async Task Create_WrongRoleIs403() { await client.PostAsync("/api/v1/widgets", null); }',
    '}',
  ].join('\n'));
  commit();
  const r = run(repo);
  assert.doesNotMatch(r.out, /WidgetsController\.(?:Update|Create) has no test/, r.out);
  assert.match(r.out, /MECHANICAL: 0 bugs, 0 gaps/);
});

// 2026-11-12 (audit C7b, QuestionsTab.tsx `title: t('exams.ruleGenerated', { count: res.added })`): a number
// in a dialog title was called markup, and pre-review went red.
test('a count, total, length or number in a SweetAlert2 title is not user text; a name still is', { skip }, () => {
  const { repo, write, commit } = fixture();
  write('eduquest-frontend/src/pages/w/Numbers.tsx', [
    "import Swal from 'sweetalert2';",
    'export function f(t, res, short, items, rows, x, n) {',
    "      void Swal.fire({ icon: res.added > 0 ? 'success' : 'info', title: t('exams.ruleGenerated', { count: res.added }), text: short ? t('exams.ruleShortfall', { count: short }) : '', confirmButtonColor: '#4f29b7' });",
    '  void Swal.fire({ title: `${items.length} removed` });',
    "  void Swal.fire({ title: t('w.removed', { total: rows.length, n: Number(x), selectedCount }) });",
    "  void Swal.fire({ html: t('w.many', { count }) });",
    '}',
  ].join('\n'));
  write('eduquest-frontend/src/pages/w/Names.tsx', [
    "import Swal from 'sweetalert2';",
    'export function g(t, student, n, name) {',
    "  void Swal.fire({ title: t('w.hello', { name: student.name }) });",
    "  void Swal.fire({ title: t('w.mixed', { count: n, name }) });",
    '  void Swal.fire({ title: `${student.name} removed` });',
    '}',
  ].join('\n'));
  commit();
  const r = run(repo);
  assert.doesNotMatch(r.out, /BUG — eduquest-frontend\/src\/pages\/w\/Numbers\.tsx/, r.out);
  for (const n of [3, 4, 5]) assert.match(r.out, new RegExp(`BUG — eduquest-frontend/src/pages/w/Names\\.tsx:${n} — a value is put into a SweetAlert2 title`));
  assert.match(r.out, /MECHANICAL: 3 bugs/);
});
