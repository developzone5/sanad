// reviewer-test.mjs (2026-11-25, owner batch x task 1): the reviewer cases, the scorer and the report. No model runs
// here: every reply below is written by the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  answerProblems, scoreReview, scorePlace, scoreNotes, reportText, refsOf, sameFile, launchSection, checkCase, caseNames,
  add, prepare, CASES, FAMILIES, JOBS, stepIds, checklistNames, noteOrder,
} from '../scripts/reviewer-test.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'reviewer-test.mjs');
const roots = [];
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); roots.push(d); return d; };
test.after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true });

const answer = {
  family: 'shared-value',
  faults: [
    { id: 'F1', family: 'shared-value', file: 'web/src/pages/SettingsPage.tsx', lines: [455, 459], grade: 'bug', place: true, wrong: 'The badge prints the raw English role.' },
    { id: 'F2', family: 'language', file: 'web/src/components/Topbar.tsx', lines: [213, 214], grade: 'bug', wrong: 'The logo label stays English on an Arabic page.' },
  ],
  notes: [
    { kind: 'Bug', true: true, text: 'web/src/pages/SettingsPage.tsx:458 — Arabic page → raw role — use the helper' },
    { kind: 'Bug', true: false, text: 'web/src/components/Topbar.tsx:199 — a capital role key → no word — lower-case it' },
  ],
};

