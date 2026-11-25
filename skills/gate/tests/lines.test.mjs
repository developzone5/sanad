import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ticketLines, renderLines } from '../scripts/lines.mjs';
import { readLines } from '../scripts/check-ticket-lines.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'lines.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lines-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true });

// 2026-11-13: the lines file was typed by hand at the start of every task.
test('every non-empty ticket line becomes T<n>, words untouched; heading and bullet marks are dropped', () => {
  const text = '## Steps\r\n- Open the exam.\n\n  * Wait for Part 1 to end.  \nExpected: "Part 1 ended, moved to Part 2."\n• انتهى وقت الجزء الأول\n';
  assert.deepEqual(ticketLines(text), ['Steps', 'Open the exam.', 'Wait for Part 1 to end.', 'Expected: "Part 1 ended, moved to Part 2."', 'انتهى وقت الجزء الأول']);
  const file = renderLines(ticketLines(text), { date: new Date('2026-11-13T10:00:00Z') });
  assert.match(file, /^# Lines \(the ticket, verbatim, 2026-11-13\)\n\nT1\. Steps\nT2\. Open the exam\.\n/);
  // The checks read it back as the same lines.
  assert.deepEqual(readLines(file).slice(0, 2), ['T1: Steps', 'T2: Open the exam.']);
  assert.match(renderLines(['x'], { noTicket: true }), /^# Lines \(no ticket: the user's own words, /);
});

test('the command writes lines.md and ticket.md beside it; a missing or empty file is a usage error', () => {
  const from = path.join(root, 'ticket.txt');
  fs.writeFileSync(from, 'Title line\n\nExpected: once\n');
  const out = path.join(root, 'notes', 'lines.md');
  const r = run(['--from', from, '--out', out]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^LINES: 2 line\(s\) T1\.\.T2 — /);
  assert.match(fs.readFileSync(out, 'utf8'), /^T2\. Expected: once$/m);
  assert.equal(fs.readFileSync(path.join(root, 'notes', 'ticket.md'), 'utf8'), 'Title line\n\nExpected: once\n');
  assert.equal(run(['--from', path.join(root, 'none.txt'), '--out', out]).status, 2);
  fs.writeFileSync(path.join(root, 'blank.txt'), '\n  \n');
  assert.equal(run(['--from', path.join(root, 'blank.txt'), '--out', out]).status, 2);
  assert.equal(run(['--from', from, '--out', out, '--no-ticket']).status, 2, '--no-ticket needs --repo');
});

test('a ticket text with no ticket ID prints the --no-ticket command; with an ID or with --no-ticket it does not', () => {
  const dir = fs.mkdtempSync(path.join(root, 'noid-'));
  const out = path.join(dir, 'lines.md');
  const from = path.join(dir, 't.txt');
  fs.writeFileSync(from, 'Show the due date in the list\n');
  let r = run(['--from', from, '--out', out]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^NOTE: no ticket ID in the text — if this task has no ticket, run: node .*lines\.mjs --from .*t\.txt --out .*lines\.md --no-ticket --repo <the repository>$/m);
  assert.ok(fs.existsSync(out));
  r = run(['--from', from, '--out', out, '--repo', '/some/repo']);
  assert.match(r.stdout, /--no-ticket --repo \/some\/repo$/m);
  fs.writeFileSync(from, 'TUW-243 show the due date\n');
  assert.doesNotMatch(run(['--from', from, '--out', out]).stdout, /no ticket ID/);
});

// 2026-11-19: a line the user dropped was cut out by hand and every later line got a new number.
import { dropLine, seedCheck } from '../scripts/lines.mjs';
import { droppedLines } from '../scripts/check-ticket-lines.mjs';

const THREE = '# Lines (the ticket, verbatim, 2026-11-19)\r\n\r\nT1. The list shows every subject.\r\nT2. Drafts stay hidden.\r\nT3. A late hand-in is marked late.\r\n';

test("--drop T2 with the user's words keeps T3 as T3 and changes no other byte of the file", () => {
  const file = path.join(fs.mkdtempSync(path.join(root, 'drop-')), 'lines.md');
  fs.writeFileSync(file, THREE);
  const r = run(['--drop', 'T2', '--words', 'leave the drafts rule for now', '--out', file]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^LINES: T2 dropped by the user: "leave the drafts rule for now" — .*no line has a new number\n$/);
  const after = fs.readFileSync(file, 'utf8');
  assert.equal(after, THREE.replace('T2. Drafts stay hidden.', 'T2. [dropped by the user: "leave the drafts rule for now"] Drafts stay hidden.'));
  assert.deepEqual(readLines(after).map((l) => l.slice(0, 3)), ['T1:', 'T2:', 'T3:']);
  assert.equal(readLines(after)[2], 'T3: A late hand-in is marked late.');
  assert.deepEqual(droppedLines(after), [2]);
});

test('--drop is refused with no words, with words under 8 characters, twice, for a number that is not there, and for the last line left', () => {
  const file = path.join(fs.mkdtempSync(path.join(root, 'drop-')), 'lines.md');
  fs.writeFileSync(file, THREE);
  for (const [args, why] of [
    [['--drop', 'T2', '--out', file], /--words "<the user's words>" \(at least 8 characters\)/],
    [['--drop', 'T2', '--words', 'skip it', '--out', file], /at least 8 characters/],
    [['--drop', 'T2', '--words', '   a   b  ', '--out', file], /at least 8 characters/],
    [['--drop', 'T9', '--words', 'leave it for later', '--out', file], /T9 is not in the lines file \(it has T1\.\.T3\)/],
    [['--drop', '2', '--words', 'leave it for later', '--out', file], /--drop needs one line number/],
  ]) {
    const r = run(args);
    assert.equal(r.status, 2, args.join(' ') + '\n' + r.stdout);
    assert.match(r.stderr, why);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), THREE, 'a refused drop writes nothing');
  assert.equal(run(['--drop', 'T2', '--words', 'leave it for later', '--out', file]).status, 0);
  const twice = run(['--drop', 't2', '--words', 'leave it for later', '--out', file]);
  assert.equal(twice.status, 2);
  assert.match(twice.stderr, /T2 is dropped already/);
  assert.equal(run(['--drop', 'T1', '--words', 'leave it for later', '--notes', path.dirname(file)]).status, 0, '--notes names the folder of lines.md');
  const last = run(['--drop', 'T3', '--words', 'leave it for later', '--out', file]);
  assert.equal(last.status, 2);
  assert.match(last.stderr, /T3 is the last ticket line left/);
  assert.deepEqual(droppedLines(fs.readFileSync(file, 'utf8')), [1, 2]);
});

test('--drop refuses a file whose numbers are not in order, and words that would end the mark early stay inside it', () => {
  assert.throws(() => dropLine('T1. one line here\nT3. another line here\n', 'T2', 'leave it for later'), /does not start with "T2\."/);
  const d = dropLine('T1. one line here\nT2. another line here\n', 'T1', 'he said "no"] to this one');
  assert.deepEqual(droppedLines(d.text), [1]);
  assert.equal(readLines(d.text)[1], 'T2: another line here');
});

test('--seed-check writes one [Tn] line per ticket line that is not dropped and never overwrites a check file', () => {
  const dir = fs.mkdtempSync(path.join(root, 'seed-'));
  const file = path.join(dir, 'lines.md'), check = path.join(dir, 'check.md');
  fs.writeFileSync(file, dropLine(THREE, 'T2', 'leave the drafts rule for now').text);
  const r = run(['--seed-check', check]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^CHECK LINES: 2 seeded \(T1, T3\) — /);
  const text = fs.readFileSync(check, 'utf8');
  assert.deepEqual(text.split('\n').filter((l) => l.startsWith('- ')), ['- [T1] The list shows every subject.', '- [T3] A late hand-in is marked late.']);
  fs.writeFileSync(check, '- [T1] my own line\n');
  const again = run(['--seed-check', check, '--out', file]);
  assert.equal(again.status, 2, again.stdout);
  assert.match(again.stderr, /check\.md exists: it is not overwritten/);
  assert.equal(fs.readFileSync(check, 'utf8'), '- [T1] my own line\n');
  assert.equal(run(['--seed-check', path.join(dir, 'none', 'check.md')]).status, 2, 'no lines file beside it');
  assert.equal(seedCheck('T1. only line here\n').count, 1);
});

test('--seed-check alone with --notes <dir> writes check.md of that folder (the form the printed step uses)', () => {
  const dir = fs.mkdtempSync(path.join(root, 'seed-notes-'));
  fs.writeFileSync(path.join(dir, 'lines.md'), THREE);
  const r = run(['--seed-check', '--notes', dir]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^CHECK LINES: 3 seeded \(T1, T2, T3\) — /);
  assert.equal(fs.readFileSync(path.join(dir, 'check.md'), 'utf8').split('\n').filter((l) => /^- \[T\d\] /.test(l)).length, 3);
  const again = run(['--seed-check', '--notes', dir]);
  assert.equal(again.status, 2);
  assert.match(again.stderr, /check\.md exists: it is not overwritten/);
  const none = run(['--seed-check']);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /give the lines file/);
  const drop = run(['--drop', 'T1', '--words', 'leave it for later']);
  assert.equal(drop.status, 2, 'a drop names its lines file');
  assert.match(drop.stderr, /give the lines file: --out <notes>\/lines\.md or --notes <dir>/);
});

