// 2026-11-28 (owner, batch c task 4; run 3: the question that solved the problem at its root came after two rounds of
// patches). Promise: on Small and Medium the builder writes the design before any code (three lines and one way turned
// down); the second look gets it with the places list and judges it in one DESIGN line, kept as D1 for the builder's
// `follow` or `not: <why>`. A tiny change has no design step, a Big task keeps its two designers and the boss, and no
// guard reads the design lines.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { STEPS } from '../scripts/steps.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.join(here, '..', 'scripts');
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'design-before-code-')));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const run = (args) => spawnSync(process.execPath, [path.join(scripts, 'siblings.mjs'), ...args], { encoding: 'utf8', windowsHide: true });
const DESIGN = 'Load the first page only, then the next page on scroll.\nThe server pages with a stable order (id).\nThe page keeps the loaded rows.\nNOT: load the whole list once — it reads 40 000 rows for a page of 20.\n';

function notesFolder({ design = true } = {}) {
  const repo = fs.mkdtempSync(path.join(root, 'repo-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q'); git('config', 'user.name', 'F'); git('config', 'user.email', 'f@example.invalid'); git('config', 'core.autocrlf', 'false');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'feed.ts'), 'export function loadFeed() { return []; }\n');
  git('add', '-A'); git('commit', '-qm', 'base');
  const notes = fs.mkdtempSync(path.join(root, 'notes-'));
  fs.writeFileSync(path.join(notes, 'lines.md'), '# Lines\n\nT1. The feed shows the newest announcements first, 20 at a time.\n');
  fs.writeFileSync(path.join(notes, 'check.md'), '- [T1] the feed shows 20 rows, newest first\n');
  const made = spawnSync(process.execPath, [path.join(scripts, 'places.mjs'), '--repo', repo, '--names', 'loadFeed', '--out', path.join(notes, 'places.md')], { encoding: 'utf8', windowsHide: true });
  assert.equal(made.status, 0, made.stdout + made.stderr);
  if (design) fs.writeFileSync(path.join(notes, 'design.md'), DESIGN);
  return { repo, notes };
}

