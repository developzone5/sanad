import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// 2026-11-17 (review score): the workflow launches several reviewers per task and nobody measured them.
// review-score.mjs reads the session's transcript with the hooks' own scanner and prints, per seat, the notes
// that led to a change, and the checklist lines the findings named; --log keeps one line per task and
// --repeats reads that log for the classes that repeat and the seats whose notes rarely lead to a change.
// Everything lives in a temp folder: the projects folder (SANAD_PROJECTS_DIR), the state folder
// (SANAD_STATE_DIR) and an empty git config, so the machine's own sessions, state and git setup play no part.
const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, '..', 'scripts', 'review-score.mjs');
// Loaded inside each test: with no script yet, every test fails on its own.
const lib = () => import('../scripts/review-score.mjs');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'review-score-')));
const projects = path.join(root, 'projects');
const state = path.join(root, 'state');
const emptyConfig = path.join(root, 'gitconfig');
fs.writeFileSync(emptyConfig, '');
// The notes lock's start time (hooks/lib/transcript-scan.js): reports before it give no notes. These are later.
fs.mkdirSync(state, { recursive: true });
fs.writeFileSync(path.join(state, 'review-notes-since'), '2026-01-01T00:00:00.000Z\n');
const env = { SANAD_PROJECTS_DIR: projects, SANAD_STATE_DIR: state, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1', CLAUDE_CODE_SESSION_ID: '' };
Object.assign(process.env, env);
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const run = (args, extra = {}, cwd = root) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true, cwd, env: { ...process.env, ...env, ...extra } });
const rows = (text) => text.split(/\r?\n/).filter(Boolean);
const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t.t', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, ...env } }).trim();
const slug = (dir) => path.resolve(dir).replace(/[^A-Za-z0-9]/g, '-');

// A transcript as the host writes it (see hooks/tests/review-notes.test.mjs): a helper's launch, its async
// result with the agent id, its report as a "[Subagent hand-back]" attachment, then the finish notice.
const at = (n) => new Date(Date.UTC(2026, 10, 17, 6, 0, 0) + n * 1000).toISOString();
const msg = (role, content, n, rest = {}) => ({ type: role, message: { role, content }, timestamp: at(n), ...rest });
const call = (id, name, input, n) => msg('assistant', [{ type: 'tool_use', id, name, input }], n);
const result = (id, content, n, toolUseResult) => msg('user', [{ type: 'tool_result', tool_use_id: id, content, is_error: false }], n, toolUseResult ? { toolUseResult } : {});
const say = (text, n) => msg('assistant', [{ type: 'text', text }], n);
const userSays = (text, n) => ({ type: 'user', message: { role: 'user', content: text }, timestamp: at(n), origin: { kind: 'human' }, userType: 'external', promptId: 'p' + n });
const FRAME = '[Subagent hand-back] The text below is the final report of a subagent this session delegated to. The report follows:';
const handBack = (id, report, n) => ({ type: 'attachment', timestamp: at(n), attachment: { type: 'queued_command', commandMode: 'prompt', isMeta: true,
  origin: { kind: 'peer', from: id, senderTaskId: id, name: 'independent-reviewer' },
  prompt: '<agent-message from="' + id + '">\n' + FRAME + '\n' + report.split('\n').map((l) => '  ' + l).join('\n') + '\n</agent-message>' } });
const notice = (id, n, report) => ({ type: 'attachment', timestamp: at(n), attachment: { type: 'queued_command', commandMode: 'task-notification',
  prompt: '<task-notification>\n<task-id>' + id + '</task-id>\n<status>completed</status>\n<summary>Agent "Review" completed</summary>\n<result>' + report + '</result>\n</task-notification>' } });
const helper = (id, n, input, report) => [
  call(id + '-call', 'Agent', { description: 'Review', run_in_background: true, ...input }, n),
  result(id + '-call', 'Async agent launched successfully.', n, { isAsync: true, status: 'async_launched', agentId: id }),
  handBack(id, report, n + 1), notice(id, n + 1, report)];
