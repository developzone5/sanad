// 2026-11-22 (owner): the review brief carries the code under review — the diff, the whole text of every changed
// function and the whole text of each calling function — read at the pinned commit. The reviewer still searches.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { codeBlock, changedRanges, buildBrief, buildFreshBrief, buildRecheckBrief, hintsBlock } from '../scripts/review-brief.mjs';
import { functionSpan } from '../scripts/size-check.mjs';

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
function repo() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rb-code-')));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 't@t']); git(dir, ['config', 'user.name', 't']); git(dir, ['config', 'core.autocrlf', 'false']);
  const write = (f, t) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); };
  write('src/api.ts', 'export function save(id: number) {\n  const n = id;\n  return n;\n}\n\nexport function other() {\n  return 0;\n}\n');
  write('src/page.ts', "import { save } from './api';\n\nexport function onClick() {\n  const r = save(1);\n  return r;\n}\n");
  git(dir, ['add', '.']); git(dir, ['commit', '-q', '-m', 'base']);
  const base = git(dir, ['rev-parse', 'HEAD']);
  write('src/api.ts', 'export function save(id: number) {\n  const n = id + 1;\n  return n;\n}\n\nexport function other() {\n  return 0;\n}\n');
  git(dir, ['commit', '-q', '-am', 'fix']);
  const pin = git(dir, ['rev-parse', 'HEAD']);
  return { dir, base, pin, write };
}
const rows = [{ name: 'save', file: 'src/api.ts', count: 1, where: ['src/page.ts:4'] }];

