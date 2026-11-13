import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'pre-review.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-review-'));
const env = { ...process.env, SANAD_STATE_DIR: path.join(root, 'state') };
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

// A repo with one web package whose eslint and tsc are tiny fakes that pass, or fail when a
// changed file holds the word BAD.
function fixture({ mechanical } = {}) {
  const repo = fs.mkdtempSync(path.join(root, 'repo-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (n, t) => { fs.mkdirSync(path.dirname(path.join(repo, n)), { recursive: true }); fs.writeFileSync(path.join(repo, n), t); };
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'core.autocrlf', 'false');
  write('web/package.json', '{"name":"web"}\n');
  write('web/tsconfig.app.json', '{}\n');
  write('web/.gitignore', 'node_modules/\n');
  const fake = (label) => `const fs=require('fs');const files=process.argv.slice(2).filter(a=>/\\.[jt]sx?$/.test(a));` +
    `const bad=files.some(f=>fs.existsSync(f)&&fs.readFileSync(f,'utf8').includes('BAD'));console.log('${label} ran on '+files.length);process.exit(bad?1:0);`;
  write('web/node_modules/eslint/bin/eslint.js', fake('eslint'));
  write('web/node_modules/typescript/bin/tsc', `console.log('tsc ' + process.argv.slice(2).join(' ')); process.exit(require('fs').readFileSync('src/a.ts','utf8').includes('TYPEBAD') ? 1 : 0);`);
  write('web/src/a.ts', 'export const a = 1;\n');
  write('README.md', 'x\n');
  git('add', '-A'); git('commit', '-qm', 'base'); git('branch', 'base');
  if (mechanical) { write('mech.mjs', mechanical); git('config', 'sanad.mechanical', path.join(repo, 'mech.mjs')); }
  return { repo, git, write };
}
const run = (repo, args = []) => spawnSync(process.execPath, [script, '--repo', repo, '--base', 'base', ...args], { encoding: 'utf8', env, windowsHide: true });
const placesScript = path.join(path.dirname(script), 'places.mjs');
// The places list for `names` in `repo`, outside it, every place given an outcome unless `open` (2026-11-12).
function placesFor(repo, names = 'a', { open = false } = {}) {
  const out = path.join(fs.mkdtempSync(path.join(root, 'notes-')), 'places.md');
  const made = spawnSync(process.execPath, [placesScript, '--repo', repo, '--names', names, '--out', out], { encoding: 'utf8', windowsHide: true });
  assert.equal(made.status, 0, made.stdout + made.stderr);
  if (!open) fs.writeFileSync(out, fs.readFileSync(out, 'utf8').replace(/→ $/gm, '→ none: unchanged on purpose in this fixture'));
  return out;
}

test('every check passes: lint, types, size, places and the project check, with one summary', () => {
  const { repo, write } = fixture({ mechanical: "console.log('MECHANICAL: 0 bugs'); process.argv.includes('--repo') || process.exit(9);" });
  write('web/src/a.ts', 'export const a = 2;\n');
  const r = run(repo, ['--places', placesFor(repo)]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /PRE-REVIEW: 7 of 7 checks passed/);
  for (const name of ['lint web \\(1 file\\)', 'types web', 'test asserts', 'commits', 'size', 'places', 'mechanical']) assert.match(r.stdout, new RegExp('✓ ' + name));
  assert.match(r.stdout, /✓ places[^\n]*\n\s+PLACES: 1 place\(s\), 0 open/, 'the count shows also when it passes');
  assert.match(r.stdout, /MECHANICAL: 0 bugs/, 'the project check got --repo');
});

// 2026-11-12: rule 1 ("list every place that uses what you change, by search") was text and was skipped; a
// date rule was fixed on the "schedule" path and missed on the "publish now" path.
test('places: a code change with no --places is NOT RUN and fails, with the command that makes the list', () => {
  const { repo, write } = fixture();
  write('web/src/a.ts', 'export const a = 12;\n');
  const r = run(repo);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^PRE-REVIEW: 5 of 6 checks passed · 3 skipped/m);
  const cmd = `node ${placesScript.replace(/\\/g, '/')} --repo ${repo.replace(/\\/g, '/')} --names <names> --out <notes>/places.md`;
  assert.ok(r.stdout.includes(`  ✗ places — NOT RUN\n      list every place that uses what you change: ${cmd}`), r.stdout);
});