// 2026-11-25 (owner, run 3): a ticket sentence wrapped over four lines became T2 to T4, each cut mid-sentence. The ticket is
// read as sentences, not line breaks. The run 3 ticket text, as it was saved:
const RUN3 = 'In the members window of a section (GroupMembersModal), only the first 50 students of the section are listed.\n'
  + 'A section with more than 50 students shows 50 rows while the header shows the full count, and student 51 and later\n'
  + 'can be reached only by typing in the search box. The window must let the admin see and manage every student of the\n'
  + 'section.\n';
test('a wrapped sentence is one line, and two sentences on one line are two lines (run 3)', () => {
  assert.deepEqual(ticketLines(RUN3), [
    'In the members window of a section (GroupMembersModal), only the first 50 students of the section are listed.',
    'A section with more than 50 students shows 50 rows while the header shows the full count, and student 51 and later can be reached only by typing in the search box.',
    'The window must let the admin see and manage every student of the section.']);
  // The lines file reads back as the same three lines, so a check line names T1..T3, each a whole sentence.
  assert.deepEqual(readLines(renderLines(ticketLines(RUN3))).map((l) => l.replace(/^T\d+: /, '')), ticketLines(RUN3));
});

test('a heading, a bullet, a numbered item, a table row and a blank line still end a line; a quote, an abbreviation and Arabic are read whole', () => {
  const text = '## Steps\n- Open the exam and wait\n  for Part 1 to end.\n1. Press Next\n2) Press Back\n| a | b |\n\n'
    + 'Expected: "Part 1 ended. Moved to Part 2." Then the timer stops.\nUse a short form, e.g. the code, for the name.\n'
    + 'Wait for the end, i.e. Part 2. Done means the list shows it.\nانتهى وقت الجزء الأول. يبدأ الجزء الثاني؟ نعم.\n';
  assert.deepEqual(ticketLines(text), ['Steps', 'Open the exam and wait for Part 1 to end.', '1. Press Next', '2) Press Back', '| a | b |',
    'Expected: "Part 1 ended. Moved to Part 2."', 'Then the timer stops.', 'Use a short form, e.g. the code, for the name.',
    'Wait for the end, i.e. Part 2.', 'Done means the list shows it.', 'انتهى وقت الجزء الأول.', 'يبدأ الجزء الثاني؟', 'نعم.']);
});