test('an answer file is checked: family, each fault field, one true and one false note', () => {
  assert.deepEqual(answerProblems(answer), []);
  assert.match(answerProblems({ ...answer, family: 'other' }).join('\n'), /family "other" is not one of/);
  assert.match(answerProblems({ ...answer, faults: [] }).join('\n'), /no fault yet/);
  assert.match(answerProblems({ family: 'clean', faults: [answer.faults[0]] }).join('\n'), /a clean case has no fault/);
  assert.deepEqual(answerProblems({ family: 'clean', faults: [] }), []);
  const bad = { ...answer, faults: [{ ...answer.faults[0], lines: [9, 3], grade: 'minor', file: 'C:\\x.ts' }] };
  const text = answerProblems(bad).join('\n');
  assert.match(text, /lines is \[from, to\]/);
  assert.match(text, /grade is one of blocker, bug, gap/);
  assert.match(text, /file is a repository path/);
  assert.match(answerProblems({ ...answer, notes: [answer.notes[0], answer.notes[0]] }).join('\n'), /one true note and one false note/);
  assert.match(answerProblems({ ...answer, faults: [answer.faults[1]] }).join('\n'), /no fault of the case's own family shared-value/);
});

test('file:line references are read in the shapes reviewers write', () => {
  assert.deepEqual(refsOf('Bug — `web/src/a.tsx:12` — x'), [{ file: 'web/src/a.tsx', from: 12, to: 12 }]);
  assert.deepEqual(refsOf('b.cs:12-18 and c.ts lines 3–5 and d.ts#L7'), [
    { file: 'b.cs', from: 12, to: 18 }, { file: 'c.ts', from: 3, to: 5 }, { file: 'd.ts', from: 7, to: 7 }]);
  assert.ok(sameFile('src/pages/SettingsPage.tsx', 'web/src/pages/SettingsPage.tsx'));
  assert.ok(!sameFile('Page.tsx', 'web/src/pages/SettingsPage.tsx'));
});

test('a review reply: a note on a fault catches it, also in a file the change did not touch; other notes are false; Questions and EXTRA TEST count neither way', () => {
  const reply = [
    'RECOMMEND: FAIL',
    'Bug (USERS FOUND BY SEARCH) — src/pages/SettingsPage.tsx:457 — an Arabic page → raw English role — use getRoleLabel',
    'Gap — web/src/components/Topbar.tsx:90 — nothing → wrong — fix',
    'Question — web/src/components/Topbar.tsx:213 — is the logo text part of the ticket?',
    'EXTRA TEST: web/src/components/Topbar.tsx:213 — the logo label in Arabic',
    'Bug: none.',
  ].join('\n');
  const r = scoreReview(answer, reply);
  assert.deepEqual(r.caught, ['F1']);
  assert.deepEqual(r.missed, ['F2']);
  assert.equal(r.falseNotes.length, 1);
  assert.match(r.falseNotes[0], /^Gap — web\/src\/components\/Topbar\.tsx:90/);
  assert.match(r.caughtLines[0], /^F1: Bug \(USERS FOUND BY SEARCH\) — src\/pages\/SettingsPage\.tsx:457/);
  assert.deepEqual(r.families, { 'shared-value': { caught: 1, total: 1 }, language: { caught: 0, total: 1 } });
  assert.deepEqual(scoreReview(answer, reply), r, 'the same input gives the same result');
});

test('a line outside the margin is a false note; the margin of the answer file widens it', () => {
  const reply = 'Bug — web/src/components/Topbar.tsx:220 — x → y — z';
  assert.deepEqual(scoreReview(answer, reply).caught, []);
  assert.deepEqual(scoreReview({ ...answer, margin: 6 }, reply).caught, ['F2']);
});

test('a clean case: every counted note is a false note, and no note is a clean pass', () => {
  const clean = { family: 'clean', faults: [] };
  assert.equal(scoreReview(clean, 'RECOMMEND: PASS\nno findings').falseNotes.length, 0);
  assert.equal(scoreReview(clean, 'Bug — src/a.cs:3 — x → y — z\nGap — src/a.cs:9 — a → b — c').falseNotes.length, 2);
});

test('the second look is caught when a SIBLING line names the place the change should have reached', () => {
  const caught = scorePlace(answer, 'SIBLING: web/src/pages/SettingsPage.tsx:458 · role badges — raw role\nSAME JOB: none');
  assert.deepEqual(caught.caught, ['F1']);
  assert.equal(caught.graded, 1, 'only faults marked place are graded');
  assert.deepEqual(scorePlace(answer, 'SIBLINGS: none\nSAME JOB: none').missed, ['F1']);
  assert.deepEqual(scorePlace(answer, 'The settings page SettingsPage.tsx also prints the role.').caught, [], 'prose is no SIBLING line');
  // Review round: a base name alone is no path (another SettingsPage.tsx), and the second look has no false notes to count.
  assert.deepEqual(scorePlace(answer, 'SIBLING: SettingsPage.tsx:458 · badges — raw role').caught, []);
  assert.deepEqual(scorePlace(answer, 'SIBLING: admin/src/pages/SettingsPage.tsx:458 · badges — raw role').caught, []);
  assert.equal(caught.falseNotes, null);
  assert.match(reportText([{ job: 'second-look', families: { 'shared-value': { caught: 1, total: 1 } }, falseNotes: null }]), /\| second-look · second-look \| [^|]+ \| 1\/1 \| – \|/);
});

test('the note check keeps the true note and drops the false one; the reverse is a miss and a false note', () => {
  const good = scoreNotes(answer, 'BRIEF 1a2b3c4d g1\nCONFIRMED K1 — web/src/pages/SettingsPage.tsx:458 prints role\nREFUTED K2 — web/src/components/Topbar.tsx:199 lower-cases first');
  assert.deepEqual([good.caught.length, good.missed.length, good.falseNotes.length], [1, 0, 0]);
  const bad = scoreNotes(answer, 'BRIEF 1a2b3c4d g1\n- **REFUTED** K1 — src/x.ts:1 guards it here\nUNSURE K2 — could not read');
  assert.deepEqual([bad.caught.length, bad.missed.length, bad.falseNotes.length], [0, 1, 1]);
  assert.match(bad.falseNotes[0], /^K2 UNSURE \(kept a false note\)/);
});

test('a note-check reply is read as note-check --record reads it: no BRIEF line or no verdict is no answer; a bare REFUTED keeps the note', () => {
  assert.deepEqual([scoreNotes(answer, '').caught.length, scoreNotes(answer, '').missed.length], [0, 1], 'an empty reply catches nothing');
  assert.match(scoreNotes(answer, 'CONFIRMED K1 — web/src/pages/SettingsPage.tsx:458 x').note, /no BRIEF line/);
  const bare = scoreNotes(answer, 'BRIEF 1a2b3c4d g1\nCONFIRMED K1 — web/src/pages/SettingsPage.tsx:458 prints role\nREFUTED K2');
  assert.equal(bare.falseNotes.length, 1, 'REFUTED with no file:line evidence keeps the false note');
});

test('the true note goes first or second by the case name, and prepare and score use the same order', () => {
  const two = [{ true: true }, { true: false }];
  const firsts = ['a-case', 'b-case', 'c-case', 'd-case', 'e-case', 'f-case'].map((n) => noteOrder(n, two)[0].true);
  assert.ok(firsts.includes(true) && firsts.includes(false), 'both orders occur');
  const name = ['a-case', 'b-case', 'c-case', 'd-case'].find((n) => noteOrder(n, two)[0].true === false);
  const r = scoreNotes(answer, 'BRIEF 1a2b3c4d g1\nREFUTED K1 — web/src/components/Topbar.tsx:199 lower-cases it first\nCONFIRMED K2 — web/src/pages/SettingsPage.tsx:458 x', name);
  assert.deepEqual([r.caught.length, r.falseNotes.length], [1, 0], 'K2 is the true note for this name');
  const set = caseNames().map((n) => JSON.parse(fs.readFileSync(path.join(CASES, n, 'answer.json'), 'utf8'))).filter((a) => a.notes);
  assert.ok(set.length >= 12, `${set.length} cases have a note pair`);
});

test('a hygiene line, a place in the also: tail, or a note without the fault\'s words is no catch; one note catches one fault', () => {
  const a = { family: 'access', faults: [
    { id: 'F1', family: 'access', file: 'src/A.cs', lines: [10, 12], grade: 'blocker', wrong: 'any teacher archives any class' },
    { id: 'F2', family: 'crash', file: 'src/A.cs', lines: [11, 11], grade: 'bug', wrong: 'a missing roles field crashes', words: ['undefined', 'crash'] },
  ] };
  assert.deepEqual(scoreReview(a, 'Gap (HYGIENE) — src/A.cs:11 — the name x is short — fix cost: rename').caught, []);
  assert.equal(scoreReview(a, 'Gap (HYGIENE) — src/A.cs:11 — the name x is short — fix cost: rename').falseNotes.length, 0);
  assert.deepEqual(scoreReview(a, 'Bug — src/B.cs:3 — x → y — z — kind: role check; also: src/A.cs:11').caught, [], 'the also: tail names other places');
  const one = scoreReview(a, 'Blocker — src/A.cs:11 — a teacher posts archive → archived — add the role check');
  assert.deepEqual(one.caught, ['F1'], 'F2 needs one of its words');
  const both = scoreReview(a, 'Blocker — src/A.cs:11 — a teacher posts archive → archived — add the role check\nBug — src/A.cs:11 — a session with no roles → undefined → crash — guard it');
  assert.deepEqual(both.caught.sort(), ['F1', 'F2']);
  // the real case: the round-one false note names Topbar.tsx:199, near three faults, and catches none of them
  const r1 = JSON.parse(fs.readFileSync(path.join(CASES, 'bench4-round1', 'answer.json'), 'utf8'));
  const wrong = r1.notes.find((x) => !x.true);
  const s = scoreReview(r1, `${wrong.kind} — ${wrong.text}`);
  assert.deepEqual([s.caught, s.falseNotes.length], [[], 1]);
});

test('check fails when the case folder is empty or missing: nothing checked is no pass', () => {
  const r = run('check', '--cases', tmp('rt-none-'));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /BAD: no case in/);
});

