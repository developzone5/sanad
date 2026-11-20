// 2026-11-19, one result per break. Before, the proof record held one entry per proof, all or nothing: one break
// that timed out, or a stop before the end, lost the result of every break that had ended, and the whole proof ran
// again. The record now also keeps one result per break and the facts of each run. The promise these tests hold:
// a break counts as proved only on the exact code tree its run was on, and only when the passing run passed on
// that tree; saving, losing or taking back one break's result never changes another break's result.
// The record functions are called here as the proof runner calls them; the writers that must run at the same time
// run in child processes.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BREAK_STATES, breakId, breakStates, codeFingerprint, declaredTests, evidenceOf, proofDir, provenHas, provenTests, readRecord, recordKey, recordNotes,
  takeBackRun, testFileHashes, testSpans, withdrawRunFacts, writeBreakResult, writeEntry, writeRunFacts } from '../scripts/proof-record.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'proof-record.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-breaks-'));
// The fixtures must not see this machine's git settings.
const emptyConfig = path.join(root, 'empty.gitconfig');
fs.writeFileSync(emptyConfig, ['[user]', '\tname = Fixture', '\temail = fixture@example.invalid', ''].join('\n'));
process.env.GIT_CONFIG_GLOBAL = emptyConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.SANAD_STATE_DIR = path.join(root, 'state');
after(() => fs.rmSync(root, { recursive: true, force: true }));

const lines = (...l) => l.join('\n') + '\n';
const F = 'src/rules.test.cjs';
const C0 = '[C0] keeps the old rule', C1 = '[C1] returns the correct value', C2 = '[C2] refuses unauthorized writes', C3 = '[C3] is proven by nothing';
const one = (title) => [`  it('${title}', () => {`, '    expect(calc.value()).toBe(2);', '  });'];
const TEST_OLD = lines("describe('rules', () => {", ...one(C0), '});');
const TEST_NEW = lines("describe('rules', () => {", ...one(C0), ...one(C1), ...one(C2), ...one(C3), '});');
const KEY = recordKey(['node', 'check.cjs'], '');
const B1 = { name: 'value is wrong', file: 'calc.cjs', find: '() => 2', put: '() => 3', mustFail: ['[C1]'] };
const B2 = { name: 'writes are open', file: 'calc.cjs', find: 'rows.push', put: 'rows.unshift', mustFail: ['[C2]'] };

let n = 0;
// A repository on branch `task`, cut from `main`. main holds one older test; the working tree adds three tests.
function repoWith() {
  const repo = path.join(root, 'repo' + (++n));
  fs.mkdirSync(repo);
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  const write = (files) => { for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), text); } };
  git('init', '-q', '-b', 'main'); git('config', 'core.autocrlf', 'false');
  write({ 'calc.cjs': lines('module.exports = {', '  value: () => 2,', "  write: (rows) => { rows.push('x'); },", '};'), 'other.cjs': 'module.exports = 1;\n', [F]: TEST_OLD });
  git('add', '--all'); git('commit', '-qm', 'base');
  git('checkout', '-q', '-b', 'task');
  write({ [F]: TEST_NEW });
  const lineOf = (title, file = F) => declaredTests(fs.readFileSync(path.join(repo, file), 'utf8'), file).find(d => d.titles.includes(title)).line;
  const hit = (title, file = F) => ({ file, line: lineOf(title, file), title, ran: 'rules > ' + title });
  return { repo, git, write, lineOf, hit };
}
// The record file of a repository, found by the folder it names.
function recordFile(repo) {
  for (const name of fs.readdirSync(proofDir()).filter(x => x.endsWith('.json'))) {
    const file = path.join(proofDir(), name);
    try { if (path.resolve(JSON.parse(fs.readFileSync(file, 'utf8')).top) === path.resolve(repo)) return file; } catch { /* another file */ }
  }
  throw new Error('no record file for ' + repo);
}
const titlesOf = (proven) => [...proven.values()].flat().map(t => t.title).sort();