test('places: a text-only change needs no list, and says so as skipped', () => {
  const { repo, write } = fixture();
  write('README.md', 'y\n');
  const r = run(repo);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^PRE-REVIEW: 3 of 3 checks passed · 4 skipped: ticket lines, test labels, size growth, places · /m);
  assert.match(r.stdout, /\n {2}– places: skipped \(a text-only change\)/);
});

test('places: the list is searched again first, every place needs an outcome, and --check numbers the check lines', async () => {
  const { planChecks } = await import('../scripts/pre-review.mjs');
  const { repo, write } = fixture();
  write('web/src/a.ts', 'export const a = 13;\n');
  const list = placesFor(repo, 'a', { open: true });
  const open = run(repo, ['--places', list]);
  assert.equal(open.status, 1, open.stdout);
  assert.match(open.stdout, /✗ places[^\n]*\n\s+OPEN: P1 · a · web\/src\/a\.ts · \(file\)\n\s+PLACES: 1 place\(s\), 1 open/);
  fs.writeFileSync(list, fs.readFileSync(list, 'utf8').replace(/→ $/m, '→ C1'));
  // A place that appears after the list was written (a new caller in an untracked file) cannot be missed.
  write('web/src/b.ts', "import { a } from './a';\n");
  const late = run(repo, ['--places', list]);
  assert.equal(late.status, 1, late.stdout);
  assert.match(late.stdout, /OPEN: P2 · a · web\/src\/b\.ts · \(file\)/);
  assert.match(fs.readFileSync(list, 'utf8'), /^P2 \(new\) · a · web\/src\/b\.ts · \(file\) · lines 1 → $/m, 'the list itself was refreshed');
  fs.writeFileSync(list, fs.readFileSync(list, 'utf8').replace(/→ $/m, '→ none: imports it only to re-export it'));
  const ok = run(repo, ['--places', list]);
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /✓ places/);
  const check = planChecks({ repo, base: 'base', node: process.execPath, remote: null, places: list, check: 'c.md' }).checks.find(c => c.name === 'places');
  assert.deepEqual(check.args.slice(1), ['--refresh', list, '--repo', repo, '--check', list, '--check-lines', 'c.md']);
});

// 2026-11-10 (PR #767): two C# files from an earlier commit failed CI's format check after the push.
test('changed C# files get the project CSharpier check, from the folder whose tool manifest lists it', async () => {
  const { planChecks } = await import('../scripts/pre-review.mjs');
  const { repo, git, write } = fixture();
  write('Api/.config/dotnet-tools.json', '{"tools":{"csharpier":{"version":"1.0.0","commands":["csharpier"]}}}\n');
  write('Api/Svc/A.cs', 'class A {}\n');
  write('Tools/B.cs', 'class B {}\n');
  git('add', '-A'); git('commit', '-qm', 'base 2'); git('branch', '-f', 'base');
  write('Api/Svc/A.cs', 'class A { }\n');
  write('Api/Svc/New.cs', 'class N {}\n');
  write('Tools/B.cs', 'class B { }\n');
  const { checks } = planChecks({ repo, base: 'base', node: process.execPath });
  const format = checks.filter(c => c.name.startsWith('format'));
  assert.equal(format.length, 1, 'one check for the folder with the manifest; a .cs file outside it gets none');
  assert.equal(format[0].name, 'format Api (2 C# files)');
  assert.equal(format[0].cmd, 'dotnet');
  assert.deepEqual(format[0].args, ['csharpier', 'check', 'Svc/A.cs', 'Svc/New.cs']);
  assert.equal(path.resolve(format[0].cwd), path.resolve(repo, 'Api'));
  write('Api/Svc/A.cs', 'class A {}\n'); write('Api/Svc/New.cs', ''); fs.rmSync(path.join(repo, 'Api/Svc/New.cs'));
  write('Tools/B.cs', 'class B {}\n');
  assert.equal(planChecks({ repo, base: 'base', node: process.execPath }).checks.filter(c => c.name.startsWith('format')).length, 0, 'no changed C# file, no format check');
});

