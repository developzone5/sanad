import './neutral-git-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { paths, readTask, writeTask, readPins, addPin, readDecisions, addDecision, taskDirOf, setTaskDir, NotesError, VERSION } from '../scripts/notes-dir.mjs';
import { BRIEF as SIBLINGS_BRIEF, LIST as SIBLINGS_LIST, REPORT as SIBLINGS_REPORT, writeBrief } from '../scripts/siblings.mjs';
import { canonicalTop } from '../scripts/proof-record.mjs';

// 2026-11-19: the notes folder's file names were spelled by each tool, and a task's state (its repository, its
// review rounds, the owner's decisions) lived only in the chat. One map of the names, and three saved records.
const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.join(here, '..', 'scripts');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'notes-dir-')));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const emptyConfig = path.join(root, 'empty.gitconfig');
fs.writeFileSync(emptyConfig, '');
process.env.GIT_CONFIG_GLOBAL = emptyConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';
for (const who of ['AUTHOR', 'COMMITTER']) { process.env[`GIT_${who}_NAME`] = 'Fixture'; process.env[`GIT_${who}_EMAIL`] = 'fixture@example.invalid'; }
// The pointers of these tests live in their own state folder, never in the machine's.
process.env.SANAD_STATE_DIR = path.join(root, 'state');
process.env.SANAD_CODEX_HOME = path.join(root, 'codex-home-empty');
fs.mkdirSync(process.env.SANAD_CODEX_HOME);

let n = 0;
const notesDir = (name = 'notes') => { const dir = path.join(root, `${name} ${++n}`); fs.mkdirSync(dir); return dir; };
function repoDir() {
  const repo = path.join(root, 'repo' + (++n));
  fs.mkdirSync(repo);
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
  git('add', '-A'); git('commit', '-qm', 'base');
  return { repo, git };
}
const id = (word) => crypto.createHash('sha1').update(word).digest('hex');
const pin = (word, more = {}) => ({ kind: 'full', commit: id('commit ' + word), tree: id('tree ' + word), mergeBase: id('base'), ...more });
const refusal = (code, file) => (e) => e instanceof NotesError && e.code === code && (!file || (e.file === file && e.message.includes(file)));
const bytes = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);