test('the report: one row per seat job with its model, caught of total per family, false notes and minutes', () => {
  const home = tmp('rt-home-');
  fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'agents', 'independent-reviewer.md'), '---\nname: independent-reviewer\nmodel: opus\neffort: xhigh\n---\n');
  const rows = [
    { job: 'fresh-claude', families: { 'shared-value': { caught: 1, total: 1 }, language: { caught: 0, total: 1 } }, falseNotes: ['a'], minutes: 4 },
    { job: 'fresh-claude', families: { access: { caught: 1, total: 1 } }, falseNotes: [], minutes: 6 },
    { job: 'whole-codex', families: { access: { caught: 0, total: 1 } }, falseNotes: ['b', 'c'] },
  ];
  const text = reportText(rows, { home });
  assert.match(text, /^\| seat · job \| model\/effort \| access \| shared-value \| language \| false notes \| min\/review \|/);
  assert.match(text, /\| independent-reviewer · fresh-claude \| opus\/xhigh \| 1\/1 \| 1\/1 \| 0\/1 \| 1 \| 5\.0 \|/);
  assert.match(text, /\| sanad-reviewer · whole-codex \| \? \| 0\/1 \| – \| – \| 2 \| – \|/);
});

test('a launch.md section is cut at the next heading', () => {
  const text = '# Launch\n\n## Fresh eyes (Claude) — Agent independent-reviewer, run_in_background\n\nYou are the independent reviewer — FRESH EYES.\n\n## Whole diff (Claude) — Agent routine-reviewer\n\nother';
  assert.equal(launchSection(text, JOBS['fresh-claude'].heading), 'You are the independent reviewer — FRESH EYES.');
  assert.equal(launchSection(text, JOBS['risk-claude'].heading), '');
});