// A writer in its own process: `breaks` saves <count> results; `entry` saves one entry and says how it went.
const writer = path.join(root, 'writer.mjs');
fs.writeFileSync(writer, lines(
  `import { writeBreakResult, writeEntry } from ${JSON.stringify(pathToFileURL(script).href)};`,
  'const [mode, repo, key, tag, count] = process.argv.slice(2);',
  "if (mode === 'breaks') for (let i = 0; i < Number(count); i++) writeBreakResult(repo, key, { name: tag + '-' + i, file: 'calc.cjs', find: 'a', put: 'b', mustFail: ['x'] }, { state: 'not-caught', tree: 'tree', run: tag });",
  "if (mode === 'entry') { try { writeEntry(repo, key, { ok: false, reason: tag }); console.log('WROTE'); } catch (e) { console.log(['ERROR', e.name, e.code, e.message].join(' ')); process.exit(3); } }"));
const child = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [writer, ...args], { windowsHide: true, env: process.env });
  let out = '';
  p.stdout.on('data', d => { out += d; });
  p.stderr.on('data', d => { out += d; });
  p.on('close', (code) => resolve({ code, out, ended: Date.now() }));
});

test('a break caught on tree T with a passing run on T is proven on T; an edit of an unrelated product file voids it', () => {
  const f = repoWith();
  const tree = codeFingerprint(f.repo);
  assert.match(tree, /^[0-9a-f]{40}/, 'the fixture has a tree id');
  // An older wording of the break, saved on an older tree: it is never proof here and the note does not count it.
  writeBreakResult(f.repo, KEY, { ...B1, find: 'an older wording' }, { state: 'caught', tree: 'b'.repeat(40), run: 'run-0', caught: [f.hit(C2)] });
  writeRunFacts(f.repo, KEY, { tree, run: 'run-1', green: true });
  writeBreakResult(f.repo, KEY, B1, { state: 'caught', tree, run: 'run-1', ms: 1200, caught: [f.hit(C1)] });

  const proven = provenTests(f.repo);
  assert.deepEqual(proven.get(F).map(t => [t.line, t.title, t.by]), [[f.lineOf(C1), C1, 'value is wrong']], 'the caught test, with the name of its break');
  const spans = testSpans(TEST_NEW, F);
  assert.equal(provenHas(proven.get(F), spans.find(s => s.titles.includes(C1))), true, 'the test check reads it as proven');
  assert.equal(provenHas(proven.get(F), spans.find(s => s.titles.includes(C2))), false, 'another test of the same file is not proven by it');
  assert.deepEqual(breakStates(f.repo, KEY, [B1, B2]).map(s => [s.name, s.state, s.saved, s.counts]),
    [['value is wrong', 'proved', 'caught', true], ['writes are open', 'run', null, false]]);

  // An edit of a product file the break does not name: another tree, so nothing counts.
  f.write({ 'other.cjs': 'module.exports = 2;\n' });
  assert.equal(provenTests(f.repo).size, 0, 'the result is of another tree now');
  assert.equal(breakStates(f.repo, KEY, [B1])[0].state, 'run', 'the break must run again');
  assert.match(recordNotes(f.repo).join('\n'), /0 break\(s\) hold a caught result on today's code, 1 still must run/);
  // The passing run passes on the new tree: the break did not run on it, so its older result still does not count.
  const edited = codeFingerprint(f.repo);
  assert.notEqual(edited, tree);
  writeRunFacts(f.repo, KEY, { tree: edited, run: 'run-2', green: true });
  assert.equal(provenTests(f.repo).size, 0, 'a result of tree T is no proof on the tree after the edit');
  assert.deepEqual(breakStates(f.repo, KEY, [B1]).map(s => [s.state, s.saved, s.counts]), [['run', null, false]]);
  assert.equal(evidenceOf(f.repo, { base: 'main' }).find(e => e.title === C1).evidence, 'none');

  // The exact tree again: the result is of this tree, so it counts again.
  f.write({ 'other.cjs': 'module.exports = 1;\n' });
  assert.deepEqual(titlesOf(provenTests(f.repo)), [C1]);
  assert.match(recordNotes(f.repo).join('\n'), /1 break\(s\) hold a caught result on today's code, 0 still must run/);

  // An edit of the test file itself voids it too.
  f.write({ [F]: TEST_NEW + '// a later edit\n' });
  assert.equal(provenTests(f.repo).size, 0);
});

test('a passing run that failed on tree T, or no passing run for T: no per-break result of T counts', () => {
  const f = repoWith();
  const tree = codeFingerprint(f.repo);
  writeBreakResult(f.repo, KEY, B1, { state: 'caught', tree, run: 'run-1', caught: [f.hit(C1)] });
  assert.equal(provenTests(f.repo).size, 0, 'no passing run is known for this tree');
  assert.deepEqual(breakStates(f.repo, KEY, [B1]).map(s => [s.state, s.counts]), [['proved', false]], 'caught here, so no second run; but it does not count yet');

  // The passing run passed on ANOTHER tree: that says nothing about this one.
  writeRunFacts(f.repo, KEY, { tree: 'f'.repeat(40), run: 'run-1', green: true });
  assert.equal(provenTests(f.repo).size, 0);

  writeRunFacts(f.repo, KEY, { tree, run: 'run-1', green: false });
  assert.equal(provenTests(f.repo).size, 0, 'the passing run failed on this tree');
  assert.match(recordNotes(f.repo).join('\n'), /the passing run did not pass on today's code/);

  writeRunFacts(f.repo, KEY, { tree, run: 'run-1', green: true });
  assert.deepEqual(titlesOf(provenTests(f.repo)), [C1]);

  // A later run of the same tree whose passing run failed takes the count back.
  writeRunFacts(f.repo, KEY, { tree, run: 'run-2', green: false });
  assert.equal(provenTests(f.repo).size, 0);
});

test('ten caught and one written as timeout or invalid: the ten stay, and the entry-level ok stays false', () => {
  const f = repoWith();
  const tree = codeFingerprint(f.repo);
  writeEntry(f.repo, KEY, { ok: false, reason: 'one break ran past the limit' });
  writeRunFacts(f.repo, KEY, { tree, run: 'run-1', green: true });
  const ten = Array.from({ length: 10 }, (_, i) => ({ name: 'break ' + i, file: 'calc.cjs', find: 'find ' + i, put: 'put', mustFail: ['t' + i] }));
  ten.forEach((b, i) => writeBreakResult(f.repo, KEY, b, { state: 'caught', tree, run: 'run-1', caught: [{ file: F, line: 100 + i, title: 'test ' + i }] }));
  const late = { name: 'late', file: 'calc.cjs', find: 'slow', put: 'put', mustFail: ['slow'] };
  const bad = { name: 'bad', file: 'calc.cjs', find: 'gone', put: 'put', mustFail: ['gone'] };
  // A state that is not caught keeps no test, whatever the caller hands in.
  writeBreakResult(f.repo, KEY, late, { state: 'timeout', tree, run: 'run-1', caught: [{ file: F, line: 200, title: 'slow test' }] });
  writeBreakResult(f.repo, KEY, bad, { state: 'invalid', tree, run: 'run-1' });

  assert.deepEqual(titlesOf(provenTests(f.repo)), ten.map((_, i) => 'test ' + i).sort(), 'the ten caught breaks stay proven');
  const states = breakStates(f.repo, KEY, [...ten, late, bad]);
  assert.deepEqual(states.slice(0, 10).map(s => s.state), Array(10).fill('proved'));
  assert.deepEqual(states.slice(10).map(s => [s.name, s.state, s.saved]), [['late', 'run', 'timeout'], ['bad', 'run', 'invalid']]);
  const record = readRecord(f.repo);
  assert.equal(record.entries[KEY].ok, false, 'the entry of the proof is still not ok');
  assert.equal(record.entries[KEY].reason, 'one break ran past the limit');
  assert.equal(Object.keys(record.perBreak[KEY]).length, 12);
  assert.throws(() => writeBreakResult(f.repo, KEY, bad, { state: 'passed', tree, run: 'run-1' }), /unknown state/, 'a state outside the list is refused');
  assert.deepEqual(BREAK_STATES, ['caught', 'not-caught', 'invalid', 'timeout', 'machine']);
});

test('takeBackRun removes only the results of that run id', () => {
  const f = repoWith();
  const tree = codeFingerprint(f.repo);
  writeRunFacts(f.repo, KEY, { tree, run: 'run-A', green: true });
  writeBreakResult(f.repo, KEY, B1, { state: 'caught', tree, run: 'run-A', caught: [f.hit(C1)] });
  const other = recordKey(['npm', 'test'], 'web');
  writeRunFacts(f.repo, other, { tree, run: 'run-B', green: true });
  writeBreakResult(f.repo, other, B2, { state: 'caught', tree, run: 'run-B', caught: [f.hit(C2)] });
  writeBreakResult(f.repo, KEY, B2, { state: 'machine', tree, run: 'run-B' });
  const before = readRecord(f.repo);

  assert.equal(takeBackRun(f.repo, 'run-B'), 3, 'two results and the run facts of run-B');
  const left = readRecord(f.repo);
  assert.deepEqual(left.perBreak[KEY][breakId(B1)], before.perBreak[KEY][breakId(B1)], "run-A's result is as it was, to the letter");
  assert.deepEqual(left.runs[KEY], before.runs[KEY]);
  assert.equal(left.perBreak[KEY][breakId(B2)], undefined);
  assert.deepEqual(left.perBreak[other], {});
  assert.deepEqual(left.runs[other], {});
  assert.deepEqual(titlesOf(provenTests(f.repo)), [C1]);

  assert.equal(takeBackRun(f.repo, 'run-B'), 0, 'nothing of that run is left');
  assert.equal(takeBackRun(f.repo, ''), 0, 'an empty run id takes nothing back');
  // The run id alone: every record of the proof folder is looked at.
  assert.equal(takeBackRun('run-A'), 2);
  assert.equal(provenTests(f.repo).size, 0);
});

test('two processes write their breaks at the same time: every result is kept', async () => {
  const f = repoWith();
  writeEntry(f.repo, KEY, { ok: false, reason: 'the proof started' });
  const done = await Promise.all(['w1', 'w2', 'w3', 'w4'].map(tag => child(['breaks', f.repo, KEY, tag, '6'])));
  assert.deepEqual(done.map(d => d.code), [0, 0, 0, 0], done.map(d => d.out).join('\n'));
  const names = Object.values(readRecord(f.repo).perBreak[KEY]).map(r => r.name).sort();
  assert.equal(names.length, 24, 'no writer lost another writer\'s result');
  assert.deepEqual(names, ['w1', 'w2', 'w3', 'w4'].flatMap(tag => [0, 1, 2, 3, 4, 5].map(i => `${tag}-${i}`)).sort());
  assert.equal(readRecord(f.repo).entries[KEY].reason, 'the proof started', 'the entry is untouched');
});

test('a lock held by a live writer: the second writer waits for it and writes after', async () => {
  const f = repoWith();
  writeEntry(f.repo, KEY, { ok: false, reason: 'first' });
  const file = recordFile(f.repo), lock = file + '.lock';
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
  let released = 0;
  const waiting = child(['entry', f.repo, KEY, 'second']);
  await new Promise(r => setTimeout(r, 1200));
  assert.equal(readRecord(f.repo).entries[KEY].reason, 'first', 'nothing is written while the lock is held');
  released = Date.now();
  fs.rmSync(lock, { recursive: true, force: true });
  const r = await waiting;
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /WROTE/);
  assert.ok(r.ended >= released, 'the write came after the lock was free');
  assert.equal(readRecord(f.repo).entries[KEY].reason, 'second');
  assert.equal(fs.existsSync(lock), false, 'the writer gave its own lock back');
});

test('a writer killed between the temp file and the rename: the record reads as before and the next writer goes on at once', () => {
  const f = repoWith();
  const tree = codeFingerprint(f.repo);
  writeBreakResult(f.repo, KEY, B1, { state: 'not-caught', tree, run: 'run-1' });
  const file = recordFile(f.repo), lock = file + '.lock';
  const gone = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;
  // What such a writer leaves: its lock with its process id, and half a temp file.
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'pid'), String(gone));
  fs.writeFileSync(`${file}.${gone}.tmp`, '{ "entries": { "half');
  assert.equal(readRecord(f.repo).perBreak[KEY][breakId(B1)].state, 'not-caught', 'the record is whole');
  const started = Date.now();
  writeBreakResult(f.repo, KEY, B2, { state: 'timeout', tree, run: 'run-2' });
  assert.ok(Date.now() - started < 3000, 'the lock of a writer that is gone is taken over at once');
  const kept = readRecord(f.repo).perBreak[KEY];
  assert.deepEqual([kept[breakId(B1)].state, kept[breakId(B2)].state], ['not-caught', 'timeout']);
});

