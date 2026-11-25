import './neutral-git-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'pre-review.mjs');
// 2026-11-22: the long name of the temp folder (CI's temp is a short 8.3 name, RUNNER~1, and a kept check result named the long one).
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pre-review-')));
const env = { ...process.env, SANAD_STATE_DIR: path.join(root, 'state') };
// The checks this file runs in its own process keep their state in the same temp folder, never in the real one.
process.env.SANAD_STATE_DIR = env.SANAD_STATE_DIR;
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
const siblingsScript = path.join(path.dirname(script), 'siblings.mjs');
// The sibling check's record next to a places list (2026-11-14): one sibling with `outcome` ('' leaves it open).
// 2026-11-17: S1 names the file of the place P1 (a.ts): a P<n> closes a sibling only in its own file (audit).
// `job`: the same-job line's outcome (2026-11-16); null writes a list with no same-job search.
function siblingsFor(places, outcome = 'P1', job = 'reuse') {
  const out = path.join(path.dirname(places), 'siblings.md');
  fs.writeFileSync(out, `# Siblings\n\nS1 · web/src/a.ts:1 · a — the same rule on another screen → ${outcome}\n` +
    (job === null ? '' : `\nJ1 · web/src/c.ts:1 · c — the same kind of job done before → ${job}\n`));
  return out;
}
// --places and --siblings for a change that is not text only, every place and sibling closed.
const closed = (repo) => { const places = placesFor(repo); return ['--places', places, '--siblings', siblingsFor(places)]; };

test('every check passes: lint, types, size, places, siblings and the project check, with one summary', () => {
  const { repo, write } = fixture({ mechanical: "console.log('MECHANICAL: 0 bugs'); process.argv.includes('--repo') || process.exit(9);" });
  write('web/src/a.ts', 'export const a = 2;\n');
  const r = run(repo, closed(repo));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /PRE-REVIEW: 9 of 9 checks passed/);
  for (const name of ['lint web \\(1 file\\)', 'types web', 'test asserts', 'commits', 'size', 'one job', 'places', 'siblings', 'mechanical']) assert.match(r.stdout, new RegExp('✓ ' + name));
  assert.match(r.stdout, /✓ places[^\n]*\n\s+PLACES: 1 place\(s\), 0 open/, 'the count shows also when it passes');
  assert.match(r.stdout, /✓ siblings[^\n]*\n\s+SIBLINGS: 1 found, 0 open/, 'the sibling count shows also when it passes');
  assert.match(r.stdout, /MECHANICAL: 0 bugs/, 'the project check got --repo');
});

// 2026-11-14: a focus fix listed three chip groups; three sibling fields with the same defect were found only at
// the final review. The author alone chose the names to search: another agent's second look is owed too.
test('siblings: a code change with no --siblings is NOT RUN and fails, with the command that starts the check', () => {
  const { repo, write } = fixture();
  write('web/src/a.ts', 'export const a = 14;\n');
  const r = run(repo, ['--places', placesFor(repo)]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^PRE-REVIEW: 7 of 8 checks passed · 3 skipped/m);
  const cmd = `node ${siblingsScript.replace(/\\/g, '/')} --brief --notes <notes> --repo ${fs.realpathSync.native(repo).replace(/\\/g, '/')}`;
  assert.ok(r.stdout.toLowerCase().includes(`  ✗ siblings — NOT RUN\n      look for the places the list misses, before code: ${cmd}`.toLowerCase()), r.stdout);
  assert.match(r.stdout, /--record <report> --notes <notes>/);
});

test('siblings: an open sibling fails the run and is named; closed, it passes; the check reads the places list after its refresh', async () => {
  const { planChecks } = await import('../scripts/pre-review.mjs');
  const { repo, write } = fixture();
  write('web/src/a.ts', 'export const a = 15;\n');
  const places = placesFor(repo);
  const open = run(repo, ['--places', places, '--siblings', siblingsFor(places, '')]);
  assert.equal(open.status, 1, open.stdout);
  assert.match(open.stdout, /✗ siblings[^\n]*\n\s+OPEN: S1 · web\/src\/a\.ts:1 · a\n\s+SIBLINGS: 1 found, 1 open/);
  const missing = run(repo, ['--places', places, '--siblings', siblingsFor(places, 'P7')]);
  assert.equal(missing.status, 1, missing.stdout);
  assert.match(missing.stdout, /OPEN: S1 · web\/src\/a\.ts:1 · a — P7 is not on the places list/, 'P<n> is checked against --places');
  const ok = run(repo, ['--places', places, '--siblings', siblingsFor(places, 'none: another screen with its own focus rule')]);
  assert.equal(ok.status, 0, ok.stdout);
  // 2026-11-16 (PR #784): the same kind of job done before needs reuse or a reason, and the search itself is required.
  const jobOpen = run(repo, ['--places', places, '--siblings', siblingsFor(places, 'P1', '')]);
  assert.equal(jobOpen.status, 1, jobOpen.stdout);
  assert.match(jobOpen.stdout, /✗ siblings[\s\S]*OPEN: J1 · web\/src\/c\.ts:1 · c/);
  const noSearch = run(repo, ['--places', places, '--siblings', siblingsFor(places, 'P1', null)]);
  assert.equal(noSearch.status, 1, noSearch.stdout);
  assert.match(noSearch.stdout, /OPEN: SAME JOB — the same-job search is missing/);
  const plan = planChecks({ repo, base: 'base', node: process.execPath, remote: null, places: 'p.md', siblings: 's.md' });
  const check = plan.checks.find((c) => c.name === 'siblings');
  assert.deepEqual(check.args, [siblingsScript, '--check', 's.md', '--places', 'p.md']);
  assert.equal(check.after, 'places', 'it starts when the places check, which rewrites the list, has ended');
  assert.equal(plan.siblingsOwed, false);
  const alone = planChecks({ repo, base: 'base', node: process.execPath, remote: null, siblings: 's.md' }).checks.find((c) => c.name === 'siblings');
  assert.deepEqual(alone.args, [siblingsScript, '--check', 's.md'], 'no --places: P<n> is not looked up');
  assert.equal(planChecks({ repo, base: 'base', node: process.execPath, remote: null }).siblingsOwed, true);
});