test('the case set: at least 14 cases, every family, two clean cases, every case well formed and its patches apply', () => {
  const names = caseNames();
  assert.ok(names.length >= 14, `${names.length} cases`);
  const families = new Set();
  let clean = 0;
  for (const n of names) {
    assert.deepEqual(checkCase(n), [], n);
    const a = JSON.parse(fs.readFileSync(path.join(CASES, n, 'answer.json'), 'utf8'));
    if (a.family === 'clean') clean++;
    for (const f of a.faults) families.add(f.family);
  }
  assert.ok(clean >= 2, 'two cases with no bug');
  for (const f of FAMILIES.filter((x) => x !== 'clean' && x !== 'other')) assert.ok(families.has(f), `a case for ${f}`);
});

test('prepare builds the throwaway repository and one launch per seat job from the live tools; the answer never enters it', () => {
  const work = tmp('rt-prepare-');
  const r = prepare('planted-swallowed-error-grade', { work });
  const jobs = r.seats.map((s) => s.job).sort();
  assert.deepEqual(jobs, ['fresh-claude', 'fresh-codex', 'note-check', 'recheck', 'risk-claude', 'risk-codex', 'whole-claude', 'whole-codex']);
  for (const s of r.seats) assert.ok(fs.readFileSync(s.launch, 'utf8').trim().length > 40, s.job);
  assert.match(fs.readFileSync(r.seats.find((s) => s.job === 'fresh-claude').launch, 'utf8'), /^You are the independent reviewer — FRESH EYES/);
  assert.match(fs.readFileSync(r.seats.find((s) => s.job === 'recheck').launch, 'utf8'), /re-check/);
  const all = execFileSync('git', ['-C', r.repo, 'ls-files'], { encoding: 'utf8' });
  assert.doesNotMatch(all, /answer\.json|case\.json|ticket\.md/);
  assert.equal(execFileSync('git', ['-C', r.repo, 'rev-list', '--count', 'main..HEAD'], { encoding: 'utf8' }).trim(), '2', 'round 1 and the fix');
  const brief = fs.readFileSync(path.join(work, 'notes', 'claude', 'brief-fresh.md'), 'utf8');
  assert.match(brief, /A teacher enters a grade from 0 to 100/);
  assert.doesNotMatch(brief, /swallowed|planted/i);
  // Review round: nothing under the seat's work folder names the case, and the launch texts, seats.json and the
  // replies live in the control folder beside it.
  roots.push(work + '-control');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === '.git' ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]));
  for (const f of walk(work)) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /planted-|swallowed-error/, f);
  assert.ok(fs.existsSync(path.join(work + '-control', 'seats.json')));
  assert.ok(!fs.existsSync(path.join(work, 'seats.json')));
  for (const s of r.seats) assert.ok(!s.launch.startsWith(work.replace(/\\/g, '/') + '/'), s.launch);
  const codex = r.seats.find((s) => s.job === 'fresh-codex');
  assert.ok(fs.readFileSync(codex.launch, 'utf8').includes(`-o "${codex.reply}"`), 'a Codex reply is where its launch writes it');
});