test('an entry in today\'s format reads exactly as before, with or without break results beside it', () => {
  const f = repoWith();
  const tree = codeFingerprint(f.repo);
  const entry = { ok: true, breaks: 1, files: testFileHashes(f.repo, [F]), targets: testFileHashes(f.repo, ['calc.cjs']), code: tree,
    caught: { [F]: [{ line: f.lineOf(C1), title: C1, ran: 'rules > ' + C1, by: 'value is wrong' }] } };
  writeEntry(f.repo, KEY, entry);
  const alone = readRecord(f.repo);
  assert.deepEqual(Object.keys(alone).sort(), ['entries', 'top'], 'an entry alone adds no new field to the record');
  const before = [...provenTests(f.repo)];
  assert.deepEqual(before, [[F, entry.caught[F]]]);
  assert.deepEqual(recordNotes(f.repo), [], 'no new note for a record with entries only');

  // Break results of another proof beside it change nothing of the entry or of what it proves.
  const other = recordKey(['npm', 'test'], 'web');
  writeBreakResult(f.repo, other, B2, { state: 'not-caught', tree, run: 'run-9' });
  writeRunFacts(f.repo, other, { tree, run: 'run-9', green: true });
  assert.deepEqual(readRecord(f.repo).entries, alone.entries);
  assert.deepEqual([...provenTests(f.repo)], before);

  // A new entry (the proof starts again and is taken back) leaves the break results as they are.
  const kept = readRecord(f.repo);
  writeEntry(f.repo, KEY, { ok: false, reason: 'the proof started and did not end' });
  const after = readRecord(f.repo);
  assert.deepEqual(after.perBreak, kept.perBreak);
  assert.deepEqual(after.runs, kept.runs);
  assert.equal(provenTests(f.repo).size, 0, 'the entry no longer proves anything');
});

