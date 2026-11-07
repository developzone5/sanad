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

test('every check passes: lint, types, size and the project check, with one summary', () => {
  const { repo, write } = fixture({ mechanical: "console.log('MECHANICAL: 0 bugs'); process.argv.includes('--repo') || process.exit(9);" });
  write('web/src/a.ts', 'export const a = 2;\n');
  const r = run(repo);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /PRE-REVIEW: 5 of 5 checks passed/);
  for (const name of ['lint web \\(1 file\\)', 'types web', 'test asserts', 'size', 'mechanical']) assert.match(r.stdout, new RegExp('✓ ' + name));
  assert.match(r.stdout, /MECHANICAL: 0 bugs/, 'the project check got --repo');
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
  const ok = run(repo, ['--lines', lines, '--was', 'small']);
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