const FRESH = 'You are the independent reviewer — FRESH EYES whole-PR review. Read and follow only the brief at C:/notes/fresh.md. Read-only: no builds, no tests, no edits.';
const RISK = 'You are the independent reviewer — risk files pass (Pass A). Read and follow the brief at C:/notes/brief.md.';

// One task's session: three seats and a report read from a file. Three notes led to a change, the user
// decided two, and the file report's note is still open.
const SESSION = [
  ...helper('fe1', 1, { prompt: FRESH }, ['RECOMMEND: FAIL', '',
    '- Bug (CLIENT STATE) — Card.tsx:40 — the editor is seeded from the cache',
    '- Gap (CALLERS) — Jobs.cs:12 — the job caller passes no acting user',
    '- Gap (low) — Card.tsx:9 — a stale comment'].join('\n')),
  ...helper('rk1', 3, { prompt: RISK }, 'RECOMMEND: FAIL\n1. Blocker (CLIENT STATE) — Exam.tsx:7 — the deadline uses the browser clock'),
  ...helper('ex1', 5, { subagent_type: 'braintrust-expert-sonnet', prompt: 'Seat: Test designer. Read your role guide first.' }, 'Two designs fit.\n- Keep one table or split it? You decide.'),
  call('cx', 'Bash', { command: 'cat C:/notes/codex-review.md' }, 7), result('cx', 'RECOMMEND: FAIL\n\n- Bug (DATABASE) - Repo.cs:3 - a query per row', 7),
  userSays('leave the stale comment for now', 8),
  userSays('keep one table for both', 9),
  // 2026-11-17 (audit 3): a fixed line counts only after a code edit and a passing test that follow the notes.
  call('fx1', 'Edit', { file_path: 'C:/repos/example/src/Card.tsx' }, 9), result('fx1', 'File updated.', 9),
  call('fx2', 'Bash', { command: 'dotnet test' }, 9), result('fx2', 'Passed!  - Failed:     0, Passed:     3', 9),
  say(['NOTE 1: fixed — the editor waits for the fresh read; test Card.seeds_from_server',
    'NOTE 2: fixed — the job passes its acting user; test Jobs.acting_user',
    'NOTE 3: user — "leave the stale comment for now"',
    'NOTE 4: fixed — the server clock decides the deadline; test Exam.server_clock',
    'NOTE 5: user — "keep one table for both"'].join('\n'), 10),
];
const SCORE = [
  '  fresh eyes: 3 note(s) → 2 fixed, 1 decided by the user, 0 open',
  '  risk files: 1 note(s) → 1 fixed, 0 decided by the user, 0 open',
  '  expert: test designer: 1 note(s) → 0 fixed, 1 decided by the user, 0 open',
  '  file report: 1 note(s) → 0 fixed, 0 decided by the user, 1 open',
  'REVIEW SCORE: 6 note(s), 3 led to a change (50%)',
  'CLASSES: CLIENT STATE ×2, CALLERS ×1, DATABASE ×1',
];
const SEATS = {
  'fresh eyes': { notes: 3, fixed: 2, user: 1, open: 0 },
  'risk files': { notes: 1, fixed: 1, user: 0, open: 0 },
  'expert: test designer': { notes: 1, fixed: 0, user: 1, open: 0 },
  'file report': { notes: 1, fixed: 0, user: 0, open: 1 },
};
const NO_NOTE = 'REVIEW SCORE: no reviewer note in this session';
const QUIET = [userSays('what does this page do?', 1), say('It lists the homework.', 2)];
const lines = (entries) => entries.map((e) => JSON.stringify(e) + '\n').join('');
const hour = (h) => new Date(Date.UTC(2026, 10, 17, h, 0, 0));