test('a result with an empty tree id never counts', () => {
  const f = repoWith();
  const tree = codeFingerprint(f.repo);
  writeBreakResult(f.repo, KEY, B1, { state: 'caught', tree: '', run: 'run-1', caught: [f.hit(C1)] });
  assert.equal(writeRunFacts(f.repo, KEY, { tree: '', run: 'run-1', green: true }), false, 'run facts with no tree are not kept');
  assert.equal(readRecord(f.repo).runs, undefined);
  writeRunFacts(f.repo, KEY, { tree, run: 'run-1', green: true });
  assert.equal(provenTests(f.repo).size, 0);
  assert.deepEqual(breakStates(f.repo, KEY, [B1]).map(s => [s.state, s.saved]), [['run', null]]);
  // When git cannot name today's tree either, an empty id still matches nothing.
  assert.deepEqual(breakStates(f.repo, KEY, [B1], '').map(s => s.state), ['run']);
  assert.equal(evidenceOf(f.repo, { base: 'main' }).find(e => e.title === C1).evidence, 'none');
});

test('CRLF and LF copies of one test file give the same hash, and of one break the same id', () => {
  const f = repoWith();
  f.write({ 'src/lf.test.cjs': TEST_NEW, 'src/crlf.test.cjs': TEST_NEW.replace(/\n/g, '\r\n') });
  const h = testFileHashes(f.repo, ['src/lf.test.cjs', 'src/crlf.test.cjs']);
  assert.equal(h['src/lf.test.cjs'], h['src/crlf.test.cjs']);
  const two = { name: 'two lines', file: 'src\\calc.cjs', find: 'a\nb', put: 'c\nd', mustFail: ['[C1]'] };
  assert.equal(breakId(two), breakId({ ...two, file: 'src/calc.cjs', find: 'a\r\nb', put: 'c\r\nd' }));
});

