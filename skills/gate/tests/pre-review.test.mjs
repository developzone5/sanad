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
  assert.match(r.stdout, /^PRE-REVIEW \(before the proof\): /);
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
  const ok = run(repo, ['--lines', lines, '--was', 'small', ...closed(repo)]);
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
  const r = run(repo, closed(repo));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^PRE-REVIEW: 8 of 8 checks passed · 3 skipped: ticket lines, test labels, size growth · 1 changed file\(s\) · /);
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
  assert.deepEqual(find({ lines: 'l.md', check: 'c.md' }), ['--check', 's.md', '--places', 'p.md', '--lines', 'l.md', '--check-lines', 'c.md']);
  assert.deepEqual(find({ lines: 'l.md' }), ['--check', 's.md', '--places', 'p.md'], 'one of the two alone: as before');
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
