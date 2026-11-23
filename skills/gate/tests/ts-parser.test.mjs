// ts-parser.mjs (2026-11-23, owner): a break whose text does not parse is refused before any run (syntax only).
// TypeScript comes from the repository; these tests find one through the installer's end-to-end setting (git config
// sanad.e2eRun "<repo>|<folder>|<command>") or SANAD_TEST_TYPESCRIPT (a typescript package folder). With none, the
// TypeScript cases are skipped and say so.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { syntaxProblem } from '../scripts/ts-parser.mjs';

function findTypeScript() {
  const own = process.env.SANAD_TEST_TYPESCRIPT;
  if (own && fs.existsSync(path.join(own, 'package.json'))) return own;
  let setting = '';
  try { setting = execFileSync('git', ['config', '--global', '--get-all', 'sanad.e2eRun'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return ''; }
  for (const line of setting.split(/\r?\n/).filter(Boolean)) {
    const [repo, folder] = line.split('|');
    // That folder, then the same folder in each work tree of its repository (as ts-parser.mjs looks).
    let trees = [repo];
    try { trees = [repo, ...execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/).filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9))]; } catch { /* the folder alone */ }
    for (const tree of trees) {
      const dir = path.join(tree || '', folder || '', 'node_modules', 'typescript');
      if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    }
  }
  return '';
}
const tsDir = findTypeScript();
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ts-parser-')));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

// A repository with one package that has TypeScript (a link to the one found), and one with none.
function repoWith(withTs) {
  const top = fs.mkdtempSync(path.join(root, 'repo-'));
  execFileSync('git', ['init', '-q'], { cwd: top, windowsHide: true });
  const web = path.join(top, 'web');
  fs.mkdirSync(path.join(web, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(web, 'package.json'), '{"name":"web"}');
  if (withTs) fs.symlinkSync(tsDir, path.join(web, 'node_modules', 'typescript'), 'junction');
  return top;
}
const needsTs = tsDir ? {} : { skip: 'no TypeScript on this machine (git config sanad.e2eRun, or SANAD_TEST_TYPESCRIPT)' };
const FILE = 'web/src/members.test.tsx';
const BASE = [
  "import { it, expect } from 'vitest';",
  '// T1: "only the first 50 students of the section are listed."',
  "it('[C1] lists every student', () => {",
  '  const url = `//not a comment ${1} // nor this`;',
  '  expect(<p>  Show more </p>).toBeTruthy();',
  '  expect(url).toContain("//");',
  '});',
  '',
].join('\n');

test('a file that does not parse gives its first syntax error; one that parses gives an empty answer', needsTs, () => {
  const top = repoWith(true);
  assert.equal(syntaxProblem(top, FILE, BASE), '');
  assert.match(syntaxProblem(top, FILE, BASE.replace('toBeTruthy()', 'toBeTruthy(')), /^line 5: '\)' expected\./);
  // Syntax only: a name that does not exist and a wrong type both parse.
  assert.equal(syntaxProblem(top, 'web/src/a.ts', 'const x: number = missingName("text");\n'), '');
});

test('with no TypeScript a .ts file is still parsed by Node, a .tsx or a C# file is not parsed (null)', () => {
  const top = repoWith(false);
  assert.match(String(syntaxProblem(top, 'web/src/fetch-all-pages.ts', 'export const all = (pages.map((p) => p.items;\n')), /\S/);
  assert.equal(syntaxProblem(top, 'web/src/fetch-all-pages.ts', 'export const all = (pages: number[]) => pages.length;\n'), '');
  assert.equal(syntaxProblem(top, 'web/src/Members.tsx', 'const a = <div>;'), null);
  assert.equal(syntaxProblem(top, 'web/src/Members.cs', 'class A {'), null);
  // A file with an enum is still read (re-check 3: the strip mode refused it, and a broken file went unparsed).
  assert.equal(syntaxProblem(top, 'web/src/kinds.ts', 'export enum Kind { A, B }\n'), '');
  assert.match(String(syntaxProblem(top, 'web/src/kinds.ts', 'export enum Kind { A, B }\nconst f = (x;\n')), /\S/);
});

test('plain JavaScript is parsed by Node, in either module form for .js: `const x;` and a type annotation do not parse, `export` does', () => {
  const top = repoWith(false);
  assert.match(String(syntaxProblem(top, 'web/src/a.cjs', 'const x;\n')), /SyntaxError/);
  assert.match(String(syntaxProblem(top, 'web/src/a.js', 'const x: number = 1;\n')), /SyntaxError/);
  assert.equal(syntaxProblem(top, 'web/src/a.js', 'export const x = 1;\n'), '');
  assert.equal(syntaxProblem(top, 'web/src/a.js', 'module.exports = 1;\n'), '');
});