test('add makes a case from a real change: the files at the base, the --also files, the patch, an empty answer the check refuses', () => {
  const repo = tmp('rt-src-');
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t.t', '-c', 'core.autocrlf=false', ...a], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(repo, 'src', 'b.ts'), 'export const b = 2;\n');
  git('add', 'src/a.ts', 'src/b.ts');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 3;\n');
  fs.writeFileSync(path.join(repo, 'src', 'c.ts'), 'export const c = 4;\n');
  git('add', 'src/a.ts', 'src/c.ts');
  git('commit', '-q', '-m', 'change');
  const ticket = path.join(repo, '..', path.basename(repo) + '-ticket.md');
  fs.writeFileSync(ticket, 'T-1 a is three\n');
  roots.push(ticket);
  const cases = tmp('rt-cases-');
  const r = add({ from: `${base}..HEAD`, ticket, name: 'my-case', step: 'review', checklist: 'TESTS CAN FAIL', repo, cases, also: ['src/b.ts'] });
  assert.equal(r.files, 2);
  assert.equal(fs.readFileSync(path.join(cases, 'my-case', 'before', 'src', 'a.ts'), 'utf8'), 'export const a = 1;\n');
  assert.equal(fs.readFileSync(path.join(cases, 'my-case', 'before', 'src', 'b.ts'), 'utf8'), 'export const b = 2;\n');
  assert.ok(!fs.existsSync(path.join(cases, 'my-case', 'before', 'src', 'c.ts')), 'a file the change adds is not in before/');
  const a = JSON.parse(fs.readFileSync(path.join(cases, 'my-case', 'answer.json'), 'utf8'));
  assert.deepEqual([a.step, a.checklist, a.faults.length], ['review', 'TESTS CAN FAIL', 0]);
  assert.match(checkCase('my-case', cases).join('\n'), /no fault yet/);
  assert.throws(() => add({ from: `${base}..HEAD`, ticket, name: 'other', step: 'nope', checklist: 'TESTS CAN FAIL', repo, cases }), /--step is one of/);
  assert.throws(() => add({ from: `${base}..HEAD`, ticket, name: 'other', step: 'review', checklist: 'NEW LINE', repo, cases }), /--checklist is one of the review checklist's lines/);
  assert.throws(() => add({ from: `${base}..HEAD`, ticket, name: 'my-case', step: 'review', checklist: 'TESTS CAN FAIL', repo, cases }), /exists already/);
  assert.ok(stepIds().includes('review') && checklistNames().includes('USERS FOUND BY SEARCH'));
});

test('the command line: score writes the result, report reads it, add needs the Sanad repository', () => {
  const results = tmp('rt-results-');
  const reply = path.join(results, 'reply.md');
  fs.writeFileSync(reply, 'RECOMMEND: FAIL\nBug — src/Application/Grades/GradeService.cs:37 — DbUpdateException → 204 and Grade saved — rethrow\n');
  const s = run('score', 'planted-swallowed-error-grade', reply, '--job', 'fresh-claude', '--minutes', '3.5', '--results', results);
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /^CAUGHT F1: Bug — src\/Application\/Grades\/GradeService\.cs:37/m);
  assert.match(s.stdout, /SCORE planted-swallowed-error-grade · fresh-claude: 1 caught, 0 missed, 0 false/);
  const saved = JSON.parse(fs.readFileSync(path.join(results, 'fresh-claude', 'planted-swallowed-error-grade.json'), 'utf8'));
  assert.equal(saved.minutes, 3.5);
  const rep = run('report', '--results', results);
  assert.equal(rep.status, 0, rep.stderr);
  assert.match(rep.stdout, /\| independent-reviewer · fresh-claude \| [^|]+ \| 1\/1 \| 0 \| 3\.5 \|/);
  assert.equal(run('score', 'planted-swallowed-error-grade', reply, '--job', 'nope').status, 2);
  const noRepo = run('add', '--from', 'a..b', '--ticket', reply, '--name', 'x-y', '--step', 'review', '--checklist', 'TESTS CAN FAIL');
  assert.equal(noRepo.status, 2);
  assert.match(noRepo.stderr, /add writes into the Sanad repository: give --sanad <path>/);
});
