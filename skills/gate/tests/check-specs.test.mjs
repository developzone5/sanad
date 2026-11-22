import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The project's spec writer lives outside the gate skill: ~/.claude/scripts/eduquest/.
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'eduquest', 'check-specs.mjs');
const hasDotnet = (() => { try { execFileSync(process.platform === 'win32' ? 'where' : 'which', ['dotnet'], { stdio: 'ignore', windowsHide: true }); return true; } catch { return false; } })();
const skip = !fs.existsSync(script) ? 'no scripts/eduquest/check-specs.mjs next to this skill (' + script + ')'
  : !hasDotnet ? 'dotnet is not on PATH: check-specs.mjs looks it up first' : false;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-specs-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
// git must not find a repository above the temp folders.
const env = {
  ...process.env, GIT_CEILING_DIRECTORIES: root,
  GIT_CONFIG_GLOBAL: path.join(root, 'no-global-config'), GIT_CONFIG_NOSYSTEM: '1',
};

function repoFixture() {
  const repo = fs.mkdtempSync(path.join(root, 'repo-'));
  for (const dir of ['.git/objects', '.git/refs', 'EduQuest', 'eduquest-frontend/src']) fs.mkdirSync(path.join(repo, dir), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return repo;
}
const run = (cwd, args) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env, windowsHide: true });
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const spec = (out, name) => JSON.parse(fs.readFileSync(path.join(out, name), 'utf8'));

// 2026-11-12 (audit C6): --repo defaulted to the main folder, so from a task's own worktree the full-suite
// specs ran the main folder's code.
test('with no --repo, the specs run the code of the repository you are in', { skip }, () => {
  const repo = repoFixture();
  const out = path.join(root, 'out-here');
  const r = run(path.join(repo, 'eduquest-frontend', 'src'), [out]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(same(spec(out, 'backend-full.json').cwd, path.join(repo, 'EduQuest')), spec(out, 'backend-full.json').cwd);
  assert.ok(same(spec(out, 'frontend-full.json').cwd, path.join(repo, 'eduquest-frontend')));
  assert.ok(same(spec(out, 'frontend-tsc.json').cwd, path.join(repo, 'eduquest-frontend')));
});

test('outside a repository with no --repo it fails with the usage line; --repo still works', { skip }, () => {
  const outside = fs.mkdtempSync(path.join(root, 'plain-'));
  const r = run(outside, [path.join(root, 'out-none')]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /usage: check-specs\.mjs <out-dir>/);
  assert.equal(fs.existsSync(path.join(root, 'out-none', 'backend-full.json')), false);
  const repo = repoFixture();
  const out = path.join(root, 'out-given');
  const given = run(outside, [out, '--repo', repo]);
  assert.equal(given.status, 0, given.stdout + given.stderr);
  assert.ok(same(spec(out, 'backend-full.json').cwd, path.join(repo, 'EduQuest')));
});

test('the gate and local pre-review share the app build info only', { skip }, async () => {
  const { planChecks } = await import('../scripts/pre-review.mjs');
  const repo = repoFixture();
  const frontend = path.join(repo, 'eduquest-frontend');
  const tsc = path.join(frontend, 'node_modules', 'typescript', 'bin', 'tsc');
  fs.mkdirSync(path.dirname(tsc), { recursive: true });
  fs.writeFileSync(tsc, '');
  fs.writeFileSync(path.join(frontend, 'package.json'), '{}');
  fs.writeFileSync(path.join(frontend, 'tsconfig.json'), JSON.stringify({
    files: [],
    references: [{ path: './tsconfig.app.json' }, { path: './tsconfig.node.json' }],
  }));
  fs.writeFileSync(path.join(frontend, 'src', 'app.ts'), '');
  const { checks } = planChecks({
    repo, base: 'HEAD', node: process.execPath, remote: null,
    set: { files: ['eduquest-frontend/src/app.ts'], deleted: [] },
  });
  const app = checks.find(check => check.args?.includes('tsconfig.app.json'));
  const node = checks.find(check => check.args?.includes('tsconfig.node.json'));

  const out = path.join(root, 'out-incremental');
  const r = run(repo, [out]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const { args } = spec(out, 'frontend-tsc.json');
  const cache = args.at(-1);
  assert.deepEqual(args, ['node_modules/typescript/bin/tsc', '--noEmit', '--project', 'tsconfig.app.json',
    '--incremental', '--tsBuildInfoFile', app.args.at(-1)]);
  assert.ok(same(path.dirname(cache), os.tmpdir()));
  assert.ok(path.relative(repo, cache).startsWith('..' + path.sep));
  assert.notEqual(cache, node.args.at(-1));

  const other = repoFixture();
  const otherOut = path.join(root, 'out-other-worktree');
  const otherRun = run(other, [otherOut]);
  assert.equal(otherRun.status, 0, otherRun.stdout + otherRun.stderr);
  assert.notEqual(cache, spec(otherOut, 'frontend-tsc.json').args.at(-1));
});
