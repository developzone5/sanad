// code-paths.cjs: "everything but prose is code" holds inside a repository. Outside one, and for a string that
// is no file name at all, only the known code kinds count (2026-11-18: the old and the new scanner were run over
// 19 real sessions; a browser tool's input text and ~/.ssh/config had become code edits that asked for a test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isCodePath, isProsePath } = require('../lib/code-paths.cjs');
const slash = (p) => p.replace(/\\/g, '/');

// A real folder outside the temp folder (the temp folder has its own rule) with no repository above it.
function homeFolder(t) {
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.sanad-code-paths-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (let up = dir; ; up = path.dirname(up)) {
    if (fs.existsSync(path.join(up, '.git'))) return null; // the home folder is itself inside a repository: cannot test here
    if (path.dirname(up) === up) break;
  }
  return dir;
}

test('a string that is no file name is never a code file', () => {
  assert.equal(isCodePath("evaluate('document.documentElement.scrollWidth > window.innerWidth')"), false);
  assert.equal(isCodePath('window.scrollTo(0, 500); return document.title'), false);
  assert.equal(isCodePath('a=1'), false);
});

test('outside a repository only the known code kinds are code', (t) => {
  const dir = homeFolder(t);
  if (!dir) return t.skip('the home folder is inside a repository');
  const plain = path.join(dir, 'plain');
  fs.mkdirSync(plain);
  assert.equal(isCodePath(slash(path.join(plain, 'config'))), false, 'a file with no ending, such as ~/.ssh/config');
  assert.equal(isCodePath(slash(path.join(plain, 'nginx.conf'))), false, 'an unknown kind outside a repository');
  assert.equal(isCodePath(path.join(plain, 'config')), false, 'the same with backslashes');
  assert.equal(isCodePath(slash(path.join(plain, 'tool.mjs'))), true, 'a script is code wherever it is');
  assert.equal(isCodePath(slash(path.join(plain, 'App.cs'))), true);
  assert.equal(isCodePath(slash(path.join(plain, 'package.json'))), true, 'a dependency manifest is code wherever it is');
});

test('must not change: inside a repository everything but prose is code', (t) => {
  const dir = homeFolder(t);
  if (!dir) return t.skip('the home folder is inside a repository');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'conf'));
  fs.mkdirSync(path.join(repo, 'bin'));
  assert.equal(isCodePath(slash(path.join(repo, 'conf', 'nginx.conf'))), true);
  assert.equal(isCodePath(slash(path.join(repo, 'bin', 'run'))), true, 'a script with no ending');
  assert.equal(isCodePath(slash(path.join(repo, 'index.html'))), true);
  assert.equal(isCodePath(slash(path.join(repo, 'requirements.txt'))), true);
  assert.equal(isCodePath(slash(path.join(repo, 'README.md'))), false);
  assert.equal(isProsePath(slash(path.join(repo, 'README.md'))), true);
});

test('must not change: a path that cannot be judged on disk stays code, and so does a relative path', () => {
  assert.equal(isCodePath('C:/repos/example-that-does-not-exist/index.html'), true);
  assert.equal(isCodePath('C:/repos/example-that-does-not-exist/nginx.conf'), true);
  assert.equal(isCodePath('nginx.conf'), true);
  assert.equal(isCodePath('data/seed.json'), true);
  assert.equal(isCodePath('src/App.ts'), true);
  assert.equal(isCodePath('docs/guide.md'), false);
});

test('media and fonts are assets like images; archives and binaries stay code; a glob is still a file name', () => {
  for (const p of ['out/eduquest-services-ar.mp4', 'docs/demo.mov', 'public/fonts/Inter.woff2', 'assets/click.mp3', 'public/favicon.ico']) {
    assert.equal(isCodePath(p), false, p);
    assert.equal(isProsePath(p), true, p);
  }
  for (const p of ['tools/setup.zip', 'lib/vendor.jar', 'bin/tool.dll', 'public/logo.svg']) assert.equal(isCodePath(p), true, p);
  assert.equal(isCodePath('scripts/remote/*.sh'), true);
  assert.equal(isCodePath('src/file?.ts'), true);
});
