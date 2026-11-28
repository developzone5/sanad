// 2026-11-14: a fix for "focus does not move to the field with the error after a failed save" listed three chip
// groups. Three sibling fields with the same defect (date pickers, a student list, a rich-text description) were
// found only at the final review, which cost a full fix round: the author alone chose the names to search.
// siblings.mjs gives another agent a second look before any code, and every sibling it names needs an outcome.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const script = path.join(scripts, 'siblings.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siblings-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
// 2026-11-17: the git of these fixtures reads no config of this machine, and nothing here writes hook state
// outside the temp folder. Set once: every child process below inherits it.
fs.writeFileSync(path.join(root, 'empty.gitconfig'), '');
Object.assign(process.env, { GIT_CONFIG_GLOBAL: path.join(root, 'empty.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', SANAD_STATE_DIR: path.join(root, 'state') });
const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true });
const slash = (p) => p.replace(/\\/g, '/');
// A folder's real name: on CI the temp folder is RUNNER~1 to Node and runneradmin to git (2026-11-13).
const real = (p) => fs.realpathSync.native(p).toLowerCase();
const sLines = (file) => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => /^S\d/.test(l));

const INSTRUCTIONS = "Before any code. Read the ticket lines and the check lines first: they are the goal. Then the places, and the code at each place and around it. Name every OTHER place where the ticket's own rule or defect applies and that is not on the list: another field, another screen or role, another entry point (create, edit, publish, import, a job), an API field, an export. A place with a different problem, or one the ticket lines do not reach, is no sibling: write it as 'OUTSIDE PR: <file>:<line> — <what>', and the user decides it at the end. Then, separately: how does this repo already do the same KIND of job the ticket needs? Search by what the code does, not by the names above (for example 'send a change to another system after a save' → an outbox table and the worker that sends it; 'a list with filters' → the screen that already pages and filters). Name each one as 'SAME JOB: <file>:<line> · <what> — <how it does the job>', at most three, the nearest to this job first, or write the single line 'SAME JOB: none' after searching. These are hints: the author designs the change, and you do not choose the design. When the brief carries the author's design, check it for gaps and missed places: each one is a SIBLING line. Answer only with lines 'SIBLING: <file>:<line> · <function or field> — <why it is the ticket's rule>', 'OUTSIDE PR:' lines and 'SAME JOB:' lines, or 'SIBLINGS: none' and 'SAME JOB: none'. Do not edit.";