test('a check with `after` starts when that check has ended; every other check starts at once', async () => {
  const { runChecks } = await import('../scripts/pre-review.mjs');
  const log = [];
  const fake = (c) => new Promise((resolve) => {
    log.push('start ' + c.name);
    setTimeout(() => { log.push('end ' + c.name); resolve({ ...c, code: 0, out: '', ms: 0 }); }, c.name === 'places' ? 60 : 1);
  });
  const results = await runChecks([{ name: 'size' }, { name: 'places' }, { name: 'siblings', after: 'places' }, { name: 'commits' }], fake);
  assert.deepEqual(results.map((r) => r.name), ['size', 'places', 'siblings', 'commits'], 'results keep the plan order');
  assert.ok(log.indexOf('start siblings') > log.indexOf('end places'), log.join(', '));
  assert.ok(log.indexOf('start commits') < log.indexOf('end places'), 'the other checks do not wait: ' + log.join(', '));
  log.length = 0;
  await runChecks([{ name: 'siblings', after: 'places' }, { name: 'size' }], fake);
  assert.equal(log[0], 'start siblings', 'no places check planned: it starts at once');
});

// 2026-11-12: rule 1 ("list every place that uses what you change, by search") was text and was skipped; a
// date rule was fixed on the "schedule" path and missed on the "publish now" path.
test('places: a code change with no --places is NOT RUN and fails, with the command that makes the list', () => {
  const { repo, write } = fixture();
  write('web/src/a.ts', 'export const a = 12;\n');
  const r = run(repo);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  // 2026-11-14: the sibling check is owed too, and shows as its own NOT RUN line.
  assert.match(r.stdout, /^PRE-REVIEW: 6 of 8 checks passed · 3 skipped/m);
  // The repo as git names it: on CI the temp folder is RUNNER~1 to Node and runneradmin to git (2026-11-13).
  const cmd = `node ${placesScript.replace(/\\/g, '/')} --repo ${fs.realpathSync.native(repo).replace(/\\/g, '/')} --names <names> --out <notes>/places.md`;
  assert.ok(r.stdout.toLowerCase().includes(`  ✗ places — NOT RUN\n      list every place that uses what you change: ${cmd}`.toLowerCase()), r.stdout);
});

test('places and siblings: a text-only change needs neither, and says so as skipped', () => {
  const { repo, write } = fixture();
  write('README.md', 'y\n');
  const r = run(repo);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^PRE-REVIEW: 4 of 4 checks passed · 5 skipped: ticket lines, test labels, size growth, places, siblings · /m);
  assert.match(r.stdout, /\n {2}– places: skipped \(a text-only change\)\n {2}– siblings: skipped \(a text-only change\)/);
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
  const ok = run(repo, ['--places', list, '--siblings', siblingsFor(list)]);
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /✓ places/);
  const check = planChecks({ repo, base: 'base', node: process.execPath, remote: null, places: list, check: 'c.md' }).checks.find(c => c.name === 'places');
  assert.deepEqual(check.args.slice(1), ['--refresh', list, '--repo', repo, '--check', list, '--check-lines', 'c.md']);
});

// 2026-11-13: before the proof, the test asserts check skips only its proof part.
test('--before-proof passes the flag to the test asserts check only, and labels the summary', async () => {
  const { planChecks } = await import('../scripts/pre-review.mjs');
  const { repo, write } = fixture();
  write('web/src/a.ts', 'export const a = 2;\n');
  const before = planChecks({ repo, base: 'base', node: process.execPath, remote: null, beforeProof: true }).checks;
  assert.ok(before.find(c => c.name === 'test asserts').args.includes('--before-proof'));
  assert.ok(before.filter(c => c.name !== 'test asserts').every(c => !(c.args || []).includes('--before-proof')));
  const after = planChecks({ repo, base: 'base', node: process.execPath, remote: null }).checks;
  assert.ok(!after.find(c => c.name === 'test asserts').args.includes('--before-proof'));
  const r = run(repo, ['--before-proof']);
  // 2026-11-19: each check's lines are printed when it ends, so the summary is the last line.
  assert.match(r.stdout.trimEnd().split(/\r?\n/).at(-1), /^PRE-REVIEW \(before the proof\): /);
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
  // 2026-11-19: a new test needs evidence in the run after the proof (check-test-asserts.mjs); this run is the one
  // before the proof, where that part is left to the later run.
  const ok = run(repo, ['--before-proof', '--lines', lines, '--was', 'small', ...closed(repo)]);
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
  assert.ok(inside.stdout.trimEnd().split(/\r?\n/).at(-1).endsWith(path.basename(repo)), 'the current folder is the default (the summary, the last line, names it): ' + inside.stdout);
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
  // 2026-11-25 (owner, test 4): the pinned Node's folder comes first on the path, so a program the check starts finds it too.
  const there = String.raw`set "PATH=C:\n;%PATH%" && cd /d "C:\r\My App\app" && C:/n/node.exe `;
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
  const r = run(repo, closed(repo));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout.trimEnd().split(/\r?\n/).at(-1), /^PRE-REVIEW: 8 of 8 checks passed · 3 skipped: ticket lines, test labels, size growth · 1 changed file\(s\) · /);
  assert.match(r.stdout, /\n {2}– ticket lines: skipped \(no --lines\)\n {2}– test labels: skipped \(no --check\)\n {2}– size growth: skipped \(no --was\)/);
  const all = planChecks({ repo, base: 'base', node: process.execPath, remote: null, lines: 'l.md', check: 'c.md', was: 'small', places: 'p.md' });
  assert.deepEqual(all.skipped, [], 'every option given: nothing skipped');
});

