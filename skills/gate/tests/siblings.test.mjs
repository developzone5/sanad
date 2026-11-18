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

const INSTRUCTIONS = "Before any code. Read the ticket lines and the check lines first: they are the goal. Then the places, and the code at each place and around it. Name every OTHER place where the ticket's own rule or defect applies and that is not on the list: another field, another screen or role, another entry point (create, edit, publish, import, a job), an API field, an export. A place with a different problem, or one the ticket lines do not reach, is no sibling: write it as 'OUTSIDE PR: <file>:<line> — <what>', and the user decides it at the end. Then, separately: how does this repo already do the same KIND of job the ticket needs? Search by what the code does, not by the names above (for example 'send a change to another system after a save' → an outbox table and the worker that sends it; 'a list with filters' → the screen that already pages and filters). Name each one as 'SAME JOB: <file>:<line> · <what> — <how it does the job>', or write the single line 'SAME JOB: none' after searching. Answer only with lines 'SIBLING: <file>:<line> · <function or field> — <why it is the ticket's rule>', 'OUTSIDE PR:' lines and 'SAME JOB:' lines, or 'SIBLINGS: none' and 'SAME JOB: none'. About 4 minutes; do not edit.";

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
  assert.ok(launch[0].startsWith('LAUNCH: Agent braintrust-expert · prompt: Seat: Sibling check, before code. '), launch[0]);
  // Never a reviewer prompt: the stop and push hooks count one as a finished review (2026-11-14).
  assert.doesNotMatch(launch[0].replace(/^LAUNCH: Agent \S+ · prompt: /, ''), /^\s*You are the independent reviewer\b/i);
  assert.ok(launch[0].includes(slash(brief)), 'the prompt names the brief: ' + launch[0]);
  for (const other of ['lines.md', 'check.md', 'places.md', 'ticket.md']) assert.ok(!launch[0].includes(other), 'the prompt names no other notes file: ' + other);
  assert.ok(r.stdout.includes(`--record ${slash(path.join(notes, 'siblings-report.md'))} --notes ${slash(notes)}`), 'the next step is printed:\n' + r.stdout);
});

test('--brief refuses a notes folder that lacks one of its three sources, a file that is not a places list, and a missing --repo', () => {
  const { repo, notes, places } = fixture();
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
  assert.match(r.stdout, /^SAME JOB: 2 found — the design reuses each one, or says why not/m);
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
  assert.equal(openReason({ ...row, body: 'Schedule.cs:20 · Reschedule — same date rule' }, onePlace), '', 'a place in the same file closes it');
  assert.equal(openReason(row, undefined), '', 'without --places no P<n> is looked up, as before');

  const { repo, notes, places, report, list } = briefed(TWO + '\nSIBLING: the rich-text description editor - same focus defect on save\n');
  assert.equal(run(['--record', report, '--notes', notes]).status, 0);
  // P1 and P2 are in src/ChipGroup.tsx and P3 is in src/focus.ts: no sibling is in either file.
  fillS(list, { S1: 'P1', S2: 'P2, P3', S3: 'P1' });
  let r = run(['--check', list, '--places', places]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.deepEqual(openOf(r), [
    'OPEN: S1 · src/DatePicker.tsx:1 · DueDatePicker — P1 is in src/ChipGroup.tsx, not in src/DatePicker.tsx' + how,
    'OPEN: S2 · src/StudentList.tsx:1 · studentIds — P2, P3 are in src/ChipGroup.tsx, src/focus.ts, not in src/StudentList.tsx' + how,
  ], 'S3 names no file: any place on the list closes it, as before');
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
  const onePlace = { repo: 'C:/r', names: ['due'], places: [{ n: 1, mark: '', name: 'due', file: 'src/Forms/DatePicker.tsx', fn: '(file)', lines: '4', outcome: '' }] };
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
