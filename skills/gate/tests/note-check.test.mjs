// 2026-11-17: a reviewer note that is wrong costs a full fix round (the code, its proof, a second review), and
// nobody tried to disprove a note before the author built its fix. note-check.mjs gives one read-only agent the
// notes of the reviewer reports, as the hooks read them, and records its answer per note. A refuted note is never
// closed here (rule 5): it goes to the user with the evidence, and no fix is built for it meanwhile.
//
// 2026-11-17 (independent check, each case run on a real input): an answer written for an older brief was
// recorded against the brief on disk, by K number alone; a note longer than the hooks' cut reached the agent
// without the file it names; REFUTED was accepted on twelve dots; an empty or UTF-16 report read as a clean one;
// the printed command broke on a path with a space. Each has its test below. The refusals are checked by their
// words (a crash exits 2 too), and the launch line and the rule lines word for word.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const script = path.join(scripts, 'note-check.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'note-check-'));
process.env.SANAD_STATE_DIR = path.join(root, 'state');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const run = (args, file = script) => spawnSync(process.execPath, [file, ...args], { encoding: 'utf8', windowsHide: true });
const slash = (p) => p.replace(/\\/g, '/');
// A folder's real name: on CI the temp folder is RUNNER~1 to Node (2026-11-13).
const real = (p) => fs.realpathSync.native(p).toLowerCase();
const starting = (text, start) => text.split(/\r?\n/).filter((l) => l.startsWith(start));
const kLines = (file) => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => /^K\d/.test(l));
// PowerShell 5.1 saves a file as UTF-16 with a byte order mark.
const utf16 = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
// The script's own functions, loaded inside the test that needs them: a missing script fails that test, not the file.
const lib = () => import(pathToFileURL(script).href);
// A path as the script prints it in a command: in double quotes when it holds a space.
const quote = (p) => (/\s/.test(p) ? `"${p}"` : p);
// The id a brief carries ('no-id' when it has none).
// 2026-11-18 (repair 4): the answer names the run, as the brief asks: '<id> g<N>' (idBare: the id alone).
const idBare = (brief) => (/^Brief id: ([0-9a-f]{8})$/m.exec(fs.readFileSync(brief, 'utf8')) || [])[1] || 'no-id';
const idOf = (brief) => idBare(brief) + ((g) => (g ? ' g' + g[1] : ''))(/^Generation: (\d+)\s*$/m.exec(fs.readFileSync(brief, 'utf8')));
// A refusal: exit 2, its reason as the first line of stderr (the usage text under it never counts), and no
// stack. A crash exits 2 as well, with a stack and another first line.
function refused(r, reason) {
  assert.equal(r.status, 2, r.stdout + r.stderr);
  const first = r.stderr.split(/\r?\n/)[0];
  assert.ok(first.startsWith('NOTE CHECK: '), r.stderr);
  assert.match(first.slice('NOTE CHECK: '.length), reason);
  assert.doesNotMatch(r.stderr, /^\s+at /m, 'a refusal, not a crash:\n' + r.stderr);
}

const INSTRUCTIONS = "Before any fix. Each K line below is one note from a code review. Try to DISPROVE each note from the code: open the file and line the note names, and what calls it, and look for what makes the claim false (a guard, a caller that never sends that input, a test that already covers it). Answer with the BRIEF line given below first, then one line per note, and nothing else: 'CONFIRMED K<n> — <file:line and the input that shows it>', 'REFUTED K<n> — <file:line that makes the claim false>' or 'UNSURE K<n> — <what could not be checked>'. A note you cannot disprove with a file and line is CONFIRMED or UNSURE, never REFUTED. Read-only; do not edit.";
const K_RULE = 'K numbers belong to this brief, not to NOTE numbers: close each note under its own NOTE <n>, found by its text.';
// 2026-11-19: the K text no longer says "ask the user about them together": the user is asked when the answer arrives.
const REFUTED_RULE = 'Refuted notes are not fixed now: ask the user now, with this evidence and a recommended answer; their words close each one (rule 5).';