test('the project check\'s GAP and NOTE lines show also when it passes', () => {
  const { repo, write } = fixture({ mechanical: "console.log('GAP — Api/A.cs — new [HttpPost] A.Create has no test naming it'); console.log('NOTE — web/b.ts — read the texts'); console.log('MECHANICAL: 0 bugs, 1 gaps, 1 notes');" });
  write('web/src/a.ts', 'export const a = 8;\n');
  const r = run(repo, closed(repo));
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

// 2026-11-16: a Check line in the wrong shape ("- C1 [T1] …") passed both pre-review runs and was refused only by
// review-brief, after the proof. The first run now checks the Check lines' sources and their cover of the ticket.
test('check lines: with --lines and --check the first run checks every Check line names its source', async () => {
  const { planChecks } = await import('../scripts/pre-review.mjs');
  const { repo } = fixture();
  for (const beforeProof of [true, false]) {
    const plan = planChecks({ repo, base: 'base', node: process.execPath, remote: null, lines: 'l.md', check: 'c.md', beforeProof });
    const check = plan.checks.find((c) => c.name === 'check lines');
    assert.ok(check, 'planned ' + (beforeProof ? 'before the proof' : 'after it'));
    assert.deepEqual(check.args.slice(1), ['--coverage', '--lines', 'l.md', '--check', 'c.md']);
    assert.match(check.args[0], /review-brief\.mjs$/);
  }
  assert.equal(planChecks({ repo, base: 'base', node: process.execPath, remote: null, lines: 'l.md' }).checks.some((c) => c.name === 'check lines'), false, 'no --check: nothing to read');
});

// 2026-11-18 (audit finding 1): a changed function with callers that was never searched passed the places check,
// because nothing compared the size check's changed functions with the list's Names.
test('finding 1: a changed function with callers that is not on the places list fails the places check; searched, it passes', async () => {
  const { unsearchedCallers } = await import('../scripts/pre-review.mjs');
  const sizeOut = 'SIZE: medium (diff) — x\n  callers: ensureDue ×1 [web/src/schedule.ts:2]; lateness ×3 [web/src/r1.ts:2, web/src/r2.ts:2, web/src/r3.ts:2]; quiet ×0 (+1 in tests); rules.ts:both ×2 [a:1]; odd ×? (not resolved: x)\n';
  assert.deepEqual(unsearchedCallers(sizeOut, ['ensureDue']).names, ['lateness', 'both', 'odd']);
  assert.deepEqual(unsearchedCallers(sizeOut, ['ensureDue', 'lateness', 'both', 'odd']).names, []);
  assert.deepEqual(unsearchedCallers('SIZE: tiny (diff) — docs only', []).names, []);
  assert.equal(unsearchedCallers('  callers: a ×1; (+3 more changed functions, all analysed; rows not printed)', ['a']).more, 3);

  const { repo, git, write } = fixture();
  write('web/src/rules.ts', 'export function ensureDue(d: number) { return d; }\nexport function lateness(d: number) { return d + 1; }\n');
  write('web/src/schedule.ts', "import { ensureDue } from './rules';\nexport const s = ensureDue(1);\n");
  for (const n of [1, 2, 3]) write(`web/src/report${n}.ts`, `import { lateness } from './rules';\nexport const r${n} = lateness(${n});\n`);
  git('add', '-A'); git('commit', '-qm', 'rules'); git('branch', '-f', 'base');
  write('web/src/rules.ts', 'export function ensureDue(d: number) { return d + 0; }\nexport function lateness(d: number) { return d + 2; }\n');
  const siblings = path.join(fs.mkdtempSync(path.join(root, 'notes-')), 'siblings.md');
  fs.writeFileSync(siblings, '# Siblings\n\nSIBLINGS: none\n\nSAME JOB: none\n');
  const one = placesFor(repo, 'ensureDue');
  let r = run(repo, ['--places', one, '--siblings', siblings, '--no-cache']);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /✗ places[^\n]*\n(?:\s+[^\n]*\n)*?\s+OPEN: lateness — changed, not on the places list/);
  assert.match(r.stdout, /callers: ensureDue ×1[^\n]*lateness ×3/, 'the size check of the same run names them');
  // Searched as well: the same change passes.
  const both = placesFor(repo, 'ensureDue,lateness');
  r = run(repo, ['--places', both, '--siblings', siblings, '--no-cache']);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /✓ places/);
});

test('finding 7: the siblings check gets the ticket lines and the check lines when pre-review has both', async () => {
  const { planChecks } = await import('../scripts/pre-review.mjs');
  const { repo } = fixture();
  const find = (o) => planChecks({ repo, base: 'base', node: process.execPath, remote: null, siblings: 's.md', places: 'p.md', ...o }).checks.find((c) => c.name === 'siblings').args.slice(1);
  // 2026-11-19 (owner decision 8): the second look is tied to the ticket lines only; the check lines are not passed.
  assert.deepEqual(find({ lines: 'l.md', check: 'c.md' }), ['--check', 's.md', '--places', 'p.md', '--lines', 'l.md']);
  assert.deepEqual(find({ lines: 'l.md' }), ['--check', 's.md', '--places', 'p.md', '--lines', 'l.md'], 'the ticket lines alone are enough');
  assert.deepEqual(find({ check: 'c.md' }), ['--check', 's.md', '--places', 'p.md'], 'no ticket lines: none passed');
});

