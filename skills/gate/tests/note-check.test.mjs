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
const idOf = (brief) => (/^Brief id: ([0-9a-f]{8})$/m.exec(fs.readFileSync(brief, 'utf8')) || [])[1] || 'no-id';
// A refusal: exit 2, its reason as the first line of stderr (the usage text under it never counts), and no
// stack. A crash exits 2 as well, with a stack and another first line.
function refused(r, reason) {
  assert.equal(r.status, 2, r.stdout + r.stderr);
  const first = r.stderr.split(/\r?\n/)[0];
  assert.ok(first.startsWith('NOTE CHECK: '), r.stderr);
  assert.match(first.slice('NOTE CHECK: '.length), reason);
  assert.doesNotMatch(r.stderr, /^\s+at /m, 'a refusal, not a crash:\n' + r.stderr);
}

const INSTRUCTIONS = "Before any fix. Each K line below is one note from a code review. Try to DISPROVE each note from the code: open the file and line the note names, and what calls it, and look for what makes the claim false (a guard, a caller that never sends that input, a test that already covers it). Answer with the BRIEF line given below first, then one line per note, and nothing else: 'CONFIRMED K<n> — <file:line and the input that shows it>', 'REFUTED K<n> — <file:line that makes the claim false>' or 'UNSURE K<n> — <what could not be checked>'. A note you cannot disprove with a file and line is CONFIRMED or UNSURE, never REFUTED. Read-only, about 3 minutes; do not edit.";
const K_RULE = 'K numbers belong to this brief, not to NOTE numbers: close each note under its own NOTE <n>, found by its text.';
const REFUTED_RULE = 'Refuted notes are not fixed now: ask the user about them together, with this evidence and a recommended answer; their words close each one (rule 5).';

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
function briefed(answer) {
  const f = fixture();
  const b = run(['--brief', '--notes', f.notes, '--reports', f.reports]);
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
  assert.equal(launch[0], `LAUNCH: Agent braintrust-expert · prompt: Check each K note, before any fix. Read and follow only the brief at ${slash(f.brief)}. ` +
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
  assert.deepEqual(out.slice(1, 4), [
    'ASK THE USER: K2 · Gap — no test covers a user with two roles in one school — refuted: tests/roles.test.ts:88 already saves a user with two roles in one school',
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
  assert.deepEqual(starting(r.stdout, 'ASK THE USER: '), ['ASK THE USER: K4 · Blocker — src/queue.ts:40 two workers can take the same row — refuted: src/a.ts:120']);
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
  assert.deepEqual(starting(r.stdout, 'ASK THE USER'), []);
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
  const first = idOf(brief);
  const firstRows = fs.readFileSync(brief, 'utf8').split(/\r?\n/);
  const late = `BRIEF ${first}\nREFUTED K1 — src/a.ts:3 returns early when the list is empty\nCONFIRMED K2 — no test names beta\n`;

  // A second reviewer's report arrives and a new brief is written: K1 is now its Blocker.
  fs.writeFileSync(codex, 'Blocker — src/pay.ts:9 money is charged twice on retry\n');
  r = run(['--brief', '--notes', notes, '--reports', codex + ',' + fresh]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(kLines(brief)[0], 'K1 · Blocker · from review-codex.md · Blocker — src/pay.ts:9 money is charged twice on retry');
  const second = idOf(brief);

  // The first agent answers late. Its K1 was the Bug: recorded, the Blocker would be set aside on the Bug's evidence.
  fs.writeFileSync(report, late);
  r = run(['--record', report, '--notes', notes]);
  assert.equal(r.status, 2, 'an answer for another brief is not recorded:\n' + r.stdout + r.stderr);
  assert.equal(r.stdout, '', 'no totals and no ASK THE USER line');
  assert.equal(fs.existsSync(list), false, 'nothing recorded');
  assert.match(first, /^[0-9a-f]{8}$/, 'the brief carries its id:\n' + firstRows.join('\n'));
  assert.ok(firstRows.includes('First line of your answer: BRIEF ' + first), 'the agent is asked to repeat the id:\n' + firstRows.join('\n'));
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
  fs.writeFileSync(report, `I opened the file the note names.\n\n**Brief id: ${second}**\nCONFIRMED K1 — src/pay.ts:9 charges before the retry check\n`);
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
    return idOf(f.brief);
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
  const answer = `BRIEF ${id}\nCONFIRMED K1 — src/save.ts:12 sends with an empty list\n`;
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
  fs.writeFileSync(f.report, `BRIEF ${f.id}\n` + answer);
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
    let r = run(['--brief', '--notes', notes, '--reports', file]);
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
  assert.deepEqual(starting(r.stdout, 'ASK THE USER: ').map((l) => l.slice(0, 'ASK THE USER: K4'.length)), ['ASK THE USER: K4', 'ASK THE USER: K5']);
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
  assert.deepEqual(r.stdout.split(/\r?\n/).filter(Boolean).slice(2), [REFUTED_RULE, K_RULE, 'WRITTEN: ' + slash(f.list)]);
  assert.ok(fs.readFileSync(f.list, 'utf8').split(/\r?\n/).includes(K_RULE), 'the list says it too');
  fs.writeFileSync(f.report, `BRIEF ${f.id}\nCONFIRMED K1 — src/save.ts:12 sends with an empty list\n`);
  r = run(['--record', f.report, '--notes', f.notes]);
  assert.deepEqual(r.stdout.split(/\r?\n/).filter(Boolean).slice(1), [K_RULE, 'WRITTEN: ' + slash(f.list)], 'with no refuted note too');
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