// A second process that writes records: `node child.mjs <action> <notes> ...`.
const child = path.join(root, 'child.mjs');
fs.writeFileSync(child, `
import crypto from 'node:crypto';
import { addPin, addDecision, taskDirOf } from ${JSON.stringify(pathToFileURL(path.join(scripts, 'notes-dir.mjs')).href)};
const [action, where, a, b] = process.argv.slice(2);
const id = (word) => crypto.createHash('sha1').update(word).digest('hex');
try {
  if (action === 'pins') for (let i = 0; i < Number(a); i++) addPin(where, { kind: 'full', commit: id('commit ' + b + i), tree: id('tree ' + b + i), mergeBase: id('base'), seats: [b] });
  else if (action === 'pin') { addPin(where, { kind: 'full', commit: id('commit ' + a), tree: id('tree ' + a), mergeBase: id('base') }, b ? { waitMs: Number(b) } : undefined); process.stdout.write('WROTE ' + Date.now() + '\\n'); }
  else if (action === 'decide-forever') for (let i = 0; ; i++) addDecision(where, { kind: 'note', words: 'leave it ' + i });
  else if (action === 'taskdir') process.stdout.write(taskDirOf(where) + '\\n');
} catch (e) { process.stdout.write('ERR ' + e.code + ' ' + e.message + '\\n'); process.exitCode = 3; }
`);
const start = (args, env = process.env) => new Promise((resolve) => {
  const c = spawn(process.execPath, [child, ...args], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  c.stdout.on('data', (d) => { out += d; });
  c.stderr.on('data', (d) => { out += d; });
  c.on('close', (code) => resolve({ code, out }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A process id that is not running any more.
const deadPid = () => spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;
const lockOf = (file, owner) => { fs.mkdirSync(file + '.lock'); if (owner) fs.writeFileSync(path.join(file + '.lock', 'owner.json'), JSON.stringify({ host: os.hostname(), token: 'someone-else', at: new Date().toISOString(), ...owner })); return file + '.lock'; };
const age = (dir, ms) => { const t = new Date(Date.now() - ms); fs.utimesSync(dir, t, t); };

test('paths(notes) gives the names lines.mjs, siblings.mjs and review-brief.mjs use today', () => {
  const notes = notesDir('task notes'), p = paths(notes);
  assert.equal(p.dir, notes);
  assert.deepEqual(Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'dir').map(([k, v]) => [k, path.relative(notes, v)])), {
    ticket: 'ticket.md', lines: 'lines.md', check: 'check.md', places: 'places.md',
    siblings: 'siblings.md', siblingsReport: 'siblings-report.md', siblingsBrief: 'siblings-brief.md',
    brief: 'brief.md', fresh: 'brief-fresh.md', launch: 'launch.md', engine: 'engine.txt', size: 'size.txt',
    breaks: 'breaks.json', proofLog: 'proof.log',
    task: 'task.json', pins: 'review-pin.json', decisions: 'decisions.json',
  });
  assert.equal(paths(path.relative(process.cwd(), notes) || '.').dir, notes, 'a relative folder is the same folder');
  for (const none of ['', '  ', undefined, null]) assert.throws(() => paths(none), refusal('usage'));

  // lines.mjs: --out <notes>/lines.md, and the ticket text beside it as ticket.md.
  const from = path.join(root, 'ticket-text.txt');
  fs.writeFileSync(from, 'Fix the title\nExpected: once\n');
  const lines = spawnSync(process.execPath, [path.join(scripts, 'lines.mjs'), '--from', from, '--out', p.lines], { encoding: 'utf8', windowsHide: true });
  assert.equal(lines.status, 0, lines.stderr);
  assert.equal(fs.readFileSync(p.ticket, 'utf8'), 'Fix the title\nExpected: once\n');

  // siblings.mjs: its three names, and the three files it reads from the folder, in its own order.
  assert.deepEqual([p.siblingsBrief, p.siblings, p.siblingsReport].map(f => path.basename(f)), [SIBLINGS_BRIEF, SIBLINGS_LIST, SIBLINGS_REPORT]);
  const { repo, git } = repoDir();
  // With the late-check-lines rule off, the brief asks for check.md first: the order this test reads the files in.
  spawnSync('git', ['config', 'sanad.lateCheckLines', 'false'], { cwd: repo, windowsHide: true });
  assert.throws(() => writeBrief({ notes, repo }), /no check\.md in /, 'lines.md was found where paths() names it');
  fs.writeFileSync(p.check, '- [T1] the title is fixed\n- [T2] shown once\n');
  assert.throws(() => writeBrief({ notes, repo }), /no places\.md in /, 'check.md was found where paths() names it');
  fs.writeFileSync(p.places, 'not a places list\n');
  assert.throws(() => writeBrief({ notes, repo }), /places\.md in .* is not a places list/, 'places.md was read from where paths() names it');
  fs.rmSync(p.places);

  // review-brief.mjs: the brief given as --out, and the four files it writes beside it.
  git('switch', '-q', '-c', 'fix/title'); fs.writeFileSync(path.join(repo, 'README.md'), 'y\n');
  const outside = path.join(root, 'no-outside.md');
  fs.writeFileSync(outside, '');
  const brief = spawnSync(process.execPath, [path.join(scripts, 'review-brief.mjs'), '--out', p.brief, '--ticket', p.ticket, '--lines', p.lines, '--check', p.check,
    '--repo', repo, '--base', 'main', '--outside', outside, '--engine', 'codex', '--size', 'small'], { encoding: 'utf8', windowsHide: true });
  assert.equal(brief.status, 0, brief.stderr);
  for (const key of ['brief', 'fresh', 'launch', 'engine', 'size']) assert.ok(fs.existsSync(p[key]), `review-brief wrote ${path.basename(p[key])}`);
  assert.equal(fs.readFileSync(p.engine, 'utf8').trim(), 'codex');
  assert.equal(fs.readFileSync(p.size, 'utf8').trim(), 'small');
  assert.match(fs.readFileSync(p.launch, 'utf8'), /brief-fresh\.md/, 'the launch lines name the fresh brief by the same name');
});

test('the task record: what is written is read back, with the repository\'s canonical top', () => {
  const notes = notesDir(), { repo } = repoDir();
  assert.equal(readTask(notes), null);
  const saved = writeTask(notes, { repo, base: 'origin/staging', branch: 'fix/title', startedAt: '2026-11-19T08:00:00+03:00', lane: 'small',
    sides: [{ name: 'server', cwd: 'api', testCommand: ['dotnet', 'test', '--filter', 'Title'], fixFiles: ['api/Title.cs'] }, { name: 'page', testCommand: ['npx', 'vitest', 'run'] }] });
  const task = readTask(notes);
  assert.deepEqual(task, saved);
  assert.deepEqual(task, {
    repo, base: 'origin/staging', branch: 'fix/title', startedAt: '2026-11-19T05:00:00.000Z', lane: 'small',
    sides: [{ name: 'server', cwd: 'api', testCommand: ['dotnet', 'test', '--filter', 'Title'], fixFiles: ['api/Title.cs'] }, { name: 'page', cwd: '', testCommand: ['npx', 'vitest', 'run'], fixFiles: [] }],
    version: 1, top: canonicalTop(repo),
  });
  assert.equal(JSON.parse(fs.readFileSync(paths(notes).task, 'utf8')).version, VERSION);
  // Written again for the same repository (a start that is run twice): replaced.
  assert.equal(writeTask(notes, { repo, base: 'origin/dev' }).base, 'origin/dev');
  assert.deepEqual(readTask(notes).sides, []);
  assert.match(readTask(notes).startedAt, /^\d{4}-\d\d-\d\dT/);
  const before = bytes(paths(notes).task);
  for (const bad of [{}, { repo: '' }, { repo, sides: 'server' }, { repo, sides: [{ name: 'a' }] }, { repo, sides: [{ name: '', testCommand: ['x'] }] },
    { repo, sides: [{ name: 'a', testCommand: ['x'] }, { name: 'a', testCommand: ['y'] }] }, { repo, sides: [{ name: 'a', testCommand: 'npm test' }] }, { repo, startedAt: 'soon' }, { repo, base: 7 }]) {
    assert.throws(() => writeTask(notes, bad), refusal('usage'), JSON.stringify(bad));
  }
  assert.equal(bytes(paths(notes).task), before, 'a refused task changes nothing');
});

test('pins: each new commit is one more round; the same commit pinned again is the same round', () => {
  const notes = notesDir();
  assert.deepEqual(readPins(notes), []);
  const first = addPin(notes, pin('A', { seats: ['fresh'], frozen: '', at: '2026-11-19T09:00:00Z' }));
  assert.deepEqual(first, { kind: 'full', commit: id('commit A'), tree: id('tree A'), mergeBase: id('base'), seats: ['fresh'], frozen: '', at: '2026-11-19T09:00:00.000Z', round: 1 });
  // The brief made a second time on the same commit (the tool runs twice per round today): still round 1, last fields kept.
  assert.equal(addPin(notes, pin('A', { seats: ['fresh', 'risk'], frozen: 'C:/copies/a' })).round, 1);
  assert.deepEqual(readPins(notes).map(x => [x.round, x.seats.length, x.frozen]), [[1, 2, 'C:/copies/a']]);
  // Y5: the same commit pinned again keeps the round's first time.
  assert.equal(readPins(notes)[0].at, '2026-11-19T09:00:00.000Z');
  assert.equal(addPin(notes, pin('B', { kind: 'recheck', round: 9, note: 'kept' })).round, 2, 'the round is given by the record, not by the caller');
  assert.equal(addPin(notes, pin('B')).round, 3, 'another kind of review on that commit is its own round');
  assert.equal(addPin(notes, pin('A')).round, 4, 'an earlier commit pinned again later is a new round');
  const pins = readPins(notes);
  assert.deepEqual(pins.map(x => [x.round, x.kind, x.commit === id('commit A')]), [[1, 'full', true], [2, 'recheck', false], [3, 'full', false], [4, 'full', true]]);
  assert.equal(pins[1].note, 'kept', 'a field this file does not know is kept');
  assert.match(pins[1].at, /^\d{4}-\d\d-\d\dT.*Z$/);
  const before = bytes(paths(notes).pins);
  for (const bad of [undefined, {}, pin('C', { kind: 'quick' }), pin('C', { commit: 'abc1234' }), pin('C', { tree: '' }), pin('C', { mergeBase: undefined }), pin('C', { seats: 'fresh' }), pin('C', { at: 'later' })]) {
    assert.throws(() => addPin(notes, bad), refusal('usage'), JSON.stringify(bad));
  }
  assert.equal(bytes(paths(notes).pins), before);
});

test('decisions: the owner\'s words are kept as typed, each with its own id', () => {
  const notes = notesDir();
  assert.deepEqual(readDecisions(notes), []);
  const one = addDecision(notes, { kind: 'note', question: 'Fix the rare timing case now?', words: '  leave it, لا تغيّره  ', source: 'chat', notes: ['N12', 'N14'], at: '2026-11-19T10:00:00Z' });
  assert.deepEqual(one, { kind: 'note', question: 'Fix the rare timing case now?', words: '  leave it, لا تغيّره  ', source: 'chat', notes: ['N12', 'N14'], at: '2026-11-19T10:00:00.000Z', id: 'D1' });
  assert.equal(addDecision(notes, { kind: 'drop-line', words: 'drop T4', id: 'D9', line: 'T4' }).id, 'D2', 'the id is given by the record');
  assert.deepEqual(readDecisions(notes).map(d => [d.id, d.kind, d.question, d.source, d.notes.length, d.line]), [['D1', 'note', 'Fix the rare timing case now?', 'chat', 2, undefined], ['D2', 'drop-line', '', '', 0, 'T4']]);
  const before = bytes(paths(notes).decisions);
  for (const bad of [undefined, { words: 'yes' }, { kind: 'note' }, { kind: 'note', words: '   ' }, { kind: 'note', words: 'yes', notes: 'N1' }, { kind: 'note', words: 'yes', notes: [12] }]) {
    assert.throws(() => addDecision(notes, bad), refusal('usage'), JSON.stringify(bad));
  }
  assert.equal(bytes(paths(notes).decisions), before);
});

test('a version 2 file or a broken file is refused by its name, by readers and writers, and stays as it is', () => {
  const { repo } = repoDir();
  const cases = [
    ['task', (notes) => readTask(notes), (notes) => writeTask(notes, { repo }), { version: 1, repo, top: canonicalTop(repo) }],
    ['pins', (notes) => readPins(notes), (notes) => addPin(notes, pin('A')), { version: 1, pins: 'none' }],
    ['decisions', (notes) => readDecisions(notes), (notes) => addDecision(notes, { kind: 'note', words: 'yes' }), { version: 1 }],
  ];
  for (const [key, read, write, wrongShape] of cases) {
    const notes = notesDir(), file = paths(notes)[key];
    const texts = [
      ['version', JSON.stringify({ version: 2, pins: [], decisions: [], repo, top: canonicalTop(repo), sides: [] })],
      ['version', JSON.stringify({ pins: [], decisions: [], repo, top: canonicalTop(repo), sides: [] })],
      ['broken', '{"version": 1, "pins": ['], ['broken', ''], ['broken', '[]'], ['broken', 'null'], ['broken', JSON.stringify(wrongShape)],
    ];
    for (const [code, text] of texts) {
      fs.writeFileSync(file, text);
      assert.throws(() => read(notes), refusal(code, file), `${key} read: ${text}`);
      assert.throws(() => write(notes), refusal(code, file), `${key} write: ${text}`);
      assert.equal(fs.readFileSync(file, 'utf8'), text, 'the file is not replaced');
      assert.equal(fs.existsSync(file + '.lock'), false, 'and the lock is given back');
    }
    // Deleting the file is the fix the message names.
    fs.rmSync(file);
    write(notes);
    assert.ok(read(notes));
  }
});

test('two processes add pins at once and every pin is kept, each with its own round', async () => {
  const notes = notesDir();
  const done = await Promise.all(['a', 'b', 'c', 'd'].map(tag => start(['pins', notes, '6', tag])));
  for (const d of done) assert.equal(d.code, 0, d.out);
  const pins = readPins(notes);
  assert.equal(pins.length, 24);
  assert.deepEqual(pins.map(x => x.round), Array.from({ length: 24 }, (_, i) => i + 1));
  assert.equal(new Set(pins.map(x => x.commit)).size, 24);
  assert.deepEqual(fs.readdirSync(notes), ['review-pin.json'], 'no lock and no temp file is left');
});

test('with a live lock the second writer waits; it never writes without the lock', async () => {
  const notes = notesDir(), file = paths(notes).pins;
  addPin(notes, pin('A'));
  const before = bytes(file);
  // Held by a process that is alive (this one), and not ours.
  const lock = lockOf(file, { pid: process.pid });
  const t0 = Date.now();
  assert.throws(() => addPin(notes, pin('B'), { waitMs: 300 }), (e) => refusal('locked', file)(e) && e.message.includes(lock) && /nothing was written/.test(e.message));
  assert.ok(Date.now() - t0 >= 300, 'it waited for the lock first');
  assert.equal(bytes(file), before, 'nothing was written');
  assert.ok(fs.existsSync(path.join(lock, 'owner.json')), 'and the other writer\'s lock is still there');
  assert.deepEqual(fs.readdirSync(notes).sort(), ['review-pin.json', 'review-pin.json.lock'], 'no temp file was made');
  // The same in a second process: it gives up by name, exit 3.
  const gaveUp = await start(['pin', notes, 'B', '300']);
  assert.equal(gaveUp.code, 3, gaveUp.out);
  assert.match(gaveUp.out, /^ERR locked /);
  assert.equal(bytes(file), before);
  // A second process that waits while the lock is held writes only after it opens.
  const waiting = start(['pin', notes, 'B']);
  await sleep(700);
  assert.equal(bytes(file), before, 'still waiting');
  const opened = Date.now();
  fs.rmSync(lock, { recursive: true });
  const wrote = await waiting;
  assert.equal(wrote.code, 0, wrote.out);
  assert.ok(Number(/WROTE (\d+)/.exec(wrote.out)[1]) >= opened, 'the write came after the lock opened');
  assert.deepEqual(readPins(notes).map(x => x.round), [1, 2]);
});

test('a lock left by a dead process is taken over; an unsigned or very old one only when it is old enough', () => {
  const notes = notesDir(), file = paths(notes).decisions;
  addDecision(notes, { kind: 'note', words: 'one' });
  // A writer killed between the temp file and the rename: its lock, its half-written temp file, the old file whole.
  const gone = deadPid();
  lockOf(file, { pid: gone });
  fs.writeFileSync(`${file}.${gone}.tmp`, '{"version": 1, "decis');
  assert.deepEqual(readDecisions(notes).map(d => d.id), ['D1'], 'the file is whole');
  const t0 = Date.now();
  assert.equal(addDecision(notes, { kind: 'note', words: 'two' }).id, 'D2');
  assert.ok(Date.now() - t0 < 1500, 'no wait for a writer that is gone');
  assert.deepEqual(fs.readdirSync(notes), ['decisions.json'], 'the dead lock and the temp file are gone');

  // A lock folder with no owner file: fresh, it may be a writer about to sign it.
  const unsigned = lockOf(file);
  assert.throws(() => addDecision(notes, { kind: 'note', words: 'three' }, { waitMs: 200 }), refusal('locked', file));
  age(unsigned, 3000);
  assert.equal(addDecision(notes, { kind: 'note', words: 'three' }, { waitMs: 200 }).id, 'D3');

  // Signed by a process id that is alive but is not a writer any more (ids are given out again): held while
  // it is young, taken once it is older than any writer holds a lock.
  const stuck = lockOf(file, { pid: process.pid });
  age(stuck, 5000);
  assert.throws(() => addDecision(notes, { kind: 'note', words: 'four' }, { waitMs: 200 }), refusal('locked', file));
  age(stuck, 11000);
  assert.equal(addDecision(notes, { kind: 'note', words: 'four' }, { waitMs: 200 }).id, 'D4');
  assert.deepEqual(fs.readdirSync(notes), ['decisions.json']);
});

test('a killed writer leaves a whole file, a reader beside it never sees a part, and the next writer goes on', async () => {
  const notes = notesDir();
  let count = 0;
  for (const more of [3, 7, 12]) {
    // The writer adds decisions as fast as it can; it is killed at whatever point it has reached by then.
    const c = spawn(process.execPath, [child, 'decide-forever', notes], { windowsHide: true, stdio: 'ignore' });
    const closed = new Promise((resolve) => c.once('close', resolve));
    const giveUp = Date.now() + 20000;
    // Every read beside the writer is a whole record, or it throws here.
    while (readDecisions(notes).length < count + more && Date.now() < giveUp) await sleep(3);
    c.kill('SIGKILL');
    await closed;
    const kept = readDecisions(notes);
    assert.ok(kept.length >= count + more, `the writer wrote before it was killed (${kept.length})`);
    assert.deepEqual(kept.map(d => d.id), kept.map((_, i) => `D${i + 1}`), 'every record is whole and in order');
    count = kept.length;
    assert.equal(addDecision(notes, { kind: 'note', words: 'after the kill' }).id, `D${++count}`);
  }
  assert.deepEqual(fs.readdirSync(notes), ['decisions.json']);
});

test('two work trees of one repository get two pointers; no session id is needed', async () => {
  const { repo, git } = repoDir();
  const tree = path.join(root, 'tree' + (++n));
  git('worktree', 'add', '-q', '-b', 'side', tree);
  const a = notesDir('task a'), b = notesDir('task b');
  assert.equal(taskDirOf(repo), '');
  assert.equal(setTaskDir(repo, a), a);
  assert.equal(setTaskDir(tree, b), b);
  assert.deepEqual([taskDirOf(repo), taskDirOf(tree)], [a, b]);
  assert.equal(fs.readdirSync(path.join(process.env.SANAD_STATE_DIR, 'sanad-task')).filter(f => f.endsWith('.json')).length, 2);
  fs.mkdirSync(path.join(repo, 'src'));
  assert.equal(taskDirOf(path.join(repo, 'src')), a, 'a folder inside the work tree is that work tree');
  // Set again (a new task in the same work tree): the pointer moves.
  const c = notesDir('task c');
  setTaskDir(repo, c);
  assert.deepEqual([taskDirOf(repo), taskDirOf(tree)], [c, b]);
  // Another process, with no session id and with another one: the same answer.
  const bare = { ...process.env };
  delete bare.CLAUDE_CODE_SESSION_ID;
  for (const env of [bare, { ...bare, CLAUDE_CODE_SESSION_ID: 'another-session' }]) {
    const r = await start(['taskdir', tree], env);
    assert.deepEqual([r.code, r.out.trim()], [0, b]);
  }
});

test('a pointer or a notes folder of another task is refused, never followed', () => {
  const one = repoDir(), two = repoDir();
  const mine = notesDir('mine'), theirs = notesDir('theirs');
  writeTask(theirs, { repo: two.repo }); setTaskDir(two.repo, theirs);
  writeTask(mine, { repo: one.repo }); setTaskDir(one.repo, mine);
  const before = bytes(paths(theirs).task);
  // Start this task in the other task's folder.
  assert.throws(() => setTaskDir(one.repo, theirs), refusal('other-task', paths(theirs).task));
  assert.throws(() => writeTask(theirs, { repo: one.repo }), refusal('other-task', paths(theirs).task));
  assert.equal(bytes(paths(theirs).task), before);
  assert.equal(taskDirOf(one.repo), mine, 'the pointer did not move');
  // Point the pointer at the other task's folder by hand.
  const dir = path.join(process.env.SANAD_STATE_DIR, 'sanad-task');
  const file = fs.readdirSync(dir).map(f => path.join(dir, f)).find(f => f.endsWith('.json') && JSON.parse(fs.readFileSync(f, 'utf8')).notes === mine);
  const pointer = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...pointer, notes: theirs }));
  assert.throws(() => taskDirOf(one.repo), (e) => refusal('other-task', file)(e) && e.message.includes(theirs) && e.message.includes(two.repo));
  // The other work tree's pointer file under this one's name.
  fs.writeFileSync(file, JSON.stringify({ ...pointer, top: canonicalTop(two.repo), notes: theirs }));
  assert.throws(() => taskDirOf(one.repo), refusal('broken', file));
  for (const [code, text] of [['broken', '{'], ['version', JSON.stringify({ ...pointer, version: 2 })]]) {
    fs.writeFileSync(file, text);
    assert.throws(() => taskDirOf(one.repo), refusal(code, file));
  }
  // The fix: the start step sets the pointer again.
  assert.equal(setTaskDir(one.repo, mine), mine);
  assert.equal(taskDirOf(one.repo), mine);
  assert.equal(taskDirOf(two.repo), theirs);
});

test('no guard reads these records: the hooks name none of them', () => {
  const hooks = path.join(here, '..', '..', '..', 'hooks');
  const files = [...fs.readdirSync(hooks), ...fs.readdirSync(path.join(hooks, 'lib')).map(f => path.join('lib', f))].filter(f => /\.(?:c?js|mjs)$/.test(f));
  assert.ok(files.includes('stop-gate.js') && files.includes(path.join('lib', 'transcript-scan.js')), 'the guards were found');
  for (const f of files) {
    assert.doesNotMatch(fs.readFileSync(path.join(hooks, f), 'utf8'), /task\.json|review-pin|decisions\.json|notes-dir|sanad-task[\\/'"`]/, f);
  }
});