test('the second look gets the places list and the design together, and is asked to judge the design', () => {
  const f = notesFolder();
  const b = run(['--brief', '--notes', f.notes, '--repo', f.repo]);
  assert.equal(b.status, 0, b.stderr);
  const brief = fs.readFileSync(path.join(f.notes, 'siblings-brief.md'), 'utf8');
  assert.match(brief, /## Places already on the list \(places\.mjs\)[\s\S]*## The author's design \(design\.md\) — judge it before any code/);
  assert.match(brief, /`DESIGN: agree — <why>`, or, when the project already does the same kind of job in a better way, `DESIGN: better — <file>:<line> · <that way> — <why it is better here>`/);
  assert.match(brief, /^ {4}NOT: load the whole list once — it reads 40 000 rows for a page of 20\.$/m);
  assert.match(b.stdout, /and the DESIGN line when the brief holds the author's design/);
  const none = notesFolder({ design: false });
  const nb = run(['--brief', '--notes', none.notes, '--repo', none.repo]);
  assert.match(nb.stdout, /NOTE: no design\.md: on a small or medium task, write the design in three lines and one way you turned down/);
});

test('the DESIGN line is kept as D1 for the builder, keeps its answer when recorded again, and is printed', () => {
  const f = notesFolder();
  assert.equal(run(['--brief', '--notes', f.notes, '--repo', f.repo]).status, 0);
  const report = path.join(f.notes, 'siblings-report.md');
  fs.writeFileSync(report, 'SIBLINGS: none\nSAME JOB: none\n**DESIGN: better — src/feed.ts:1 · the keyset pager the reports screen uses — no deep offset**\n');
  const r = run(['--record', report, '--notes', f.notes]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ {2}D1 · better — src\/feed\.ts:1 · the keyset pager the reports screen uses — no deep offset →$/m);
  assert.match(r.stdout, /DESIGN: the second look judged your design — write follow or not: <why> after →/);
  const list = path.join(f.notes, 'siblings.md');
  assert.match(fs.readFileSync(list, 'utf8'), /## The second look's view of the design[^\n]*\n\nD1 · better — src\/feed\.ts:1 · the keyset pager the reports screen uses — no deep offset → \n/);
  fs.writeFileSync(list, fs.readFileSync(list, 'utf8').replace(/^(D1 · .*→).*$/m, '$1 follow'));
  assert.equal(run(['--record', report, '--notes', f.notes]).status, 0);
  assert.match(fs.readFileSync(list, 'utf8'), /^D1 · better — src\/feed\.ts:1 · .* → follow$/m, 'the answer stays');
  // The design line is no check: an open D line does not hold the list open.
  fs.writeFileSync(list, fs.readFileSync(list, 'utf8').replace(/^(D1 · .*→).*$/m, '$1 '));
  const check = run(['--check', list]);
  assert.equal(check.status, 0, check.stdout + check.stderr);
});

// 2026-11-28 (owner, notes 24 and 25): on Small and Medium the judgement is always given; on Big it is never asked.
test('a small or medium task cannot start the second look without design.md, and its answer must hold the DESIGN line', () => {
  for (const size of ['small', 'medium']) {
    const none = notesFolder({ design: false });
    fs.writeFileSync(path.join(none.notes, 'size.txt'), size + '\n');
    const refused = run(['--brief', '--notes', none.notes, '--repo', none.repo]);
    assert.equal(refused.status, 2, size + ': ' + refused.stdout + refused.stderr);
    assert.match(refused.stderr, new RegExp(`a ${size} task's second look judges the design: write .*design\\.md first`));
    const f = notesFolder();
    assert.equal(run(['--brief', '--notes', f.notes, '--repo', f.repo, '--size', size]).status, 0, size);
    const report = path.join(f.notes, 'siblings-report.md');
    fs.writeFileSync(report, 'SIBLINGS: none\nSAME JOB: none\n');
    const r = run(['--record', report, '--notes', f.notes]);
    assert.equal(r.status, 2, size + ': no DESIGN line is refused');
    assert.match(r.stderr, /has no DESIGN line, and the brief asked the second look to judge the design/);
    fs.writeFileSync(report, 'SIBLINGS: none\nSAME JOB: none\nDESIGN: agree — paging on the server is how the reports screen does it\n');
    assert.equal(run(['--record', report, '--notes', f.notes]).status, 0, size);
  }
});

test('a big task is never asked for the design judgement, even with a design.md', () => {
  for (const how of ['--size', 'size.txt', 'size.json']) {
    const f = notesFolder();
    if (how === 'size.txt') fs.writeFileSync(path.join(f.notes, 'size.txt'), 'small\n');
    if (how === 'size.json') fs.writeFileSync(path.join(f.notes, 'size.json'), JSON.stringify({ saved: 'big' }));
    if (how === 'size.txt') fs.writeFileSync(path.join(f.notes, 'size.json'), JSON.stringify({ saved: 'big' }));
    const b = run(['--brief', '--notes', f.notes, '--repo', f.repo, ...(how === '--size' ? ['--size', 'big'] : [])]);
    assert.equal(b.status, 0, how + ': ' + b.stderr);
    const brief = fs.readFileSync(path.join(f.notes, 'siblings-brief.md'), 'utf8');
    assert.doesNotMatch(brief, /^## The author's design|Judge this design/m, how);
    assert.doesNotMatch(b.stdout, /NOTE: no design\.md/, how);
    const report = path.join(f.notes, 'siblings-report.md');
    fs.writeFileSync(report, 'SIBLINGS: none\nSAME JOB: none\n');
    assert.equal(run(['--record', report, '--notes', f.notes]).status, 0, how + ': no DESIGN line needed');
  }
  const second = STEPS.find((s) => s.id === 'second-look');
  const c = { gate: 'G', repo: 'R', notes: 'N', base: 'origin/x', engine: 'claude', ticket: '', sides: [] };
  assert.match(second.lines(c, { lane: 'big', size: 'big', switches: {} })[0].text, / --size big$/);
  assert.doesNotMatch(second.lines(c, { lane: 'small', size: '', switches: {} }).map((l) => l.text).join('\n'), /--size/);
});

test('the printed steps ask for the design on Small and Medium only; tiny has none and Big keeps its designers', () => {
  const second = STEPS.find((s) => s.id === 'second-look');
  const start = STEPS.find((s) => s.id === 'start');
  const c = { gate: 'G', repo: 'R', notes: 'N', base: 'origin/x', engine: 'claude', ticket: '', sides: [] };
  const facts = (lane) => ({ lane, switches: { remoteHost: '' } });
  for (const lane of ['small', 'medium']) {
    const lines = second.lines(c, facts(lane)).map((l) => l.text);
    assert.match(lines[0], /^first write N\/design\.md: the design in three lines, then NOT: <one way you turned down> — <why, in one line>$/, lane);
    assert.match(lines[lines.length - 1], /its D1 line judges the design: follow it, or write not: <why> after its → and show the owner that one line/, lane);
    assert.match(start.lines(c, facts(lane)).map((l) => l.text).join('\n'), /the second look gets the places list and the design together/, lane);
  }
  for (const lane of ['big', 'text']) {
    assert.doesNotMatch(second.lines(c, facts(lane)).map((l) => l.text).join('\n'), /design\.md|D1 line/, lane);
    assert.doesNotMatch(start.lines(c, facts(lane)).map((l) => l.text).join('\n'), /design\.md/, lane);
  }
  assert.deepEqual(second.lanes, ['small', 'medium', 'big'], 'a tiny change has no second look at all');
});

const staged = path.resolve(here, '..', '..', '..', '..');
const candidate = fs.existsSync(path.join(staged, 'claude/skills/sanad/SKILL.md'));
const claudeRoot = candidate ? path.join(staged, 'claude') : path.join(os.homedir(), '.claude');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8').replace(/\r\n/g, '\n');
test('the loop page and the second look say it, Big is as before, and no guard reads the design lines', () => {
  const loop = read(claudeRoot, 'skills', 'sanad', 'reference', 'loop.md');
  assert.match(loop, /^- \*\*Small and Medium:\*\* before item 6, `<notes>\/design\.md`: the design in 3 lines, then `NOT: <way> — <why>`\. The second look judges it \(`D1`\): `→ follow` or `→ not: <why>`, shown to the user\.$/m);
  assert.match(loop, /^- \*\*Big:\*\* `\/braintrust` before code; two Architects each propose a design, blind to each other, and the boss picks; its verdict is the plan\./m);
  assert.ok(loop.length < 14000, 'loop.md is ' + loop.length + ' bytes');
  assert.match(read(claudeRoot, 'skills', 'sanad', 'reference', 'loop-rare-cases.md'), /By the owner's yes \(switch `sanad\.designChoice`\) the user chooses between the two before code when the picked one adds a table, a migration or a worker, or is about twice the other's size/);
  assert.match(read(claudeRoot, 'agents', 'second-look.md'), /When the brief holds the author's design, you judge it before any code, in one `DESIGN:` line: you agree, or you name a better way this project already uses for the same kind of job, with its file and line\./);
  const hooks = path.join(claudeRoot, 'hooks');
  const files = [...fs.readdirSync(hooks).filter((n) => /\.(?:c?js)$/.test(n)).map((n) => path.join(hooks, n)), ...fs.readdirSync(path.join(hooks, 'lib')).map((n) => path.join(hooks, 'lib', n))];
  for (const file of files) assert.doesNotMatch(read(file), /design\.md|\bD1\b|DESIGN:/, path.basename(file));
});