test('a failing check fails the run and shows its output; the others still run', () => {
  const { repo, write } = fixture();
  write('web/src/a.ts', 'export const a = "BAD";\n');
  const r = run(repo);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /✗ lint web/);
  assert.match(r.stdout, /eslint ran on 1/);
  assert.match(r.stdout, /✓ types web/);
  assert.match(r.stdout, /✓ size/);
});

test('the type check is incremental, with its build info outside the repo', () => {
  const { repo, write } = fixture();
  write('web/src/a.ts', 'export const a = 3;\n');
  const r = run(repo);
  assert.match(r.stdout, /✓ types web/);
  assert.equal(fs.readdirSync(path.join(repo, 'web')).some(n => /tsbuildinfo/.test(n)), false);
});

test('ticket lines run when a lines file is given, and --was fails a grown change', () => {
  const { repo, write } = fixture();
  write('web/src/a.test.ts', "// STORY-1: \"The total shows once\"\nit('x', () => {});\n");
  write('web/src/a.ts', 'export const a = 4;\n');
  const lines = path.join(root, 'lines.md');
  fs.writeFileSync(lines, '- The total shows once\n');
  const ok = run(repo, ['--lines', lines, '--was', 'small', '--places', placesFor(repo)]);
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /✓ ticket lines/);
  write('Api/Migrations/20260101_X.cs', 'public class X : Migration { }\n');
  const grew = run(repo, ['--was', 'small']);
  assert.equal(grew.status, 1);
  assert.match(grew.stdout, /✗ size/);
  assert.match(grew.stdout, /SIZE GREW: small → big/);
});

test('it checks the repository it is given, not another one, and refuses a non-repo', () => {
  const { repo, write } = fixture();
  write('web/src/a.ts', 'export const a = 5;\n');
  const inside = spawnSync(process.execPath, [script, '--base', 'base'], { cwd: path.join(repo, 'web'), encoding: 'utf8', env });
  assert.ok(inside.stdout.split(/\r?\n/)[0].endsWith(path.basename(repo)), 'the current folder is the default: ' + inside.stdout);
  assert.equal(spawnSync(process.execPath, [script, '--repo', root], { encoding: 'utf8', env }).status, 2);
});

// 2026-11-11 (TUW-242, TUW-243): a task's own folder (a new git worktree) has no node_modules. Lint and types
// were left out without a word, and the summary still read "6 of 6 checks passed".
function noModulesFixture() {
  const f = fixture();
  f.write('app/package.json', '{"name":"app","devDependencies":{"eslint":"^9.0.0","typescript":"~5.9.0"}}\n');
  f.write('app/tsconfig.json', '{}\n');
  f.write('app/src/b.ts', 'export const b = 1;\n');
  f.git('add', '-A'); f.git('commit', '-qm', 'base with app'); f.git('branch', '-f', 'base');
  f.write('app/src/b.ts', 'export const b = 2;\n');
  f.write('web/src/a.ts', 'export const a = 6;\n');
  return f;
}