test('two breaks with one name and another find text, put text, file or mustFail are different breaks', () => {
  const ids = [B1, { ...B1, find: '() => 2 ' }, { ...B1, put: '() => 4' }, { ...B1, file: 'other.cjs' }, { ...B1, mustFail: ['[C2]'] }, { ...B1, name: 'another name' }].map(breakId);
  assert.equal(new Set(ids).size, ids.length, ids.join(' '));
  assert.match(ids[0], /^[0-9a-f]{16}$/);
  assert.equal(breakId(B1), breakId({ ...B1 }), 'the same break gives the same id');

  // A result saved for one of them says nothing about the other.
  const f = repoWith();
  const tree = codeFingerprint(f.repo);
  writeRunFacts(f.repo, KEY, { tree, run: 'run-1', green: true });
  writeBreakResult(f.repo, KEY, B1, { state: 'caught', tree, run: 'run-1', caught: [f.hit(C1)] });
  assert.deepEqual(breakStates(f.repo, KEY, [B1, { ...B1, find: '() => 2 ' }]).map(s => s.state), ['proved', 'run']);
});

test('evidenceOf: red on the old code reads "old code", caught by a break reads the break\'s name, neither reads "none"', () => {
  const f = repoWith();
  const tree = codeFingerprint(f.repo);
  // As the runner saves them: the passing run first, then the tests seen red on the old code, then each break.
  writeRunFacts(f.repo, KEY, { tree, run: 'run-1', green: true });
  writeRunFacts(f.repo, KEY, { tree, run: 'run-1', redOld: [f.hit(C2)] });
  writeBreakResult(f.repo, KEY, B1, { state: 'caught', tree, run: 'run-1', caught: [f.hit(C1)] });
  const facts = readRecord(f.repo).runs[KEY][tree];
  assert.equal(facts.green, true, 'the second save of the same run keeps what the first one said');

  const evidence = evidenceOf(f.repo, { base: 'main' });
  assert.deepEqual(evidence.map(e => [e.title, e.evidence]), [[C1, 'break value is wrong'], [C2, 'old code'], [C3, 'none']], 'one row per new test; the older test [C0] is not asked');
  assert.deepEqual(evidence.map(e => [e.file, e.line]), [C1, C2, C3].map(t => [F, f.lineOf(t)]));
  assert.deepEqual(evidence[0].breaks, ['value is wrong']);
  assert.equal(evidenceOf(f.repo, { base: 'no-such-branch' }), null, 'no merge base: the new tests are not known');

  // The passing run failed on this tree in a later run: red on the old code proves nothing by itself.
  writeRunFacts(f.repo, KEY, { tree, run: 'run-2', green: false, redOld: [f.hit(C2)] });
  assert.deepEqual(evidenceOf(f.repo, { base: 'main' }).map(e => e.evidence), ['none', 'none', 'none']);
});