test('finding 1, must not change: a changed function with no caller, and a change with no function, owe no name on the list', () => {
  const { repo, write } = fixture();
  write('web/src/a.ts', 'export const a = 3;\n');
  const r = run(repo, [...closed(repo), '--no-cache']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

// ---- 2026-11-18 (audit, repair round) ----
const noSiblings = () => {
  const f = path.join(fs.mkdtempSync(path.join(root, 'notes-')), 'siblings.md');
  fs.writeFileSync(f, '# Siblings\n\nSIBLINGS: none\n\nSAME JOB: none\n');
  return f;
};

test('audit 1: a changed member of an object (assignmentsApi.publishNow) with three caller files is owed on the list; searched by its full name or its last part it passes', async () => {
  const { unsearchedCallers } = await import('../scripts/pre-review.mjs');
  const out = 'SIZE: medium (diff) — x\n  callers: assignmentsApi.publishNow ×3 [a.tsx:3, b.tsx:3, c.tsx:3]; lateness ×3 [r1.ts:2, r2.ts:2, r3.ts:2]\n';
  assert.deepEqual(unsearchedCallers(out, ['label']).names, ['assignmentsApi.publishNow', 'lateness']);
  assert.deepEqual(unsearchedCallers(out, ['assignmentsApi.publishNow', 'lateness']).names, []);
  assert.deepEqual(unsearchedCallers(out, ['publishNow', 'lateness']).names, [], 'the last part is searched too');
  assert.deepEqual(unsearchedCallers('  callers: a ×1; some strange entry', ['a']).unreadable, ['some strange entry'], 'an entry that cannot be read is returned, never skipped');

  const { repo, git, write } = fixture();
  write('web/src/api/assignments.ts', 'export const assignmentsApi = {\n  create: (body: object) => http.post("/a", body),\n  publishNow: (id: number) => http.post(`/a/${id}/p`, {}),\n};\n');
  for (const n of [1, 2, 3]) write(`web/src/Page${n}.tsx`, `import { assignmentsApi } from './api/assignments';\nexport const P${n} = () => assignmentsApi.publishNow(${n});\n`);
  write('web/src/other.ts', 'export function label() { return 1; }\n');
  git('add', '-A'); git('commit', '-qm', 'api'); git('branch', '-f', 'base');
  write('web/src/api/assignments.ts', 'export const assignmentsApi = {\n  create: (body: object) => http.post("/a", body),\n  publishNow: (id: number) => http.post(`/a/${id}/publish-now`, {}),\n};\n');
  let r = run(repo, ['--places', placesFor(repo, 'label'), '--siblings', noSiblings(), '--no-cache']);
  assert.match(r.stdout, /callers: assignmentsApi\.publishNow ×3/, r.stdout);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /OPEN: assignmentsApi\.publishNow — changed, not on the places list/);
  r = run(repo, ['--places', placesFor(repo, 'assignmentsApi.publishNow'), '--siblings', noSiblings(), '--no-cache']);
  assert.equal(r.status, 0, r.stdout);
});

function forms(handlerBody) {
  const { repo, git, write } = fixture();
  for (const n of [1, 2, 3, 4]) {
    write(`web/src/Form${n}.tsx`, `export function Form${n}() {\n  const dueDate = useDue();\n  const handleSubmit = () => { save(dueDate); };\n  return <form onSubmit={handleSubmit} />;\n}\n`);
  }
  git('add', '-A'); git('commit', '-qm', 'forms'); git('branch', '-f', 'base');
  write('web/src/Form1.tsx', `export function Form1() {\n  const dueDate = useDue();\n  const handleSubmit = () => { ${handlerBody} save(dueDate); };\n  return <form onSubmit={handleSubmit} />;\n}\n`);
  return { repo, git, write };
}

test('audit 3: a handler declared inside a component and used only inside it owes no name on the places list', () => {
  const { repo } = forms('if (!dueDate) return;');
  const r = run(repo, ['--places', placesFor(repo, 'dueDate'), '--siblings', noSiblings(), '--no-cache']);
  assert.match(r.stdout, /callers: handleSubmit ×1/, 'the size check names it: ' + r.stdout);
  assert.equal(r.status, 0, r.stdout);
});

test('audit 3, must not change: a handler that has a caller outside the function that declares it, or one that is passed on, still owes its name', async () => {
  const { unsearchedCallers } = await import('../scripts/pre-review.mjs');
  const { repo, write } = fixture();
  // The caller (line 6) is after the component's closing brace: shared.
  write('web/src/Shared.tsx', 'export function Shared() {\n  const handleSubmit = () => { save(1); };\n  return null;\n}\nconst x = 1;\nhandleSubmit();\n');
  const o = { repo, changed: ['web/src/Shared.tsx'] };
  assert.deepEqual(unsearchedCallers('  callers: handleSubmit ×1 [Shared.tsx:6]', [], o).names, ['handleSubmit']);
  // The same name declared twice in the file, or a count that is not all listed: shared.
  write('web/src/Twice.tsx', 'export function A() {\n  const h = () => 1;\n  return h();\n}\nexport function B() {\n  const h = () => 2;\n  return h();\n}\n');
  assert.deepEqual(unsearchedCallers('  callers: h ×1 [Twice.tsx:3]', [], { repo, changed: ['web/src/Twice.tsx'] }).names, ['h']);
  assert.deepEqual(unsearchedCallers('  callers: handleSubmit ×9 [Shared.tsx:3]', [], o).names, ['handleSubmit']);
  // Inside one component, one caller line: local.
  write('web/src/Own.tsx', 'export function Own() {\n  const handleSubmit = () => {\n    save(1);\n  };\n  return <form onSubmit={handleSubmit} />;\n}\n');
  assert.deepEqual(unsearchedCallers('  callers: handleSubmit ×1 [Own.tsx:5]', [], { repo, changed: ['web/src/Own.tsx'] }).names, []);
  // No repo given: every changed function with callers is owed, as before.
  assert.deepEqual(unsearchedCallers('  callers: handleSubmit ×1 [Own.tsx:5]', []).names, ['handleSubmit']);
});

// 2026-11-18 (audit finding 6): a spelling fix in a locale file is sized tiny and the rule page (loop.md, "Text
// only") asks for no new test, yet pre-review failed "ticket lines" and "test asserts" (UNTAGGED [C1]). A genuine
// text-only change (docs and locale text) leaves out the two checks that demand new tests; a test or style file
// is tiny too but is not text, so it keeps both.
function textFixture(file, text) {
  const f = fixture();
  const lines = path.join(f.repo, '..', 'tt-lines.md'), check = path.join(f.repo, '..', 'tt-check.md');
  fs.writeFileSync(lines, '- The button says Submit\n');
  fs.writeFileSync(check, '- [T1] The label is spelled right\n');
  f.write(file, text);
  return { ...f, lines, check };
}

test('text only: a locale spelling fix is not asked for a quoted ticket test or a [C1] test; the other checks stay', () => {
  const { repo, lines, check } = textFixture('web/src/locales/en.json', '{"send":"Submit"}\n');
  const r = run(repo, ['--lines', lines, '--check', check]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /UNTAGGED|ticket lines.*\n.*✗|✗ ticket lines/);
  assert.match(r.stdout, /– ticket lines: skipped \(a text-only change\)/);
  assert.match(r.stdout, /– test labels: skipped \(a text-only change\)/);
  for (const name of ['test asserts', 'commits', 'size', 'one job', 'check lines']) assert.match(r.stdout, new RegExp('✓ ' + name), name);
});

test('text only (must not change): a tiny change to a test file is still asked for the ticket test and the [C1] test', () => {
  const { repo, lines, check } = textFixture('web/src/a.test.ts', "it('x', () => { expect(1).toBe(1); });\n");
  const r = run(repo, ['--lines', lines, '--check', check]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /✗ ticket lines/);
  assert.match(r.stdout, /UNTAGGED: check line C1 has no new test tagged \[C1\]/);
});

test('text only (must not change): a tiny style change and a small logic change keep the test checks', async () => {
  const { planChecks } = await import('../scripts/pre-review.mjs');
  for (const file of ['web/src/a.css', 'web/src/a.ts']) {
    const { repo, write } = fixture();
    write(file, file.endsWith('.css') ? 'a { color: red; }\n' : 'export const a = 9;\n');
    const plan = planChecks({ repo, base: 'base', node: process.execPath, remote: null, lines: 'l.md', check: 'c.md' });
    assert.ok(plan.checks.some(c => c.name === 'ticket lines'), file);
    assert.ok(plan.checks.find(c => c.name === 'test asserts').args.includes('--check'), file);
  }
  const { repo, write } = fixture();
  write('web/src/locales/en.json', '{"a":"b"}\n'); write('web/src/a.ts', 'export const a = 9;\n');
  const mixed = planChecks({ repo, base: 'base', node: process.execPath, remote: null, lines: 'l.md', check: 'c.md' });
  assert.ok(mixed.checks.some(c => c.name === 'ticket lines'), 'locale plus logic is not text only');
});

// 2026-11-18 (audit): a deleted file and logic in a locale script are not text. A locale fix plus a deleted test
// file or a deleted code file, and a changed function body under locales/, are still asked for the ticket test.
async function planFor(setup) {
  const { planChecks } = await import('../scripts/pre-review.mjs');
  const f = fixture();
  f.write('web/src/locales/en.json', '{"send":"Sumbit"}\n');
  f.write('web/src/label.test.ts', "it('x', () => {});\n");
  f.write('web/src/old.ts', 'export const old = 1;\n');
  f.write('web/src/locales/index.ts', "import en from './en.json';\nexport function t(key) { return en[key] ?? key; }\n");
  f.git('add', '-A'); f.git('commit', '-qm', 'more'); f.git('branch', '-f', 'base');
  setup(f);
  return planChecks({ repo: fs.realpathSync.native(f.repo), base: 'base', node: process.execPath, remote: null, lines: 'l.md', check: 'c.md' });
}

test('text only (audit): a locale fix plus a deleted test file, or a deleted code file, is still asked for tests', async () => {
  for (const gone of ['web/src/label.test.ts', 'web/src/old.ts']) {
    const plan = await planFor(f => { f.write('web/src/locales/en.json', '{"send":"Submit"}\n'); fs.rmSync(path.join(f.repo, gone)); });
    assert.ok(plan.checks.some(c => c.name === 'ticket lines'), gone);
    assert.ok(plan.checks.find(c => c.name === 'test asserts').args.includes('--check'), gone);
  }
});

test('text only (audit): logic in a locale script is asked for tests; plain locale text and a deleted doc stay text only', async () => {
  const logic = await planFor(f => f.write('web/src/locales/index.ts', "import en from './en.json';\nexport function t(key) { if (!key) throw new Error('no key'); return en[key] ?? key.toUpperCase(); }\n"));
  assert.ok(logic.checks.some(c => c.name === 'ticket lines'), 'changed function body');
  const bundle = await planFor(f => f.write('web/src/locales/index.ts', "import en from './en.json';\nexport function t(key) { return en[key] ?? key; }\nexport const m = { count: (n) => n > 10 ? 'many' : String(n) };\n"));
  assert.ok(bundle.checks.some(c => c.name === 'ticket lines'), 'function value in a bundle');
  const plain = await planFor(f => { f.write('web/src/locales/en.json', '{"send":"Submit"}\n'); f.write('README.md', 'y\n'); });
  assert.ok(!plain.checks.some(c => c.name === 'ticket lines'), 'plain text stays text only');
  const bundleText = await planFor(f => f.write('web/src/locales/index.ts', "import en from './en.json';\nexport function t(key) { return en[key] ?? key; }\n// note (see docs)\n"));
  assert.ok(!bundleText.checks.some(c => c.name === 'ticket lines'), 'a comment is text');
});

// ---- 2026-11-19 (speed batch) ----

// Another session's folder sat untracked in the repository: 1,498 "changed" files, and one check took 852 s.
test('a folder with 1,500 untracked files: one failed check with the FOREIGN? line, in under 5 seconds, and no other check starts', () => {
  const { repo, write } = fixture();
  write('web/src/a.ts', 'export const a = 8;\n');
  fs.mkdirSync(path.join(repo, 'other-session', 'src'), { recursive: true });
  for (let i = 0; i < 1500; i++) fs.writeFileSync(path.join(repo, 'other-session', 'src', `f${i}.ts`), 'export const x = 1;\n');
  const started = Date.now();
  const r = run(repo);
  const took = Date.now() - started;
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.ok(took < 5000, `it took ${took} ms`);
  assert.match(r.stdout, /✗ changed files[^\n]*\n\s+FOREIGN\? other-session\/ holds 1500 untracked files: add it to \S*info\/exclude if it is another session's, else commit it/);
  assert.match(r.stdout.trimEnd().split(/\r?\n/).at(-1), /^PRE-REVIEW: 0 of 1 checks passed/);
  assert.doesNotMatch(r.stdout, /lint|types|size|commits/, 'no other check ran');
});

// The size check's printed rows are capped; pre-review read the row "(+N more … rows not printed)" as a function
// name once, and the author added each missing name by hand.
test('15 changed functions: every caller row is read from the size check\'s data; one that is not on the list is added to it as an open place, and the places check fails with its name', async () => {
  const { preReview } = await import('../scripts/pre-review.mjs');
  const { repo, write, git } = fixture();
  const names = Array.from({ length: 15 }, (_, i) => 'rule' + (i + 1));
  write('web/src/rules.ts', names.map(n => `export function ${n}(d: number) { return d; }\n`).join(''));
  write('web/src/use.ts', "import * as r from './rules';\n" + names.map(n => `export const u_${n} = r.${n}(1);\n`).join(''));
  git('add', '-A'); git('commit', '-qm', 'rules'); git('branch', '-f', 'base');
  write('web/src/rules.ts', names.map(n => `export function ${n}(d: number) { return d + 1; }\n`).join(''));
  // The list searched 14 of the 15 names; rule15 is the one past the printed rows.
  const places = placesFor(repo, names.slice(0, 14).join(','));
  const row = (n, i) => ({ name: n, file: 'web/src/rules.ts', count: 1, tests: 0, unresolved: [], where: [`web/src/use.ts:${i + 2}`] });
  const all = names.map(row);
  const sizeJson = JSON.stringify({ mode: 'diff', size: 'small', stack: null, signals: {}, roles: ['one review: fresh eyes'], callers: all.slice(0, 12), moreSymbols: 3, moved: [], files: 1, codeFiles: 1, lines: 15, renamed: [], binary: [], names: null, read: [], unread: [], allCallers: all });
  const ran = [];
  const fakeRun = (c) => {
    ran.push(c.name);
    if (c.name === 'size') return Promise.resolve({ ...c, code: 0, out: sizeJson, ms: 1 });
    if (c.name === 'places') { const r = spawnSync(process.execPath, c.args, { cwd: c.cwd, encoding: 'utf8', windowsHide: true }); return Promise.resolve({ ...c, code: r.status, out: r.stdout + r.stderr, ms: 1 }); }
    return Promise.resolve({ ...c, code: 0, out: '', ms: 1 });
  };
  const r = await preReview({ repo, base: 'base', node: process.execPath, remote: null, noCache: true, places, run: fakeRun });
  assert.equal(r.ok, false, r.text);
  assert.match(r.text, /✓ size[^\n]*\n\s+SIZE: small \(diff\)[^\n]*\n\s+roles:[^\n]*\n\s+callers: rule1 ×1[^\n]*\(\+3 more changed functions, all analysed; rows not printed\)/, 'the size text is shown as size-check prints it');
  assert.match(r.text, /✗ places[^\n]*\n(?:\s+[^\n]*\n)*?\s+OPEN: rule15 — changed, not on the places list: it has callers; it is added to the list now/);
  assert.doesNotMatch(r.text, /rows not printed[^\n]*not on the places list|callers entry not readable|more changed function\(s\) are not named/, 'no row is lost and none is read as a name');
  assert.doesNotMatch(r.text, /OPEN: rule(?:[1-9]|1[0-4]) —/, 'the 14 searched names are not named');
  assert.match(fs.readFileSync(places, 'utf8'), /^Names: .*\brule15\b/m, 'the name is on the list now');
  assert.match(r.text, /OPEN[^\n]*use\.ts/, 'and its place shows as open: ' + r.text);
  assert.equal(ran.filter(n => n === 'places').length, 2, 'the places check ran again on the new list');
  // The next run finds every name on the list: nothing is added, and only the open place fails it.
  const again = await preReview({ repo, base: 'base', node: process.execPath, remote: null, noCache: true, places, run: fakeRun });
  assert.doesNotMatch(again.text, /not on the places list/);
});

// Re-check, 2026-11-23: the list files given one by one, without --notes, check no break plan, so a pass there is not
// kept for the proof; the same pass with --notes is.
test('--before-proof keeps its pass for the proof only when run with --notes', async () => {
  const { beforeProofPassed, notesInputs, BEFORE_PROOF_FILES } = await import('../scripts/pre-review-cache.mjs');
  const { repo, write } = fixture();
  write('web/src/a.test.ts', "// STORY-1: \"The total shows once\"\nit('x', () => {});\n");
  write('web/src/a.ts', 'export const a = 4;\n');
  const places = placesFor(repo), notes = path.dirname(places);
  siblingsFor(places);
  fs.writeFileSync(path.join(notes, 'lines.md'), '- The total shows once\n');
  const inputs = () => notesInputs(BEFORE_PROOF_FILES.map((n) => path.join(notes, n)));
  const loose = run(repo, ['--before-proof', '--lines', path.join(notes, 'lines.md'), '--was', 'small', '--places', places, '--siblings', path.join(notes, 'siblings.md')]);
  assert.equal(loose.status, 0, loose.stdout);
  assert.equal(beforeProofPassed(repo, undefined, inputs(), 'base'), false, 'no --notes: no pass kept');
  const whole = run(repo, ['--notes', notes, '--before-proof', '--was', 'small']);
  assert.equal(whole.status, 0, whole.stdout);
  assert.equal(beforeProofPassed(repo, undefined, inputs(), 'base'), true, 'with --notes: the pass is kept, for the base it ran against');
  // The base moves while the checks run (last check, 2026-11-23): no pass, for the old base or the new one.
  const moved = execFileSync('git', ['commit-tree', 'base^{tree}', '-p', 'base', '-m', 'moved'], { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  const mech = path.join(path.dirname(notes), 'move-base.mjs');
  fs.writeFileSync(mech, `import { execFileSync } from 'node:child_process';\nexecFileSync('git', ['-C', ${JSON.stringify(repo)}, 'update-ref', 'refs/heads/base', ${JSON.stringify(moved)}]);\n`);
  execFileSync('git', ['config', 'sanad.mechanical', mech], { cwd: repo, windowsHide: true });
  const during = run(repo, ['--notes', notes, '--before-proof', '--was', 'small']);
  assert.equal(during.status, 0, during.stdout);
  assert.equal(beforeProofPassed(repo, undefined, inputs(), 'base'), false, 'the base moved during the run: no pass');
});

test('--notes fills the list options from the notes folder; an option that names another file is a usage error', async () => {
  const { repo, write } = fixture();
  write('web/src/a.ts', 'export const a = 9;\n');
  const places = placesFor(repo), notes = path.dirname(places);
  siblingsFor(places);
  fs.writeFileSync(path.join(notes, 'lines.md'), '- The total shows once\n');
  const filled = run(repo, ['--notes', notes, '--before-proof']);
  assert.match(filled.stdout, /✓ places/, filled.stdout + filled.stderr);
  assert.match(filled.stdout, /✓ siblings/);
  assert.match(filled.stdout, /ticket lines \(\d/, 'lines.md of the notes folder is used: ' + filled.stdout);
  assert.match(filled.stdout, /– test labels: skipped \(no --check\)/, 'a file that is not in the folder is not made up');
  // The same file given by hand is fine; another one is refused.
  assert.notEqual(run(repo, ['--notes', notes, '--places', places, '--before-proof']).status, 2);
  const other = path.join(fs.mkdtempSync(path.join(root, 'other-')), 'places.md');
  fs.copyFileSync(places, other);
  const refused = run(repo, ['--notes', notes, '--places', other]);
  assert.equal(refused.status, 2, refused.stdout);
  assert.match(refused.stderr, /PRE-REVIEW: --places \S+ is not the notes folder's file/);
  assert.equal(refused.stdout, '', 'nothing ran');
  assert.equal(run(repo, ['--notes', path.join(root, 'no-such-notes')]).status, 2);
  assert.equal(run(repo, ['--part', 'all']).status, 2, '--part takes lists or code only');
});

test('--before-proof with the notes folder\'s break list: a bad break fails the break plan check and is named; no test command fails it too (2026-11-23: it was only named as skipped)', async () => {
  const { planChecks } = await import('../scripts/pre-review.mjs');
  const { writeTask } = await import('../scripts/notes-dir.mjs');
  const { repo, write } = fixture();
  write('web/src/a.ts', 'export const a = 10;\n');
  const places = placesFor(repo), notes = path.dirname(places);
  siblingsFor(places);
  fs.writeFileSync(path.join(notes, 'breaks.json'), JSON.stringify([{ name: 'value broken', file: 'web/src/a.ts', find: 'NOT IN THE FILE', put: 'x', mustFail: ['the value'] }]));
  const noCommand = run(repo, ['--notes', notes, '--before-proof']);
  assert.equal(noCommand.status, 1, noCommand.stdout + noCommand.stderr);
  assert.match(noCommand.stdout, /✗ break plan — NOT RUN/, noCommand.stdout + noCommand.stderr);
  assert.match(noCommand.stdout, /the notes folder names no test command \(task\.json\), so the break plan cannot be checked before the proof/);
  assert.doesNotMatch(noCommand.stdout, /– break plan: skipped/);
  writeTask(notes, { repo, base: 'base', sides: [{ name: 'web', cwd: '', testCommand: [process.execPath, '-e', '0'] }] });
  const bad = run(repo, ['--notes', notes, '--before-proof']);
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stdout, /✗ break plan[^\n]*\n(?:\s+[^\n]*\n)*?[^\n]*value broken/, bad.stdout);
  // Without --before-proof the proof has run: no break plan check.
  assert.doesNotMatch(run(repo, ['--notes', notes]).stdout, /break plan/);
  const plan = planChecks({ repo, base: 'base', node: process.execPath, remote: null, beforeProof: true, breaks: 'b.json', proof: ['npm', 'test'], proofCwd: 'web' }).checks.find(c => c.name === 'break plan');
  assert.deepEqual(plan.args.slice(1), ['--repo', repo, '--breaks', 'b.json', '--base', 'base', '--cwd', 'web', '--check-plan', '--', 'npm', 'test']);
  // Two test folders: one break plan check each (re-check 3: only the first was checked).
  const two = planChecks({ repo, base: 'base', node: process.execPath, remote: null, beforeProof: true, breaks: 'b.json',
    proofs: [{ name: 'page', cmd: ['npm', 'test'], cwd: 'web' }, { name: 'server', cmd: ['dotnet', 'test'], cwd: 'api' }] }).checks.filter(c => /^break plan/.test(c.name));
  assert.deepEqual(two.map((c) => [c.name, c.args.slice(-2).join(' '), c.args[c.args.indexOf('--cwd') + 1]]), [['break plan (page)', 'npm test', 'web'], ['break plan (server)', 'dotnet test', 'api']]);
});

test('a before-proof pass is for one commit: an amended commit with the same files reopens it', async () => {
  const { beforeProofPassed, rememberBeforeProof, workTree } = await import('../scripts/pre-review-cache.mjs');
  const { repo } = fixture();
  const tree = workTree(repo);
  rememberBeforeProof(repo, tree, true, 'in');
  assert.equal(beforeProofPassed(repo, tree, 'in'), true);
  execFileSync('git', ['commit', '-q', '--amend', '-m', 'another message'], { cwd: repo, windowsHide: true });
  assert.equal(beforeProofPassed(repo, workTree(repo), 'in'), false);
});

test('checkStatus says which checks are a kept pass for the code as it is, and runs nothing; tscInfoFile names the type check\'s build-info file', async () => {
  const { checkStatus, planChecks, tscInfoFile } = await import('../scripts/pre-review.mjs');
  const { repo, write } = fixture();
  write('web/src/a.ts', 'export const a = 11;\n');
  const opts = { repo, base: 'base', node: process.execPath, remote: null };
  const before = checkStatus(opts);
  assert.equal(before.foreign, '');
  assert.deepEqual(before.checks.filter(c => c.kept).map(c => c.name), [], 'nothing is kept before the first run');
  assert.equal(before.checks.find(c => c.name === 'test asserts').keyed, false, 'a check that is never kept says so');
  assert.equal(run(repo, closed(repo)).status, 0);
  const after = checkStatus(opts);
  for (const name of ['lint web (1 file)', 'types web', 'size']) assert.equal(after.checks.find(c => c.name === name).kept, true, name);
  assert.match(after.checks.find(c => c.name === 'types web').at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(after.checks.find(c => c.name === 'one job').kept, false);
  write('web/src/a.ts', 'export const a = 12;\n');
  assert.deepEqual(checkStatus(opts).checks.filter(c => c.kept).map(c => c.name), [], 'an edit: no pass is kept for this code');
  const types = planChecks(opts).checks.find(c => c.name === 'types web');
  assert.equal(types.args.at(-1), tscInfoFile(path.join(repo, 'web'), 'tsconfig.app.json'));
  assert.match(path.basename(tscInfoFile(path.join(repo, 'web'), 'tsconfig.app.json')), /^sanad-tsc-[0-9a-f]{12}\.tsbuildinfo$/);
  assert.notEqual(tscInfoFile(path.join(repo, 'web'), 'tsconfig.app.json'), tscInfoFile(path.join(repo, 'web'), 'tsconfig.node.json'));
});

// 2026-11-19 (owner yes): the tests-only light path. With `sanad.testsOnlyLane true`, a tests-only change leaves out the
// new-test evidence part. Switch off, or a change that is not tests only: the check is planned as before.
test('tests-only lane: the switch on and a tests-only change skip the evidence; the switch off keeps it', async () => {
  const { planChecks } = await import('../scripts/pre-review.mjs');
  const laneOf = (repo) => planChecks({ repo, base: 'base', node: process.execPath, remote: null }).checks.find(c => c.name === 'test asserts').args.includes('--tests-only-lane');
  const { repo, git, write } = fixture();
  write('web/src/a.test.ts', "it('x', () => { expect(1).toBe(1); });\n");
  assert.equal(laneOf(repo), false, 'the switch is off');
  git('config', 'sanad.testsOnlyLane', 'true');
  assert.equal(laneOf(repo), true, 'the switch is on and the change is tests only');
  git('config', 'sanad.testsOnlyLane', 'false');
  assert.equal(laneOf(repo), false, 'the switch is off again');
});

test('tests-only lane (must not change): the switch on with product code in the change keeps the evidence', async () => {
  const { planChecks } = await import('../scripts/pre-review.mjs');
  const { repo, git, write } = fixture();
  write('web/src/a.test.ts', "it('x', () => { expect(1).toBe(1); });\n");
  write('web/src/a.ts', 'export const a = 9;\n');
  git('config', 'sanad.testsOnlyLane', 'true');
  assert.equal(planChecks({ repo, base: 'base', node: process.execPath, remote: null }).checks.find(c => c.name === 'test asserts').args.includes('--tests-only-lane'), false);
});

test('Y2: a passing test-asserts check shows its warning rows under its own line', () => {
  const { repo, git, write } = fixture();
  git('config', 'sanad.strictEvidence', 'false');
  write('web/src/form.test.ts', "it('shows the count once', () => { expect(n).toBe(1); });\n");
  const r = run(repo, closed(repo));
  assert.match(r.stdout, /✓ test asserts[^\n]*\n\s+NOT PROVEN TEST: web\/src\/form\.test\.ts:1 shows the count once\n\s+→ the missing-run-evidence rows/, r.stdout + r.stderr);
});

test('Y2: with no strictEvidence setting, the missing-run-evidence row fails the check', () => {
  const { repo, write } = fixture();
  write('web/src/form.test.ts', "it('shows the count once', () => { expect(n).toBe(1); });\n");
  const r = run(repo, closed(repo));
  assert.match(r.stdout, /✗ test asserts/, r.stdout + r.stderr);
  assert.match(r.stdout, /NOT PROVEN TEST: web\/src\/form\.test\.ts:1 shows the count once/, r.stdout + r.stderr);
});

// 2026-11-25 (owner, "the checks pass the first time"): in test 4, 28 runs took 24 minutes; 13 of them were runs that
// a cheap check failed. The cheap checks run first; when one fails, lint and the type check are not started, and every
// failure is named with the command that fixes it.
test('a failed cheap check stops the run before lint and the type check; every failure gets its FIX line', () => {
  const { repo, git, write } = fixture();
  write('web/src/a.ts', 'export const a = 2;\n');
  git('add', '-A'); git('commit', '-qm', 'one');
  write('web/src/a.ts', 'export const a = 3;\n');
  git('add', '-A'); git('commit', '-qm', 'two');
  const r = run(repo, closed(repo));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /✗ commits/);
  assert.doesNotMatch(r.stdout, /eslint ran on/, 'lint was not started');
  assert.match(r.stdout, /✗ lint web[^\n]*\n\s+not run: a check above failed — fix it first \(see FIX\), then run again/);
  assert.match(r.stdout, /✗ types web[^\n]*\n\s+not run: a check above failed/);
  assert.match(r.stdout, /^FIX commits: make one commit: git reset --soft \$\(git merge-base base HEAD\) && git commit -m "<type\(scope\): what>"$/m);
  assert.doesNotMatch(r.stdout, /^FIX (?:lint|types)/m, 'no FIX line for a check that did not run');
  // With the cheap checks green, lint and the type check run as before.
  git('reset', '-q', '--soft', 'base');
  const ok = run(repo, closed(repo));
  assert.match(ok.stdout, /✓ lint web/);
  assert.doesNotMatch(ok.stdout, /not run: a check above failed/);
  assert.match(ok.stdout, /✓ types web/);
});

test('fixLines: one line per failed check, each with its command; a check that did not run gets none', async () => {
  const { fixLines, isHeavyCheck } = await import('../scripts/pre-review.mjs');
  const lines = fixLines([
    { name: 'commits', code: 1, out: 'COMMIT: 2 commits since origin/staging' },
    { name: 'places', code: 1, out: 'OPEN: P22 · enums.roles' },
    { name: 'break plan', code: 1, out: '', notRun: 'the notes folder names no test command (task.json)' },
    { name: 'test asserts', code: 1, out: 'NOT PROVEN TEST: a.test.ts:3 [C3] switches' },
    { name: 'ticket lines', code: 1, out: '✗ L2 — no test quotes it' },
    { name: 'lint web (1 file)', code: 1, out: 'not run: a check above failed — fix it first (see FIX), then run again' },
    { name: 'size', code: 0, out: '' },
  ], { repo: '/r', base: 'origin/staging', notes: '/n' });
  assert.deepEqual(lines.map((l) => l.split(':')[0]), ['FIX commits', 'FIX places', 'FIX break plan', 'FIX test asserts', 'FIX ticket lines']);
  assert.match(lines[1], /places\.mjs"? --close \/n\/places\.md --set "P<n>=C<k>"/);
  assert.match(lines[2], /sanad\.mjs"? start --repo \/r --notes \/n --side <name>/);
  assert.match(lines[3], /run the proof first/);
  assert.equal(isHeavyCheck({ name: 'lint web (1 file)' }), true);
  assert.equal(isHeavyCheck({ name: 'types web (app)' }), true);
  assert.equal(isHeavyCheck({ name: 'places', remote: false }), false);
  assert.equal(isHeavyCheck({ name: 'test asserts' }), false);
});