// A repo where focusFirstError is used by the chip group form, and a notes folder with the three sources:
// the ticket lines, the check lines and the places list (made by places.mjs).
function fixture() {
  const repo = fs.mkdtempSync(path.join(root, 'repo-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (n, t) => { fs.mkdirSync(path.dirname(path.join(repo, n)), { recursive: true }); fs.writeFileSync(path.join(repo, n), t); };
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'core.autocrlf', 'false');
  write('src/focus.ts', 'export function focusFirstError(errors) { return errors; }\n');
  write('src/ChipGroup.tsx', "import { focusFirstError } from './focus';\nexport function onSaveFailed(errors) {\n  focusFirstError(errors);\n}\n");
  write('src/DatePicker.tsx', 'export function DueDatePicker() { return null; }\n');
  write('src/StudentList.tsx', 'export const studentIds = [];\n');
  git('add', '-A'); git('commit', '-qm', 'base');
  const notes = fs.mkdtempSync(path.join(root, 'notes-'));
  fs.writeFileSync(path.join(notes, 'lines.md'), '# Lines (the ticket, verbatim, 2026-11-14)\n\nT1. Focus does not move to the field with the error after a failed save.\nT2. Expected: the first field with an error gets the focus.\n');
  fs.writeFileSync(path.join(notes, 'check.md'), '- [T1, T2] after a failed save the first chip group with an error has the focus\n');
  const places = path.join(notes, 'places.md');
  const made = spawnSync(process.execPath, [path.join(scripts, 'places.mjs'), '--repo', repo, '--names', 'focusFirstError', '--out', places], { encoding: 'utf8', windowsHide: true });
  assert.equal(made.status, 0, made.stdout + made.stderr);
  return { repo, notes, places, git, write };
}

// A notes folder whose brief was written, with the agent's report saved as `text`. A report with no same-job
// answer gets "SAME JOB: none" (2026-11-16: the brief asks for it, and a report without one is refused).
function briefed(text, { sameJob = true } = {}) {
  if (sameJob && !/SAME JOB/.test(text)) text = text.replace(/\s*$/, '') + '\nSAME JOB: none\n';
  const f = fixture();
  const b = run(['--brief', '--notes', f.notes, '--repo', f.repo]);
  assert.equal(b.status, 0, b.stdout + b.stderr);
  const report = path.join(f.notes, 'siblings-report.md');
  fs.writeFileSync(report, text);
  return { ...f, report, list: path.join(f.notes, 'siblings.md') };
}

const TWO = [
  'I read the three chip groups and the form around them.',
  '',
  '- SIBLING: src/DatePicker.tsx:1 · DueDatePicker — a field on the same form whose error never gets the focus after a failed save',
  '`SIBLING: src/StudentList.tsx:1 · studentIds — the student list shows its error, but the focus stays on the save button`',
  'Done.',
].join('\r\n');

test('--brief writes the brief from the ticket lines, the check lines and the places, and prints one launch line that names only the brief', () => {
  const { repo, notes, places } = fixture();
  const r = run(['--brief', '--notes', notes, '--repo', repo]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const brief = path.join(notes, 'siblings-brief.md');
  const text = fs.readFileSync(brief, 'utf8');
  assert.ok(text.includes(INSTRUCTIONS), 'the fixed instructions, word for word:\n' + text);
  assert.equal(real(/^Repo: (.+)$/m.exec(text)[1]), real(repo));
  assert.match(text, /^- T1\. Focus does not move to the field with the error after a failed save\.$/m);
  assert.match(text, /^- T2\. Expected: the first field with an error gets the focus\.$/m);
  assert.match(text, /^- C1\. \[T1, T2\] after a failed save the first chip group with an error has the focus$/m);
  const placeLines = fs.readFileSync(places, 'utf8').split(/\r?\n/).filter((l) => /^P\d/.test(l));
  assert.equal(placeLines.length, 3, placeLines.join('\n'));
  for (const l of placeLines) assert.ok(text.includes('\n- ' + l + '\n'), 'place in the brief: ' + l + '\n' + text);
  const launch = r.stdout.split(/\r?\n/).filter((l) => l.startsWith('LAUNCH:'));
  assert.equal(launch.length, 1, 'one launch line:\n' + r.stdout);
  assert.ok(launch[0].startsWith('LAUNCH: Agent second-look · prompt: Seat: Sibling check, before code. '), launch[0]);
  // Never a reviewer prompt: the stop and push hooks count one as a finished review (2026-11-14).
  assert.doesNotMatch(launch[0].replace(/^LAUNCH: Agent \S+ · prompt: /, ''), /^\s*You are the independent reviewer\b/i);
  assert.ok(launch[0].includes(slash(brief)), 'the prompt names the brief: ' + launch[0]);
  for (const other of ['lines.md', 'check.md', 'places.md', 'ticket.md']) assert.ok(!launch[0].includes(other), 'the prompt names no other notes file: ' + other);
  assert.ok(r.stdout.includes(`--record ${slash(path.join(notes, 'siblings-report.md'))} --notes ${slash(notes)}`), 'the next step is printed:\n' + r.stdout);
});

// 2026-11-25 (owner, test 4): the Settings badges and the view-as strip showed the same role value by another path, and the
// review found them two rounds later. The brief asks one direct question, and names the data the places list searched.
test('--brief asks one direct question: where else is this value read or shown (with the data names when the list has them)', () => {
  const f = fixture();
  let r = run(['--brief', '--notes', f.notes, '--repo', f.repo]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const ask = /^## Where else is this value read or shown\?\n\nAnswer it directly: where else is the value this change touches read or shown, by another path than the names above: another screen, a badge, a strip, a list, an export, a second word list for the same value\? Each such place not on the list is a SIBLING line\.$/m;
  assert.match(fs.readFileSync(path.join(f.notes, 'siblings-brief.md'), 'utf8').replace(/\r\n/g, '\n'), ask);
  f.write('src/Topbar.tsx', 'export function Topbar({ user }) {\n  return <b>{user.roles[0]}</b>;\n}\n');
  const made = spawnSync(process.execPath, [path.join(scripts, 'places.mjs'), '--repo', f.repo, '--names', 'focusFirstError', '--data', 'user.roles', '--out', f.places], { encoding: 'utf8', windowsHide: true });
  assert.equal(made.status, 0, made.stdout + made.stderr);
  r = run(['--brief', '--notes', f.notes, '--repo', f.repo]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(fs.readFileSync(path.join(f.notes, 'siblings-brief.md'), 'utf8'), /^Answer it directly: where else is the value this change touches \(user\.roles\) read or shown, by another path/m);
});

test('--brief refuses a notes folder that lacks one of its three sources, a file that is not a places list, and a missing --repo', () => {
  const f = fixture();
  const { repo, notes, places } = f;
  f.git('config', 'sanad.lateCheckLines', 'false'); // the owner's switch off: the second look waits for the check lines
  fs.rmSync(path.join(notes, 'check.md'));
  let r = run(['--brief', '--notes', notes, '--repo', repo]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /check\.md/);
  assert.equal(fs.existsSync(path.join(notes, 'siblings-brief.md')), false, 'nothing written on an error');
  fs.writeFileSync(path.join(notes, 'check.md'), '- [T1] one\n');
  fs.writeFileSync(places, '# notes\n');
  r = run(['--brief', '--notes', notes, '--repo', repo]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /not a places list/);
  assert.equal(run(['--brief', '--notes', notes]).status, 2, '--brief needs --repo');
  assert.equal(run(['--brief', '--notes', notes, '--repo', root]).status, 2, '--repo must be a git repository');
});

test('--record takes the SIBLING lines of the report: one open S line each, in the shape the check reads', () => {
  const { report, list } = briefed('﻿' + TWO + '\r\n');
  const r = run(['--record', report, '--notes', path.dirname(report)]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(sLines(list), [
    'S1 · src/DatePicker.tsx:1 · DueDatePicker — a field on the same form whose error never gets the focus after a failed save → ',
    'S2 · src/StudentList.tsx:1 · studentIds — the student list shows its error, but the focus stays on the save button → ',
  ]);
  const text = fs.readFileSync(list, 'utf8');
  assert.match(text, /^# Siblings/, 'a header first');
  assert.ok(text.includes('Report: ' + slash(report)), text);
  assert.doesNotMatch(text, /^SIBLINGS: none$/m);
  assert.match(r.stdout, /^SIBLINGS: 2 found, 2 open — /m);
});

test('--record from "SIBLINGS: none" writes that line, and the check passes', () => {
  const { report, list } = briefed('Checked the date pickers and the lists: each uses the shared form helper.\n\n**SIBLINGS: none**\n');
  const r = run(['--record', report, '--notes', path.dirname(report)]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(fs.readFileSync(list, 'utf8'), /^SIBLINGS: none$/m);
  assert.deepEqual(sLines(list), []);
  const c = run(['--check', list]);
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.match(c.stdout, /^SIBLINGS: 0 found, 0 open$/m);
});

test('a report with neither SIBLING lines nor "SIBLINGS: none" is refused: the check did not run', () => {
  // The instruction quoted back, with its placeholders, is no answer either.
  const { report, list } = briefed('Looks fine to me. I was asked for lines like:\nSIBLING: <file>:<line> · <function or field> — <why it is the same rule>\n');
  const r = run(['--record', report, '--notes', path.dirname(report)]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /the check did not run/);
  assert.equal(fs.existsSync(list), false, 'nothing written');
  assert.equal(run(['--record', path.join(root, 'missing-report.md'), '--notes', path.dirname(report)]).status, 2, 'a missing report');
});

test('--record needs the brief first, keeps a SIBLING line in another shape as written, and reads a UTF-16 report', () => {
  const f = fixture();
  const report = path.join(f.notes, 'siblings-report.md');
  fs.writeFileSync(report, 'SIBLINGS: none\n');
  const early = run(['--record', report, '--notes', f.notes]);
  assert.equal(early.status, 2, 'no brief written: the agent never got it');
  assert.match(early.stderr, /--brief/);
  assert.equal(run(['--brief', '--notes', f.notes, '--repo', f.repo]).status, 0);
  // PowerShell 5.1 writes UTF-16 with a byte order mark; an arrow in the agent's words is not the outcome arrow.
  fs.writeFileSync(report, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('SIBLING: the rich-text description editor - same focus defect on save → publish\r\nSAME JOB: none\r\n', 'utf16le')]));
  const r = run(['--record', report, '--notes', f.notes]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(sLines(path.join(f.notes, 'siblings.md')), ['S1 · the rich-text description editor - same focus defect on save -> publish → ']);
});

// 2026-11-15 (role-sync task): the agent named 7 places with other problems, outside the ticket's goal. They are
// OUTSIDE PR lines now: kept apart for the user's end list, never an S line that needs an outcome.
test('--record keeps OUTSIDE PR lines apart: no S number, no outcome needed, kept when recorded again', () => {
  const { report, list } = briefed([
    '- SIBLING: src/DatePicker.tsx:1 · DueDatePicker — a field on the same form whose error never gets the focus after a failed save',
    '- OUTSIDE PR: src/StudentList.tsx:1 — the list loads every student at once (a speed problem, not the focus rule)',
    '`OUTSIDE PR: <file>:<line> — <what>`',
  ].join('\n'));
  const r = run(['--record', report, '--notes', path.dirname(report)]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(sLines(list), ['S1 · src/DatePicker.tsx:1 · DueDatePicker — a field on the same form whose error never gets the focus after a failed save → ']);
  const text = fs.readFileSync(list, 'utf8');
  assert.match(text, /^## Outside the ticket — for the user's end list \(no outcome here\)$/m);
  assert.deepEqual(text.split(/\r?\n/).filter((l) => l.startsWith('- OUTSIDE PR:')),
    ['- OUTSIDE PR: src/StudentList.tsx:1 — the list loads every student at once (a speed problem, not the focus rule)'], 'the quoted instruction is no line');
  assert.match(r.stdout, /^SIBLINGS: 1 found, 1 open — /m);
  assert.match(r.stdout, /^OUTSIDE PR: 1 line\(s\) outside the ticket, kept apart/m);
  // Only the S line needs an outcome: once it has one, the check passes with the OUTSIDE PR line still there.
  fs.writeFileSync(list, text.replace(/^(S1 · .*→) $/m, '$1 none: the date picker already moves the focus'));
  const c = run(['--check', list]);
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.match(c.stdout, /^SIBLINGS: 1 found, 0 open$/m);
  // Recorded again with a new outside line: the old one stays, the new one joins, the outcome is kept.
  fs.writeFileSync(report, 'OUTSIDE PR: src/focus.ts:1 — the helper has no test of its own\n');
  assert.equal(run(['--record', report, '--notes', path.dirname(report)]).status, 0);
  const again = fs.readFileSync(list, 'utf8');
  assert.deepEqual(again.split(/\r?\n/).filter((l) => l.startsWith('- OUTSIDE PR:')), [
    '- OUTSIDE PR: src/StudentList.tsx:1 — the list loads every student at once (a speed problem, not the focus rule)',
    '- OUTSIDE PR: src/focus.ts:1 — the helper has no test of its own',
  ]);
  assert.deepEqual(sLines(list), ['S1 · src/DatePicker.tsx:1 · DueDatePicker — a field on the same form whose error never gets the focus after a failed save → none: the date picker already moves the focus']);
});

test('--record from OUTSIDE PR lines alone writes "SIBLINGS: none" and keeps them; the check passes', () => {
  const { report, list } = briefed('OUTSIDE PR: src/StudentList.tsx:1 — the list loads every student at once\n');
  const r = run(['--record', report, '--notes', path.dirname(report)]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const text = fs.readFileSync(list, 'utf8');
  assert.match(text, /^SIBLINGS: none$/m);
  assert.match(text, /^- OUTSIDE PR: src\/StudentList\.tsx:1 — the list loads every student at once$/m);
  assert.equal(run(['--check', list]).status, 0);
});

test('--record again keeps each S line\'s number and outcome and adds the new siblings', () => {
  const { report, list } = briefed(TWO);
  assert.equal(run(['--record', report, '--notes', path.dirname(report)]).status, 0);
  fs.writeFileSync(list, fs.readFileSync(list, 'utf8').replace(/^(S1 · .*→) $/m, '$1 P4'));
  fs.writeFileSync(report, TWO + '\nSIBLING: src/Description.tsx:9 · description — the rich-text editor keeps the focus on save\n');
  const r = run(['--record', report, '--notes', path.dirname(report)]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(sLines(list), [
    'S1 · src/DatePicker.tsx:1 · DueDatePicker — a field on the same form whose error never gets the focus after a failed save → P4',
    'S2 · src/StudentList.tsx:1 · studentIds — the student list shows its error, but the focus stays on the save button → ',
    'S3 · src/Description.tsx:9 · description — the rich-text editor keeps the focus on save → ',
  ]);
});

test('--check: every S line needs P<n> on the places list (not gone) or none: <reason>; open lines are named', () => {
  const { repo, notes, places, report, list, write } = briefed(TWO);
  assert.equal(run(['--record', report, '--notes', notes]).status, 0);
  let r = run(['--check', list, '--places', places]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.deepEqual(r.stdout.split(/\r?\n/).filter((l) => l.startsWith('OPEN:')), [
    'OPEN: S1 · src/DatePicker.tsx:1 · DueDatePicker',
    'OPEN: S2 · src/StudentList.tsx:1 · studentIds',
  ]);
  assert.match(r.stdout, /^SIBLINGS: 2 found, 2 open$/m);
  const fill = (map) => {
    let text = fs.readFileSync(list, 'utf8');
    for (const [n, outcome] of Object.entries(map)) text = text.replace(new RegExp('^(' + n + ' · .*?→).*$', 'm'), '$1 ' + outcome);
    fs.writeFileSync(list, text);
  };
  fill({ S1: 'none: too short', S2: 'P9' });
  r = run(['--check', list, '--places', places]);
  assert.equal(r.status, 1, r.stdout);
  assert.deepEqual(r.stdout.split(/\r?\n/).filter((l) => l.startsWith('OPEN:')), [
    'OPEN: S1 · src/DatePicker.tsx:1 · DueDatePicker — the reason after none: needs at least 12 characters',
    'OPEN: S2 · src/StudentList.tsx:1 · studentIds — P9 is not on the places list: add the sibling\'s name with places.mjs --names',
  ]);
  // Without --places any P<n> is taken.
  r = run(['--check', list]);
  assert.deepEqual(r.stdout.split(/\r?\n/).filter((l) => l.startsWith('OPEN:')).map((l) => l.slice(0, 9)), ['OPEN: S1 ']);
  // The author adds the sibling's name: it becomes a place, P4. A place gone from the list does not close it.
  const added = spawnSync(process.execPath, [path.join(scripts, 'places.mjs'), '--repo', repo, '--names', 'DueDatePicker', '--out', places], { encoding: 'utf8', windowsHide: true });
  assert.equal(added.status, 0, added.stderr);
  assert.match(fs.readFileSync(places, 'utf8'), /^P4 \(new\) · DueDatePicker · src\/DatePicker\.tsx · DueDatePicker · lines 1 → $/m);
  write('src/ChipGroup.tsx', 'export function onSaveFailed(errors) {}\n');
  assert.equal(spawnSync(process.execPath, [path.join(scripts, 'places.mjs'), '--refresh', places], { encoding: 'utf8', windowsHide: true }).status, 0);
  assert.match(fs.readFileSync(places, 'utf8'), /^P1 \(gone\) /m);
  fill({ S1: 'P4', S2: 'P1' });
  r = run(['--check', list, '--places', places]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /^OPEN: S2 · src\/StudentList\.tsx:1 · studentIds — P1 is gone from the places list$/m);
  fill({ S2: 'none: the student list has its own focus handling, tested in its own file' });
  r = run(['--check', list, '--places', places]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^SIBLINGS: 2 found, 0 open$/m);
  // An S line whose arrow was deleted is open, never dropped.
  fs.writeFileSync(list, fs.readFileSync(list, 'utf8').replace(/^(S2 · [^→]*?) ?→.*$/m, '$1'));
  r = run(['--check', list, '--places', places]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /^OPEN: S2 · src\/StudentList\.tsx:1 · studentIds$/m);
});

test('--check refuses a missing file, a file with no S line and no "SIBLINGS: none", and --places that is not a places list', () => {
  const { notes, places } = fixture();
  assert.equal(run(['--check', path.join(notes, 'siblings.md')]).status, 2, 'a missing file');
  const bare = path.join(notes, 'siblings.md');
  fs.writeFileSync(bare, '# Siblings\n\nnothing here\n');
  const r = run(['--check', bare]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /--record/);
  fs.writeFileSync(bare, 'SIBLINGS: none\nSAME JOB: none\n');
  assert.equal(run(['--check', bare, '--places', places]).status, 0);
  fs.writeFileSync(places, '# notes\n');
  assert.equal(run(['--check', bare, '--places', places]).status, 2, '--places must be a places list');
  assert.equal(run(['--places', places]).status, 2, 'no mode given');
  assert.equal(run(['--record', bare]).status, 2, '--record needs --notes');
});

// 2026-11-16 (PR #784): nobody asked how the repo already does the same KIND of job, so an inline call was built where
// the repo already had an outbox table and its worker. The second look now names that work; each find needs reuse or
// a reason, and a report or list without the search is refused.
const JOBS = [
  'SIBLINGS: none',
  '- SAME JOB: src/outbox/EmailOutbox.ts:12 · EmailOutbox — a table row in the same save, sent later by a worker with retries',
  '- SAME JOB: src/ms/MicrosoftIdentityChanges.ts:40 · MicrosoftIdentityChanges — queued identity changes, one worker drains them',
  '`SAME JOB: <file>:<line> · <what> — <how it does the job>`',
  'BEST DESIGN: J1 — the outbox is the way this repo already sends a change later',
].join('\n');
const jLines = (file) => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => /^J\d/.test(l));

test('the brief asks how the repo already does the same kind of job', () => {
  const { report } = briefed('SIBLINGS: none');
  const brief = fs.readFileSync(path.join(path.dirname(report), 'siblings-brief.md'), 'utf8');
  assert.match(brief, /how does this repo already do the same KIND of job/);
  assert.match(brief, /'SAME JOB: none' after searching/);
});

test('--record writes each SAME JOB line as an open J line; --check needs reuse or not: <reason> for each', () => {
  const { report, list } = briefed(JOBS);
  const r = run(['--record', report, '--notes', path.dirname(report)]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(jLines(list), [
    'J1 · src/outbox/EmailOutbox.ts:12 · EmailOutbox — a table row in the same save, sent later by a worker with retries → ',
    'J2 · src/ms/MicrosoftIdentityChanges.ts:40 · MicrosoftIdentityChanges — queued identity changes, one worker drains them → ',
  ], 'the quoted instruction is no line');
  assert.match(fs.readFileSync(list, 'utf8'), /^## Same kind of job done before — write `reuse`/m);
  assert.match(r.stdout, /^SAME JOB: 2 found — hints for the design: write reuse or not: <why> after each/m);
  let c = run(['--check', list]);
  assert.equal(c.status, 1, c.stdout);
  assert.deepEqual(c.stdout.split(/\r?\n/).filter((l) => l.startsWith('OPEN:')), [
    'OPEN: J1 · src/outbox/EmailOutbox.ts:12 · EmailOutbox',
    'OPEN: J2 · src/ms/MicrosoftIdentityChanges.ts:40 · MicrosoftIdentityChanges',
  ]);
  assert.match(c.stdout, /^SAME JOB: 2 found, 2 open$/m);
  const fill = (map) => {
    let text = fs.readFileSync(list, 'utf8');
    for (const [n, outcome] of Object.entries(map)) text = text.replace(new RegExp('^(' + n + ' · .*?→).*$', 'm'), '$1 ' + outcome);
    fs.writeFileSync(list, text);
  };
  fill({ J1: 'reuse — the role change becomes an outbox row', J2: 'not: short' });
  c = run(['--check', list]);
  assert.equal(c.status, 1, c.stdout);
  assert.deepEqual(c.stdout.split(/\r?\n/).filter((l) => l.startsWith('OPEN:')), [
    'OPEN: J2 · src/ms/MicrosoftIdentityChanges.ts:40 · MicrosoftIdentityChanges — the reason after not: needs at least 12 characters',
  ]);
  fill({ J2: 'not: it sends to Microsoft Graph, a different system with its own ordering' });
  c = run(['--check', list]);
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.match(c.stdout, /^SAME JOB: 2 found, 0 open$/m);
  // Recorded again: each J line keeps its number and outcome.
  assert.equal(run(['--record', report, '--notes', path.dirname(report)]).status, 0);
  assert.equal(jLines(list)[0], 'J1 · src/outbox/EmailOutbox.ts:12 · EmailOutbox — a table row in the same save, sent later by a worker with retries → reuse — the role change becomes an outbox row');
});

test('a report with no same-job answer is refused: the search did not run; "SAME JOB: none" alone is an answer', () => {
  const { report, list } = briefed('SIBLINGS: none\n', { sameJob: false });
  const r = run(['--record', report, '--notes', path.dirname(report)]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /no SAME JOB line and no "SAME JOB: none" line: the same-job search did not run/);
  assert.equal(fs.existsSync(list), false, 'nothing written');
  fs.writeFileSync(report, 'SIBLINGS: none\n**SAME JOB: none**\n');
  assert.equal(run(['--record', report, '--notes', path.dirname(report)]).status, 0);
  assert.match(fs.readFileSync(list, 'utf8'), /^SAME JOB: none$/m);
  assert.equal(run(['--check', list]).status, 0);
});

test('--check: a list with no same-job search (an older list) is open', () => {
  const { notes } = fixture();
  const file = path.join(notes, 'siblings.md');
  fs.writeFileSync(file, 'SIBLINGS: none\n');
  const r = run(['--check', file]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^OPEN: SAME JOB — the same-job search is missing/m);
});

// 2026-11-17 (audit, "a sibling can close against an unrelated place"): any P number that was on the places list
// closed an S line, so a number copied from another line closed a sibling whose own file was never searched.
const fillS = (list, map) => {
  let text = fs.readFileSync(list, 'utf8');
  for (const [n, outcome] of Object.entries(map)) text = text.replace(new RegExp('^(' + n + ' · .*?→).*$', 'm'), (all, head) => head + ' ' + outcome);
  fs.writeFileSync(list, text);
};
const openOf = (r) => r.stdout.split(/\r?\n/).filter((l) => l.startsWith('OPEN:'));
const addNames = (repo, places, names) => spawnSync(process.execPath, [path.join(scripts, 'places.mjs'), '--repo', repo, '--names', names, '--out', places], { encoding: 'utf8', windowsHide: true });

test('a P<n> closes a sibling only when that place is in the file the sibling names; of several, at least one; a line that names no file is closed as before', async () => {
  // The input of the audit, through the checker itself: a sibling in PublishNow.cs, closed with a place of Schedule.cs.
  const { openReason, checkSiblings } = await import(pathToFileURL(script).href);
  const onePlace = { repo: 'C:/r', names: ['Validate'], places: [{ n: 1, mark: '', name: 'Validate', file: 'Schedule.cs', fn: 'Schedule', lines: '3', outcome: 'C1' }] };
  const row = { n: 1, body: 'PublishNow.cs:8 · Publish — same date rule', outcome: 'P1' };
  const how = ": add the sibling's own name with places.mjs --names, or write none: <reason>";
  assert.equal(openReason(row, onePlace), 'P1 is in Schedule.cs, not in PublishNow.cs' + how);
  const checked = checkSiblings({ rows: [row], jobs: [], jobNone: true }, { places: onePlace });
  assert.equal(checked.ok, false);
  assert.equal(checked.text.split('\n')[0], 'OPEN: S1 · PublishNow.cs:8 · Publish — P1 is in Schedule.cs, not in PublishNow.cs' + how);
  // 2026-11-18 (audit finding 4): this line used "Reschedule" and a place of the function "Schedule" closed it; a place
  // of another function of the same file no longer closes a sibling. The sibling's own function is "Schedule" here.
  assert.equal(openReason({ ...row, body: 'Schedule.cs:20 · Schedule — same date rule' }, onePlace), '', 'a place of the same function in the same file closes it');
  assert.match(openReason({ ...row, body: 'Schedule.cs:20 · Reschedule — same date rule' }, onePlace), /^P1 is a place of Schedule, not of Reschedule/, 'a place of another function of the file does not');
  assert.equal(openReason(row, undefined), '', 'without --places no P<n> is looked up, as before');

  const { repo, notes, places, report, list } = briefed(TWO + '\nSIBLING: the rich-text description editor - same focus defect on save\n');
  assert.equal(run(['--record', report, '--notes', notes]).status, 0);
  // P1 and P2 are in src/ChipGroup.tsx and P3 is in src/focus.ts: no sibling is in either file.
  // 2026-11-18 (audit finding 6): S3 names no file, so no P<n> closes it (it was closed by any place before); it takes none:.
  fillS(list, { S1: 'P1', S2: 'P2, P3', S3: 'none: a text editor, not a form field' });
  let r = run(['--check', list, '--places', places]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.deepEqual(openOf(r), [
    'OPEN: S1 · src/DatePicker.tsx:1 · DueDatePicker — P1 is in src/ChipGroup.tsx, not in src/DatePicker.tsx' + how,
    'OPEN: S2 · src/StudentList.tsx:1 · studentIds — P2, P3 are in src/ChipGroup.tsx, src/focus.ts, not in src/StudentList.tsx' + how,
  ], 'S3 has its none: outcome');
  assert.match(r.stdout, /^SIBLINGS: 3 found, 2 open$/m);
  // The author adds the own name of each sibling: P4 is in src/DatePicker.tsx and P5 in src/StudentList.tsx.
  const added = addNames(repo, places, 'DueDatePicker,studentIds');
  assert.equal(added.status, 0, added.stderr);
  const now = fs.readFileSync(places, 'utf8');
  assert.match(now, /^P4 \(new\) · DueDatePicker · src\/DatePicker\.tsx · /m);
  assert.match(now, /^P5 \(new\) · studentIds · src\/StudentList\.tsx · /m);
  fillS(list, { S1: 'P4', S2: 'P1, P5' });
  r = run(['--check', list, '--places', places]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^SIBLINGS: 3 found, 0 open$/m);
  // The two outcomes swapped: each number is on the list, and each is a place in the file of the other sibling.
  fillS(list, { S1: 'P5', S2: 'P4' });
  r = run(['--check', list, '--places', places]);
  assert.equal(r.status, 1, r.stdout);
  assert.deepEqual(openOf(r), [
    'OPEN: S1 · src/DatePicker.tsx:1 · DueDatePicker — P5 is in src/StudentList.tsx, not in src/DatePicker.tsx' + how,
    'OPEN: S2 · src/StudentList.tsx:1 · studentIds — P4 is in src/DatePicker.tsx, not in src/StudentList.tsx' + how,
  ]);
});

test('the file of a sibling is read as the places list names it: backslashes, "./", a whole path, and letter case where the file system ignores it', async () => {
  const { openReason } = await import(pathToFileURL(script).href);
  const onePlace = { repo: 'C:/r', names: ['due'], places: [{ n: 1, mark: '', name: 'due', file: 'src/Forms/DatePicker.tsx', fn: 'due', lines: '4', outcome: '' }] };
  // 2026-11-18 (audit finding 4): the place is the one of the function the line names ("due"); with a place of another
  // function of that file the line stays open, so this fixture's place carries that function (it was "(file)").
  const row = (file) => ({ n: 1, body: `${file}:4 · due — the same rule`, outcome: 'P1' });
  const elsewhere = /^P1 is in src\/Forms\/DatePicker\.tsx, not in /;
  assert.match(openReason(row('src/Forms/Other.tsx'), onePlace), elsewhere);
  assert.equal(openReason(row('src\\Forms\\DatePicker.tsx'), onePlace), '', 'backslashes');
  assert.equal(openReason(row('./src/Forms/DatePicker.tsx'), onePlace), '', 'a leading ./');
  assert.equal(openReason(row('SRC/forms/datepicker.TSX'), onePlace, { ignoreCase: true }), '', 'Windows: one file, whatever the letter case');
  assert.match(openReason(row('SRC/forms/datepicker.TSX'), onePlace, { ignoreCase: false }), elsewhere, 'a file system that tells letter case apart: two files');
  assert.match(openReason(row('src\\Forms\\Other.tsx'), onePlace), /, not in src\/Forms\/Other\.tsx: /, 'the message names the file with forward slashes');

  // Through the command: a report from Windows names one file with backslashes and one by its whole path. The
  // temp folder can have a short and a long spelling; the list holds the one git gives.
  const f = fixture();
  assert.equal(run(['--brief', '--notes', f.notes, '--repo', f.repo]).status, 0);
  const report = path.join(f.notes, 'siblings-report.md'), list = path.join(f.notes, 'siblings.md');
  const whole = path.join(f.repo, 'src', 'StudentList.tsx');
  fs.writeFileSync(report, [
    'SIBLING: src\\DatePicker.tsx:1 · DueDatePicker — a field on the same form whose error never gets the focus',
    `SIBLING: ${whole}:1 · studentIds — the list shows its error, but the focus stays on the save button`,
    'SAME JOB: none', '',
  ].join('\n'));
  assert.equal(run(['--record', report, '--notes', f.notes]).status, 0);
  assert.equal(addNames(f.repo, f.places, 'DueDatePicker,studentIds').status, 0);
  fillS(list, { S1: 'P4', S2: 'P5' });
  let r = run(['--check', list, '--places', f.places]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  fillS(list, { S1: 'P5', S2: 'P4' });
  r = run(['--check', list, '--places', f.places]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(openOf(r)[0], / — P5 is in src\/StudentList\.tsx, not in src\/DatePicker\.tsx: /);
  assert.match(openOf(r)[1], / — P4 is in src\/DatePicker\.tsx, not in .*StudentList\.tsx: /);
});

// 2026-11-17 (audit, bug-detection 6): the file guard read the file only from "<file>:<line> · ", so a line kept
// as written in another shape had no file and any place closed it.
test('an S line that names its file in another shape still closes only with a place of that file', async () => {
  const { siblingFile } = await import(pathToFileURL(script).href);
  assert.equal(siblingFile('web/src/DatePicker.tsx:1:17 · x — y'), 'web/src/DatePicker.tsx');
  assert.equal(siblingFile('web/src/DatePicker.tsx:1 - DueDatePicker - a field'), 'web/src/DatePicker.tsx');
  assert.equal(siblingFile('`src/DatePicker.tsx:1` · x'), 'src/DatePicker.tsx');
  assert.equal(siblingFile('/src/DatePicker.tsx:1: x'), 'src/DatePicker.tsx');
  assert.equal(siblingFile('src/a.ts:12-20 · x'), 'src/a.ts');
  assert.equal(siblingFile('Note: 5 items'), '', 'no file: the old behavior');
  const f = fixture();
  assert.equal(run(['--brief', '--notes', f.notes, '--repo', f.repo]).status, 0);
  const report = path.join(f.notes, 'siblings-report.md'), list = path.join(f.notes, 'siblings.md');
  fs.writeFileSync(report, [
    'SIBLING: src/DatePicker.tsx:1 - DueDatePicker - a field on the same form whose error never gets the focus',
    'SIBLING: src/StudentList.tsx:1 — studentIds: the list shows its error, but the focus stays on the save button',
    'SAME JOB: none', '',
  ].join('\n'));
  assert.equal(run(['--record', report, '--notes', f.notes]).status, 0);
  assert.equal(addNames(f.repo, f.places, 'DueDatePicker,studentIds').status, 0);
  // P1 is in src/focus.ts or src/ChipGroup.tsx: no S line closes with it.
  fillS(list, { S1: 'P1', S2: 'P1' });
  let r = run(['--check', list, '--places', f.places]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /^SIBLINGS: 2 found, 2 open$/m);
  fillS(list, { S1: 'P4', S2: 'P5' });
  r = run(['--check', list, '--places', f.places]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

// ---- 2026-11-18 (audit of the release): findings 4 to 7 and 10 ----

const SERVICE = [
  'public class Service {',          // 1
  '    public void Schedule() {',    // 2
  '        DateRule.Check(h);',      // 3
  '    }',                           // 4
  '    public void PublishNow() {',  // 5
  '        Save(h);',                // 6
  '    }',                           // 7
  '}', '',
].join('\n');
const placeOf = (places, name) => Number(new RegExp('^P(\\d+)(?: \\(new\\))? · ' + name + ' ', 'm').exec(fs.readFileSync(places, 'utf8'))[1]);

test('finding 4: a place of another function of the same file does not close a sibling; the place of its own function does', () => {
  const f = fixture();
  f.write('src/Service.cs', SERVICE);
  assert.equal(addNames(f.repo, f.places, 'DateRule').status, 0);
  const schedule = placeOf(f.places, 'DateRule');
  const list = path.join(f.notes, 'siblings.md');
  const write = (outcome) => fs.writeFileSync(list, `# Siblings\n\nS1 · src/Service.cs:5 · PublishNow — publishes with no date check, the same rule → ${outcome}\n\nSAME JOB: none\n`);
  write('P' + schedule);
  let r = run(['--check', list, '--places', f.places]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(openOf(r)[0], /^OPEN: S1 · src\/Service\.cs:5 · PublishNow — P\d+ is a place of Schedule, not of PublishNow \(src\/Service\.cs:5\)/);
  assert.match(r.stdout, /^SIBLINGS: 1 found, 1 open$/m);
  assert.equal(addNames(f.repo, f.places, 'PublishNow').status, 0);
  write('P' + placeOf(f.places, 'PublishNow'));
  r = run(['--check', list, '--places', f.places]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // A line inside the function reads as that function, though its place was found on another line.
  fs.writeFileSync(list, `# Siblings\n\nS1 · src/Service.cs:6 · Save — the same rule → P${placeOf(f.places, 'PublishNow')}\n\nSAME JOB: none\n`);
  assert.equal(run(['--check', list, '--places', f.places]).status, 0, 'line 6 is inside PublishNow');
});

test('finding 5: a sibling line in a near shape is read, never dropped: any case, bold marks, a number; one that cannot be read is a usage error', () => {
  const { report, notes, list } = briefed([
    '**SIBLING**: src/DatePicker.tsx:1 · DueDatePicker — the picker lets the same wrong date through',
    'Sibling: src/StudentList.tsx:1 · studentIds — the list has the same defect',
    'SIBLING 4: src/focus.ts:1 · focusFirstError — the helper itself',
    'OUTSIDE PR: src/Service.cs:13 — Save is called twice',
    'SAME JOB: none', '',
  ].join('\n'));
  const r = run(['--record', report, '--notes', notes]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^SIBLINGS: 3 found, 3 open/m);
  assert.deepEqual(sLines(list).map((l) => l.replace(/ — .*/, '')), [
    'S1 · src/DatePicker.tsx:1 · DueDatePicker', 'S2 · src/StudentList.tsx:1 · studentIds', 'S3 · src/focus.ts:1 · focusFirstError']);
  // A line that starts with SIBLING and is not a sibling line: the check did not run; nothing is recorded.
  const bad = briefed('Siblings found in three files\nSAME JOB: none\n');
  const e = run(['--record', bad.report, '--notes', bad.notes]);
  assert.equal(e.status, 2, e.stdout);
  assert.match(e.stderr, /starts with SIBLING but is not "SIBLING: <file>:<line> · <what> — <why>"/);
  assert.equal(fs.existsSync(bad.list), false, 'nothing recorded on an error');
});

test('finding 6: a sibling line that does not start with its file is closed by a place of that file only; one with no file takes none:', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.notes, 'siblings.md'), [
    '# Siblings', '',
    'S1 · DatePicker (src/components/DatePicker.tsx:1) — the picker lets the same wrong date through → P1',
    'S2 · the rich-text editor lets the same wrong date through → P1',
    'S3 · see (src/ChipGroup.tsx:2) — the handler of the chip groups → P2', '',
    'SAME JOB: none', '',
  ].join('\n'));
  const r = run(['--check', path.join(f.notes, 'siblings.md'), '--places', f.places]);
  assert.equal(r.status, 1, r.stdout);
  const open = openOf(r);
  assert.match(open[0], /^OPEN: S1 .* — P1 is in src\/ChipGroup\.tsx, not in src\/components\/DatePicker\.tsx/);
  assert.match(open[1], /^OPEN: S2 .* — no file named: start the line with <file>:<line>, or write none: <reason>/);
  assert.equal(open.length, 2, 'S3 names line 2 of src/ChipGroup.tsx, the function onSaveFailed, which is P2: closed');
});

test('finding 7: the siblings list is stale after the ticket lines or the check lines change: the check fails until --brief and --record run again', () => {
  const f = briefed('SIBLINGS: none\nSAME JOB: none\n');
  assert.equal(run(['--record', f.report, '--notes', f.notes]).status, 0);
  const lines = path.join(f.notes, 'lines.md'), check = path.join(f.notes, 'check.md');
  assert.match(fs.readFileSync(f.list, 'utf8'), /^Sources: [0-9a-f]{12}$/m);
  const ok = run(['--check', f.list, '--places', f.places, '--lines', lines, '--check-lines', check]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  // A cosmetic change (header text, blank lines) is no change.
  fs.writeFileSync(lines, fs.readFileSync(lines, 'utf8').replace('verbatim, 2026-11-14', 'verbatim').replace(/\n\n/, '\n\n\n'));
  assert.equal(run(['--check', f.list, '--places', f.places, '--lines', lines, '--check-lines', check]).status, 0);
  fs.appendFileSync(lines, 'T3. A late hand-in is marked late from the due minute itself.\n');
  fs.appendFileSync(check, '- [T3] a hand-in at the due minute is late\n');
  let r = run(['--check', f.list, '--places', f.places, '--lines', lines, '--check-lines', check]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /^OPEN: SIBLINGS — ticket lines changed: run --brief again/m);
  // Recording the old report again is refused: the brief was written for the old lines.
  const again = run(['--record', f.report, '--notes', f.notes]);
  assert.equal(again.status, 2, again.stdout);
  assert.match(again.stderr, /ticket lines or check lines changed after the brief was written: run --brief again/);
  // The whole flow again: brief, a new report, record: the list is current.
  assert.equal(run(['--brief', '--notes', f.notes, '--repo', f.repo]).status, 0);
  assert.equal(run(['--record', f.report, '--notes', f.notes]).status, 0);
  r = run(['--check', f.list, '--places', f.places, '--lines', lines, '--check-lines', check]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('finding 7, must not change: a list without a Sources line (older) and a check without --lines read as before', () => {
  const f = briefed('SIBLINGS: none\nSAME JOB: none\n');
  assert.equal(run(['--record', f.report, '--notes', f.notes]).status, 0);
  assert.equal(run(['--check', f.list, '--places', f.places]).status, 0, 'no --lines: no comparison');
  // 2026-11-19: the list also stores one hash per line (Lines:, Checks:); an older list has none of the three.
  fs.writeFileSync(f.list, fs.readFileSync(f.list, 'utf8').replace(/^(?:Sources|Lines|Checks): .*\n/gm, ''));
  fs.appendFileSync(path.join(f.notes, 'lines.md'), 'T3. Another line.\n');
  const r = run(['--check', f.list, '--places', f.places, '--lines', path.join(f.notes, 'lines.md'), '--check-lines', path.join(f.notes, 'check.md')]);
  assert.equal(r.status, 0, 'a list from before the Sources line has nothing to compare');
});

test('finding 10: honest answers with a few extra words are read as none; "SIBLING: none" is "SIBLINGS: none"; a real file named none.ts is not none', () => {
  for (const [sib, job] of [
    ['SIBLINGS: none (searched the three other date fields)', 'SAME JOB: none'],
    ['SIBLINGS: none', 'SAME JOB: none - no outbox or worker does this'],
    ['SIBLING: none', 'SAME JOB: none'],
    ['SIBLINGS: none.', 'SAME JOB: none (searched the workers)'],
  ]) {
    const f = briefed(sib + '\n' + job + '\n');
    const r = run(['--record', f.report, '--notes', f.notes]);
    assert.equal(r.status, 0, sib + ' / ' + job + '\n' + r.stdout + r.stderr);
    const c = run(['--check', f.list, '--places', f.places]);
    assert.equal(c.status, 0, sib + ' / ' + job + '\n' + c.stdout);
    assert.match(c.stdout, /^SIBLINGS: 0 found, 0 open$/m);
    assert.match(c.stdout, /^SAME JOB: 0 found, 0 open$/m);
  }
  const f = briefed('SIBLING: none.ts:3 · none — a file called none.ts has the same rule\nSAME JOB: none\n');
  assert.equal(run(['--record', f.report, '--notes', f.notes]).status, 0);
  assert.equal(sLines(f.list).length, 1, 'a file named none.ts is a sibling');
});

// ---- 2026-11-18 (audit, repair round) ----
// A repo with Schedule (lines 3-8) then PublishNow (from line 9), both with the date rule; places P1 (Schedule) and P2 (PublishNow).
function service() {
  const repo = fs.mkdtempSync(path.join(root, 'svc-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (n, t) => { fs.mkdirSync(path.dirname(path.join(repo, n)), { recursive: true }); fs.writeFileSync(path.join(repo, n), t); };
  git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'core.autocrlf', 'false');
  const text = (extra = []) => ['class Service', '{', '    public void Schedule(Homework h)', '    {', ...extra, '        DateRule.Check(h);', '    }',
    '    public void PublishNow(Homework h)', '    {', '        Publish(h);', '        DateRule.Check(h);', '    }', '}', ''].join('\n');
  write('src/Service.cs', text());
  git('add', '-A'); git('commit', '-qm', 'base');
  const notes = fs.mkdtempSync(path.join(root, 'notes-'));
  fs.writeFileSync(path.join(notes, 'lines.md'), 'T1. Check the date.\n');
  fs.writeFileSync(path.join(notes, 'check.md'), '- [T1] the date is checked\n');
  const places = path.join(notes, 'places.md');
  assert.equal(spawnSync(process.execPath, [path.join(scripts, 'places.mjs'), '--repo', repo, '--names', 'DateRule', '--out', places], { encoding: 'utf8', windowsHide: true }).status, 0);
  return { repo, notes, places, write, text };
}
const refresh = (f) => assert.equal(spawnSync(process.execPath, [path.join(scripts, 'places.mjs'), '--refresh', f.places, '--repo', f.repo], { encoding: 'utf8', windowsHide: true }).status, 0);
const recordFor = (f, body) => {
  assert.equal(run(['--brief', '--notes', f.notes, '--repo', f.repo]).status, 0);
  fs.writeFileSync(path.join(f.notes, 'siblings-report.md'), `SIBLING: ${body}\nSAME JOB: none\n`);
  const r = run(['--record', path.join(f.notes, 'siblings-report.md'), '--notes', f.notes]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return path.join(f.notes, 'siblings.md');
};
const placeNo = (f, fn) => fs.readFileSync(f.places, 'utf8').split(/\r?\n/).map((l) => new RegExp(`^P(\\d+)(?: \\(\\w+\\))? · DateRule · src/Service\\.cs · ${fn} · `).exec(l)).filter(Boolean)[0][1];
const closeWith = (list, p) => fs.writeFileSync(list, fs.readFileSync(list, 'utf8').replace(/(^S1 · .*→).*$/m, `$1 P${p}`));

test('audit 2: a sibling closed with the place of ANOTHER function stays open after the fix moved the lines (the function is stored when the sibling is recorded)', () => {
  const f = service();
  const list = recordFor(f, 'src/Service.cs:10 · PublishNow — publishes with no date check, the same rule');
  assert.match(fs.readFileSync(list, 'utf8'), /^Holds: /m);
  closeWith(list, placeNo(f, 'Schedule'));
  let r = run(['--check', list, '--places', f.places]);
  assert.equal(r.status, 1, 'before code it is open: ' + r.stdout);
  f.write('src/Service.cs', f.text(['        var a = 1;', '        var b = 2;', '        var c = 3;', '        var d = 4;']));
  refresh(f);
  r = run(['--check', list, '--places', f.places]);
  assert.equal(r.status, 1, 'after the lines moved it is still open: ' + r.stdout);
  assert.match(r.stdout, /OPEN: S1 .*not of PublishNow/);
});

test('audit 6: a sibling closed with its OWN place stays closed after lines moved, whatever the report wrote as the function', () => {
  for (const part of ['Service.PublishNow', 'PublishNow(Homework h)', 'PublishNow method', 'the publish-now path']) {
    const f = service();
    const list = recordFor(f, `src/Service.cs:10 · ${part} — publishes with no date check, the same rule`);
    closeWith(list, placeNo(f, 'PublishNow'));
    assert.equal(run(['--check', list, '--places', f.places]).status, 0, part + ' before code');
    f.write('src/Service.cs', f.text(['        var a = 1;', '        var b = 2;', '        var c = 3;', '        var d = 4;', '        var e = 5;', '        var g = 6;']));
    refresh(f);
    const r = run(['--check', list, '--places', f.places]);
    assert.equal(r.status, 0, part + ' after lines moved: ' + r.stdout);
  }
});

test('audit 7: a sibling line behind a heading mark, a table bar, a bracket, an arrow or strike marks is read; a lead word is refused; never dropped', () => {
  const what = 'src/DatePicker.tsx:1 · DueDatePicker — the picker never gets the focus';
  for (const [shape, read] of [
    ['### SIBLING: ' + what, true],
    ['#### 2. SIBLING: ' + what, true],
    ['| SIBLING: ' + what + ' |', true],
    ['[SIBLING] ' + what, true],
    ['(SIBLING) ' + what, true],
    ['➜ SIBLING: ' + what, true],
    ['~~SIBLING~~: ' + what, true],
    ['Possible SIBLING: ' + what, false],
    ['Second sibling: ' + what, false],
  ]) {
    const f = briefed('SIBLING: src/StudentList.tsx:1 · studentIds — the list shows its error, but the focus stays on the save button\n' + shape + '\n');
    const r = run(['--record', f.report, '--notes', f.notes]);
    if (read) {
      assert.equal(r.status, 0, shape + '\n' + r.stdout + r.stderr);
      assert.equal(sLines(f.list).length, 2, shape + ' is read:\n' + fs.readFileSync(f.list, 'utf8'));
      assert.match(sLines(f.list)[1], /^S2 · src\/DatePicker\.tsx:1 · DueDatePicker — the picker never gets the focus → $/, shape);
    } else {
      assert.equal(r.status, 2, shape + ' is refused:\n' + r.stdout);
      assert.match(r.stderr, /SIBLING/i);
    }
  }
});

test('audit 7, must not change: prose with no file:line and the instruction quoted back are no sibling and no error', () => {
  const f = briefed("I looked for a sibling in every form.\nAnswer only with lines 'SIBLING: <file>:<line> · <function or field> — <why>'.\nSIBLING: src/StudentList.tsx:1 · studentIds — the list shows its error\n");
  const r = run(['--record', f.report, '--notes', f.notes]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(sLines(f.list).length, 1);
});

// 2026-11-19 (release "ticket lines and the second look, line by line"). One added check line forced a second full
// run of the second look (3.5 minutes), and 13 outcomes were typed through a hand-made script.
const linesOf = (f) => path.join(f.notes, 'lines.md');
const checkOf = (f) => path.join(f.notes, 'check.md');
const checkArgs = (f) => ['--check', f.list, '--places', f.places, '--lines', linesOf(f), '--check-lines', checkOf(f)];
const recorded = (text = 'SIBLINGS: none\nSAME JOB: none\n') => {
  const f = briefed(text);
  const r = run(['--record', f.report, '--notes', f.notes]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return f;
};
// The owner's switch, set in the fixture's own repository (the tests read no config of this machine).
// Since 2026-11-20 the rule is on unless the owner sets it to false.
const switchOff = (f) => f.git('config', 'sanad.lateCheckLines', 'false');

test('each ticket line has its own hash: one changed word or one added line is stale; a dropped line and a new order are not', () => {
  const f = recorded();
  const list = fs.readFileSync(f.list, 'utf8');
  assert.match(list, /^Lines: [0-9a-f]{10} [0-9a-f]{10}$/m, 'one short hash per ticket line');
  assert.match(list, /^Checks: [0-9a-f]{10}$/m, 'one short hash per check line');
  const original = fs.readFileSync(linesOf(f), 'utf8');
  assert.equal(run(checkArgs(f)).status, 0);
  // The two lines in the other order, no word changed.
  fs.writeFileSync(linesOf(f), '# Lines\n\nT1. Expected: the first field with an error gets the focus.\nT2. Focus does not move to the field with the error after a failed save.\n');
  let r = run(checkArgs(f));
  assert.equal(r.status, 0, 'a new order is no change\n' + r.stdout);
  // One line dropped by the user, as lines.mjs --drop writes it.
  fs.writeFileSync(linesOf(f), original.replace('T2. Expected', 'T2. [dropped by the user: "leave the focus rule for now"] Expected'));
  r = run(checkArgs(f));
  assert.equal(r.status, 0, 'a dropped line is no change\n' + r.stdout);
  // The dropped line brought back by hand: the second look read it, so the list is still current.
  fs.writeFileSync(linesOf(f), original);
  assert.equal(run(checkArgs(f)).status, 0);
  // One word changed.
  fs.writeFileSync(linesOf(f), original.replace('gets the focus', 'gets the cursor'));
  r = run(checkArgs(f));
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /^OPEN: SIBLINGS — ticket lines changed: run --brief again.* — T2 is new or changed$/m);
  // One line added.
  fs.writeFileSync(linesOf(f), original + 'T3. A late hand-in is marked late.\n');
  r = run(checkArgs(f));
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, / — T3 is new or changed$/m);
  // The ticket lines alone: the same answers, and the check file beside them is still read.
  fs.writeFileSync(linesOf(f), original);
  assert.equal(run(['--check', f.list, '--lines', linesOf(f)]).status, 0);
  fs.appendFileSync(checkOf(f), '- [T2] the date picker gets the focus too\n');
  switchOff(f);
  r = run(['--check', f.list, '--places', f.places, '--lines', linesOf(f)]);
  assert.equal(r.status, 1, 'with the switch off, a check line added later still asks for the second look\n' + r.stdout);
  assert.match(r.stdout, / — the check lines changed: C2$/m);
});

test('a line dropped before the brief is not in the brief; brought back by hand later, it makes the list stale', () => {
  const f = fixture();
  const original = fs.readFileSync(linesOf(f), 'utf8');
  fs.writeFileSync(linesOf(f), original.replace('T1. Focus', 'T1. [dropped by the user: "leave the focus rule for now"] Focus'));
  const b = run(['--brief', '--notes', f.notes, '--repo', f.repo]);
  assert.equal(b.status, 0, b.stdout + b.stderr);
  assert.match(b.stdout, /T1\.\.T2 \(T1 dropped\) · C1\.\.C1/);
  const brief = fs.readFileSync(path.join(f.notes, 'siblings-brief.md'), 'utf8');
  assert.doesNotMatch(brief, /^- T1\./m);
  assert.match(brief, /^- T2\. Expected: the first field with an error gets the focus\.$/m, 'T2 keeps its number');
  assert.match(brief, /^\(T1 dropped by the user: no part of the goal\)$/m);
  const report = path.join(f.notes, 'siblings-report.md'), list = path.join(f.notes, 'siblings.md');
  fs.writeFileSync(report, 'SIBLINGS: none\nSAME JOB: none\n');
  assert.equal(run(['--record', report, '--notes', f.notes]).status, 0);
  assert.equal(run(['--check', list, '--lines', linesOf(f)]).status, 0);
  fs.writeFileSync(linesOf(f), original);
  const r = run(['--check', list, '--lines', linesOf(f)]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, / — T1 is new or changed$/m);
  // A lines file with every line dropped has no rule to search for.
  fs.writeFileSync(linesOf(f), 'T1. [dropped by the user: "leave the focus rule for now"] Focus stays.\n');
  const none = run(['--brief', '--notes', f.notes, '--repo', f.repo]);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /every ticket line .* is dropped/);
});

test("with the owner's switch: a check line added after the second look is not stale, and the NOTE line names it", async () => {
  const f = recorded();
  fs.appendFileSync(checkOf(f), '- [T2] the date picker gets the focus too\n');
  // Switched off (false): the rule of 2026-11-18 stands.
  switchOff(f);
  assert.equal(run(checkArgs(f)).status, 1);
  f.git('config', '--unset-all', 'sanad.lateCheckLines');
  let r = run(checkArgs(f));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^NOTE: C2 added after the second look$/m);
  assert.doesNotMatch(r.stdout, /OPEN: SIBLINGS/);
  // A check line that is edited, not added, was never read either.
  fs.writeFileSync(checkOf(f), '- [T1, T2] after a failed save the first date picker with an error has the focus\n');
  r = run(checkArgs(f));
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^NOTE: C1 added after the second look$/m);
  // The export the review brief reads.
  const { lateCheckLines, parseSiblings } = await import(pathToFileURL(script).href);
  const listText = fs.readFileSync(f.list, 'utf8');
  const two = '- [T1, T2] after a failed save the first chip group with an error has the focus\n- [T2] the date picker gets the focus too\n';
  assert.deepEqual(lateCheckLines(listText, two), [{ n: 2, text: '[T2] the date picker gets the focus too' }]);
  assert.deepEqual(lateCheckLines(parseSiblings(listText), two).map((c) => c.n), [2]);
  assert.deepEqual(lateCheckLines(listText.replace(/^Checks: .*\n/m, ''), two), [], 'a list of the release before has no late line');
  // A ticket line added or changed is stale with the switch too.
  fs.appendFileSync(linesOf(f), 'T3. A late hand-in is marked late.\n');
  r = run(checkArgs(f));
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, / — T3 is new or changed$/m);
});

test("with the owner's switch, --brief with no check.md writes the brief; without the switch it is refused as before", () => {
  const f = fixture();
  fs.rmSync(checkOf(f));
  switchOff(f);
  const off = run(['--brief', '--notes', f.notes, '--repo', f.repo]);
  assert.equal(off.status, 2, off.stdout);
  assert.match(off.stderr, /no check\.md in .*write the check lines first/);
  f.git('config', '--unset-all', 'sanad.lateCheckLines');
  const on = run(['--brief', '--notes', f.notes, '--repo', f.repo]);
  assert.equal(on.status, 0, on.stdout + on.stderr);
  assert.match(on.stdout, /T1\.\.T2 · no check line yet · /);
  assert.match(fs.readFileSync(path.join(f.notes, 'siblings-brief.md'), 'utf8'), /^- none yet: the check lines are written after this look$/m);
  const report = path.join(f.notes, 'siblings-report.md'), list = path.join(f.notes, 'siblings.md');
  fs.writeFileSync(report, 'SIBLINGS: none\nSAME JOB: none\n');
  // The check lines are written while the agent searches; the record takes the report.
  fs.writeFileSync(checkOf(f), '- [T1, T2] the first chip group with an error has the focus\n');
  const rec = run(['--record', report, '--notes', f.notes]);
  assert.equal(rec.status, 0, rec.stdout + rec.stderr);
  assert.match(fs.readFileSync(list, 'utf8'), /^Checks: none$/m);
  const r = run(['--check', list, '--places', f.places, '--lines', linesOf(f)]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^NOTE: C1 added after the second look$/m);
});

test('with no setting at all, a check line added after the brief does not void the record', () => {
  const f = recorded();
  fs.appendFileSync(checkOf(f), '- [T2] the date picker gets the focus too\n');
  const r = run(checkArgs(f));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^NOTE: C2 added after the second look$/m);
});

test('a siblings list written by the release before (one Sources hash) is valid until a ticket line changes', () => {
  const f = recorded();
  fs.writeFileSync(f.list, fs.readFileSync(f.list, 'utf8').replace(/^(?:Lines|Checks): .*\n/gm, ''));
  assert.match(fs.readFileSync(f.list, 'utf8'), /^Sources: [0-9a-f]{12}$/m);
  assert.equal(run(checkArgs(f)).status, 0);
  // A dropped line keeps the old hash: its own words still count there.
  const original = fs.readFileSync(linesOf(f), 'utf8');
  fs.writeFileSync(linesOf(f), original.replace('T2. Expected', 'T2. [dropped by the user: "leave the focus rule for now"] Expected'));
  assert.equal(run(checkArgs(f)).status, 0);
  fs.writeFileSync(linesOf(f), original.replace('gets the focus', 'gets the cursor'));
  const r = run(checkArgs(f));
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /^OPEN: SIBLINGS — ticket lines changed: run --brief again/m);
});

test('--close with two --set options writes the outcomes by the rules of --check, and writes nothing when one is refused', () => {
  const f = briefed(TWO + '\nSIBLING: src/ChipGroup.tsx:3 · onSaveFailed — the handler itself skips the second group\nSAME JOB: src/focus.ts:1 · focusFirstError — the helper every form calls after a failed save\nSAME JOB: src/ChipGroup.tsx:2 · onSaveFailed — the handler that calls it\nBEST DESIGN: J1 — one helper every form calls\n');
  assert.equal(run(['--record', f.report, '--notes', f.notes]).status, 0);
  const before = fs.readFileSync(f.list, 'utf8');
  // P1 is the place of the file's top level, not of the function onSaveFailed that holds S3's line: refused, as
  // --check refuses it. P2 is that function's place.
  let other = run(['--close', f.list, '--set', 'S3=P1']);
  assert.equal(other.status, 1, other.stdout + other.stderr);
  assert.match(other.stdout, /^REFUSED: S3 — P1 is a place of \(file\), not of onSaveFailed/m);
  assert.equal(fs.readFileSync(f.list, 'utf8'), before);
  other = run(['--close', f.list, '--set', 'S3=P2']);
  assert.equal(other.status, 0, other.stdout + other.stderr);
  assert.match(other.stdout, /^ {2}S3 · .* → P2$/m);
  assert.match(other.stdout, /^SIBLINGS: 3 found, 2 open$/m);
  fs.writeFileSync(f.list, before);
  // P1 is the place of another file: refused, as --check refuses it, and nothing is written.
  let r = run(['--close', f.list, '--set', 'S1=P1', '--set', 'J1,J2=reuse']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^REFUSED: S1 — P1 is in .*, not in src\/DatePicker\.tsx/m);
  assert.match(r.stdout, /^SIBLINGS: nothing written/m);
  assert.equal(fs.readFileSync(f.list, 'utf8'), before);
  // A reason of 11 characters is too short, for S and for J.
  r = run(['--close', f.list, '--set', 'S1,S2=none: elevenchars', '--set', 'J2=not: elevenchars']);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /^REFUSED: S1 — the reason after none: needs at least 12 characters$/m);
  assert.match(r.stdout, /^REFUSED: J2 — the reason after not: needs at least 12 characters$/m);
  assert.equal(fs.readFileSync(f.list, 'utf8'), before);
  // Two --set options, S and J lines.
  r = run(['--close', f.list, '--set', 's1, S2=none: another form with its own focus rule', '--set', 'J1,J2=reuse', '--set', 'S3=P2']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^CLOSED: 5 line\(s\) written to /m);
  assert.match(r.stdout, /^SIBLINGS: 3 found, 0 open$/m);
  assert.match(r.stdout, /^SAME JOB: 2 found, 0 open$/m);
  const after = fs.readFileSync(f.list, 'utf8');
  assert.deepEqual(sLines(f.list).map((l) => l.split(' → ')[1]), ['none: another form with its own focus rule', 'none: another form with its own focus rule', 'P2']);
  assert.equal(after.split('\n').filter((l) => /^J\d .* → reuse$/.test(l)).length, 2);
  assert.equal(after.replace(/ → .*$/gm, ' → '), before.replace(/ → .*$/gm, ' → '), 'only the outcomes changed');
  assert.equal(run(['--check', f.list, '--places', f.places]).status, 0);
  // Usage errors: a number that is not on the list, a line set twice, no --set, --set without --close.
  for (const [args, why] of [
    [['--close', f.list, '--set', 'S9=none: another form with its own rule'], /S9 is not on the list/],
    [['--close', f.list, '--set', 'S1=none: another form here', '--set', 'S1=none: another form there'], /S1 is set twice/],
    [['--close', f.list, '--set', 'P1=none: another form with its own rule'], /names S and J lines by number/],
    [['--close', f.list], /--close needs at least one --set/],
    [['--check', f.list, '--set', 'S1=P2'], /--set goes with --close/],
  ]) {
    const u = run(args);
    assert.equal(u.status, 2, args.join(' ') + '\n' + u.stdout);
    assert.match(u.stderr, why);
  }
});

test('the instructions ask for at most three SAME JOB lines, the nearest first; SIBLING lines have no limit', async () => {
  const mod = await import(pathToFileURL(script).href);
  assert.match(mod.INSTRUCTIONS, /'SAME JOB: <file>:<line> · <what> — <how it does the job>', at most three, the nearest to this job first, or write the single line 'SAME JOB: none'/);
  assert.doesNotMatch(mod.INSTRUCTIONS, /SIBLING: [^']*', at most/);
  assert.equal(mod.lateChecksOn(root), true, 'the rule is on unless the owner sets it to false');
});

test('a report saved as UTF-16 or with CRLF is recorded with its per-line hashes', () => {
  for (const save of [(t) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(t, 'utf16le')]), (t) => Buffer.from(t.replace(/\n/g, '\r\n'), 'utf8')]) {
    const f = briefed('SIBLINGS: none\nSAME JOB: none\n');
    fs.writeFileSync(f.report, save('SIBLING: src/DatePicker.tsx:1 · DueDatePicker — the same focus rule\nSAME JOB: none\n'));
    const r = run(['--record', f.report, '--notes', f.notes]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(sLines(f.list).length, 1);
    assert.match(fs.readFileSync(f.list, 'utf8'), /^Lines: [0-9a-f]{10} [0-9a-f]{10}$/m);
  }
});

// 2026-11-22 (owner): the second look gives hints and never picks the design. A timed test showed a locked design
// pick made the fix narrower than a plain session's. The author closes any J line "reuse" or "not: <why>", with no
// owner words; the reviewer sees each reason. The author's own design (design.md) goes into the brief to be checked.
const HINTS = 'SIBLINGS: none\n' +
  'SAME JOB: src/outbox/EmailOutbox.ts:12 · EmailOutbox — a table row in the same save, sent later by a worker\n' +
  'SAME JOB: src/ms/MicrosoftIdentityChanges.ts:40 · MicrosoftIdentityChanges — queued identity changes, one worker drains them\n';

test('hints: the brief asks for no design pick, and a report with SAME JOB lines and no BEST DESIGN line records', () => {
  const f = briefed(HINTS);
  const brief = fs.readFileSync(path.join(f.notes, 'siblings-brief.md'), 'utf8');
  assert.doesNotMatch(brief, /BEST DESIGN/);
  assert.match(brief, /you do not choose the design/);
  const r = run(['--record', f.report, '--notes', f.notes]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(fs.readFileSync(f.list, 'utf8'), /BEST DESIGN/);
  assert.match(r.stdout, /^SAME JOB: 2 found — hints for the design: write reuse or not: <why> after each \(the reviewer sees the reason\)/m);
});

test('hints: a BEST DESIGN line in an older report or list is passed over, in any shape', () => {
  for (const line of ['BEST DESIGN: J2 — one worker drains every change', '**BEST DESIGN:** **J2** — x', 'BEST DESIGN — J2: wrong shape', 'BEST DESIGN: J9 — no such line']) {
    const f = briefed(HINTS + line + '\n' + line + '\n');
    const r = run(['--record', f.report, '--notes', f.notes]);
    assert.equal(r.status, 0, line + '\n' + r.stdout + r.stderr);
    assert.doesNotMatch(fs.readFileSync(f.list, 'utf8'), /BEST DESIGN/, line);
  }
});

test('hints: any J line closes "not: <why>" with no owner words, also one an older list marked BEST DESIGN', () => {
  const f = briefed(HINTS);
  assert.equal(run(['--record', f.report, '--notes', f.notes]).status, 0);
  // A list of the release before carried the pick and locked that J.
  fs.writeFileSync(f.list, fs.readFileSync(f.list, 'utf8').replace(/(J2 · [^\n]*\n)/, '$1\nBEST DESIGN: J2 — one worker drains every change\n'));
  const why = 'not: it sends to Microsoft Graph, a different system with its own ordering';
  let r = run(['--close', f.list, '--set', 'J1=reuse', '--set', 'J2=' + why]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^SAME JOB: 2 found, 0 open$/m);
  const c = run(['--check', f.list]);
  assert.equal(c.status, 0, c.stdout + c.stderr);
  // A reason too short to tell the reviewer anything is still refused.
  r = run(['--close', f.list, '--set', 'J1=not: no']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^REFUSED: J1 — the reason after not: needs at least \d+ characters/m);
});

test('hints: the author\'s design note (design.md) goes into the brief for the gap check', () => {
  const f = fixture();
  // A design line shaped like a check line ("- C1. …") must not be read back as one when the report is recorded.
  fs.writeFileSync(path.join(f.notes, 'design.md'), 'Page the roster on the server; keep the add list from offering members.\n- C1. a line that only looks like a check line\n');
  const b = run(['--brief', '--notes', f.notes, '--repo', f.repo]);
  assert.equal(b.status, 0, b.stdout + b.stderr);
  const brief = fs.readFileSync(path.join(f.notes, 'siblings-brief.md'), 'utf8');
  // 2026-11-28 (batch c task 4): the heading asks the second look to judge the design, with one instruction line.
  assert.match(brief, /^## The author's design \(design\.md\) — judge it before any code\n\nJudge this design [^\n]*Check it for gaps and missed places too\.\n\n {4}Page the roster on the server; keep the add list from offering members\.\n {4}- C1\. a line that only looks like a check line$/m);
  const report = path.join(f.notes, 'siblings-report.md');
  fs.writeFileSync(report, 'SIBLINGS: none\nSAME JOB: none\n');
  const rec = run(['--record', report, '--notes', f.notes]);
  assert.equal(rec.status, 0, rec.stdout + rec.stderr);
  const g = fixture();
  assert.equal(run(['--brief', '--notes', g.notes, '--repo', g.repo]).status, 0);
  assert.doesNotMatch(fs.readFileSync(path.join(g.notes, 'siblings-brief.md'), 'utf8'), /^## The author's design/m);
});