let count = 0;
// A project folder of its own (so its sessions and its log are its own).
function project(name = 'repo' + (++count)) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
// A session's transcript where the host keeps it for that folder. mtime: which one is the newest, without waiting.
function transcript(dir, name, entries, mtime) {
  const file = path.join(projects, slug(dir), name + '.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines(entries));
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return file;
}
const logOf = (dir) => path.join(state, 'review-log', slug(dir) + '.jsonl');
const logged = (dir) => rows(fs.readFileSync(logOf(dir), 'utf8')).map((l) => JSON.parse(l));

// ---------------------------------------------------------------------------
// The score of a session
// ---------------------------------------------------------------------------

test('the score names each seat with its notes and their outcomes, the share that led to a change, and the classes named', async () => {
  const dir = project();
  transcript(dir, 's1', SESSION);
  const r = run(['--repo', dir]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(rows(r.stdout), SCORE);
  // The same counts from a scan result: the seat and the class of a note sit at the note's own index.
  const { scoreOf, scoreLines } = await lib();
  const score = scoreOf({ reviewNotes: [{ outcome: 'fixed' }, { outcome: null }, { outcome: 'user' }], reviewNoteSeats: ['whole diff', 'whole diff', 're-check'], reviewNoteClasses: ['TIME', '', 'TIME'] });
  assert.deepEqual(score, { seats: { 'whole diff': { notes: 2, fixed: 1, user: 0, open: 1 }, 're-check': { notes: 1, fixed: 0, user: 1, open: 0 } }, classes: { TIME: 2 } });
  assert.deepEqual(scoreLines(score).slice(-2), ['REVIEW SCORE: 3 note(s), 1 led to a change (33%)', 'CLASSES: TIME ×2']);
  // No class named, and a scan result with no seat list (an older scanner): every note is a reviewer's.
  assert.deepEqual(scoreLines(scoreOf({ reviewNotes: [{ outcome: 'fixed' }, { outcome: 'fixed' }] })),
    ['  reviewer: 2 note(s) → 2 fixed, 0 decided by the user, 0 open', 'REVIEW SCORE: 2 note(s), 2 led to a change (100%)', 'CLASSES: none named']);
});

test('a session with no reviewer note says so, and --log adds nothing for it', () => {
  const dir = project();
  transcript(dir, 's1', QUIET);
  const r = run(['--repo', dir, '--log']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(rows(r.stdout), [NO_NOTE, 'LOGGED: nothing (no reviewer note in this session)']);
  assert.equal(fs.existsSync(logOf(dir)), false);
});

// ---------------------------------------------------------------------------
// Which transcript
// ---------------------------------------------------------------------------

test('the transcript is the newest .jsonl of the project folder; this session\'s own file comes first; --transcript names any file', () => {
  const dir = project();
  transcript(dir, 'older', SESSION, hour(7));
  transcript(dir, 'newer', QUIET, hour(8));
  // A helper's transcript lives below the folder: it is no session, however new.
  const below = path.join(projects, slug(dir), 'newer', 'subagents', 'agent-x.jsonl');
  fs.mkdirSync(path.dirname(below), { recursive: true });
  fs.writeFileSync(below, lines(SESSION));
  fs.utimesSync(below, hour(9), hour(9));
  assert.deepEqual(rows(run(['--repo', dir]).stdout), [NO_NOTE], 'the newest one');
  assert.deepEqual(rows(run([], {}, dir).stdout), [NO_NOTE], 'with no --repo: the current folder');
  assert.deepEqual(rows(run(['--repo', dir], { CLAUDE_CODE_SESSION_ID: 'older' }).stdout), SCORE, 'the session the host names');
  const unknown = run(['--repo', dir], { CLAUDE_CODE_SESSION_ID: 'another-session' });
  assert.equal(unknown.status, 2, 'a named session with no file anywhere: never the file of another session');
  assert.match(unknown.stderr, /no transcript found/);
  const elsewhere = path.join(root, 'elsewhere.jsonl');
  fs.writeFileSync(elsewhere, lines(SESSION));
  const named = run(['--repo', dir, '--transcript', elsewhere]);
  assert.equal(named.status, 0, named.stdout + named.stderr);
  assert.deepEqual(rows(named.stdout), SCORE);
});

test('the project folder is the absolute path with every character that is not a letter or a digit written as "-"', async () => {
  const { slugOf } = await lib();
  const [given, name] = process.platform === 'win32'
    ? [String.raw`C:\Users\Asus\orca\workspaces\EduQuest\leatherback`, 'C--Users-Asus-orca-workspaces-EduQuest-leatherback']
    : ['/home/dev/orca/workspaces/EduQuest/leather_back.v2', '-home-dev-orca-workspaces-EduQuest-leather-back-v2'];
  assert.equal(slugOf(given), name);
  // A dot, a space and an underscore in the folder's own name: found where the host would keep it.
  const dir = project('My repo_v2.1');
  transcript(dir, 's1', SESSION);
  assert.match(slug(dir), /-My-repo-v2-1$/);
  assert.deepEqual(rows(run(['--repo', dir]).stdout), SCORE);
});

test('inside a git worktree its own folder names the project, never the main checkout; a subfolder uses its work tree', () => {
  const main = project('main-checkout');
  git(main, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(main, 'README.md'), 'x\n');
  git(main, 'add', 'README.md');
  git(main, 'commit', '-q', '-m', 'base');
  const tree = path.join(root, 'tree-one');
  git(main, 'worktree', 'add', '-q', '-b', 'feat/score', tree);
  fs.mkdirSync(path.join(tree, 'src'));
  transcript(main, 'm1', QUIET, hour(9));   // the main checkout's own session, and the newer one
  transcript(tree, 't1', SESSION, hour(7));
  const r = run(['--repo', tree, '--log']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(rows(r.stdout).slice(0, SCORE.length), SCORE, 'the worktree\'s own session');
  const [entry] = logged(main);
  assert.equal(entry.branch, 'feat/score');
  assert.equal(slug(entry.repo).toLowerCase(), slug(tree).toLowerCase());
  assert.equal(entry.session, 't1');
  // From a subfolder: the work tree's session, and the work tree's log.
  const sub = run(['--log'], {}, path.join(tree, 'src'));
  assert.equal(sub.status, 0, sub.stdout + sub.stderr);
  assert.deepEqual(rows(sub.stdout).slice(0, SCORE.length), SCORE);
  assert.equal(logged(main).length, 2, 'the log is the log of the main checkout');
  assert.ok(!fs.existsSync(logOf(tree)), 'a worktree has no log of its own');
  assert.deepEqual(rows(run(['--repo', main]).stdout), [NO_NOTE], 'the main checkout scores its own session');
});

// ---------------------------------------------------------------------------
// The log and what repeats
// ---------------------------------------------------------------------------

const REPEAT_ADVICE = ' — write a check for it in the project\'s own check script, or a rule for the author';
const task = (session, classes = {}, seats = {}) => ({ at: at(0), repo: 'C:/r', branch: 'b', session, seats, classes });
const seat = (notes, fixed) => ({ notes, fixed, user: notes - fixed, open: 0 });

test('--log adds one line with the seats and the classes; a session logged again counts once in --repeats, by its newest line', () => {
  const dir = project();
  transcript(dir, 'session-a', SESSION);
  const first = run(['--repo', dir, '--log']);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const out = rows(first.stdout);
  assert.deepEqual(out.slice(0, SCORE.length), SCORE);
  assert.match(out[SCORE.length], /^LOGGED: .*review-log.*\.jsonl$/);
  assert.equal(out.length, SCORE.length + 1);
  const [entry, ...more] = logged(dir);
  assert.deepEqual(more, [], 'one line');
  assert.deepEqual(Object.keys(entry), ['at', 'repo', 'branch', 'session', 'seats', 'classes']);
  assert.ok(Number.isFinite(Date.parse(entry.at)) && entry.at.endsWith('Z'), 'the time, in UTC');
  assert.equal(typeof entry.branch, 'string');
  assert.equal(entry.session, 'session-a');
  assert.deepEqual(entry.seats, SEATS);
  assert.deepEqual(entry.classes, { 'CLIENT STATE': 2, CALLERS: 1, DATABASE: 1 });
  // Run twice more: three lines, still one task, so nothing repeats yet.
  run(['--repo', dir, '--log']);
  const third = run(['--repo', dir, '--log', '--repeats']);
  assert.equal(logged(dir).length, 3);
  assert.deepEqual(rows(third.stdout).slice(SCORE.length + 1), ['REPEATS: none']);
  // Two more tasks that name the same class: three of the last three.
  fs.appendFileSync(logOf(dir), JSON.stringify(task('session-b', { 'CLIENT STATE': 1 })) + '\n' + JSON.stringify(task('session-c', { 'CLIENT STATE': 4, TIME: 1 })) + '\n');
  const again = run(['--repo', dir, '--repeats']);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.deepEqual(rows(again.stdout), [...SCORE, 'REPEAT: CLIENT STATE in 3 of the last 3 tasks' + REPEAT_ADVICE]);
  assert.equal(logged(dir).length, 5, '--repeats alone adds no line');
});

test('a class in 3 or more of the last 10 logged tasks repeats; a reviewer seat with 10 or more notes and under 30% that led to a change is low value', async () => {
  const { repeatLines } = await lib();
  assert.deepEqual(repeatLines([]), ['REPEATS: none']);
  // Twelve tasks: the last ten are t3..t12.
  const classes = { 1: { 'OLD DATA': 1 }, 2: { 'OLD DATA': 2 }, 3: { 'OLD DATA': 1, 'CLIENT STATE': 1 }, 4: { CALLERS: 1 }, 5: { CALLERS: 2, TIME: 1 }, 6: { CALLERS: 1, TIME: 1 },
    7: { CALLERS: 1, 'CLIENT STATE': 3 }, 8: { CALLERS: 1 }, 12: { 'CLIENT STATE': 1 } };
  const seats = {
    1: { 'whole diff': seat(5, 1), 'fresh eyes': seat(4, 0), 'risk files': seat(9, 0) },
    2: { 'whole diff': seat(5, 1), 'fresh eyes': seat(6, 3), 'expert: test designer': seat(12, 0) },
  };
  const tasks = Array.from({ length: 12 }, (_, i) => task('t' + (i + 1), classes[i + 1], seats[i + 1]));
  assert.deepEqual(repeatLines(tasks), [
    'REPEAT: CALLERS in 5 of the last 10 tasks' + REPEAT_ADVICE,      // the most frequent first
    'REPEAT: CLIENT STATE in 3 of the last 10 tasks' + REPEAT_ADVICE, // exactly three; TIME (two) and OLD DATA (one of the last ten) do not repeat
    'LOW VALUE: whole diff — 2 of 10 notes led to a change over 2 tasks', // over the whole log; fresh eyes is at 30%, risk files has 9 notes
  ], 'an expert seat is never listed: only its questions for the user are notes');
  assert.deepEqual(repeatLines(tasks.slice(0, 2)), ['REPEATS: none', 'LOW VALUE: whole diff — 2 of 10 notes led to a change over 2 tasks']);
  assert.deepEqual(repeatLines([task('a', {}, { reviewer: seat(11, 3) })]), ['REPEATS: none', 'LOW VALUE: reviewer — 3 of 11 notes led to a change over 1 task']);
  assert.deepEqual(repeatLines([task('a', { UI: 1 }), task('b', { UI: 1 }), task('c', { UI: 2 })]), ['REPEAT: UI in 3 of the last 3 tasks' + REPEAT_ADVICE]);
});

test('the log is read whatever its line endings; a torn or foreign line is skipped; a session\'s newest line replaces its older one', async () => {
  const { readLog } = await lib();
  const file = path.join(root, 'log-shapes.jsonl');
  fs.writeFileSync(file, [JSON.stringify(task('s1', { TIME: 1 })), '{"at":"2026-11-17T06:00:00.000Z","repo"', 'null', '[1,2]', JSON.stringify({ at: at(1), note: 'no seats' }),
    JSON.stringify(task('s2', { UI: 1 })), JSON.stringify(task('s1', { CALLERS: 1 })), ''].join('\r\n'));
  assert.deepEqual(readLog(file).map((t) => [t.session, Object.keys(t.classes)]), [['s2', ['UI']], ['s1', ['CALLERS']]]);
  assert.deepEqual(readLog(path.join(root, 'no-such-log.jsonl')), []);
});

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

test('a usage error or no transcript exits 2; the --repeats lines, which need only the log, are still printed', () => {
  const dir = project();
  const none = run(['--repo', dir]);
  assert.equal(none.status, 2, none.stdout + none.stderr);
  assert.match(none.stderr, /^REVIEW SCORE: no transcript found for /);
  assert.equal(none.stdout, '');
  for (const args of [['--nope'], ['--repo'], ['--transcript'], ['--repo', '--log'], ['extra']]) {
    const r = run(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /^REVIEW SCORE: Unknown or empty option: /, args.join(' '));
    assert.match(r.stderr, /Usage: node review-score\.mjs \[--repo <path>\] \[--transcript <file\.jsonl>\] \[--log\] \[--repeats\]/);
    assert.equal(r.stdout, '');
  }
  const missing = run(['--transcript', path.join(root, 'no-such.jsonl'), '--log']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /^REVIEW SCORE: cannot read the transcript /);
  assert.equal(fs.existsSync(logOf(root)), false, 'nothing is logged for it');
  // The log of a folder with no session of its own (the other engine ran its tasks, say) is still read.
  fs.mkdirSync(path.dirname(logOf(dir)), { recursive: true });
  fs.writeFileSync(logOf(dir), [task('a', { UI: 1 }), task('b', { UI: 1 }), task('c', { UI: 2 })].map((t) => JSON.stringify(t) + '\n').join(''));
  const r = run(['--repo', dir, '--repeats']);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.deepEqual(rows(r.stdout), ['REPEAT: UI in 3 of the last 3 tasks' + REPEAT_ADVICE]);
  assert.match(r.stderr, /^REVIEW SCORE: no transcript found for /);
});

// ---------------------------------------------------------------------------
// The reviewer brief names the class (review-brief.mjs ROLE)
// ---------------------------------------------------------------------------

test('the reviewer brief asks for the checklist line in brackets after the kind, and the scanner reads that class from the brief\'s own example', async () => {
  const { buildBrief, buildFreshBrief } = await import('../scripts/review-brief.mjs');
  const scan = createRequire(import.meta.url)('../../../hooks/lib/transcript-scan.js');
  const checklist = fs.readFileSync(path.join(here, '..', '..', 'sanad', 'reference', 'review-checklist.md'), 'utf8');
  const args = { repo: 'C:/r', branch: 'b', base: 'origin/staging', mergeBase: 'a'.repeat(40), ticket: 't', checks: ['[change] x'], outside: { other: [], touched: [] }, facts: { stack: '', size: '', callers: '' } };
  for (const brief of [buildBrief(args), buildFreshBrief(args)]) {
    const m = /name that line in round brackets [(] [)] after the kind, as the checklist names it \(([^)]+)\): `([^`]+)`/.exec(brief);
    assert.ok(m, 'the sentence is in the brief');
    assert.ok(m.index > brief.indexOf('<one-line fix>') && m.index < brief.indexOf('`OUTSIDE PR:`'), 'right after the findings format');
    // The names it gives are the checklist's own lines, and each one reads back as a class.
    const names = m[1].split(', ').filter((name) => name !== '…');
    assert.ok(names.length >= 3, m[1]);
    for (const name of names) {
      assert.ok(checklist.includes('- `' + name + ':`'), name + ' is a line of the review checklist');
      const read = [];
      scan.reportNotes('- Gap (' + name + ') — a.ts:1 — x', read);
      assert.deepEqual(read, [name]);
    }
    // Its example is a finding line as before, and its class is read.
    const classes = [];
    assert.deepEqual(scan.reportNotes(m[2], classes).map((note) => note.kind), ['Bug']);
    assert.deepEqual(classes, ['CLIENT STATE']);
  }
});

// ---------------------------------------------------------------------------
// Repairs after the 2026-11-17 review
// ---------------------------------------------------------------------------

const REFUTED_SESSION = [
  ...helper('fe1', 1, { prompt: FRESH }, ['RECOMMEND: FAIL', '- Bug (CLIENT STATE) — Card.tsx:40 — the editor is seeded from the cache', '- Gap (CALLERS) — Jobs.cs:12 — the job caller passes no acting user'].join('\n')),
  ...helper('nc', 3, { subagent_type: 'braintrust-expert-sonnet', prompt: 'Seat: Note check, before any fix.' }, 'REFUTED 2 — Jobs.cs:12 passes ActingUserId on line 14; the note misread the overload'),
  say('NOTE 2: refuted — Jobs.cs:14 passes ActingUserId; the checker agrees', 5),
  call('fx1', 'Edit', { file_path: 'C:/repos/example/src/Card.tsx' }, 6), result('fx1', 'File updated.', 6),
  call('fx2', 'Bash', { command: 'dotnet test' }, 7), result('fx2', 'Passed!  - Failed:     0, Passed:     3', 7),
  say('NOTE 1: fixed — the editor waits for the fresh read; test Card.seeds_from_server', 8),
];

test('a refuted note is neither open nor a change, and its class is not counted', async () => {
  const dir = project();
  transcript(dir, 's1', REFUTED_SESSION);
  const r = run(['--repo', dir, '--log']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = rows(r.stdout);
  assert.equal(out[0], '  fresh eyes: 2 note(s) → 1 fixed, 0 decided by the user, 0 open, 1 refuted');
  assert.equal(out[1], 'REVIEW SCORE: 2 note(s), 1 led to a change (50%)');
  assert.equal(out[2], 'CLASSES: CLIENT STATE ×1');
  assert.deepEqual(logged(dir)[0].seats['fresh eyes'], { notes: 2, fixed: 1, user: 0, open: 0, refuted: 1 });
  assert.deepEqual(logged(dir)[0].classes, { 'CLIENT STATE': 1 });
});

test('a session the host names, whose file is in another project folder, is found there; never the newest file here', () => {
  const dir = project(), other = project();
  transcript(dir, 'old-session', helper('fe1', 1, { prompt: FRESH }, 'RECOMMEND: FAIL\n- Bug (DATABASE) — Repo.cs:3 — a query per row'), hour(7));
  transcript(other, 'current-session', SESSION, hour(8));
  const r = run(['--repo', dir, '--log'], { CLAUDE_CODE_SESSION_ID: 'current-session' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(rows(r.stdout).slice(0, SCORE.length), SCORE);
  assert.equal(logged(dir)[0].session, 'current-session');
  const none = run(['--repo', dir], { CLAUDE_CODE_SESSION_ID: 'nowhere' });
  assert.equal(none.status, 2, none.stdout);
});

test('the worktrees of one repository add to one log, so --repeats counts a class across them', () => {
  const main = project('multi-main');
  git(main, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(main, 'README.md'), 'x\n');
  git(main, 'add', 'README.md');
  git(main, 'commit', '-q', '-m', 'base');
  const report = 'RECOMMEND: FAIL\n- Bug (CLIENT STATE) — Card.tsx:40 — old title saved';
  let last;
  for (const name of ['wt-a', 'wt-b', 'wt-c']) {
    const tree = path.join(root, 'multi-' + name);
    git(main, 'worktree', 'add', '-q', '-b', 'b-' + name, tree);
    transcript(tree, name + '-session', helper('fe1', 1, { prompt: FRESH }, report));
    last = run(['--repo', tree, '--log', '--repeats']);
    assert.equal(last.status, 0, last.stdout + last.stderr);
  }
  assert.equal(logged(main).length, 3);
  assert.match(rows(last.stdout).at(-1), /^REPEAT: CLIENT STATE in 3 of the last 3 tasks/);
});