test('a package with no node_modules here: lint and types run in the clone on the test machine', async () => {
  const { planChecks, preReview } = await import('../scripts/pre-review.mjs');
  const { repo } = noModulesFixture();
  const remote = { host: 'pc2', repo: 'C:/r/My App', node: 'C:/n/node.exe' };
  const { checks } = planChecks({ repo, base: 'base', node: process.execPath, remote });
  const named = (start) => checks.filter(c => c.name.startsWith(start));
  assert.deepEqual(named('lint').map(c => c.name).sort(), ['lint app (1 file, on pc2)', 'lint web (1 file)'], 'the package with node_modules stays here');
  const [lint] = named('lint app'), [types] = named('types app');
  assert.equal(lint.cmd, 'ssh'); assert.equal(lint.remote, true);
  const there = String.raw`cd /d "C:\r\My App\app" && C:/n/node.exe `;
  assert.deepEqual(lint.args.slice(-2), ['pc2', there + 'node_modules/eslint/bin/eslint.js src/b.ts']);
  assert.equal(types.name, 'types app (on pc2)');
  assert.ok(types.args.at(-1).startsWith(there + String.raw`node_modules/typescript/bin/tsc -p tsconfig.json --noEmit --incremental --tsBuildInfoFile %TEMP%\sanad-tsc-`), types.args.at(-1));
  assert.match(types.args.at(-1), /sanad-tsc-[0-9a-f]{12}\.tsbuildinfo$/);
  assert.equal(named('types web')[0].cmd, process.execPath, 'types of the package with node_modules stay here');
  // A clone on a machine that is not Windows.
  const posix = planChecks({ repo, base: 'base', node: process.execPath, remote: { host: 'box', repo: '/srv/app', node: 'node' } }).checks.find(c => c.name.startsWith('lint app'));
  assert.equal(posix.args.at(-1), "cd '/srv/app/app' && node node_modules/eslint/bin/eslint.js src/b.ts");

  // The sync fails (the machine is down, or another task's check runs there): the two checks fail by name.
  const down = await preReview({ repo, base: 'base', node: process.execPath, remote, sync: () => ({ ok: false, text: 'REMOTE-DOWN: pc2 does not answer' }) });
  assert.equal(down.ok, false);
  assert.match(down.text, /✗ lint app \(1 file, on pc2\) — NOT RUN\n\s+not run on pc2: REMOTE-DOWN: pc2 does not answer/);
  assert.match(down.text, /✗ types app \(on pc2\) — NOT RUN/);
  assert.match(down.text, /✓ lint web \(1 file\)/, 'the other checks still run');
});

test('no node_modules and no test machine: lint and types show as NOT RUN and fail the run', () => {
  const { repo } = noModulesFixture();
  const r = run(repo);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /✗ lint app \(1 file\) — NOT RUN\n\s+no node_modules in app, and no test machine is set/);
  assert.match(r.stdout, /✗ types app — NOT RUN/);
  assert.doesNotMatch(r.stdout, /PRE-REVIEW: (\d+) of \1 checks passed/, 'never "all passed" with a check left out');
});

test('a package that lists no lint or type tool owes none', async () => {
  const { planChecks } = await import('../scripts/pre-review.mjs');
  const { repo, git, write } = fixture();
  write('docs/package.json', '{"name":"docs"}\n');
  write('docs/tsconfig.json', '{}\n');
  write('docs/x.ts', 'export const x = 1;\n');
  git('add', '-A'); git('commit', '-qm', 'docs'); git('branch', '-f', 'base');
  write('docs/x.ts', 'export const x = 2;\n');
  const { checks } = planChecks({ repo, base: 'base', node: process.execPath, remote: null });
  assert.deepEqual(checks.filter(c => / docs/.test(c.name)), []);
});

// 2026-11-12 (audit C14): with no --lines, --check or --was those parts were left out without a word, and the
// summary still read "N of N checks passed".
test('a part left out for a missing option is named as skipped, and is not a failure', async () => {
  const { planChecks } = await import('../scripts/pre-review.mjs');
  const { repo, write } = fixture();
  write('web/src/a.ts', 'export const a = 7;\n');
  const r = run(repo, ['--places', placesFor(repo)]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^PRE-REVIEW: 6 of 6 checks passed · 3 skipped: ticket lines, test labels, size growth · 1 changed file\(s\) · /);
  assert.match(r.stdout, /\n {2}– ticket lines: skipped \(no --lines\)\n {2}– test labels: skipped \(no --check\)\n {2}– size growth: skipped \(no --was\)/);
  const all = planChecks({ repo, base: 'base', node: process.execPath, remote: null, lines: 'l.md', check: 'c.md', was: 'small', places: 'p.md' });
  assert.deepEqual(all.skipped, [], 'every option given: nothing skipped');
});

