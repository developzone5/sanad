// transcriptCandidates: the session logs of the other work trees of the same repository (2026-11-20).
// Fixtures are written by hand with invented text. Real temp git repositories, real "git worktree add".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { transcriptCandidates } from '../scripts/note-check.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
const slug = (p) => path.resolve(p).replace(/[^A-Za-z0-9]/g, '-');

// One main work tree and one linked work tree, plus an empty projects folder.
function setup({ withSibling = true } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-sib-')));
  const main = path.join(base, 'main');
  const task = path.join(base, 'task');
  fs.mkdirSync(main);
  git(main, 'init', '-q');
  git(main, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'first');
  if (withSibling) git(main, 'worktree', 'add', '-q', '-b', 'task-branch', task);
  const projects = path.join(base, 'projects');
  fs.mkdirSync(projects);
  const log = (tree, name, text, at) => {
    const dir = path.join(projects, slug(tree));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, text);
    if (at) fs.utimesSync(file, at, at);
    return file;
  };
  return { main, task, projects, log };
}
function withEnv(projects, fn) {
  const old = { p: process.env.SANAD_PROJECTS_DIR, s: process.env.CLAUDE_CODE_SESSION_ID };
  process.env.SANAD_PROJECTS_DIR = projects;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  try { return fn(); } finally {
    for (const [k, v] of [['SANAD_PROJECTS_DIR', old.p], ['CLAUDE_CODE_SESSION_ID', old.s]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('own project folder log is returned first, the sibling log after it', () => {
  const s = setup();
  const own = s.log(s.task, 'own.jsonl', '{"note":"own"}\n', new Date(Date.now() - 60000));
  const sib = s.log(s.main, 'sib.jsonl', JSON.stringify({ cwd: s.task.replace(/\\/g, '/') }) + '\n', new Date());
  const got = withEnv(s.projects, () => transcriptCandidates(s.task));
  assert.deepEqual(got, [own, sib]);
});

test('a log in a sibling work tree folder that mentions the task path is returned (all spellings)', () => {
  const s = setup();
  const fwd = s.log(s.main, 'fwd.jsonl', 'x ' + s.task.replace(/\\/g, '/').toUpperCase() + ' y\n', new Date(Date.now() - 3000));
  const back = s.log(s.main, 'back.jsonl', 'x ' + s.task.replace(/\//g, '\\') + ' y\n', new Date(Date.now() - 2000));
  const esc = s.log(s.main, 'esc.jsonl', JSON.stringify('x ' + s.task.replace(/\//g, '\\')) + '\n', new Date(Date.now() - 1000));
  const got = withEnv(s.projects, () => transcriptCandidates(s.task));
  assert.equal(got.length, 3);
  assert.deepEqual(got, [esc, back, fwd], 'newest first');
});

test('a sibling log that does not mention the task path is not returned', () => {
  const s = setup();
  s.log(s.main, 'other.jsonl', '{"cwd":"/somewhere/else/entirely"}\n');
  const got = withEnv(s.projects, () => transcriptCandidates(s.task));
  assert.deepEqual(got, []);
});

test('a hit that lies across a read chunk is found', () => {
  const s = setup();
  const needle = s.task.replace(/\\/g, '/');
  const pad = 'a'.repeat(1024 * 1024 - 5);
  const f = s.log(s.main, 'big.jsonl', pad + needle + '\n');
  const got = withEnv(s.projects, () => transcriptCandidates(s.task));
  assert.deepEqual(got, [f]);
});

test('no other work tree and no own log: the answer is empty', () => {
  const s = setup({ withSibling: false });
  assert.deepEqual(withEnv(s.projects, () => transcriptCandidates(s.main)), []);
});

test('not a git folder: only the own folder answers, as before', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-nogit-')));
  const projects = path.join(base, 'projects');
  const dir = path.join(projects, slug(base));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.jsonl'), '');
  const got = withEnv(projects, () => transcriptCandidates(base));
  assert.deepEqual(got.map((f) => path.basename(f)), ['a.jsonl']);
});

// 2026-11-20 (U4): the three fixes.
function withSession(projects, id, fn) {
  const old = { p: process.env.SANAD_PROJECTS_DIR, s: process.env.CLAUDE_CODE_SESSION_ID };
  process.env.SANAD_PROJECTS_DIR = projects;
  process.env.CLAUDE_CODE_SESSION_ID = id;
  try { return fn(); } finally {
    for (const [k, v] of [['SANAD_PROJECTS_DIR', old.p], ['CLAUDE_CODE_SESSION_ID', old.s]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('(a) the session id log in a sibling work tree folder is returned alone', () => {
  const s = setup();
  s.log(s.task, 'older.jsonl', '{"note":"older"}\n', new Date());
  const mine = s.log(s.main, 'sess-123.jsonl', '{"note":"mine"}\n', new Date(Date.now() - 600000));
  s.log(s.main, 'other.jsonl', 'x ' + s.task.split('\\').join('/') + ' y\n');
  assert.deepEqual(withSession(s.projects, 'sess-123', () => transcriptCandidates(s.task)), [mine]);
});

test('(a) an unknown session id falls back to the normal list', () => {
  const s = setup();
  const own = s.log(s.task, 'own.jsonl', '{"note":"own"}\n');
  assert.deepEqual(withSession(s.projects, 'nope', () => transcriptCandidates(s.task)), [own]);
});

test('(b) a path that continues with a letter, digit, dash, underscore or dot is not a mention', () => {
  const s = setup();
  const fwd = s.task.split('\\').join('/');
  s.log(s.main, 'dash.jsonl', 'x ' + fwd + '-seqnotice/a y\n');
  s.log(s.main, 'dot.jsonl', 'x ' + fwd + '.bak y\n');
  s.log(s.main, 'under.jsonl', 'x ' + fwd + '_2 y\n');
  s.log(s.main, 'digit.jsonl', 'x ' + fwd + '2 y\n');
  s.log(s.main, 'letter.jsonl', 'x ' + fwd + 'x y\n');
  assert.deepEqual(withEnv(s.projects, () => transcriptCandidates(s.task)), []);
});

test('(b) a path followed by a quote, slash, backslash, space or the end is a mention', () => {
  const s = setup();
  const fwd = s.task.split('\\').join('/');
  const names = ['quote', 'slash', 'back', 'space', 'end'];
  const texts = ['"' + fwd + '"', fwd + '/a', fwd + '\\a', fwd + ' a', fwd];
  names.forEach((n, i) => s.log(s.main, n + '.jsonl', 'x ' + texts[i], new Date(Date.now() - i * 1000)));
  assert.equal(withEnv(s.projects, () => transcriptCandidates(s.task)).length, 5);
});

test('(b) the next character is read across a chunk cut', () => {
  const s = setup();
  const needle = s.task.split('\\').join('/');
  const pad = 'a'.repeat(1024 * 1024 - needle.length);
  s.log(s.main, 'cutbad.jsonl', pad + needle + '-more\n');
  const ok = s.log(s.main, 'cutok.jsonl', pad + needle + '"\n', new Date(Date.now() - 5000));
  assert.deepEqual(withEnv(s.projects, () => transcriptCandidates(s.task)), [ok]);
});

test('(c) no session id: own folder first, a sibling log only when it mentions the path by the strict rule', () => {
  const s = setup();
  const own = s.log(s.task, 'own.jsonl', '{"note":"own"}\n', new Date(Date.now() - 60000));
  const good = s.log(s.main, 'good.jsonl', 'x ' + s.task.split('\\').join('/') + '/f y\n', new Date());
  s.log(s.main, 'bad.jsonl', 'x ' + s.task.split('\\').join('/') + '-other/f y\n', new Date());
  assert.deepEqual(withEnv(s.projects, () => transcriptCandidates(s.task)), [own, good]);
});