// 2026-11-25 (owner, test 4: a line of background had no check line and failed two checks): the plan shows it as
// "background, no check", and the owner's go on that plan is the words that drop it. No extra question.
test('--drop T<n> --go "<the owner\'s go>" drops a background sentence with the go quoted; the command prints how', () => {
  const dir = fs.mkdtempSync(path.join(root, 'background-'));
  const from = path.join(dir, 'ticket.txt');
  fs.writeFileSync(from, 'The role must show in the page language.\nEvery other word of the top bar is in Arabic, so this line looks broken.\n');
  const out = path.join(dir, 'lines.md');
  const made = run(['--from', from, '--out', out]);
  assert.equal(made.status, 0, made.stderr);
  assert.match(made.stdout, /^BACKGROUND: a sentence with nothing to prove goes in the plan as "T<n>: background, no check"; after the owner's go on that plan: node \S*lines\.mjs --drop T<n> --go "<the owner's go, quoted>" --out /m);
  const r = run(['--drop', 'T2', '--go', 'Go.', '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(out, 'utf8'), /^T2\. \[dropped by the user: "background, no check; the owner's go on the plan: Go\."\] Every other word/m);
  assert.deepEqual(droppedLines(fs.readFileSync(out, 'utf8')), [2], 'the ticket check reads it as dropped');
  assert.equal(run(['--drop', 'T1', '--go', '', '--out', out]).status, 2, 'an empty go is refused');
  const both = run(['--drop', 'T1', '--go', 'Go.', '--words', 'the owner said so', '--out', out]);
  assert.equal(both.status, 2);
  assert.match(both.stderr, /give --words or --go, not both/);
  // Review (2026-11-25): `--go "No."` closed a ticket line. A go must say yes.
  const no = run(['--drop', 'T1', '--go', 'No.', '--out', out]);
  assert.equal(no.status, 2);
  assert.match(no.stderr, /holds no go/);
  assert.doesNotMatch(fs.readFileSync(out, 'utf8'), /^T1\. \[dropped/m);
});

// Review (2026-11-25): a line that ends a sentence with a one-letter word or a short form ("Part A.", "etc.") merged with
// the next line; the old copy kept them apart.
// Install suite (2026-11-25): a title with no stop joined the next line ("Fix the title Expected: once").
test('a line with no stop joins the next one only when that line starts with a small letter', () => {
  assert.deepEqual(ticketLines('Fix the title\nExpected: once\n'), ['Fix the title', 'Expected: once']);
  assert.deepEqual(ticketLines('Members window\nshows 50 rows\nلا يظهر الدور\nبالعربية\n'), ['Members window shows 50 rows', 'لا يظهر الدور', 'بالعربية']);
});

test('a line that ends a sentence with a one-letter word or etc. still ends the line', () => {
  assert.deepEqual(ticketLines('The student finishes Part A.\nThe timer of Part B must start at once.\nList the roles, names, etc.\nThe page must sort them by name.\n'),
    ['The student finishes Part A.', 'The timer of Part B must start at once.', 'List the roles, names, etc.', 'The page must sort them by name.']);
});