test('the code block holds the diff, the whole changed function and the whole calling function', () => {
  const { dir, base, pin } = repo();
  const text = codeBlock({ repo: dir, mergeBase: base, pin, rows }).join('\n');
  assert.match(text, /^## Code under review/m);
  assert.match(text, /Search the repository yourself for the places this copy does not show/);
  assert.match(text, /^### Diff$/m);
  assert.match(text, /^\+ {2}const n = id \+ 1;$/m);
  assert.match(text, /^#### src\/api\.ts · save \(lines 1-4\)$/m);
  assert.match(text, /export function save\(id: number\) \{\n {2}const n = id \+ 1;\n {2}return n;\n\}/);
  assert.doesNotMatch(text, /#### src\/api\.ts · other/, 'an unchanged function of the same file is not copied');
  assert.match(text, /^### Callers of the changed functions/m);
  assert.match(text, /^#### src\/page\.ts · onClick \(line 4 uses save\)$/m);
  assert.match(text, /export function onClick\(\) \{\n {2}const r = save\(1\);\n {2}return r;\n\}/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the code is read at the pinned commit, not the working tree', () => {
  const { dir, base, pin, write } = repo();
  write('src/api.ts', 'export function save(id: number) {\n  const n = id + 99;\n  return n;\n}\n');
  const text = codeBlock({ repo: dir, mergeBase: base, pin, rows }).join('\n');
  assert.match(text, /const n = id \+ 1;/);
  assert.doesNotMatch(text, /id \+ 99/);
  assert.match(text, new RegExp(`read at commit ${pin.slice(0, 12)}`));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a caller in the function\'s own file, named by its base name, is read from that file', () => {
  const { dir, base, pin } = repo();
  const text = codeBlock({ repo: dir, mergeBase: base, pin, rows: [{ name: 'save', file: 'src/api.ts', where: ['api.ts:7'] }] }).join('\n');
  assert.match(text, /^#### src\/api\.ts · other \(line 7 uses save\)$/m);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('no change gives no code block', () => {
  const { dir, pin } = repo();
  assert.deepEqual(codeBlock({ repo: dir, mergeBase: pin, pin, rows }), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a C# method with its signature over several lines spans to its closing brace', () => {
  const lines = [
    'public class S', '{', '    public async Task<int> Count(', '        long id,', '        CancellationToken ct', '    )', '    {',
    '        var n = await Q(id, ct);', '        return n;', '    }', '', '    public int Two() => 2;', '}',
  ];
  assert.deepEqual(functionSpan(lines, 7), { name: 'Count', start: 2, end: 9 });
  assert.deepEqual(functionSpan(lines, 11), { name: 'Two', start: 11, end: 11 });
});

test('changedRanges reads the new-side lines of each file', () => {
  const diff = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -2 +2,2 @@\n-x\n+y\n+z\n@@ -9,0 +11 @@\n+w\n';
  assert.deepEqual([...changedRanges(diff)], [['a.ts', [[2, 3], [11, 11]]]]);
});

test('the full, fresh and re-check briefs end with the code block they are given', () => {
  const code = ['## Code under review — a copy for reading; the commit counts', '', 'CODE MARK', ''];
  const facts = { stack: 'Stack: x', size: 'SIZE: small', callers: '', signals: null, rows: [] };
  const common = { repo: 'r', branch: 'b', base: 'main', mergeBase: 'a'.repeat(40), ticket: 'T', outside: { touched: [], other: [], decided: [], decisions: [] }, facts, size: 'small', changed: [], code };
  for (const text of [buildBrief({ ...common, checks: [] }), buildFreshBrief(common), buildRecheckBrief({ repo: 'r', branch: 'b', from: 'a', to: 'b', round: 2, code })]) {
    assert.match(text, /## Code under review[\s\S]*CODE MARK\s*$/);
  }
});

// Attack notes of 2026-11-22: the copy is whole, every caller is read, and the shapes JS/TS and C# use are found.
test('a long function is copied whole, and every caller location is read with its own path', () => {
  const { dir, base, pin } = repo();
  const long = ['export function save(id: number) {', ...Array.from({ length: 300 }, (_, i) => `  const v${i} = id + ${i};`), '  return id;', '}', ''].join('\n');
  fs.mkdirSync(path.join(dir, 'pages'), { recursive: true });
  const callers = [];
  for (let k = 0; k < 8; k++) {
    fs.writeFileSync(path.join(dir, `pages/p${k}.ts`), `import { save } from '../src/api';\n\nexport function use${k}() {\n  return save(${k});\n}\n`);
    callers.push(`pages/p${k}.ts:4`);
  }
  fs.writeFileSync(path.join(dir, 'api.ts'), "import { save } from './src/api';\n\nexport function rootUse() {\n  return save(9);\n}\n");
  callers.push('api.ts:4');
  git(dir, ['add', '.']); git(dir, ['commit', '-q', '-m', 'callers']);
  const from = git(dir, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(dir, 'src/api.ts'), long);
  git(dir, ['commit', '-q', '-am', 'long']);
  const head = git(dir, ['rev-parse', 'HEAD']);
  const text = codeBlock({ repo: dir, mergeBase: from, pin: head, rows: [{ name: 'save', file: 'src/api.ts', where: callers.slice(0, 6), places: callers }] }).join('\n');
  assert.match(text, /const v299 = id \+ 299;\n {2}return id;\n\}/, 'no cut inside the function');
  for (let k = 0; k < 8; k++) assert.ok(text.includes(`#### pages/p${k}.ts · use${k} (line 4 uses save)`), `caller ${k} is copied`);
  assert.match(text, /#### api\.ts · rootUse \(line 4 uses save\)/, 'a root api.ts caller is read from api.ts, not src/api.ts');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('before the commit, a new file git does not track yet is copied whole', () => {
  const { dir, pin } = repo();
  fs.writeFileSync(path.join(dir, 'src/fresh.ts'), 'export const fresh = () => 1;\n');
  const text = codeBlock({ repo: dir, mergeBase: pin, pin: '', rows: [] }).join('\n');
  assert.match(text, /#### src\/fresh\.ts \(new, not in git yet: the whole file\)/);
  assert.match(text, /export const fresh = \(\) => 1;/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('spans: a one-line function ends on its line, an object member and a C# attribute find their function', () => {
  const pair = ['function first() { return 1; }', 'function second() {', '  return 2;', '}'];
  assert.deepEqual(functionSpan(pair, 0), { name: 'first', start: 0, end: 0 }, 'a one-line function does not run into the next one');
  assert.deepEqual(functionSpan(pair, 2), { name: 'second', start: 1, end: 3 });
  const api = ['export const api = {', '  save: (id: number) => {', '    return post(id);', '  },', '  load(id: number) {', '    return get(id);', '  },', '};'];
  assert.deepEqual(functionSpan(api, 2), { name: 'api.save', start: 1, end: 3 });
  assert.deepEqual(functionSpan(api, 5), { name: 'api.load', start: 4, end: 6 });
  const cs = ['public class C', '{', '    [HttpGet("{id:long}")]', '    public IActionResult Get(long id)', '    {', '        return Ok(id);', '    }', '}'];
  const span = functionSpan(cs, 2);
  assert.equal(span.name, 'Get');
  assert.equal(span.end, 6);
});

test('the second look\'s hints and the author\'s answers go into both briefs', () => {
  const hints = hintsBlock(['# Siblings', '', 'J1 · src/a.ts:1 · a — one read → reuse', 'J2 · src/b.ts:2 · b — one worker → not: another system with its own order', 'S1 · src/c.ts:3 · c — same rule → none: a different field', ''].join('\n'));
  const text = hints.join('\n');
  assert.match(text, /^## The second look's hints and the author's answers/m);
  assert.match(text, /^- J2 · src\/b\.ts:2 · b — one worker → not: another system with its own order$/m);
  assert.match(text, /^- S1 · src\/c\.ts:3 · c — same rule → none: a different field$/m);
  const facts = { stack: 'Stack: x', size: 'SIZE: small', callers: '', signals: null, rows: [] };
  const common = { repo: 'r', branch: 'b', base: 'main', mergeBase: 'a'.repeat(40), ticket: 'T', outside: { touched: [], other: [], decided: [], decisions: [] }, facts, size: 'small', changed: [], hints };
  for (const brief of [buildBrief({ ...common, checks: [] }), buildFreshBrief(common)]) assert.match(brief, /→ not: another system with its own order/);
});