// 2026-11-19 (groups): notes that name the same file and line are one group in the brief. Every text stays a K line
// of its own, and the checker may give two notes of a group different verdicts.
test('a K brief of two groups lists both texts of each group, and the checker\'s split gives two verdicts', () => {
  const notes = fs.mkdtempSync(path.join(root, 'groups-'));
  const a = path.join(notes, 'review-a.md'), b = path.join(notes, 'review-b.md');
  fs.writeFileSync(a, 'RECOMMEND: FAIL\n\nBug — src/save.ts:12 saveRole() sends the request when the role list is empty\nBug — src/queue.ts:40 two workers can take the same row\n');
  fs.writeFileSync(b, 'RECOMMEND: FAIL\n\nBug — src/save.ts:12 the role list is read before it is loaded\nGap — src/queue.ts:40 no test takes one row from two workers\nGap — no test covers a user with two roles\n');
  const r = run(['--brief', '--notes', notes, '--reports', a + ',' + b]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const brief = path.join(notes, 'note-check-brief.md');
  const text = fs.readFileSync(brief, 'utf8').split(/\r?\n/);
  assert.deepEqual(text.filter((l) => /^G\d/.test(l)), ['G1 · src/save.ts:12 · K1, K3', 'G2 · src/queue.ts:40 · K2, K4']);
  assert.ok(text.indexOf('## Groups') > 0 && text.indexOf('## Groups') < text.indexOf('## Notes'), 'the groups stand above the notes');
  assert.ok(text.some((l) => l.includes('You may split a group')), 'the checker is told it may split a group');
  // Both texts of each group are K lines of their own; the note with no place is in no group.
  assert.deepEqual(kLines(brief).map((l) => l.replace(/ · from review-[ab]\.md/, '')), [
    'K1 · Bug · Bug — src/save.ts:12 saveRole() sends the request when the role list is empty',
    'K2 · Bug · Bug — src/queue.ts:40 two workers can take the same row',
    'K3 · Bug · Bug — src/save.ts:12 the role list is read before it is loaded',
    'K4 · Gap · Gap — src/queue.ts:40 no test takes one row from two workers',
    'K5 · Gap · Gap — no test covers a user with two roles',
  ]);
  const answer = path.join(notes, 'note-check-report.md');
  fs.writeFileSync(answer, `BRIEF ${idOf(brief)}\nCONFIRMED K1 — src/save.ts:12 sends with an empty list\nUNSURE K3 — the load order could not be read\nCONFIRMED K2 — src/queue.ts:40 has no lock\nCONFIRMED K4 — no such test in tests/queue.test.ts:1\nCONFIRMED K5 — no such test\n`);
  const rec = run(['--record', answer, '--notes', notes]);
  assert.equal(rec.status, 0, rec.stdout + rec.stderr);
  assert.deepEqual(starting(rec.stdout, 'GROUP '), [
    'GROUP G1 · src/save.ts:12 · K1 CONFIRMED, K3 UNSURE — split: the checker judged these texts differently; answer every number of the group by its own verdict',
    'GROUP G2 · src/queue.ts:40 · K2 CONFIRMED, K4 CONFIRMED — one verdict; answer every number of the group by its own verdict',
  ]);
  // A brief with no two notes at one place has no Groups part.
  const single = fs.mkdtempSync(path.join(root, 'nogroup-'));
  const one = path.join(single, 'review.md');
  fs.writeFileSync(one, 'RECOMMEND: FAIL\n\nBug — src/save.ts:12 saveRole() sends the request when the role list is empty\n');
  assert.equal(run(['--brief', '--notes', single, '--reports', one]).status, 0);
  assert.doesNotMatch(fs.readFileSync(path.join(single, 'note-check-brief.md'), 'utf8'), /## Groups|^G\d/m);
});

// Two reviewer reports. The first has CRLF lines and a byte order mark; the second is UTF-16. Between them:
// one note of each kind, a line that asks the user to decide (a Question to the hooks), the same Bug in both
// reports, and three things that are no note: an OUTSIDE PR line, "No Blocker or Bug found", a code block.
const FRESH = [
  'RECOMMEND: FAIL',
  '',
  'Bug — src/save.ts:12 saveRole() sends the request when the role list is empty',
  '- Gap — no test covers a user with two roles in one school',
  'The export may also include archived rows: you decide.',
  'OUTSIDE PR: src/list.ts:3 — the list loads every row at once',
  'No Blocker or Bug found in the queue worker.',
].join('\r\n') + '\r\n';
const RISK = [
  'RECOMMEND: FAIL',
  '',
  '1. Blocker — src/queue.ts:40 two workers can take the same row',
  '2. Bug — src/save.ts:12 saveRole() sends the request when the role list is empty',
  '',
  'EXTRA TEST: a role removed and added again in one save',
  '```',
  'Bug — an example line inside a code block',
  '```',
].join('\n') + '\n';
const BUG = 'Bug · Bug — src/save.ts:12 saveRole() sends the request when the role list is empty';
const GAP = 'Gap · Gap — no test covers a user with two roles in one school';
const QUESTION = 'Question · The export may also include archived rows: you decide.';
const BLOCKER = 'Blocker · Blocker — src/queue.ts:40 two workers can take the same row';
const EXTRA = 'EXTRA TEST · EXTRA TEST: a role removed and added again in one save';

// A notes folder with the two reviewer reports in it.
function fixture() {
  const notes = fs.mkdtempSync(path.join(root, 'notes-'));
  const fresh = path.join(notes, 'review-fresh-eyes.md'), risk = path.join(notes, 'review-risk.md');
  fs.writeFileSync(fresh, '﻿' + FRESH);
  fs.writeFileSync(risk, utf16(RISK));
  return {
    notes, fresh, risk, reports: fresh + ',' + risk,
    brief: path.join(notes, 'note-check-brief.md'), report: path.join(notes, 'note-check-report.md'), list: path.join(notes, 'note-check.md'),
  };
}

// The same folder after --brief, with the agent's answer saved as its report. The answer starts with the line
// that names the brief, as the brief asks; a function gets the id and gives the whole file.
// 2026-11-18: a REFUTED answer is recorded only for a brief bound to a git repository that holds the files it cites, so
// these tests brief a small temp repository (made once) that holds the files their answers name.
let shared = '';
function citedRepo() {
  if (shared) return shared;
  shared = gitRepo();
  for (const rel of ['src/save.ts', 'src/queue.ts', 'src/a.ts', 'src/b.ts', 'src/export.ts', 'src/other.ts', 'src/pay.ts', 'src/limit.ts', 'src/Roles/SaveRoleHandler.cs', 'tests/roles.test.ts', 'README.md']) {
    fs.mkdirSync(path.dirname(path.join(shared, rel)), { recursive: true });
    fs.writeFileSync(path.join(shared, rel), 'x\n');
  }
  return shared;
}
function briefed(answer) {
  const f = fixture();
  const b = run(['--brief', '--notes', f.notes, '--reports', f.reports, '--repo', citedRepo()]);
  assert.equal(b.status, 0, b.stdout + b.stderr);
  f.id = idOf(f.brief);
  fs.writeFileSync(f.report, typeof answer === 'function' ? answer(f.id) : `BRIEF ${f.id}\n` + answer);
  return f;
}

test('--brief lists the notes of two reports once each, in order, under the fixed instructions, and prints one launch line that names only the brief', () => {
  const f = fixture();
  const repo = fs.mkdtempSync(path.join(root, 'repo-'));
  const r = run(['--brief', '--notes', f.notes, '--reports', f.reports, '--repo', repo]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const text = fs.readFileSync(f.brief, 'utf8');
  assert.ok(text.includes(INSTRUCTIONS), 'the fixed instructions, word for word:\n' + text);
  assert.equal(real(/^Repo: (.+)$/m.exec(text)[1]), real(repo));
  // Where a note's file is: without this line the agent looks for src/save.ts in its own folder.
  assert.ok(text.split(/\r?\n/).includes('A file a note names is relative to the repo above.'), text);
  // The hooks' parser gives the notes: the Bug of both reports once, the "you decide" line as a Question.
  assert.deepEqual(kLines(f.brief), [
    'K1 · Bug · from review-fresh-eyes.md · Bug — src/save.ts:12 saveRole() sends the request when the role list is empty',
    'K2 · Gap · from review-fresh-eyes.md · Gap — no test covers a user with two roles in one school',
    'K3 · Question · from review-fresh-eyes.md · The export may also include archived rows: you decide.',
    'K4 · Blocker · from review-risk.md · Blocker — src/queue.ts:40 two workers can take the same row',
    'K5 · EXTRA TEST · from review-risk.md · EXTRA TEST: a role removed and added again in one save',
  ]);
  assert.doesNotMatch(text, /OUTSIDE PR|No Blocker or Bug found|inside a code block/, 'an OUTSIDE PR line, a "none found" line and a code block are no note');
  const head = starting(r.stdout, 'NOTE CHECK BRIEF: ');
  assert.equal(head.length, 1, r.stdout);
  assert.equal(head[0], `NOTE CHECK BRIEF: ${slash(f.brief)} · 5 note(s)`);
  const launch = starting(r.stdout, 'LAUNCH:');
  assert.equal(launch.length, 1, 'one launch line:\n' + r.stdout);
  // The whole line: the words after the brief's path keep the agent read-only and its answer to the lines asked for.
  assert.equal(launch[0], `LAUNCH: Agent note-checker · prompt: Check each K note, before any fix. Read and follow only the brief at ${slash(f.brief)}. ` +
    'Do not open any other file in that folder. Read-only: no builds, no tests, no edits. Your final message is only the BRIEF line the brief gives, then the CONFIRMED, REFUTED and UNSURE lines, one per note.');
  // Never a reviewer prompt: the stop and push hooks count one as a finished review.
  assert.doesNotMatch(launch[0].replace(/^LAUNCH: Agent \S+ · prompt: /, ''), /^\s*You are the independent reviewer\b/i);
  assert.doesNotMatch(launch[0], /independent reviewer/i);
  for (const other of ['review-fresh-eyes.md', 'review-risk.md', 'note-check-report.md', 'note-check.md']) assert.ok(!launch[0].includes(other), 'the prompt names no other file: ' + other);
  const then = starting(r.stdout, 'THEN: ');
  assert.equal(then.length, 1, r.stdout);
  assert.ok(then[0].startsWith(`THEN: save the agent's final message as ${quote(slash(f.report))}, then run: node `), then[0]);
  assert.ok(then[0].endsWith(` --record ${quote(slash(f.report))} --notes ${quote(slash(f.notes))}`), then[0]);
  assert.match(then[0], /\/note-check\.mjs"? --record /);
});

test('--brief without --repo writes no repo line; a missing report, notes folder, repo folder or --reports is refused and nothing is written', () => {
  const f = fixture();
  const r = run(['--brief', '--notes', f.notes, '--reports', f.fresh]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const text = fs.readFileSync(f.brief, 'utf8');
  assert.doesNotMatch(text, /^Repo:/m);
  assert.doesNotMatch(text, /repo above/);
  assert.equal(kLines(f.brief).length, 3, text);
  assert.equal(starting(r.stdout, 'NOTE CHECK BRIEF: ')[0], `NOTE CHECK BRIEF: ${slash(f.brief)} · 3 note(s)`);

  const g = fixture();
  const missing = run(['--brief', '--notes', g.notes, '--reports', g.fresh + ',' + path.join(g.notes, 'no-such-review.md')]);
  refused(missing, /^no such report: .*no-such-review\.md$/);
  assert.equal(fs.existsSync(g.brief), false, 'nothing written on an error');
  refused(run(['--brief', '--notes', g.notes]), /^--brief needs --reports <file1,file2,\.\.\.>$/);
  refused(run(['--brief', '--notes', g.notes, '--reports', ' , ']), /^--reports names no file$/);
  refused(run(['--brief', '--notes', path.join(g.notes, 'no-such-folder'), '--reports', g.fresh]), /^no such notes folder: .*no-such-folder$/);
  refused(run(['--brief', '--notes', g.notes, '--reports', g.fresh, '--repo', path.join(g.notes, 'no-such-repo')]), /^no such repo folder: .*no-such-repo$/);
  refused(run(['--brief', '--reports', g.fresh]), /^--brief needs --notes <dir>$/);
  refused(run(['--brief', '--notes']), /^Unknown or empty option: --notes$/);
  assert.equal(fs.existsSync(g.brief), false, 'nothing written on an error');
});

test('reports with no note: "NOTE CHECK: no note to check", no brief, exit 0', () => {
  const notes = fs.mkdtempSync(path.join(root, 'notes-'));
  const clean = path.join(notes, 'review-fresh-eyes.md');
  fs.writeFileSync(clean, [
    'RECOMMEND: PASS', '',
    'No Blocker or Bug found.',
    'Bugs: none',
    'OUTSIDE PR: src/list.ts:3 — the list loads every row at once',
    '```', 'Bug — an example line inside a code block', '```', '',
  ].join('\n'));
  const r = run(['--brief', '--notes', notes, '--reports', clean]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.stdout.split(/\r?\n/).filter(Boolean), ['NOTE CHECK: no note to check']);
  assert.equal(fs.existsSync(path.join(notes, 'note-check-brief.md')), false, 'no brief for no note');
});

test('an install without the hooks: --brief is refused and names the parser it needs, nothing is written', () => {
  // The script alone, in the same folder layout, with no hooks folder beside the skills folder.
  const copy = path.join(fs.mkdtempSync(path.join(root, 'no-hooks-')), 'skills', 'gate', 'scripts');
  fs.mkdirSync(copy, { recursive: true });
  for (const name of ['note-check.mjs', 'is-main.mjs']) fs.copyFileSync(path.join(scripts, name), path.join(copy, name));
  const f = fixture();
  const r = run(['--brief', '--notes', f.notes, '--reports', f.reports], path.join(copy, 'note-check.mjs'));
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /note parser cannot be loaded/);
  assert.match(r.stderr, /hooks\/lib\/transcript-scan\.js/);
  assert.equal(fs.existsSync(f.brief), false, 'nothing written');
});

test('--record writes one line per note: the three verdicts with their evidence, and UNSURE (no verdict) for a note with no answer', () => {
  const f = briefed([
    'I opened each file the notes name.',
    '',
    '- **CONFIRMED K1** — src/save.ts:12 sends with roles = [] (no guard before the call at line 14)',
    '`REFUTED K 2 - tests/roles.test.ts:88 already saves a user with two roles in one school`',
    '3. UNSURE K3: the export code is not in this repo',
    '**REFUTED K4 —** `src/queue.ts:44` takes the row with a guarded UPDATE, so one worker wins',
    'The lines asked for were:',
    'REFUTED K<n> — <file:line that makes the claim false>',
    'CONFIRMED K5 — <file:line and the input that shows it>',
  ].join('\r\n') + '\r\n');
  const r = run(['--record', f.report, '--notes', f.notes]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // List marks, bold, backticks, "K 2" and the - and : separators are read; the quoted instruction is no verdict.
  assert.deepEqual(kLines(f.list), [
    `K1 · CONFIRMED · ${BUG} — src/save.ts:12 sends with roles = [] (no guard before the call at line 14)`,
    `K2 · REFUTED · ${GAP} — tests/roles.test.ts:88 already saves a user with two roles in one school`,
    `K3 · UNSURE · ${QUESTION} — the export code is not in this repo`,
    `K4 · REFUTED · ${BLOCKER} — \`src/queue.ts:44\` takes the row with a guarded UPDATE, so one worker wins`,
    `K5 · UNSURE (no verdict) · ${EXTRA}`,
  ]);
  const text = fs.readFileSync(f.list, 'utf8');
  assert.match(text, /^# Note check/, 'a header first');
  assert.ok(text.includes('Report: ' + slash(f.report)), text);
  // Rule 5, in the list the author reads: nothing is closed here, and a refuted note gets no fix and goes to the user.
  for (const rule of [
    'No note is closed here (rule 5). CONFIRMED: fix it with a test. UNSURE: not proven either way; check the missing fact first (a reproducer, or the file the checker could not read), fix it only when the fact holds, and a product choice goes to the user.',
    'REFUTED: build no fix now; ask the user with this evidence and a recommended answer, and their words close it.',
  ]) assert.ok(text.split(/\r?\n/).includes(rule), 'the list holds: ' + rule + '\n' + text);
  const out = r.stdout.split(/\r?\n/).filter(Boolean);
  assert.equal(out[0], 'NOTE CHECK: 5 note(s) — 1 confirmed, 2 refuted, 2 unsure');
  // A refuted note is not closed and not fixed: the user is asked, with the evidence (rule 5).
  // 2026-11-18: a Question is asked of the user too, with the checker's view (it is never refuted).
  assert.deepEqual(out.slice(1, 5), [
    'ASK THE USER: K2 · Gap — no test covers a user with two roles in one school — refuted: tests/roles.test.ts:88 already saves a user with two roles in one school',
    `ASK THE USER: K3 · The export may also include archived rows: you decide. — Question, the checker's view (UNSURE): the export code is not in this repo`,
    'ASK THE USER: K4 · Blocker — src/queue.ts:40 two workers can take the same row — refuted: `src/queue.ts:44` takes the row with a guarded UPDATE, so one worker wins',
    REFUTED_RULE,
  ]);
});

test('--record reads a verdict under a heading, a quote mark, bold or quotes, and leaves the marks inside the evidence whole', () => {
  const f = briefed([
    '### CONFIRMED `K1` — **src/save.ts:12** has no guard for an empty list',
    '> REFUTED: K2 — `tests/roles.test.ts:88` covers two roles in one school',
    '* **UNSURE** K3 – the export code is not in this repo',
    '**REFUTED K4 — src/queue.ts:44 takes the row with a guarded UPDATE**',
    '"CONFIRMED K5: no test saves a role twice in one request"',
  ].join('\n') + '\n');
  const r = run(['--record', f.report, '--notes', f.notes]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(kLines(f.list), [
    `K1 · CONFIRMED · ${BUG} — **src/save.ts:12** has no guard for an empty list`,
    `K2 · REFUTED · ${GAP} — \`tests/roles.test.ts:88\` covers two roles in one school`,
    `K3 · UNSURE · ${QUESTION} — the export code is not in this repo`,
    `K4 · REFUTED · ${BLOCKER} — src/queue.ts:44 takes the row with a guarded UPDATE`,
    `K5 · CONFIRMED · ${EXTRA} — no test saves a role twice in one request`,
  ]);
  assert.match(r.stdout, /^NOTE CHECK: 5 note\(s\) — 2 confirmed, 2 refuted, 1 unsure$/m);
});

test('--record: REFUTED with fewer than 12 characters of evidence counts as UNSURE, and the user is not asked about it', () => {
  const f = briefed([
    'REFUTED K1',
    'REFUTED K2 — src/a.ts:12',     // 11 characters
    'REFUTED K4 — src/a.ts:120',    // 12 characters: enough
    'CONFIRMED K5',
  ].join('\n') + '\n');
  const r = run(['--record', f.report, '--notes', f.notes]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(kLines(f.list), [
    `K1 · UNSURE (refuted without evidence) · ${BUG}`,
    `K2 · UNSURE (refuted without evidence) · ${GAP} — src/a.ts:12`,
    `K3 · UNSURE (no verdict) · ${QUESTION}`,
    `K4 · REFUTED · ${BLOCKER} — src/a.ts:120`,
    `K5 · CONFIRMED · ${EXTRA}`,
  ]);
  assert.match(r.stdout, /^NOTE CHECK: 5 note\(s\) — 1 confirmed, 1 refuted, 3 unsure$/m);
  assert.deepEqual(starting(r.stdout, 'ASK THE USER: '), [
    "ASK THE USER: K3 · The export may also include archived rows: you decide. — Question, the checker's view (UNSURE (no verdict)): no view given",
    'ASK THE USER: K4 · Blocker — src/queue.ts:40 two workers can take the same row — refuted: src/a.ts:120']);
});

test('--record: the last verdict line for a note wins; with no refuted note nobody is asked; recorded again, the list follows the newest report', () => {
  const f = briefed([
    'REFUTED K1 — src/save.ts:9 returns early when the list is empty',
    'On a second look that early return is only in the edit path.',
    'CONFIRMED K1 — src/save.ts:12 the create path has no early return',
    'UNSURE K2 — could not find the test file',
  ].join('\n') + '\n');
  let r = run(['--record', f.report, '--notes', f.notes]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(kLines(f.list).slice(0, 2), [
    `K1 · CONFIRMED · ${BUG} — src/save.ts:12 the create path has no early return`,
    `K2 · UNSURE · ${GAP} — could not find the test file`,
  ]);
  assert.match(r.stdout, /^NOTE CHECK: 5 note\(s\) — 1 confirmed, 0 refuted, 4 unsure$/m);
  assert.deepEqual(starting(r.stdout, 'ASK THE USER').filter((l) => !l.startsWith('ASK THE USER: K3 ')), [], 'only the Question (K3) is asked of the user');
  assert.ok(!r.stdout.includes('Refuted notes'), r.stdout);

  fs.writeFileSync(f.report, `BRIEF ${f.id}\nREFUTED K1 — src/save.ts:9 returns early on every path, create included\n`);
  r = run(['--record', f.report, '--notes', f.notes]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(kLines(f.list).slice(0, 2), [
    `K1 · REFUTED · ${BUG} — src/save.ts:9 returns early on every path, create included`,
    `K2 · UNSURE (no verdict) · ${GAP}`,
  ]);
  assert.match(r.stdout, /^NOTE CHECK: 5 note\(s\) — 0 confirmed, 1 refuted, 4 unsure$/m);
  assert.ok(r.stdout.includes(REFUTED_RULE), r.stdout);
});

test('--record reads a UTF-16 report', () => {
  const f = briefed((id) => utf16(`BRIEF ${id}\r\nCONFIRMED K1 — src/save.ts:12 sends with an empty list\r\nREFUTED K4 — src/queue.ts:44 takes the row with a guarded UPDATE\r\n`));
  const r = run(['--record', f.report, '--notes', f.notes]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const rows = kLines(f.list);
  assert.equal(rows[0], `K1 · CONFIRMED · ${BUG} — src/save.ts:12 sends with an empty list`);
  assert.equal(rows[3], `K4 · REFUTED · ${BLOCKER} — src/queue.ts:44 takes the row with a guarded UPDATE`);
  assert.match(r.stdout, /^NOTE CHECK: 5 note\(s\) — 1 confirmed, 1 refuted, 3 unsure$/m);
});

test('--record is refused when the report has no verdict for a note of the brief, when there is no brief, and on a wrong call', () => {
  // The instruction quoted back and a verdict for a note that is not in the brief are no answer.
  const f = briefed('Looks right to me. The lines asked for were:\nREFUTED K<n> — <file:line that makes the claim false>\nCONFIRMED K9 — src/other.ts:1 a note that is not in this brief\n');
  const r = run(['--record', f.report, '--notes', f.notes]);
  refused(r, /has no CONFIRMED, REFUTED or UNSURE line for K1\.\.K5: the check did not run/);
  assert.equal(fs.existsSync(f.list), false, 'nothing written');
  refused(run(['--record', path.join(f.notes, 'no-such-report.md'), '--notes', f.notes]), /^no such report: .*no-such-report\.md$/);

  // No brief: the agent never got one, so its K numbers mean nothing.
  const g = fixture();
  fs.writeFileSync(g.report, 'CONFIRMED K1 — src/save.ts:12 sends with an empty list\n');
  const early = run(['--record', g.report, '--notes', g.notes]);
  refused(early, /^no note-check-brief\.md in .*: run --brief first and launch the line it prints$/);
  assert.equal(fs.existsSync(g.list), false, 'nothing written');

  const one = /^give one of --brief or --record <report>$/, withBrief = /^--reports and --repo go with --brief$/;
  refused(run([]), one);
  refused(run(['--brief', '--record', f.report, '--notes', f.notes, '--reports', f.fresh]), one);
  refused(run(['--record', f.report]), /^--record needs --notes <dir>$/);
  refused(run(['--record', f.report, '--notes', f.notes, '--repo', f.notes]), withBrief);
  refused(run(['--record', f.report, '--notes', f.notes, '--reports', f.fresh]), withBrief);
  refused(run(['--record', f.report, '--notes', f.notes, '--color']), /^Unknown or empty option: --color$/);
  assert.equal(fs.existsSync(f.list), false, 'nothing written');
});

// ---- 2026-11-17, independent check: the cases below each failed on a real input ----

test('--record: an answer written for an older brief is refused by its id, and an answer with no id line too', () => {
  const notes = fs.mkdtempSync(path.join(root, 'notes-'));
  const at = (name) => path.join(notes, name);
  const fresh = at('review-fresh.md'), codex = at('review-codex.md');
  const brief = at('note-check-brief.md'), report = at('note-check-report.md'), list = at('note-check.md');
  fs.writeFileSync(fresh, 'Bug — src/a.ts:1 alpha is wrong when the list is empty\nGap — no test for beta with two roles\n');
  let r = run(['--brief', '--notes', notes, '--reports', fresh]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const first = idBare(brief);
  const firstRows = fs.readFileSync(brief, 'utf8').split(/\r?\n/);
  const late = `BRIEF ${first}\nREFUTED K1 — src/a.ts:3 returns early when the list is empty\nCONFIRMED K2 — no test names beta\n`;

  // A second reviewer's report arrives and a new brief is written: K1 is now its Blocker.
  fs.writeFileSync(codex, 'Blocker — src/pay.ts:9 money is charged twice on retry\n');
  r = run(['--brief', '--notes', notes, '--reports', codex + ',' + fresh]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(kLines(brief)[0], 'K1 · Blocker · from review-codex.md · Blocker — src/pay.ts:9 money is charged twice on retry');
  const second = idBare(brief);

  // The first agent answers late. Its K1 was the Bug: recorded, the Blocker would be set aside on the Bug's evidence.
  fs.writeFileSync(report, late);
  r = run(['--record', report, '--notes', notes]);
  assert.equal(r.status, 2, 'an answer for another brief is not recorded:\n' + r.stdout + r.stderr);
  assert.equal(r.stdout, '', 'no totals and no ASK THE USER line');
  assert.equal(fs.existsSync(list), false, 'nothing recorded');
  assert.match(first, /^[0-9a-f]{8}$/, 'the brief carries its id:\n' + firstRows.join('\n'));
  assert.ok(firstRows.some((l) => l.startsWith('First line of your answer: BRIEF ' + first)), 'the agent is asked to repeat the id:\n' + firstRows.join('\n'));
  assert.notEqual(second, first, 'other notes, another id');
  refused(r, new RegExp(`answers brief ${first}; the brief in .* is ${second}: the K numbers are not the same notes`));

  // No id line: nothing says which brief the agent read.
  fs.writeFileSync(report, 'REFUTED K1 — src/a.ts:3 returns early when the list is empty\n');
  refused(run(['--record', report, '--notes', notes]), new RegExp(`has no 'BRIEF ${second}' line`));
  // Two id lines, one of them another brief's: refused too.
  fs.writeFileSync(report, `BRIEF ${second}\nCONFIRMED K1 — src/pay.ts:9 charges before the retry check\nBRIEF ${first}\nREFUTED K1 — src/a.ts:3 returns early\n`);
  refused(run(['--record', report, '--notes', notes]), new RegExp(`answers brief ${first}; `));
  assert.equal(fs.existsSync(list), false, 'nothing recorded');

  // The answer for the brief on disk is recorded; words before the id line, bold and "Brief id:" are read.
  fs.writeFileSync(report, `I opened the file the note names.\n\n**Brief id: ${idOf(brief)}**\nCONFIRMED K1 — src/pay.ts:9 charges before the retry check\n`);
  r = run(['--record', report, '--notes', notes]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(kLines(list), [
    'K1 · CONFIRMED · Blocker · Blocker — src/pay.ts:9 money is charged twice on retry — src/pay.ts:9 charges before the retry check',
    'K2 · UNSURE (no verdict) · Bug · Bug — src/a.ts:1 alpha is wrong when the list is empty',
    'K3 · UNSURE (no verdict) · Gap · Gap — no test for beta with two roles',
  ]);
});

test('the brief id follows the notes and the repo; a brief changed after it was written is refused', () => {
  const f = fixture();
  const repoA = fs.mkdtempSync(path.join(root, 'repo-')), repoB = fs.mkdtempSync(path.join(root, 'repo-'));
  const idFor = (...args) => {
    const r = run(['--brief', '--notes', f.notes, ...args]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return idBare(f.brief);
  };
  const id = idFor('--reports', f.reports, '--repo', repoA);
  assert.match(id, /^[0-9a-f]{8}$/);
  assert.equal(idFor('--reports', f.reports, '--repo', repoA), id, 'the same notes and repo: the same id');
  assert.notEqual(idFor('--reports', f.reports, '--repo', repoB), id, 'another repo: the agent read other code');
  assert.notEqual(idFor('--reports', f.reports), id, 'no repo');
  assert.notEqual(idFor('--reports', f.risk + ',' + f.fresh, '--repo', repoA), id, 'the same notes in another order: other K numbers');
  assert.equal(idFor('--reports', f.reports, '--repo', repoA), id);

  // A K line changed by hand: the id in the brief is no longer the id of its notes.
  const written = fs.readFileSync(f.brief, 'utf8');
  const answer = `BRIEF ${idOf(f.brief)}\nCONFIRMED K1 — src/save.ts:12 sends with an empty list\n`;
  fs.writeFileSync(f.brief, written.replace('K2 · Gap ·', 'K2 · Bug ·'));
  fs.writeFileSync(f.report, answer);
  refused(run(['--record', f.report, '--notes', f.notes]), /does not carry the id of its notes.*run --brief again/);
  // A brief with no id line (the release before the id) is refused the same way.
  fs.writeFileSync(f.brief, written.replace(/^Brief id: .*\r?\n/m, ''));
  refused(run(['--record', f.report, '--notes', f.notes]), /does not carry the id of its notes.*run --brief again/);
  assert.equal(fs.existsSync(f.list), false, 'nothing recorded');
  // The brief as written, with CRLF line ends (a tool that rewrites them): the same notes, so the same id.
  fs.writeFileSync(f.brief, written.replace(/\r?\n/g, '\r\n'));
  assert.equal(run(['--record', f.report, '--notes', f.notes]).status, 0);
});

test('--brief starts a new check: the last answer and list are removed, and the old brief too when no note is left', () => {
  const answer = 'REFUTED K1 — src/save.ts:9 returns early when the list is empty\n';
  const f = briefed(answer);
  let r = run(['--record', f.report, '--notes', f.notes]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(f.list), true);

  // A new brief: the answer and the list of the last check are gone, and the output names them.
  r = run(['--brief', '--notes', f.notes, '--reports', f.reports]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(f.report), false, 'the last answer is removed');
  assert.equal(fs.existsSync(f.list), false, 'the last list is removed');
  assert.equal(fs.existsSync(f.brief), true);
  assert.deepEqual(starting(r.stdout, 'REMOVED: '), ["REMOVED: note-check-report.md, note-check.md (the last check's files: a new --brief starts a new check)"]);
  r = run(['--brief', '--notes', f.notes, '--reports', f.reports]);
  assert.deepEqual(starting(r.stdout, 'REMOVED: '), [], 'nothing to remove, no line');

  // The next round's report holds no note: no brief stays for the old answer to be recorded against.
  fs.writeFileSync(f.report, `BRIEF ${idOf(f.brief)}\n` + answer);
  assert.equal(run(['--record', f.report, '--notes', f.notes]).status, 0);
  const clean = path.join(f.notes, 'review-round-2.md');
  fs.writeFileSync(clean, 'RECOMMEND: PASS\n\nNo Blocker or Bug found.\n');
  r = run(['--brief', '--notes', f.notes, '--reports', clean]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const file of [f.brief, f.report, f.list]) assert.equal(fs.existsSync(file), false, 'removed: ' + path.basename(file));
  assert.deepEqual(r.stdout.split(/\r?\n/).filter(Boolean), [
    'NOTE CHECK: no note to check',
    "REMOVED: note-check-report.md, note-check.md, note-check-brief.md (the last check's files: a new --brief starts a new check)",
  ]);
  fs.writeFileSync(f.report, `BRIEF ${f.id}\n` + answer);
  refused(run(['--record', f.report, '--notes', f.notes]), /run --brief first/);
  assert.equal(fs.existsSync(f.list), false, 'the old verdicts are not written again');

  // This check's own files are never a reviewer report: --brief would remove the file it was asked to read.
  refused(run(['--brief', '--notes', f.notes, '--reports', f.fresh + ',' + f.report]), /note-check-report\.md is this check's own file, not a reviewer report$/);
  assert.equal(fs.existsSync(f.report), true, 'the file named as a report is still there');
  assert.equal(fs.existsSync(f.brief), false, 'nothing written');
});

// One finding line of 400 characters and more: the files it names are past the hooks' cut (300 characters today).
const LONG = 'Bug — when a manager who owns two schools saves a role change for a teacher of the second school, the scope check reads only the first school of the manager, finds the teacher outside it, falls back to the scope of the whole organisation and never walks the rest of the list of schools, so the role is written for the third school too, which the manager does not own: see src/Roles/SaveRoleHandler.cs:214 (IsInScope) and its caller at src/Roles/RolesController.cs:88';
// A note over four lines, and a note with nothing after its separator, over a list.
const GAP_ROWS = [
  'Gap — the list of schools is read again for every role in the request:',
  'one query per role, each loading every school of the organisation and every campus under it, with no paging',
  'and no filter on the manager, so a manager of two schools still loads all of them, once for every role;',
  'the fix is one query before the loop, in src/Roles/SaveRoleHandler.cs:150 (LoadSchools).',
];
const EXTRA_ROWS = [
  'EXTRA TEST:',
  '- a manager of two schools saves a role for a teacher of the second school, and the role is written once',
  '- a manager of one school saves a role for a teacher of another school, and the answer is 403 with no row written at all',
  '- an admin saves the same role twice in one request, and one row is written: tests/Roles/SaveRoleTests.cs:40',
];

test('a note longer than the hooks cut reaches the agent whole: its lines from the report, under its K line', () => {
  for (const eol of ['\n', '\r\n']) {
    const notes = fs.mkdtempSync(path.join(root, 'notes-'));
    const file = path.join(notes, 'review-long.md'), brief = path.join(notes, 'note-check-brief.md');
    fs.writeFileSync(file, [
      'RECOMMEND: FAIL', '',
      '1. ' + LONG,
      '2. ' + GAP_ROWS[0], ...GAP_ROWS.slice(1).map((l) => '   ' + l),
      'Not a line of the note above: the handler also logs every role twice.',
      '',
      ...EXTRA_ROWS,
      '',
      'Bug — src/a.ts:1 a short note',
      '',
    ].join(eol));
    let r = run(['--brief', '--notes', notes, '--reports', file, '--repo', citedRepo()]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const rows = fs.readFileSync(brief, 'utf8').split(/\r?\n/);
    const under = (n, kind) => {
      const start = `K${n} · ${kind} · from review-long.md · `;
      const at = rows.findIndex((l) => l.startsWith(start));
      assert.ok(at >= 0, 'a K line for note ' + n + ':\n' + rows.join('\n'));
      return { text: rows[at].slice(start.length), next: rows[at + 1] };
    };
    // The K line keeps the hooks' own text, cut; the line under it has every word of the note.
    const k1 = under(1, 'Bug'), k2 = under(2, 'Gap'), k3 = under(3, 'EXTRA TEST'), k4 = under(4, 'Bug');
    const cut = k1.text.length;
    assert.ok(cut < LONG.indexOf('src/Roles/SaveRoleHandler.cs:214') && LONG.startsWith(k1.text), 'the K line is cut before the file it names: ' + k1.text);
    assert.equal(k1.next, `    K1 in full (the K line is cut at ${cut} characters): ${LONG}`);
    assert.ok(!k2.text.includes('SaveRoleHandler.cs:150'), k2.text);
    assert.equal(k2.next, `    K2 in full (the K line is cut at ${cut} characters): ${GAP_ROWS.join(' ')}`);
    assert.ok(!k3.text.includes('SaveRoleTests.cs:40'), k3.text);
    assert.equal(k3.next, `    K3 in full (the K line is cut at ${cut} characters): ${EXTRA_ROWS.join(' ')}`);
    assert.equal(k4.text, 'Bug — src/a.ts:1 a short note');
    assert.equal(k4.next, '', 'a short note has no second line');
    assert.ok(!rows.join('\n').includes('Not a line of the note above'), 'a line the hooks do not count in the note is not in it here');
    assert.equal(kLines(brief).length, 4, 'the lines in full are no K lines');

    // The answer is recorded against the same four notes.
    const report = path.join(notes, 'note-check-report.md');
    fs.writeFileSync(report, `BRIEF ${idOf(brief)}\nCONFIRMED K1 — src/Roles/SaveRoleHandler.cs:214 reads only the first school\nREFUTED K2 — src/Roles/SaveRoleHandler.cs:150 loads the schools once, before the loop\n`);
    r = run(['--record', report, '--notes', notes]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const listed = kLines(path.join(notes, 'note-check.md'));
    assert.equal(listed.length, 4, listed.join('\n'));
    assert.ok(listed[1].startsWith('K2 · REFUTED · Gap · Gap — the list of schools is read again'), listed[1]);
    assert.ok(listed[1].endsWith(' — src/Roles/SaveRoleHandler.cs:150 loads the schools once, before the loop'), listed[1]);
  }
});

test('a note that ends at the cut has no second line; a cut note whose other lines cannot be found says so, and asks for UNSURE', async () => {
  const { collectNotes, buildBrief } = await lib();
  const notes = fs.mkdtempSync(path.join(root, 'notes-'));
  const file = path.join(notes, 'review-odd.md');
  // A parser that cuts at 40 characters: every "Bug — " line is a note of one line.
  const lines = (text) => text.split('\n').filter((l) => l.startsWith('Bug — ')).map((l) => ({ kind: 'Bug', text: l.slice(0, 40) }));
  const exact = 'Bug — ' + 'y'.repeat(34);
  fs.writeFileSync(file, exact + '\nBug — ' + 'w'.repeat(60) + ' src/a.ts:9\n');
  assert.deepEqual(collectNotes([file], lines), [
    { n: 1, kind: 'Bug', from: 'review-odd.md', text: exact },
    { n: 2, kind: 'Bug', from: 'review-odd.md', text: 'Bug — ' + 'w'.repeat(34), cut: 40, whole: 'Bug — ' + 'w'.repeat(60) + ' src/a.ts:9' },
  ]);
  // A parser whose note text is in no line of the report: the rest of the note cannot be found.
  const odd = (text) => (text.startsWith('Bug — word') ? [{ kind: 'Bug', text: text.slice(0, 40) }] : text.includes('ODD') ? [{ kind: 'Bug', text: 'Bug — ' + 'z'.repeat(34) }] : []);
  fs.writeFileSync(file, 'ODD report\n');
  const list = collectNotes([file], odd);
  assert.deepEqual(list, [{ n: 1, kind: 'Bug', from: 'review-odd.md', text: 'Bug — ' + 'z'.repeat(34), cut: 40, whole: '' }]);
  const rows = buildBrief({ notes: list }).split('\n');
  assert.equal(rows[rows.indexOf('K1 · Bug · from review-odd.md · Bug — ' + 'z'.repeat(34)) + 1],
    '    K1 is cut at 40 characters, and its other lines were not found in review-odd.md: answer UNSURE when the part shown is not enough to check.');
});

test('--record: REFUTED counts only with a file and line in its evidence; dots or plain words leave the note UNSURE', () => {
  const f = briefed([
    'REFUTED K1 — ............',
    'REFUTED K2 — it is not true.',
    'REFUTED K3 — cannot refute this one, the note is right',
    'REFUTED K4 — `src/queue.ts`:44 takes the row with a guarded UPDATE',
    'REFUTED K5 — the test is in tests/roles.test.ts:120-131',
  ].join('\n') + '\n');
  const r = run(['--record', f.report, '--notes', f.notes]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(kLines(f.list), [
    `K1 · UNSURE (refuted without evidence) · ${BUG} — ............`,
    `K2 · UNSURE (refuted without evidence) · ${GAP} — it is not true.`,
    `K3 · UNSURE (refuted without evidence) · ${QUESTION} — cannot refute this one, the note is right`,
    `K4 · REFUTED · ${BLOCKER} — \`src/queue.ts\`:44 takes the row with a guarded UPDATE`,
    `K5 · REFUTED · ${EXTRA} — the test is in tests/roles.test.ts:120-131`,
  ]);
  assert.match(r.stdout, /^NOTE CHECK: 5 note\(s\) — 0 confirmed, 2 refuted, 3 unsure$/m);
  // Only a note refuted with a file and line goes to the user as refuted.
  assert.deepEqual(starting(r.stdout, 'ASK THE USER: ').map((l) => l.slice(0, 'ASK THE USER: K4'.length)), ['ASK THE USER: K3', 'ASK THE USER: K4', 'ASK THE USER: K5']);
});

test('the THEN command runs as printed when the notes path has a space', () => {
  const notes = path.join(fs.mkdtempSync(path.join(root, 'exp-')), 'my notes');
  fs.mkdirSync(notes);
  const fresh = path.join(notes, 'review-fresh.md'), brief = path.join(notes, 'note-check-brief.md'), report = path.join(notes, 'note-check-report.md');
  fs.writeFileSync(fresh, FRESH);
  const b = run(['--brief', '--notes', notes, '--reports', fresh]);
  assert.equal(b.status, 0, b.stdout + b.stderr);
  const then = starting(b.stdout, 'THEN: ')[0];
  const command = then.slice(then.indexOf(', then run: ') + ', then run: '.length);
  // As a shell reads the command: words end at a space, and a part in double quotes is one word.
  const words = [...command.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
  assert.equal(words[0], 'node', command);
  fs.writeFileSync(report, `BRIEF ${idOf(brief)}\nCONFIRMED K1 — src/save.ts:12 sends with an empty list\n`);
  const r = spawnSync(process.execPath, words.slice(1), { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, 'the printed command runs:\n' + command + '\n' + r.stdout + r.stderr);
  assert.equal(kLines(path.join(notes, 'note-check.md')).length, 3);
  assert.ok(then.startsWith(`THEN: save the agent's final message as "${slash(report)}", then run: node `), then);
  assert.ok(then.endsWith(` --record "${slash(report)}" --notes "${slash(notes)}"`), then);
});

test('--record says that K numbers are not NOTE numbers, in its output and in the list', () => {
  const f = briefed('CONFIRMED K1 — src/save.ts:12 sends with an empty list\nREFUTED K4 — src/queue.ts:44 takes the row with a guarded UPDATE\n');
  let r = run(['--record', f.report, '--notes', f.notes]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // The hooks count the same finding of two reviewer runs twice, and NOTE numbers go on across rounds.
  assert.deepEqual(r.stdout.split(/\r?\n/).filter(Boolean).slice(3), [REFUTED_RULE, K_RULE, 'WRITTEN: ' + slash(f.list)]);
  assert.ok(fs.readFileSync(f.list, 'utf8').split(/\r?\n/).includes(K_RULE), 'the list says it too');
  fs.writeFileSync(f.report, `BRIEF ${f.id}\nCONFIRMED K1 — src/save.ts:12 sends with an empty list\n`);
  r = run(['--record', f.report, '--notes', f.notes]);
  assert.deepEqual(r.stdout.split(/\r?\n/).filter(Boolean).filter((l) => !l.startsWith('ASK THE USER: K3 ')).slice(1), [K_RULE, 'WRITTEN: ' + slash(f.list)], 'with no refuted note too (the Question K3 is asked of the user)');
});

test('a report that cannot be read is refused by name, never taken as a clean report: empty, or UTF-16 without its byte order mark', () => {
  const text = 'RECOMMEND: FAIL\r\n\r\nBug — src/a.ts:1 alpha is wrong\r\n';
  const be = Buffer.from(text, 'utf16le').swap16();
  for (const [what, bytes, reason] of [
    ['an empty file', Buffer.alloc(0), /review-fresh\.md is empty/],
    ['only blank lines', Buffer.from(' \r\n\r\n'), /review-fresh\.md is empty/],
    ['UTF-16 LE without its byte order mark', Buffer.from(text, 'utf16le'), /review-fresh\.md is not plain text/],
    ['UTF-16 BE without its byte order mark', be, /review-fresh\.md is not plain text/],
    ['UTF-16 BE with its byte order mark', Buffer.concat([Buffer.from([0xfe, 0xff]), be]), /review-fresh\.md is not plain text/],
  ]) {
    const notes = fs.mkdtempSync(path.join(root, 'notes-'));
    const fresh = path.join(notes, 'review-fresh.md');
    fs.writeFileSync(fresh, bytes);
    const r = run(['--brief', '--notes', notes, '--reports', fresh]);
    assert.equal(r.status, 2, what + ' is not a clean report:\n' + r.stdout + r.stderr);
    refused(r, reason);
    assert.equal(r.stdout, '', what + ': never "no note to check"');
    assert.equal(fs.existsSync(path.join(notes, 'note-check-brief.md')), false, what + ': nothing written');
  }
  // The same text with its byte order mark is read: PowerShell 5.1 saves it so.
  const notes = fs.mkdtempSync(path.join(root, 'notes-'));
  const fresh = path.join(notes, 'review-fresh.md');
  fs.writeFileSync(fresh, utf16(text));
  assert.equal(run(['--brief', '--notes', notes, '--reports', fresh]).status, 0);
  assert.deepEqual(kLines(path.join(notes, 'note-check-brief.md')), ['K1 · Bug · from review-fresh.md · Bug — src/a.ts:1 alpha is wrong']);
  // The agent's answer saved the same wrong way is refused by name too.
  const f = briefed((id) => Buffer.from(`BRIEF ${id}\r\nCONFIRMED K1 — src/save.ts:12 sends with an empty list\r\n`, 'utf16le'));
  refused(run(['--record', f.report, '--notes', f.notes]), /note-check-report\.md is not plain text/);
  assert.equal(fs.existsSync(f.list), false, 'nothing recorded');
});

test('--brief with an empty --repo is refused: the current folder is never taken as the repo', () => {
  const f = fixture();
  const r = run(['--brief', '--notes', f.notes, '--reports', f.fresh, '--repo', '']);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  refused(r, /^--repo names no folder$/);
  assert.equal(fs.existsSync(f.brief), false, 'nothing written');
});

test('one very long line in the answer is read fast, and a verdict on a long line still counts', async () => {
  const { parseVerdicts } = await lib();
  const started = Date.now();
  // 40 000 spaces took 7.7 s and 40 000 stars 2.2 s: the verdict pattern backtracks on such a line.
  assert.equal(parseVerdicts('REFUTED' + ' '.repeat(40000) + 'x').size, 0);
  assert.equal(parseVerdicts('REFUTED' + '*'.repeat(40000)).size, 0);
  const read = parseVerdicts('REFUTED K1 — src/a.ts:12 ' + 'y'.repeat(40000) + '\nCONFIRMED K2 — src/b.ts:3 has no guard\n');
  const took = Date.now() - started;
  assert.ok(took < 2000, `three long lines read in ${took} ms`);
  assert.equal(read.get(1).verdict, 'REFUTED');
  assert.ok(read.get(1).evidence.startsWith('src/a.ts:12 yyy') && read.get(1).evidence.length < 2100, 'the long line is cut, its start is kept');
  assert.deepEqual(read.get(2), { verdict: 'CONFIRMED', evidence: 'src/b.ts:3 has no guard' });
});

// ---- 2026-11-18 (audit 3 + user decision): the brief binds the code, and a Question is for the user ----

// A real git repository with one committed code file: the brief's id binds its code state.
function gitRepo() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(root, 'gitrepo-')));
  const git = (...args) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8', windowsHide: true }); assert.equal(r.status, 0, r.stderr); };
  git('init', '-q');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'roles.ts'), 'export const canSave = (user) => user.role === "admin";\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return dir;
}

test('C1: the brief id binds the code: the same notes over other code give another id, and an answer for the old code is refused', () => {
  const f = fixture();
  const repo = gitRepo();
  const brief = () => { const r = run(['--brief', '--notes', f.notes, '--reports', f.reports, '--repo', repo]); assert.equal(r.status, 0, r.stdout + r.stderr); return idBare(f.brief); };
  const id = brief();
  assert.match(fs.readFileSync(f.brief, 'utf8'), /^Code: [0-9a-f]{40,64}$/m);
  assert.equal(brief(), id, 'the same notes over the same code: the same id');
  // a prose file and the check's own files do not change the id
  fs.writeFileSync(path.join(repo, 'NOTES.md'), 'a note in prose\n');
  assert.equal(brief(), id, 'a prose edit keeps the id');
  // the code goes from a role check to open access: the same notes, another id
  fs.writeFileSync(path.join(repo, 'src', 'roles.ts'), 'export const canSave = (user) => true;\n');
  const answer = `BRIEF ${idOf(f.brief)}\nREFUTED K1 — src/roles.ts:1 checks the role before saving, so the claim is false\n`;
  fs.writeFileSync(f.report, answer);
  // 2026-11-18 (scoped staleness): the record is no longer refused for any code change; the note whose cited file changed
  // is UNSURE with no author line (the file roles.ts was changed after the brief).
  const changed = run(['--record', f.report, '--notes', f.notes]);
  assert.equal(changed.status, 0, changed.stdout + changed.stderr);
  assert.match(fs.readFileSync(f.list, 'utf8'), /K1 · UNSURE \(the code it cites changed: check again\)/);
  assert.match(changed.stdout, /^CHANGED SINCE THE BRIEF: K1 /m);
  assert.doesNotMatch(changed.stdout, /ASK THE USER: K1/);
  const next = brief();
  assert.notEqual(next, id, 'other code, another id');
  // the old answer names the old brief: refused too, and the new brief takes its own answer
  fs.writeFileSync(f.report, answer);
  refused(run(['--record', f.report, '--notes', f.notes]), /answers brief /);
  fs.writeFileSync(f.report, answer.replace(/^BRIEF .*$/m, 'BRIEF ' + idOf(f.brief)));
  assert.equal(run(['--record', f.report, '--notes', f.notes]).status, 0);
  // an edit of the cited file between the brief and the record turns the refutation into UNSURE (scoped, 2026-11-18)
  brief();
  fs.writeFileSync(f.report, answer.replace(/^BRIEF .*$/m, 'BRIEF ' + idOf(f.brief)));
  fs.appendFileSync(path.join(repo, 'src', 'roles.ts'), 'export const more = 1;\n');
  assert.equal(run(['--record', f.report, '--notes', f.notes]).status, 0);
  assert.match(fs.readFileSync(f.list, 'utf8'), /K1 · UNSURE \(the code it cites changed: check again\)/);
});

test('C1: must not change: a folder that is no git repository has no code line and keeps the old id', () => {
  const f = fixture();
  const plain = fs.mkdtempSync(path.join(root, 'plain-'));
  assert.equal(run(['--brief', '--notes', f.notes, '--reports', f.reports, '--repo', plain]).status, 0);
  assert.doesNotMatch(fs.readFileSync(f.brief, 'utf8'), /^Code/m);
});

test('C5: a Question is asked of the user with the checker\'s view, never offered to the author as refuted', () => {
  // the brief tells the checker what to say about a Question
  const f = briefed([
    'REFUTED K3 — src/export.ts:20 already filters archived rows; recommend: keep it as it is',
    'CONFIRMED K1 — src/save.ts:12 sends with an empty list',
  ].join('\n') + '\n');
  const text = fs.readFileSync(f.brief, 'utf8');
  assert.match(text, /For a Question line.*what the code shows \(file:line\).*recommended answer/);
  const r = run(['--record', f.report, '--notes', f.notes]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const ask = starting(r.stdout, 'ASK THE USER: K3');
  assert.equal(ask.length, 1, r.stdout);
  assert.ok(ask[0].includes('src/export.ts:20 already filters archived rows; recommend: keep it as it is'), ask[0]);
  assert.match(ask[0], /Question/);
  assert.doesNotMatch(r.stdout, /THE AUTHOR MAY NOW WRITE/);
  // no Question line is in the REFUTED rule: only the user's words close it
  assert.ok(fs.readFileSync(f.list, 'utf8').includes("A Question is never closed here or by the author: the user's words close it; the checker's view is advice."));
});

// ---- 2026-11-18 (audit 3 repair) ----

test('6: a brief with no --repo, or a repo folder that is no git repository, says CODE: NOT BOUND, and --record repeats it', () => {
  // no --repo: the current folder is never taken (it may be another repository); the line is in the brief, on the screen and at record
  const f = fixture();
  const b = run(['--brief', '--notes', f.notes, '--reports', f.reports]);
  assert.equal(b.status, 0, b.stdout + b.stderr);
  assert.match(b.stdout, /^CODE: NOT BOUND /m);
  assert.match(fs.readFileSync(f.brief, 'utf8'), /^CODE: NOT BOUND /m);
  fs.writeFileSync(f.report, `BRIEF ${idOf(f.brief)}\nREFUTED K1 — src/save.ts:12 holds the role check\n`);
  const r = run(['--record', f.report, '--notes', f.notes]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /^CODE: NOT BOUND /m);   // on stderr: the result lines on stdout stay as they were
  // a folder that is no git repository: the same
  const plain = fs.mkdtempSync(path.join(root, 'plain-'));
  const g = fixture();
  assert.equal(run(['--brief', '--notes', g.notes, '--reports', g.reports, '--repo', plain]).status, 0);
  assert.match(fs.readFileSync(g.brief, 'utf8'), /^CODE: NOT BOUND /m);
  // a repository: bound, no such line
  const repo = gitRepo();
  const h = fixture();
  const hb = run(['--brief', '--notes', h.notes, '--reports', h.reports, '--repo', repo]);
  assert.doesNotMatch(hb.stdout, /CODE: NOT BOUND/);
  assert.doesNotMatch(fs.readFileSync(h.brief, 'utf8'), /CODE: NOT BOUND/);
  // run from inside another repository without --repo: it is not taken as the code of these notes
  const other = gitRepo();
  const k = fixture();
  const inOther = spawnSync(process.execPath, [script, '--brief', '--notes', k.notes, '--reports', k.reports], { encoding: 'utf8', windowsHide: true, cwd: other });
  assert.equal(inOther.status, 0, inOther.stdout + inOther.stderr);
  assert.match(inOther.stdout, /^CODE: NOT BOUND /m);
  assert.doesNotMatch(fs.readFileSync(k.brief, 'utf8'), /^Code root:/m);
});

// 2026-11-18 (scoped staleness): --record keeps a REFUTED verdict when every file the note and its evidence name is
// unchanged, whatever else changed since the brief (a plainly right note fixed meanwhile); a touched file makes it UNSURE.
test('7: a REFUTED stands for an untouched cited file, and is UNSURE for a touched one, a new one or a gone one', () => {
  const f = fixture();
  const repo = gitRepo();
  assert.equal(run(['--brief', '--notes', f.notes, '--reports', f.reports, '--repo', repo]).status, 0);
  assert.ok(fs.existsSync(path.join(f.notes, 'note-check-files.json')), 'the file fingerprint is saved beside the brief');
  assert.doesNotMatch(fs.readFileSync(f.brief, 'utf8'), /roles\.ts/, 'and is not in the brief text');
  const answer = `BRIEF ${idOf(f.brief)}\nREFUTED K1 — src/roles.ts:1 holds the role check\n`;
  fs.writeFileSync(f.report, answer);
  assert.equal(run(['--record', f.report, '--notes', f.notes]).status, 0);
  assert.match(fs.readFileSync(f.list, 'utf8'), /K1 · REFUTED/);
  // another file changes (new), the cited one does not: it stands, and the author line is still printed
  fs.writeFileSync(path.join(repo, 'src', 'other.ts'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(repo, 'NOTES.md'), 'prose\n');
  const kept = run(['--record', f.report, '--notes', f.notes]);
  assert.equal(kept.status, 0, kept.stdout + kept.stderr);
  assert.match(fs.readFileSync(f.list, 'utf8'), /K1 · REFUTED/);
  assert.doesNotMatch(kept.stdout, /CHANGED SINCE THE BRIEF/);
  // the cited file is edited: UNSURE
  fs.appendFileSync(path.join(repo, 'src', 'roles.ts'), 'export const more = 1;\n');
  const touched = run(['--record', f.report, '--notes', f.notes]);
  assert.equal(touched.status, 0, touched.stdout + touched.stderr);
  assert.match(fs.readFileSync(f.list, 'utf8'), /K1 · UNSURE \(the code it cites changed: check again\)/);
  assert.match(touched.stdout, /1 note\(s\)|5 note\(s\)/);
  assert.match(touched.stdout, /0 refuted/);
  // the cited file is gone: UNSURE too
  fs.rmSync(path.join(repo, 'src', 'roles.ts'));
  run(['--record', f.report, '--notes', f.notes]);
  assert.match(fs.readFileSync(f.list, 'utf8'), /K1 · UNSURE \(the code it cites changed/);
  // a brief with no file fingerprint (removed): nothing shows the file unchanged
  fs.writeFileSync(path.join(repo, 'src', 'roles.ts'), 'export const canSave = (user) => user.role === "admin";\n');
  fs.rmSync(path.join(f.notes, 'note-check-files.json'));
  run(['--record', f.report, '--notes', f.notes]);
  assert.match(fs.readFileSync(f.list, 'utf8'), /K1 · UNSURE \(the code it cites changed/);
});

test('7: a REFUTED that cites a prose file (README.md:1) is UNSURE once that prose file changes', () => {
  const f = fixture();
  const repo = gitRepo();
  fs.writeFileSync(path.join(repo, 'README.md'), 'the limit is 50\n');
  assert.equal(run(['--brief', '--notes', f.notes, '--reports', f.reports, '--repo', repo]).status, 0);
  fs.writeFileSync(f.report, `BRIEF ${idOf(f.brief)}\nREFUTED K1 — README.md:1 says the limit is 50, so the claim is false\n`);
  assert.equal(run(['--record', f.report, '--notes', f.notes]).status, 0);
  assert.match(fs.readFileSync(f.list, 'utf8'), /K1 · REFUTED/);
  fs.writeFileSync(path.join(repo, 'README.md'), 'the limit is 100\n');
  run(['--record', f.report, '--notes', f.notes]);
  assert.match(fs.readFileSync(f.list, 'utf8'), /K1 · UNSURE \(the code it cites changed/);
});

// Changed 2026-11-18: a refutation whose evidence names no file of the repository used to stand (it was "not judged by the
// files"); nothing then shows the cited code unchanged, so it is UNSURE now (see R2). The note's own words naming no file are still not judged.
test('7: a note text that names no file of the repository is not judged by the files, when the evidence cites a real one', () => {
  const f = fixture();
  const repo = gitRepo();
  assert.equal(run(['--brief', '--notes', f.notes, '--reports', f.reports, '--repo', repo]).status, 0);
  fs.writeFileSync(f.report, `BRIEF ${idOf(f.brief)}\nREFUTED K1 — src/roles.ts:1 (e.g. the vendor copy) holds the guard\n`);
  assert.equal(run(['--record', f.report, '--notes', f.notes]).status, 0);
  assert.match(fs.readFileSync(f.list, 'utf8'), /K1 · REFUTED/);
});

// 2026-11-18 (scoped staleness): every --brief run has its own generation; an older saved answer is never recorded
// after a newer one, though the two briefs share one id (the same notes over the same code).
test('9: an answer written for an older generation of the same brief is refused', () => {
  const f = fixture();
  const repo = gitRepo();
  const brief = () => { const r = run(['--brief', '--notes', f.notes, '--reports', f.reports, '--repo', repo]); assert.equal(r.status, 0, r.stdout + r.stderr); return fs.readFileSync(f.brief, 'utf8'); };
  const first = brief(), id = idBare(f.brief);
  const gen = (text) => Number(/^Generation: (\d+)$/m.exec(text)[1]);
  const second = brief();
  assert.equal(idBare(f.brief), id, 'the same notes over the same code share one id');
  assert.equal(gen(second), gen(first) + 1, 'but not the generation');
  assert.match(second, new RegExp(`BRIEF ${id} g${gen(second)}`), 'the brief tells the agent to repeat it');
  const old = `BRIEF ${id} g${gen(first)}\nCONFIRMED K1 — src/save.ts:12 sends with an empty list\n`;
  const newer = `BRIEF ${id} g${gen(second)}\nREFUTED K1 — src/roles.ts:1 holds the role check\n`;
  fs.writeFileSync(f.report, newer);
  assert.equal(run(['--record', f.report, '--notes', f.notes]).status, 0);
  fs.writeFileSync(f.report, old);
  refused(run(['--record', f.report, '--notes', f.notes]), /written for generation \d+ of this check; generation \d+ is already recorded|older answer never replaces/);
  assert.match(fs.readFileSync(f.list, 'utf8'), /K1 · REFUTED/, 'the newer record is untouched');
  // an older answer before anything was recorded is refused too (the brief on disk is newer)
  const third = brief();
  fs.writeFileSync(f.report, newer);
  refused(run(['--record', f.report, '--notes', f.notes]), /written for generation \d+ of this check/);
  assert.ok(gen(third) > gen(second));
});

test('9: must not change: the right run is recorded, and again (changed 2026-11-18: an answer with no g part is refused, test 4)', () => {
  const f = fixture();
  const repo = gitRepo();
  const b = run(['--brief', '--notes', f.notes, '--reports', f.reports, '--repo', repo]);
  assert.equal(b.status, 0, b.stdout + b.stderr);
  const id = idBare(f.brief);
  const g = Number(/^Generation: (\d+)\s*$/m.exec(fs.readFileSync(f.brief, 'utf8'))[1]);
  fs.writeFileSync(f.report, `BRIEF ${id} g${g}\nCONFIRMED K1 — src/save.ts:12 sends with an empty list\n`);
  assert.equal(run(['--record', f.report, '--notes', f.notes]).status, 0);
  assert.equal(run(['--record', f.report, '--notes', f.notes]).status, 0, 'the same generation again is no older');
});

test('8: a Gap or Bug that asks the user to decide is asked of the user with the checker view, never offered to the author', () => {
  const notes = fs.mkdtempSync(path.join(root, 'notes-'));
  const report = path.join(notes, 'review.md');
  fs.writeFileSync(report, 'RECOMMEND: FAIL\n- Gap — src/limit.ts:9 the limit is 50 here and 100 in the ticket: you decide which one.\n- Bug — src/save.ts:12 sends with an empty list\n');
  assert.equal(run(['--brief', '--notes', notes, '--reports', report, '--repo', citedRepo()]).status, 0);
  const brief = path.join(notes, 'note-check-brief.md');
  assert.match(fs.readFileSync(brief, 'utf8'), /^K1 · Gap \(asks the user\) · from review\.md · /m);
  assert.match(fs.readFileSync(brief, 'utf8'), /For a Question line/);
  const answer = path.join(notes, 'note-check-report.md');
  fs.writeFileSync(answer, `BRIEF ${idOf(brief)}\nREFUTED K1 — src/limit.ts:9 holds 50, recommend 50\nREFUTED K2 — src/save.ts:12 holds the empty check\n`);
  const r = run(['--record', answer, '--notes', notes]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(starting(r.stdout, 'ASK THE USER: K1')[0], /asks the user to decide|Question|decide/);
  assert.ok(starting(r.stdout, 'ASK THE USER: K1')[0].includes('src/limit.ts:9 holds 50, recommend 50'));
  assert.match(starting(r.stdout, 'ASK THE USER: K2')[0], /refuted: src\/save\.ts:12/);
  assert.doesNotMatch(r.stdout, /THE AUTHOR MAY NOW WRITE: NOTE 1/);
});

// ---- 2026-11-18 (repair 1, 2, 4) ----
// One refutation of K1 that cites `cite`, then a change of `touch` (a path under the repo) after the brief; the list line of K1.
function refutedThenChanged(cite, touch, setup = () => {}) {
  const f = fixture();
  const repo = gitRepo();
  setup(repo);
  assert.equal(run(['--brief', '--notes', f.notes, '--reports', f.reports, '--repo', repo]).status, 0);
  fs.writeFileSync(f.report, `BRIEF ${idOf(f.brief)}\nREFUTED K1 — ${cite(repo)} filters the school id before the upload\n`);
  assert.equal(run(['--record', f.report, '--notes', f.notes]).status, 0);
  assert.match(fs.readFileSync(f.list, 'utf8'), /K1 · REFUTED/, 'untouched: the refutation stands');
  const file = path.join(repo, touch);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, '\nexport const more = 1;\n');
  assert.equal(run(['--record', f.report, '--notes', f.notes]).status, 0);
  return /K1 · UNSURE \(the code it cites changed/.test(fs.readFileSync(f.list, 'utf8'));
}
test('1/2: a refutation that cites its file as an absolute Windows path, a leading slash, a diff prefix, a dot-dot folder or brackets is UNSURE once the file changes', () => {
  const win = (p) => p.replace(/\//g, '\\');
  const cites = {
    'backslashes': (repo) => win(repo) + '\\src\\roles.ts:1',
    'forward slashes with a drive': (repo) => repo.replace(/\\/g, '/') + '/src/roles.ts:1',
    'leading slash': () => '/src/roles.ts:1',
    'diff prefix': () => 'b/src/roles.ts:1',
    'dot dot backslash': () => '..\\src\\roles.ts:1',
  };
  for (const [name, cite] of Object.entries(cites)) assert.ok(refutedThenChanged(cite, 'src/roles.ts'), name);
  assert.ok(refutedThenChanged(() => 'app/[id]/page.tsx:4', 'app/[id]/page.tsx', (repo) => { fs.mkdirSync(path.join(repo, 'app', '[id]'), { recursive: true }); fs.writeFileSync(path.join(repo, 'app', '[id]', 'page.tsx'), 'export default 1;\n'); }), 'brackets');
  assert.ok(refutedThenChanged(() => 'src/My Upload.cs:9', 'src/My Upload.cs', (repo) => fs.writeFileSync(path.join(repo, 'src', 'My Upload.cs'), 'class A {}\n')), 'a space in the name');
});
test('1/2: must not change: a change of another file, or of a file the refutation does not name, leaves it REFUTED', () => {
  const other = (repo) => fs.writeFileSync(path.join(repo, 'src', 'other.ts'), 'export const a = 1;\n');
  assert.equal(refutedThenChanged((repo) => repo.replace(/\\/g, '/') + '/src/roles.ts:1', 'src/other.ts', other), false);
  assert.equal(refutedThenChanged((repo) => repo.replace(/\//g, '\\') + '\\src\\roles.ts:1', 'src/other.ts', other), false);
});
test('4: the brief asks for the run number in the first line, and an answer with no g part is refused, an older one too', () => {
  const f = fixture();
  const repo = gitRepo();
  const brief = () => { const r = run(['--brief', '--notes', f.notes, '--reports', f.reports, '--repo', repo]); assert.equal(r.status, 0, r.stdout + r.stderr); return fs.readFileSync(f.brief, 'utf8'); };
  const gen = (t) => Number(/^Generation: (\d+)\s*$/m.exec(t)[1]);
  const first = brief(), second = brief();
  const id = idBare(f.brief);
  assert.match(second, new RegExp(`^First line of your answer: BRIEF ${id} g${gen(second)}$`, 'm'));
  fs.writeFileSync(f.report, `BRIEF ${id} g${gen(second)}\nCONFIRMED K1 — src/save.ts:12 sends with an empty list\n`);
  assert.equal(run(['--record', f.report, '--notes', f.notes]).status, 0);
  fs.writeFileSync(f.report, `BRIEF ${id}\nREFUTED K1 — src/roles.ts:1 holds the role check so the text is fine\n`);
  refused(run(['--record', f.report, '--notes', f.notes]), /names the brief but not the run/);
  assert.match(fs.readFileSync(f.list, 'utf8'), /K1 · CONFIRMED/, 'the newer record is untouched');
  assert.ok(gen(second) > gen(first));
});

// ---- 2026-11-18 (recheck by the other engine): a REFUTED answer is accepted only when the files it cites are SHOWN unchanged ----
// A brief with no code state cannot show that, so its REFUTED answers are UNSURE; a bound brief whose cited files cannot
// be found in the repository cannot show it either. The first test is the reported case, in a folder that is no git repository.
const NOT_SHOWN = 'UNSURE (the code is not bound to a repository: run --brief again with --repo <the git repository>)';
test('R1: a brief in a folder with no git repository: a REFUTED answer is UNSURE with the reason, no author line, listed; the source changing later changes nothing', () => {
  const plain = fs.realpathSync.native(fs.mkdtempSync(path.join(root, 'plain-')));
  fs.mkdirSync(path.join(plain, 'src'));
  fs.writeFileSync(path.join(plain, 'src', 'roles.ts'), 'export const canSave = (user) => user.role === "admin";\n');
  const f = fixture();
  assert.equal(run(['--brief', '--notes', f.notes, '--reports', f.reports, '--repo', plain]).status, 0);
  fs.writeFileSync(f.report, `BRIEF ${idOf(f.brief)}\nREFUTED K1 — src/roles.ts:1 checks the admin role before saving\nCONFIRMED K2 — src/list.ts:3 loads every row\nUNSURE K4 — the worker code is not in this folder\n`);
  fs.writeFileSync(path.join(plain, 'src', 'roles.ts'), 'export const canSave = () => true;\n');   // changed after the answer, nothing sees it
  const r = run(['--record', f.report, '--notes', f.notes]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const rows = kLines(f.list);
  assert.ok(rows.some((l) => l.startsWith('K1 · ' + NOT_SHOWN + ' · ')), rows.join('\n'));
  assert.ok(rows.some((l) => l.startsWith('K2 · CONFIRMED · ')) && rows.some((l) => l.startsWith('K4 · UNSURE · ')), 'CONFIRMED and UNSURE are recorded as before');
  assert.match(r.stdout, /^NOTE CHECK: 5 note\(s\) — 1 confirmed, 0 refuted, \d unsure$/m);
  assert.doesNotMatch(r.stdout, /ASK THE USER: K1|THE AUTHOR MAY NOW WRITE|^Refuted notes are not fixed now/m);
  assert.match(r.stdout, /^NOT SHOWN UNCHANGED: K1 — /m, 'listed beside the changed notes');
  assert.match(r.stderr, /^CODE: NOT BOUND /m, 'the NOT BOUND line stays');
});
test('R1: no --repo at all, and a brief whose NOT BOUND line was taken out: the same', () => {
  for (const strip of [false, true]) {
    const f = fixture();
    assert.equal(run(['--brief', '--notes', f.notes, '--reports', f.reports]).status, 0);
    if (strip) fs.writeFileSync(f.brief, fs.readFileSync(f.brief, 'utf8').split(/\r?\n/).filter((l) => !l.startsWith('CODE: NOT BOUND')).join('\n'));
    fs.writeFileSync(f.report, `BRIEF ${idOf(f.brief)}\nREFUTED K1 — src/save.ts:12 holds the role check\n`);
    const r = run(['--record', f.report, '--notes', f.notes]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(kLines(f.list).some((l) => l.startsWith('K1 · ' + NOT_SHOWN + ' · ')), 'strip=' + strip + '\n' + kLines(f.list).join('\n'));
    assert.match(r.stdout, /0 refuted/);
  }
});
test('R2: a bound brief whose evidence cites no file of the repository cannot show it unchanged: UNSURE', () => {
  const f = fixture();
  const repo = gitRepo();
  assert.equal(run(['--brief', '--notes', f.notes, '--reports', f.reports, '--repo', repo]).status, 0);
  fs.writeFileSync(f.report, `BRIEF ${idOf(f.brief)}\nREFUTED K1 — docs/outside.txt:3 (e.g. the vendor copy) holds the guard\n`);
  const r = run(['--record', f.report, '--notes', f.notes]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(fs.readFileSync(f.list, 'utf8'), /K1 · UNSURE \(no file it cites is in the repository/);
  assert.match(r.stdout, /0 refuted/);
  assert.match(r.stdout, /^NOT SHOWN UNCHANGED: K1 — /m);
});
test('R3: must not change: a bound brief whose cited file is untouched stays REFUTED, with its ASK line', () => {
  const f = fixture();
  const repo = gitRepo();
  assert.equal(run(['--brief', '--notes', f.notes, '--reports', f.reports, '--repo', repo]).status, 0);
  fs.writeFileSync(f.report, `BRIEF ${idOf(f.brief)}\nREFUTED K1 — src/roles.ts:1 holds the role check\n`);
  const r = run(['--record', f.report, '--notes', f.notes]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(fs.readFileSync(f.list, 'utf8'), /K1 · REFUTED/);
  assert.match(r.stdout, /1 refuted/);
  assert.match(r.stdout, /^ASK THE USER: K1 /m);
  assert.doesNotMatch(r.stdout, /NOT SHOWN UNCHANGED/);
});

// ---- 2026-11-18 (repair, a REFUTED answer is accepted only when every cited file is SHOWN unchanged) ----
// Each case makes its own temp repository (a real path), briefs it, optionally changes a file, and records one answer.
const wait = (ms) => { const end = Date.now() + ms; while (Date.now() < end); };
function scenario({ files, ignore, report, answer, change, before }) {
  const f = fixture();
  const repo = gitRepo();
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
  if (ignore) put('.gitignore', ignore);
  for (const [rel, text] of Object.entries(files)) put(rel, text);
  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8', windowsHide: true });
  git('add', '.gitignore');
  git('add', 'src', 'tests', 'api', 'docker-compose.yml', 'Dockerfile');
  git('commit', '-q', '-m', 'more');
  if (before) before(repo, put);
  fs.writeFileSync(f.fresh, '﻿' + report);
  wait(40);
  const b = run(['--brief', '--notes', f.notes, '--reports', f.fresh, '--repo', repo]);
  assert.equal(b.status, 0, b.stdout + b.stderr);
  wait(40);
  if (change) change(repo, put);
  fs.writeFileSync(f.report, `BRIEF ${idOf(f.brief)}\n${answer(repo)}\n`);
  const r = run(['--record', f.report, '--notes', f.notes]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return r.stdout;
}
const ADMIN = 'class P { bool Can() { return user.IsAdmin; } }\n';
const OPEN = 'class P { bool Can() { return true; } }\n';
const NOTE = 'Bug — any student can delete a material, there is no role check.\n';
const refutedCount = (out) => Number(/(\d+) refuted/.exec(out)[1]);

test('R4 (1): a bare file name after ( [ or @ is read: its change turns the answer UNSURE, the untouched one stays REFUTED', () => {
  const files = { 'src/Policy.cs': ADMIN, 'src/Auth/RoleFilter.cs': 'class F {}\n' };
  for (const cite of ['the guard (Policy.cs:4) holds', 'the guard [Policy.cs:4] holds', 'see @Policy.cs:4 for the guard']) {
    const answer = () => `REFUTED K1 — src/Auth/RoleFilter.cs:1 rejects every non-admin, ${cite}`;
    const changed = scenario({ files, report: NOTE, answer, change: (repo, put) => put('src/Policy.cs', OPEN) });
    assert.equal(refutedCount(changed), 0, cite + '\n' + changed);
    assert.match(changed, /unsure/);
    const same = scenario({ files, report: NOTE, answer });
    assert.equal(refutedCount(same), 1, cite + '\n' + same);
    assert.match(same, /^ASK THE USER: K1 /m);
  }
});
test('R4 (2): an honest refutation of an untouched bare-name file in ( ) is REFUTED', () => {
  const out = scenario({ files: { 'src/Policy.cs': ADMIN }, report: 'Bug — src/Policy.cs:4 lets any user delete a material, there is no role check.\n', answer: () => 'REFUTED K1 — the admin guard is already there (Policy.cs:4) and it blocks a student' });
  assert.equal(refutedCount(out), 1, out);
  assert.doesNotMatch(out, /NOT SHOWN UNCHANGED/);
});
test('R4 (3): a bare-name fallback is not used for an ignored copy or a path outside the repository', () => {
  const files = { 'api/Policy.cs': ADMIN, 'build/Policy.cs': ADMIN };
  const a = scenario({ files, ignore: 'build/\n', report: NOTE, answer: () => 'REFUTED K1 — build/Policy.cs:4 checks the admin role before the delete', change: (repo, put) => put('build/Policy.cs', OPEN) });
  assert.equal(refutedCount(a), 0, a);
  const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(root, 'outside-')));
  fs.mkdirSync(path.join(outside, 'src'));
  fs.writeFileSync(path.join(outside, 'src', 'Policy.cs'), ADMIN);
  const b = scenario({ files: { 'src/Policy.cs': ADMIN }, report: NOTE, answer: () => `REFUTED K1 — ${slash(outside)}/src/Policy.cs:4 checks the admin role`, change: () => fs.writeFileSync(path.join(outside, 'src', 'Policy.cs'), OPEN) });
  assert.equal(refutedCount(b), 0, b);
});
test('R4 (4): one cited file that git does not list and that changed makes the answer UNSURE, although another cited file is found', () => {
  const files = { 'tests/PolicyTests.cs': 'class T {}\n', 'generated/Roles.g.cs': ADMIN };
  const answer = () => 'REFUTED K1 — generated/Roles.g.cs:4 checks the admin role; covered by tests/PolicyTests.cs:1';
  const changed = scenario({ files, ignore: 'generated/\n', report: NOTE, answer, change: (repo, put) => put('generated/Roles.g.cs', OPEN) });
  assert.equal(refutedCount(changed), 0, changed);
  const same = scenario({ files, ignore: 'generated/\n', report: NOTE, answer });
  assert.equal(refutedCount(same), 1, 'an untouched ignored file is shown by its modified time:\n' + same);
});
test('R4 (5): a file with no extension (Dockerfile) that changed is seen when the answer also cites a file with an extension', () => {
  const files = { 'Dockerfile': 'FROM x\nUSER app\n', 'docker-compose.yml': 'a: 1\n' };
  const answer = () => 'REFUTED K1 — Dockerfile:2 sets USER app; see docker-compose.yml:1';
  const report = 'Bug — the container runs as root (Dockerfile).\n';
  const changed = scenario({ files, report, answer, change: (repo, put) => put('Dockerfile', 'FROM x\nUSER root\n') });
  assert.equal(refutedCount(changed), 0, changed);
  assert.match(changed, /unsure/);
  const same = scenario({ files, report, answer });
  assert.equal(refutedCount(same), 1, same);
});
test('R4 (6): an honest refutation of an untouched ignored, nested-repository or non-ASCII file is REFUTED', () => {
  const ign = scenario({ files: { 'generated/Roles.g.cs': ADMIN }, ignore: 'generated/\n', report: NOTE, answer: () => 'REFUTED K1 — generated/Roles.g.cs:4 checks the admin role' });
  assert.equal(refutedCount(ign), 1, ign);
  const nested = scenario({
    files: { 'src/x.cs': 'x\n' }, report: NOTE, answer: () => 'REFUTED K1 — libs/core/Gate.cs:4 checks the admin role before the delete',
    before: (repo, put) => {
      put('libs/core/Gate.cs', ADMIN);
      for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'n']]) assert.equal(spawnSync('git', args, { cwd: path.join(repo, 'libs', 'core'), encoding: 'utf8', windowsHide: true }).status, 0);
    },
  });
  assert.equal(refutedCount(nested), 1, nested);
  const uni = scenario({ files: { 'src/Política.cs': ADMIN }, report: NOTE, answer: () => 'REFUTED K1 — src/Política.cs:4 checks the admin role before the delete' });
  assert.equal(refutedCount(uni), 1, uni);
});