test('evidenceOf after the test file is renamed, or a test is moved to another file: none until the proof runs again', () => {
  const f = repoWith();
  let tree = codeFingerprint(f.repo);
  writeRunFacts(f.repo, KEY, { tree, run: 'run-1', green: true, redOld: [f.hit(C2)] });
  writeBreakResult(f.repo, KEY, B1, { state: 'caught', tree, run: 'run-1', caught: [f.hit(C1)] });
  assert.deepEqual(evidenceOf(f.repo, { base: 'main' }).map(e => e.evidence), ['break value is wrong', 'old code', 'none']);

  // A test moved to another file: the same title on the same line there is still not the proven test.
  f.write({ [F]: TEST_OLD, 'src/moved.test.cjs': TEST_NEW });
  const moved = evidenceOf(f.repo, { base: 'main' });
  assert.deepEqual(moved.map(e => [e.file, e.evidence]), [C0, C1, C2, C3].map(() => ['src/moved.test.cjs', 'none']));
  assert.equal(provenTests(f.repo).size, 0);

  // Proved again on the new tree, under the new file name.
  tree = codeFingerprint(f.repo);
  writeRunFacts(f.repo, KEY, { tree, run: 'run-2', green: true });
  writeBreakResult(f.repo, KEY, B1, { state: 'caught', tree, run: 'run-2', caught: [f.hit(C1, 'src/moved.test.cjs')] });
  assert.equal(evidenceOf(f.repo, { base: 'main' }).find(e => e.title === C1).evidence, 'break value is wrong');
});