test('the project check\'s GAP and NOTE lines show also when it passes', () => {
  const { repo, write } = fixture({ mechanical: "console.log('GAP — Api/A.cs — new [HttpPost] A.Create has no test naming it'); console.log('NOTE — web/b.ts — read the texts'); console.log('MECHANICAL: 0 bugs, 1 gaps, 1 notes');" });
  write('web/src/a.ts', 'export const a = 8;\n');
  const r = run(repo, ['--places', placesFor(repo)]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /✓ mechanical[^\n]*\n\s+GAP — Api\/A\.cs — new \[HttpPost\] A\.Create has no test naming it\n\s+NOTE — web\/b\.ts — read the texts\n\s+MECHANICAL: 0 bugs, 1 gaps, 1 notes/);
});

test('a failing check shows every ✗, GAP, BUG, UNTAGGED, UNPROVEN and NOT RUN line, then its last 12 lines', () => {
  const { repo, write } = fixture({ mechanical: [
    "console.log('BUG — first.tsx:3 — a value in a title');",
    "console.log('  ✗ L2 \"a ticket line\" — no test quotes it');",
    "for (let i = 0; i < 20; i++) console.log('detail ' + i);",
    "console.log('UNPROVEN: a.test.ts:4 — expect(x).not.toHaveBeenCalled()');",
    "console.log('MECHANICAL: 1 bugs, 0 gaps, 0 notes');",
    'process.exit(1);',
  ].join('\n') });
  write('web/src/a.ts', 'export const a = 9;\n');
  const r = run(repo);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const shown = r.stdout.split(/\r?\n/).map((l) => l.trim());
  for (const l of ['BUG — first.tsx:3 — a value in a title', '✗ L2 "a ticket line" — no test quotes it', 'UNPROVEN: a.test.ts:4 — expect(x).not.toHaveBeenCalled()', 'MECHANICAL: 1 bugs, 0 gaps, 0 notes', 'detail 10', 'detail 19'])
    assert.equal(shown.filter((s) => s === l).length, 1, l + ' shown once:\n' + r.stdout);
  assert.equal(shown.includes('detail 9'), false, 'a plain line above the last 12 stays hidden');
  assert.ok(shown.indexOf('BUG — first.tsx:3 — a value in a title') < shown.indexOf('detail 10'), 'lines keep their order');
});

// 2026-11-12 (audit C15): types ran only tsconfig.app.json, so vite.config.ts and vitest.config.ts (in
// tsconfig.node.json) were never type checked, while `tsc -b` in the build checks both.
test('types run for every project the root tsconfig references, each under its own name', async () => {
  const { planChecks } = await import('../scripts/pre-review.mjs');
  const { repo, git, write } = fixture();
  const refs = '{\n  // the two projects, as Vite writes them\n  "$schema": "https://json.schemastore.org/tsconfig",\n  "files": [],\n  "references": [\n    { "path": "./tsconfig.app.json" },\n    { "path": "./tsconfig.node.json" },\n  ],\n}\n';
  write('web/tsconfig.json', refs);
  write('web/tsconfig.node.json', '{}\n');
  write('app/package.json', '{"name":"app","devDependencies":{"eslint":"^9.0.0","typescript":"~5.9.0"}}\n');
  write('app/tsconfig.json', refs);
  write('app/src/b.ts', 'export const b = 1;\n');
  git('add', '-A'); git('commit', '-qm', 'two projects'); git('branch', '-f', 'base');
  write('web/src/a.ts', 'export const a = 10;\n');
  write('app/src/b.ts', 'export const b = 2;\n');
  const { checks } = planChecks({ repo, base: 'base', node: process.execPath, remote: { host: 'pc2', repo: 'C:/r/App', node: 'node' } });
  const here = checks.filter((c) => c.name.startsWith('types web'));
  assert.deepEqual(here.map((c) => c.name), ['types web (app)', 'types web (node)']);
  assert.deepEqual(here.map((c) => c.args[c.args.indexOf('-p') + 1]), ['tsconfig.app.json', 'tsconfig.node.json']);
  assert.notEqual(here[0].args.at(-1), here[1].args.at(-1), 'each project keeps its own build info');
  const there = checks.filter((c) => c.name.startsWith('types app'));
  assert.deepEqual(there.map((c) => c.name), ['types app (app, on pc2)', 'types app (node, on pc2)']);
  assert.match(there[1].args.at(-1), /tsc -p tsconfig\.node\.json --noEmit/);
  const r = run(repo);
  assert.match(r.stdout, /✓ types web \(app\)/);
  assert.match(r.stdout, /✓ types web \(node\)/);
  // tsconfig is JSON with comments: a BOM, a // inside a string, a block comment and trailing commas.
  const { readJsonc } = await import('../scripts/pre-review.mjs');
  const jsonc = path.join(repo, 'web', 'odd.json');
  fs.writeFileSync(jsonc, String.fromCharCode(0xfeff) + '{"a": "x // y", /* note, */ "b": [1, 2,], // end\n}');
  assert.deepEqual(readJsonc(jsonc), { a: 'x // y', b: [1, 2] });
  assert.equal(readJsonc(path.join(repo, 'web', 'missing.json')), null);
});

