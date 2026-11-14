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
import { fileURLToPath } from 'node:url';

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const script = path.join(scripts, 'siblings.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siblings-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true });
const slash = (p) => p.replace(/\\/g, '/');
// A folder's real name: on CI the temp folder is RUNNER~1 to Node and runneradmin to git (2026-11-13).
const real = (p) => fs.realpathSync.native(p).toLowerCase();
const sLines = (file) => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => /^S\d/.test(l));

const INSTRUCTIONS = "Before any code. Read the ticket lines and the places, then the code at each place and around it. Name every OTHER place that applies the same rule or has the same defect and is not on the list: another field, another screen or role, another entry point (create, edit, publish, import, a job), an API field, an export. Answer only with lines 'SIBLING: <file>:<line> · <function or field> — <why it is the same rule>' or the single line 'SIBLINGS: none'. About 3 minutes; do not edit.";

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

// A notes folder whose brief was written, with the agent's report saved as `text`.
function briefed(text) {
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
  fs.writeFileSync(report, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('SIBLING: the rich-text description editor - same focus defect on save → publish\r\n', 'utf16le')]));
  const r = run(['--record', report, '--notes', f.notes]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(sLines(path.join(f.notes, 'siblings.md')), ['S1 · the rich-text description editor - same focus defect on save -> publish → ']);
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
  fs.writeFileSync(bare, 'SIBLINGS: none\n');
  assert.equal(run(['--check', bare, '--places', places]).status, 0);
  fs.writeFileSync(places, '# notes\n');
  assert.equal(run(['--check', bare, '--places', places]).status, 2, '--places must be a places list');
  assert.equal(run(['--places', places]).status, 2, 'no mode given');
  assert.equal(run(['--record', bare]).status, 2, '--record needs --notes');
});