test('a record edited by hand to mark a break caught, or a run passed, does not count', () => {
  const f = repoWith();
  const tree = codeFingerprint(f.repo);
  writeRunFacts(f.repo, KEY, { tree, run: 'run-1', green: true });
  writeBreakResult(f.repo, KEY, B1, { state: 'not-caught', tree, run: 'run-1' });
  // An older caught result of another tree.
  writeBreakResult(f.repo, KEY, B2, { state: 'caught', tree: 'a'.repeat(40), run: 'run-0', caught: [f.hit(C2)] });
  const file = recordFile(f.repo);
  const edit = (change) => { const record = JSON.parse(fs.readFileSync(file, 'utf8')); change(record); fs.writeFileSync(file, JSON.stringify(record, null, 2)); };

  edit(r => { const mine = r.perBreak[KEY][breakId(B1)]; mine.state = 'caught'; mine.caught = { [F]: [{ line: f.lineOf(C1), title: C1 }] }; mine.files = testFileHashes(f.repo, [F]); });
  edit(r => { r.perBreak[KEY][breakId(B2)].tree = tree; });
  assert.equal(provenTests(f.repo).size, 0, 'a state turned into caught and a tree id pasted in do not count');
  assert.deepEqual(breakStates(f.repo, KEY, [B1, B2]).map(s => s.state), ['run', 'run']);

  // A result copied under another break's id does not count for that break.
  const g = repoWith();
  const gTree = codeFingerprint(g.repo);
  writeRunFacts(g.repo, KEY, { tree: gTree, run: 'run-1', green: false });
  writeBreakResult(g.repo, KEY, B1, { state: 'caught', tree: gTree, run: 'run-1', caught: [g.hit(C1)] });
  const gFile = recordFile(g.repo);
  const record = JSON.parse(fs.readFileSync(gFile, 'utf8'));
  record.perBreak[KEY][breakId(B2)] = { ...record.perBreak[KEY][breakId(B1)] };
  record.runs[KEY][gTree].green = true;
  fs.writeFileSync(gFile, JSON.stringify(record, null, 2));
  assert.equal(provenTests(g.repo).size, 0, 'a passing run turned into passed by hand does not count');
  assert.deepEqual(breakStates(g.repo, KEY, [B1, B2]).map(s => [s.state, s.counts]), [['proved', false], ['run', false]]);

  // A record that is no JSON, or holds the wrong shapes, reads as nothing and breaks no reader.
  fs.writeFileSync(gFile, JSON.stringify({ top: g.repo, entries: {}, perBreak: [1, 2], runs: 'x' }));
  assert.equal(provenTests(g.repo).size, 0);
  assert.deepEqual(breakStates(g.repo, KEY, [B1]).map(s => s.state), ['run']);
  assert.deepEqual(recordNotes(g.repo), []);
  writeBreakResult(g.repo, KEY, B1, { state: 'timeout', tree: gTree, run: 'run-2' });
  assert.equal(readRecord(g.repo).perBreak[KEY][breakId(B1)].state, 'timeout', 'the next writer repairs the shape');
});