test('ESLint fails on a warning, and the C# format check also gets changed project files', async () => {
  const { planChecks } = await import('../scripts/pre-review.mjs');
  const { repo, git, write } = fixture();
  write('Api/.config/dotnet-tools.json', '{"tools":{"csharpier":{"version":"1.3.0","commands":["csharpier"]}}}\n');
  write('Api/Api.csproj', '<Project />\n');
  write('Api/Directory.Build.props', '<Project />\n');
  write('Api/Build.targets', '<Project />\n');
  write('Api/A.cs', 'class A {}\n');
  git('add', '-A'); git('commit', '-qm', 'api'); git('branch', '-f', 'base');
  write('Api/Api.csproj', '<Project>\n</Project>\n');
  write('Api/Directory.Build.props', '<Project>\n</Project>\n');
  write('Api/Build.targets', '<Project>\n</Project>\n');
  write('web/src/a.ts', 'export const a = 11;\n');
  const { checks } = planChecks({ repo, base: 'base', node: process.execPath, remote: null });
  const lint = checks.find((c) => c.name.startsWith('lint web'));
  assert.equal(lint.args.includes('--max-warnings'), false, 'old warnings in a touched file must not fail the task');
  const format = checks.filter((c) => c.name.startsWith('format'));
  assert.equal(format.length, 1);
  assert.deepEqual(format[0].args, ['csharpier', 'check', 'Api.csproj', 'Build.targets', 'Directory.Build.props']);
  assert.equal(format[0].name, 'format Api (3 project files)');
});

// The clone on the test machine is one folder: a sync while another task's check runs there would change
// the code under that check.
test('another task whose check runs on the test machine now is seen; this task, a finished or a dead one is not', async () => {
  const { otherTaskOnRemote } = await import('../scripts/pre-review.mjs');
  const dir = fs.mkdtempSync(path.join(root, 'locks-'));
  const before = process.env.SANAD_CHECK_LOCK_DIR;
  process.env.SANAD_CHECK_LOCK_DIR = dir;
  try {
    const remote = { host: 'pc2', repo: 'C:/r/App', node: 'node' };
    const mine = path.join(root, 'mine'), other = path.join(root, 'other');
    const lock = (name, over) => fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify({ toplevel: other, pid: process.pid,
      expiresAt: new Date(Date.now() + 600000).toISOString(), command: 'C:/Windows/System32/OpenSSH/ssh.exe -o BatchMode=yes pc2 cd /d C:\r\App && dotnet test', ...over }));
    assert.equal(otherTaskOnRemote(mine, remote), '', 'no lock, no other task');
    lock('same', { toplevel: mine });
    lock('expired', { expiresAt: new Date(Date.now() - 1000).toISOString() });
    lock('dead', { pid: 2147483646 });
    lock('local', { command: 'dotnet test App.sln' });
    lock('other-host', { command: 'ssh pc20 dotnet test' });
    fs.writeFileSync(path.join(dir, 'half-written.json'), '{"toplevel":');
    assert.equal(otherTaskOnRemote(mine, remote), '');
    lock('running');
    assert.equal(otherTaskOnRemote(mine, remote), other);
  } finally {
    if (before === undefined) delete process.env.SANAD_CHECK_LOCK_DIR; else process.env.SANAD_CHECK_LOCK_DIR = before;
  }
});