test('the record lives under a state folder with spaces and non-ASCII letters', () => {
  const f = repoWith();
  const tree = codeFingerprint(f.repo);
  const was = process.env.SANAD_STATE_DIR;
  process.env.SANAD_STATE_DIR = path.join(root, 'state dir é عربي');
  try {
    writeRunFacts(f.repo, KEY, { tree, run: 'run-1', green: true });
    writeBreakResult(f.repo, KEY, B1, { state: 'caught', tree, run: 'run-1', caught: [f.hit(C1)] });
    assert.ok(fs.existsSync(recordFile(f.repo)), 'the record is in that folder');
    assert.ok(recordFile(f.repo).startsWith(process.env.SANAD_STATE_DIR));
    assert.deepEqual(titlesOf(provenTests(f.repo)), [C1]);
    assert.equal(takeBackRun('run-1'), 2);
  } finally { process.env.SANAD_STATE_DIR = was; }
  assert.equal(readRecord(f.repo), null, 'the usual folder holds nothing of this repository');
});

test('withdrawRunFacts: a pass, then a new run starts: no proof for that tree until a new pass is written; other trees are kept', () => {
  const f = repoWith();
  const tree = codeFingerprint(f.repo), other = 'e'.repeat(40);
  writeRunFacts(f.repo, KEY, { tree, run: 'run-1', green: true });
  writeRunFacts(f.repo, KEY, { tree: other, run: 'run-1', green: true });
  writeBreakResult(f.repo, KEY, B1, { state: 'caught', tree, run: 'run-1', caught: [f.hit(C1)] });
  assert.deepEqual(titlesOf(provenTests(f.repo)), [C1]);
  assert.equal(withdrawRunFacts(f.repo, KEY, tree), true);
  assert.equal(provenTests(f.repo).size, 0);
  assert.deepEqual(breakStates(f.repo, KEY, [B1]).map(s => s.counts), [false]);
  assert.ok(evidenceOf(f.repo, { base: 'main' }).every(e => e.evidence === 'none'));
  assert.equal(readRecord(f.repo).runs[KEY][other].green, true, 'another tree keeps its fact');
  assert.equal(withdrawRunFacts(f.repo, KEY, tree), false, 'nothing left to withdraw');
  writeRunFacts(f.repo, KEY, { tree, run: 'run-2', green: true });
  assert.deepEqual(titlesOf(provenTests(f.repo)), [C1], 'written again by a passing run');
});

test('U2-1: an --old run, then a --then-green run: the red-on-old tests stay while the test file is the same', () => {
  const f = repoWith();
  const tree = codeFingerprint(f.repo);
  writeRunFacts(f.repo, KEY, { tree, run: 'run-1', green: true });
  writeRunFacts(f.repo, KEY, { tree, run: 'run-1', redOld: [f.hit(C2)], old: 'abc123' });
  // The second proof starts: the pass is withdrawn, the old-code facts stay.
  assert.equal(withdrawRunFacts(f.repo, KEY, tree), true);
  const left = readRecord(f.repo).runs[KEY][tree];
  assert.equal(left.green, false);
  assert.deepEqual(Object.keys(left.redOld), [F]);
  assert.deepEqual(evidenceOf(f.repo, { base: 'main' }).map(e => e.evidence), ['none', 'none', 'none'], 'no pass, no proof');
  assert.equal(withdrawRunFacts(f.repo, KEY, tree), false, 'a second withdraw changes nothing');
  // The passing run of the second proof ends green and says nothing of the old code.
  writeRunFacts(f.repo, KEY, { tree, run: 'run-2', green: true });
  assert.deepEqual(evidenceOf(f.repo, { base: 'main' }).map(e => [e.title, e.evidence]), [[C1, 'none'], [C2, 'old code'], [C3, 'none']]);
  // The test file changed: the saved hash no longer fits, so the old-code fact stops counting.
  fs.appendFileSync(path.join(f.repo, F), '// changed'+String.fromCharCode(10));
  assert.ok(evidenceOf(f.repo, { base: 'main' }).every(e => e.evidence === 'none'));
});
