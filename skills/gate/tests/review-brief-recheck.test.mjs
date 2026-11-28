// 2026-11-19: a review is pinned to one commit, and the re-check brief is made by the tool from that commit to
// the new one. Before, the brief said "the working tree" (a different change for each reviewer), and re-checks
// were typed by hand or ran as full reviews.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildBrief, buildFreshBrief, buildLaunch, buildRecheckBrief, buildRecheckLaunch, coverageProblems, decisionLines, fixSignals, isCodeFile, pinRef, pinTask, pinRefusal, recheckTooLarge, RECHECK_LIMIT, SEAT_QUESTION } from '../scripts/review-brief.mjs';
import { addDecision, readPins } from '../scripts/notes-dir.mjs';
import { makeCopy, dropCopy } from '../scripts/review-copy.mjs';

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const script = path.join(scripts, 'review-brief.mjs');
const roots = [];
test.after(() => { for (const r of roots) { try { dropCopy(r); } catch { /* a temp folder */ } } });

// A repository with one task commit (A) on a branch off main, and a notes folder outside it with every input.
function fixture() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'review-recheck-')));
  roots.push(root);
  const repo = path.join(root, 'repo'), notes = path.join(root, 'notes'), state = path.join(root, 'state');
  fs.mkdirSync(repo); fs.mkdirSync(notes); fs.mkdirSync(state);
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  const write = (name, text) => { fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true }); fs.writeFileSync(path.join(repo, name), text); };
  write('a.js', 'export const valueOfA = 1;\n');
  write('b.js', 'export const other = 1;\n');
  git('add', '-A'); git('commit', '-qm', 'one');
  git('checkout', '-q', '-b', 'task');
  write('a.js', 'export const valueOfA = 2;\n');
  git('add', '-A'); git('commit', '-qm', 'task');
  fs.writeFileSync(path.join(notes, 'ticket.md'), 'The value is 2.\n');
  fs.writeFileSync(path.join(notes, 'lines.md'), '- The value is 2.\n');
  fs.writeFileSync(path.join(notes, 'check.md'), '- [T1] the value is 2\n');
  fs.writeFileSync(path.join(notes, 'none.md'), '');
  const env = { ...process.env, SANAD_STATE_DIR: state };
  const places = path.join(notes, 'places.md');
  const made = spawnSync(process.execPath, [path.join(scripts, 'places.mjs'), '--repo', repo, '--names', 'valueOfA', '--out', places], { encoding: 'utf8', windowsHide: true, env });
  assert.equal(made.status, 0, made.stdout + made.stderr);
  fs.writeFileSync(places, fs.readFileSync(places, 'utf8').replace(/→ $/gm, '→ C1'));
  const run = (...extra) => spawnSync(process.execPath, [script, '--notes', notes, '--repo', repo, '--base', 'main', '--outside', path.join(notes, 'none.md'), ...extra], { encoding: 'utf8', windowsHide: true, env });
  const read = name => fs.readFileSync(path.join(notes, name), 'utf8');
  return { root, repo, notes, state, git, write, run, read, head: () => git('rev-parse', 'HEAD') };
}

test('--recheck with no earlier full round is refused and writes nothing', () => {
  const f = fixture();
  const r = f.run('--recheck');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /--recheck needs a full review round first/);
  assert.equal(fs.readdirSync(f.notes).some(n => /^brief-recheck/.test(n)), false);
  assert.deepEqual(readPins(f.notes), []);
});

test('--pin refuses an uncommitted code file or an untracked test file, names them, and writes no brief; with no --pin the tool is today\'s', () => {
  const f = fixture();
  // b.js holds no name of the places list, so the list stays closed for the run with no --pin.
  f.write('b.js', 'export const other = 3;\n');
  f.write('tests/new.test.js', 'test();\n');
  f.write('scratch.md', 'a note\n');
  const r = f.run('--pin');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /--pin: 2 code file\(s\) are not in commit [0-9a-f]{12}: /);
  assert.match(r.stderr, /: b\.js, tests\/new\.test\.js\. Commit them/);
  assert.doesNotMatch(r.stderr, /scratch\.md/, 'a prose file does not stop the pin');
  assert.equal(fs.existsSync(path.join(f.notes, 'brief.md')), false, 'no brief');
  assert.deepEqual(readPins(f.notes), [], 'no round saved');
  // No --pin: the working tree is reviewed, untracked files marked, as before.
  const old = f.run();
  assert.equal(old.status, 0, old.stdout + old.stderr);
  assert.match(f.read('brief.md'), /Review the working tree against [0-9a-f]{12} \(where it left main\): `git diff [0-9a-f]{40}` \(uncommitted work included\)\./);
  assert.match(f.read('brief.md'), /tests\/new\.test\.js \(new, not in git yet/);
  assert.doesNotMatch(old.stdout, /^PIN:/m);
  assert.deepEqual(readPins(f.notes), []);
});

test('--pin names the one commit in both briefs, saves the round and keeps the commit under a local ref; a small change gets no copy', () => {
  const f = fixture();
  f.write('scratch.md', 'a note\n'); // prose, untracked: not under review and not in the pinned list
  const a = f.head(), mb = f.git('merge-base', 'main', 'HEAD');
  const r = f.run('--pin');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const name of ['brief.md', 'brief-fresh.md']) {
    const text = f.read(name);
    assert.ok(text.includes(`Review commit ${a} against ${mb.slice(0, 12)} (where it left main): \`git diff ${mb} ${a}\`. Only this commit is under review.`), text);
    assert.doesNotMatch(text, /working tree|uncommitted work included/);
    assert.doesNotMatch(text, /scratch\.md/);
    assert.match(text, /^- a\.js$/m);
  }
  const pins = readPins(f.notes);
  assert.equal(pins.length, 1);
  assert.deepEqual([pins[0].round, pins[0].kind, pins[0].commit, pins[0].frozen, pins[0].mergeBase], [1, 'full', a, '', mb]);
  assert.deepEqual(pins[0].seats, ['fresh eyes', 'other engine'], 'a small round is both engines (2026-11-28)');
  const ref = pinRef(pinTask(f.notes), 1);
  assert.match(ref, /^refs\/sanad\/review\/notes-[0-9a-f]{8}\/1$/);
  assert.equal(f.git('rev-parse', ref), a);
  assert.match(r.stdout, new RegExp(`^PIN: round 1 · commit ${a} · ref ${ref}$`, 'm'));
  assert.equal(fs.existsSync(path.join(f.state, 'review-copy')), false, 'Small makes no copy');
  // The brief made twice at one commit is one round.
  assert.equal(f.run('--pin').status, 0);
  assert.equal(readPins(f.notes).length, 1);
});

test('after a round at A and an amended fix at B, the re-check brief holds only `git diff A B`, the notes part, the decided list and the round number', () => {
  const f = fixture();
  const a = f.head();
  assert.equal(f.run('--pin').status, 0);
  addDecision(f.notes, { kind: 'note', question: 'Is a value above 9 allowed?', words: 'no, keep it under ten', source: 'chat', notes: ['N4'] });
  f.write('a.js', 'export const valueOfA = 2;\nexport const limit = 9;\n');
  f.write('tests/limit.test.js', 'test();\n');
  f.git('add', '-A'); f.git('commit', '-q', '--amend', '-m', 'task');
  const b = f.head();
  assert.notEqual(a, b);
  assert.equal(f.git('rev-parse', pinRef(pinTask(f.notes), 1)), a, 'the amended-away commit still resolves through its ref');
  const r = f.run('--recheck');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`^RECHECK: round 2 · git diff ${a.slice(0, 12)} ${b.slice(0, 12)} · 2 file\\(s\\), 1 code line\\(s\\) in 1 code file\\(s\\) · seats: whole diff · `, 'm'));
  const brief = f.read('brief-recheck-2.md');
  assert.match(brief.split('\n')[0], /re-check/);
  assert.ok(brief.includes(`The fix is the change from commit ${a} (round 1, already reviewed) to commit ${b}: \`git diff ${a} ${b}\`.`), brief);
  assert.match(brief, /^Re-check, round 2\. The round number is information only: report every finding you have\.$/m);
  assert.match(brief, /^- a\.js — 1 changed line\(s\)$/m);
  assert.match(brief, /^- tests\/limit\.test\.js \(new in this fix: read the whole file\)$/m);
  assert.doesNotMatch(brief, /working tree|## Ticket|## Check/, 'only the fix, not the whole PR');
  assert.doesNotMatch(brief, /stop reporting|do not report more/i);
  // The notes: rows with answers, or the plain reason they could not be read. Never an empty list.
  const notesPart = brief.split('## Earlier notes and their answers\n\n')[1].split('\n\n')[0];
  assert.ok(/^- .+\n {2}Answer: /.test(notesPart) || /^The earlier notes could not be read here \(.+\)\. Read the reviewers' reports in /.test(notesPart), notesPart);
  assert.match(brief, /## Decided by the user — do not ask again\n\n- D1 \(note\): Is a value above 9 allowed\? — the user: "no, keep it under ten" \[N4\]\n\nYou may say once, with new evidence, that a decision is unsafe/);
  assert.match(brief, /## Callers of the changed functions\n\n\S/);
  const launch = f.read('launch.md');
  const prompt = launch.split('\n').find(l => l.startsWith('You are'));
  assert.match(prompt, /^You are the independent reviewer — re-check \(whole-diff pass on the fix only\)\. Read and follow only the brief at \S+brief-recheck-2\.md\./);
  assert.doesNotMatch(launch, /risk files/i, 'no risk signal: one seat');
  const pins = readPins(f.notes);
  assert.deepEqual(pins.map(p => [p.round, p.kind, p.commit]), [[1, 'full', a], [2, 'recheck', b]]);
  assert.equal(f.git('rev-parse', pinRef(pinTask(f.notes), 2)), b);
  // Made twice at B: the same round, and the fix still starts at A.
  const again = f.run('--recheck');
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(readPins(f.notes).length, 2);
  assert.ok(f.read('brief-recheck-2.md').includes(`\`git diff ${a} ${b}\``));
  // With no new commit after a full round there is nothing to re-check.
  const g = fixture();
  assert.equal(g.run('--pin').status, 0);
  const none = g.run('--recheck');
  assert.equal(none.status, 2);
  assert.match(none.stderr, /nothing to re-check, HEAD is still commit/);
});

test('a Codex task gets codex exec lines for the same re-check brief', () => {
  const f = fixture();
  assert.equal(f.run('--pin', '--engine', 'codex').status, 0);
  f.write('a.js', 'export const valueOfA = 2; // fixed\n');
  f.git('commit', '-qam', 'fix');
  const r = f.run('--recheck');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const launch = f.read('launch.md');
  assert.match(launch, /^Engine: Codex — re-check, round 2: the whole-diff reviewer\.$/m);
  assert.match(launch, /codex exec -s read-only -c model_reasoning_effort="xhigh" -C "[^"]+" -o "[^"]+\/codex-recheck-2\.md"[^\n]* "You are the independent reviewer — re-check \(whole-diff pass on the fix only\)\. Read and follow only the brief at [^ ]+brief-recheck-2\.md\./);
});

test('a fix of 200 code lines prints RECHECK TOO LARGE and gets the full brief as a new full round', () => {
  const f = fixture();
  assert.equal(f.run('--pin').status, 0);
  f.write('a.js', 'export const valueOfA = 2;\n' + Array.from({ length: 200 }, (_, i) => `export const n${i} = ${i};`).join('\n') + '\n');
  f.git('commit', '-qam', 'big fix');
  const b = f.head();
  const r = f.run('--recheck');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^RECHECK TOO LARGE: 200 changed code lines \(limit 150\)\. This round gets the full brief/m);
  assert.equal(fs.readdirSync(f.notes).some(n => /^brief-recheck/.test(n)), false, 'no narrow brief');
  assert.ok(f.read('brief.md').includes(`Review commit ${b} against`));
  // P9 counts rounds by the word re-check in the first line, also of this brief.
  assert.match(f.read('brief.md').split('\n')[0], /re-check/i);
  assert.match(f.read('brief-fresh.md').split('\n')[0], /re-check/i);
  assert.deepEqual(readPins(f.notes).map(p => [p.round, p.kind]), [[1, 'full'], [2, 'full']]);
});

test('the limits: 149 lines in 8 files fit; one more line, a ninth file or a new risk signal do not; tests are not counted', () => {
  const eight = Array.from({ length: 8 }, (_, i) => ({ name: `src/f${i}.cs`, lines: i === 0 ? 30 : 17 }));
  assert.equal(eight.reduce((s, f) => s + f.lines, 0), 149);
  assert.deepEqual(recheckTooLarge({ files: eight }), []);
  assert.deepEqual(recheckTooLarge({ files: [...eight, { name: 'Api.Tests/FooTests.cs', lines: 400 }, { name: 'notes.md', lines: 400 }] }), []);
  assert.match(recheckTooLarge({ files: [{ name: 'a.cs', lines: RECHECK_LIMIT.lines + 1 }] })[0], /151 changed code lines \(limit 150\)/);
  assert.match(recheckTooLarge({ files: [...eight, { name: 'src/f9.cs', lines: 1 }] }).join('|'), /9 code files \(limit 8\)/);
  assert.match(recheckTooLarge({ files: eight, newSignals: ['access'] })[0], /^a new risk signal: /);
  assert.equal(isCodeFile('a.md'), false); assert.equal(isCodeFile('src/a.test.ts'), true); assert.equal(isCodeFile('x/appsettings.json'), true);
});

test('a fix that touches an access file adds the risk reviewer\'s line, with that file and its question only', () => {
  const files = [{ name: 'Api/Controllers/FilesController.cs', lines: 4 }, { name: 'web/src/Page.tsx', lines: 2 }];
  const risk = fixSignals({ access: ['FilesController.cs'], query: ['Other.cs'], clientState: ['Page.tsx'] }, files);
  assert.deepEqual(risk, { access: ['FilesController.cs'] });
  const launch = buildRecheckLaunch({ brief: 'C:/n/brief-recheck-2.md', repo: 'C:/r', round: 2, risk, files });
  const prompts = launch.split('\n').filter(l => l.startsWith('You are'));
  assert.equal(prompts.length, 2);
  for (const p of prompts) assert.match(p, /^You are the independent reviewer — re-check \(/);
  assert.match(prompts[1], /risk files pass on the fix only/);
  assert.match(launch, /\n- Api\/Controllers\/FilesController\.cs — [^\n]+\nTrace list:\n1\. Can a caller without the right role/);
  assert.doesNotMatch(launch, /Page\.tsx|Other\.cs/);
  assert.equal(buildRecheckLaunch({ brief: 'C:/n/b.md', repo: 'C:/r', round: 2, risk: {}, files }).split('\n').filter(l => l.startsWith('You are')).length, 1);
  // No signals at all (the size check failed): the risk reviewer re-checks too.
  assert.match(buildRecheckLaunch({ brief: 'C:/n/b.md', repo: 'C:/r', round: 2, risk: null, files }), /Re-check, risk files \(Claude\)/);
  // A quote, a dollar sign or a backtick in a file name cannot leave the Codex prompt's quotes.
  const hostile = buildRecheckLaunch({ brief: 'C:/n/b.md', repo: 'C:/r', round: 2, engine: 'codex', risk: { access: ['a"$(x)`y`.cs'] }, files: [{ name: 'a"$(x)`y`.cs', lines: 1 }], codexHome: path.join(os.tmpdir(), 'no-such-codex-home') });
  assert.ok(hostile.includes('a\\"\\$(x)\\`y\\`.cs'), hostile);
});

test('the re-check brief shows each earlier note with its answer, and says so when there is none to show', () => {
  const args = { repo: 'C:/r', branch: 'b', from: 'a'.repeat(40), to: 'b'.repeat(40), round: 3, fromRound: 2, files: [{ name: 'x.cs', lines: 3 }], callers: { text: 'Save ×2 [Api/X.cs:4]' } };
  const brief = buildRecheckBrief({ ...args, notes: { list: [{ number: 12, seat: 'fresh eyes', kind: 'Bug', place: 'x.cs:10', text: 'empty name → 500', state: 'fixed', answer: 'guard added, test NameEmpty' }, { number: 13, seat: 'whole diff', kind: 'Gap', place: 'y.cs:2', text: 'no test' }] } });
  assert.match(brief, /- N12 \[fresh eyes\] Bug — x\.cs:10 — empty name → 500\n {2}Answer: fixed — guard added, test NameEmpty\n- N13 \[whole diff\] Gap — y\.cs:2 — no test\n {2}Answer: none yet \(open\)/);
  assert.match(brief, /Callers: Save ×2 \[Api\/X\.cs:4\]/);
  for (const notes of [{ list: [] }, {}, { failed: 'no session log' }]) {
    const none = buildRecheckBrief({ ...args, notes });
    assert.match(none, /## Earlier notes and their answers\n\nThe earlier notes could not be read here \(/);
  }
  assert.match(buildRecheckBrief({ ...args, callers: { failed: 'Unknown option' } }), /The size check gave no callers for this range \(Unknown option\)\. Find the callers of each changed function yourself/);
});

const facts = { stack: 'Stack: x', size: 'SIZE: small (diff) — behavior code with no risk signal', callers: '' };
const base = { repo: 'C:/r', branch: 'b', base: 'origin/staging', mergeBase: 'a'.repeat(40), ticket: 'Expected: once', checks: ['[T1] once'], outside: { touched: [], other: [] }, facts };

test('a decision of this task is under "Decided by the user" in both briefs, and a reviewer may still call it unsafe once', () => {
  const decisions = decisionLines([{ id: 'D2', kind: 'design', question: 'Queue or direct call?', words: 'direct call, no queue', notes: [] }, { id: 'D3', kind: 'note', words: '   ' }]);
  assert.deepEqual(decisions, ['D2 (design): Queue or direct call? — the user: "direct call, no queue"']);
  for (const build of [buildBrief, buildFreshBrief]) {
    const text = build({ ...base, outside: { touched: [], other: [], decided: ['QA asked about the label · CLOSED'], decisions } });
    assert.match(text, /## Decided by the user — do not ask again\n\n- QA asked about the label · CLOSED\n- D2 \(design\): Queue or direct call\? — the user: "direct call, no queue"\n\nYou may say once, with new evidence, that a decision is unsafe/);
    assert.doesNotMatch(build(base), /Decided by the user|decision is unsafe/);
  }
});

test('the after-save question is in the fresh brief only when the signal is present, and only on a change with one review', () => {
  const Q = /The change saves and then calls another system\. For each result of that call \(sent; refused; failed; no answer before the timeout/;
  assert.match(buildFreshBrief({ ...base, size: 'small', facts: { ...facts, signals: { afterSave: ['Sync.cs'] } } }), Q);
  assert.doesNotMatch(buildFreshBrief({ ...base, size: 'small', facts: { ...facts, signals: { access: ['X.cs'] } } }), Q);
  assert.doesNotMatch(buildFreshBrief({ ...base, size: 'small' }), Q);
  const bigFacts = { ...facts, size: 'SIZE: big (diff) — x', signals: { afterSave: ['Sync.cs'] } };
  assert.doesNotMatch(buildFreshBrief({ ...base, size: 'big', facts: bigFacts }), Q, 'on Big it is the risk reviewer\'s trace question');
  const launch = buildLaunch({ brief: 'C:/n/brief.md', fresh: 'C:/n/brief-fresh.md', repo: 'C:/r', branch: 'b', size: 'big', facts: bigFacts, changed: [{ name: 'Api/Sync.cs' }], designerDone: 'x', codexHome: path.join(os.tmpdir(), 'no-such-codex-home') });
  assert.match(launch, /- Api\/Sync\.cs — [^\n]+\nTrace list:\n1\. The change saves and then calls another system\./);
});

// 2026-11-28 (owner, batch c task 2): a Claude task's Big round has no whole-diff seat (three seats); a Codex task keeps
// its own (four). Small holds the two fresh eyes.
test('a Big launch holds its seats with their own questions; fresh eyes stays free; Small holds the two fresh eyes', () => {
  const args = { brief: 'C:/n/brief.md', fresh: 'C:/n/brief-fresh.md', repo: 'C:/r', branch: 'b', designerDone: 'x', codexHome: path.join(os.tmpdir(), 'no-such-codex-home') };
  for (const engine of ['claude', 'codex']) {
    const big = buildLaunch({ ...args, size: 'big', engine });
    const seats = big.split(/^## /m).slice(1);
    assert.equal(seats.length, engine === 'codex' ? 4 : 3, engine);
    const risk = seats.find(s => /^Risk files/.test(s)), whole = seats.find(s => /^Whole diff/.test(s)), fresh = seats.filter(s => /^Fresh eyes/.test(s));
    assert.ok(risk.includes(SEAT_QUESTION.risk) && !risk.includes(SEAT_QUESTION.whole), engine);
    if (engine === 'codex') assert.ok(whole.includes(SEAT_QUESTION.whole) && !whole.includes(SEAT_QUESTION.risk), engine);
    else assert.equal(whole, undefined, engine);
    assert.equal(fresh.length, 2);
    for (const s of fresh) assert.doesNotMatch(s, /Your own question/);
    const small = buildLaunch({ ...args, size: 'small', engine });
    assert.equal(small.split(/^## /m).length - 1, 2);
    assert.doesNotMatch(small, /Your own question/);
  }
});

test('a ticket line the owner dropped is not reported as uncovered, and both briefs list it as dropped', () => {
  const lines = ['shows once', 'shows a badge', 'keeps the order'];
  const checks = ['[T1] once', '[T3] order'];
  assert.deepEqual(coverageProblems(lines, checks), ['T2 has no Check line: shows a badge']);
  assert.deepEqual(coverageProblems(lines, checks, [2]), []);
  assert.deepEqual(coverageProblems(lines, checks, ['T2']), []);
  const dropped = [{ n: 2, text: 'shows a badge' }];
  const framed = buildBrief({ ...base, ticketLines: lines, checks, dropped });
  assert.match(framed, /## Dropped by the owner — not part of this change, no Check line and no test\n\n- T2\. shows a badge\n/);
  assert.match(framed, /- T1\. shows once\n- T3\. keeps the order\n/);
  assert.match(buildFreshBrief({ ...base, dropped }), /## Dropped by the owner[^\n]*\n\n- T2\. shows a badge\n/);
  assert.doesNotMatch(buildBrief({ ...base, ticketLines: lines, checks: [...checks, '[T2] badge'] }), /Dropped by the owner/);
});

test('a Big pin names the read-only copy on the Repo line and in the Codex -C path; work folder edits do not reach it; --drop-pins removes refs and copies', () => {
  const f = fixture();
  const a = f.head();
  const r = f.run('--pin', '--size', 'big', '--designer-done');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const copy = /^PIN: round 1 · commit [0-9a-f]{40} · ref \S+ · copy (.+)$/m.exec(r.stdout)?.[1];
  assert.ok(copy, r.stdout);
  assert.ok(copy.replace(/\\/g, '/').startsWith(f.state.replace(/\\/g, '/') + '/review-copy/'), 'outside the repository');
  assert.equal(readPins(f.notes)[0].frozen, copy);
  for (const name of ['brief.md', 'brief-fresh.md']) assert.ok(f.read(name).includes(`Repo: ${copy}, branch task. Review commit ${a} against`), f.read(name));
  assert.match(f.read('brief.md'), /This folder is a read-only copy of that commit: read the files here\./);
  assert.ok(f.read('launch.md').includes(`-C "${copy}"`), f.read('launch.md'));
  // The author fixes an early note while the reviewers read: the copy still holds commit A.
  f.write('a.js', 'export const valueOfA = 99;\n');
  assert.equal(fs.readFileSync(path.join(copy, 'a.js'), 'utf8').replace(/\r/g, ''), 'export const valueOfA = 2;\n');
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: copy, encoding: 'utf8' }).trim(), a);
  assert.throws(() => fs.writeFileSync(path.join(copy, 'a.js'), 'x'), 'the copy is read-only');
  const d = f.run('--drop-pins');
  assert.equal(d.status, 0, d.stdout + d.stderr);
  assert.match(d.stdout, /^PINS DROPPED: 1 ref\(s\) under refs\/sanad\/review\/notes-[0-9a-f]{8}\/, 1 copy folder\(s\)\./m);
  assert.equal(f.git('for-each-ref', 'refs/sanad/review/'), '');
  assert.equal(fs.existsSync(copy), false);
  assert.equal(readPins(f.notes).length, 1, 'the saved rounds stay');
});

test('when the copy cannot be made, the brief keeps the pinned diff and prints one NOTE line; --no-frozen asks for none', () => {
  const f = fixture();
  const a = f.head();
  fs.writeFileSync(path.join(f.state, 'review-copy'), 'a file where the copies folder should be\n');
  const r = f.run('--pin', '--size', 'big', '--designer-done');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal((r.stdout.match(/^NOTE: the read-only copy of commit [0-9a-f]{12} could not be made \(.+\): the reviewers read the pinned commit in the work folder, so no source edit while they read\.$/gm) || []).length, 1, r.stdout);
  assert.ok(f.read('brief.md').includes(`Repo: ${f.repo.replace(/\\/g, '/')}`) || f.read('brief.md').includes(`Repo: ${f.git('rev-parse', '--show-toplevel')}`));
  assert.ok(f.read('brief.md').includes(`\`git diff ${f.git('merge-base', 'main', 'HEAD')} ${a}\``));
  assert.equal(readPins(f.notes)[0].frozen, '');
  assert.throws(() => makeCopy({ repo: f.repo, commit: a, task: 't', round: 1, root: path.join(f.state, 'review-copy') }));
  const g = fixture();
  const n = g.run('--pin', '--size', 'big', '--designer-done', '--no-frozen');
  assert.equal(n.status, 0, n.stdout + n.stderr);
  assert.doesNotMatch(n.stdout, /copy|NOTE:/);
  assert.equal(fs.existsSync(path.join(g.state, 'review-copy')), false);
});

test('pinRefusal names a foreign folder with the shared FOREIGN? line', () => {
  const line = pinRefusal({ at: 'a'.repeat(40), uncommitted: [], untracked: [], foreign: [{ dir: 'other/', count: 300, repo: false, exclude: '.git/info/exclude' }] });
  assert.match(line, /^FOREIGN\? other\/ holds 300 untracked files: /);
  assert.equal(pinRefusal({ at: 'a'.repeat(40), uncommitted: ['notes.md'], untracked: ['x.log'], foreign: [] }), '');
});

// 2026-11-25 (owner): a medium round has two seats, the fresh eyes and the other engine, so the ready check waits for
// both reports (sanad.mjs reads pin.seats). Only Big gets the read-only copy. The re-check runs on its own agent file
// (recheck-reviewer, high); the whole diff of a Big task keeps routine-reviewer (xhigh).
test('--pin on a medium change saves two seats, the fresh eyes and the other engine, and makes no copy', () => {
  const f = fixture();
  const r = f.run('--pin', '--size', 'medium');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const pins = readPins(f.notes);
  assert.equal(pins.length, 1);
  assert.deepEqual(pins[0].seats, ['fresh eyes', 'other engine']);
  assert.equal(pins[0].frozen, '', 'the read-only copy is for Big only');
  assert.equal((f.read('launch.md').match(/codex exec -s read-only/g) || []).length, 1);
});

test('the re-check launch names recheck-reviewer; a Big round launches no routine-reviewer', () => {
  const recheck = buildRecheckLaunch({ brief: 'C:/n/brief-recheck-2.md', repo: 'C:/r', round: 2, engine: 'claude', risk: {} });
  assert.match(recheck, /^## Re-check, whole diff \(Claude\) — Agent recheck-reviewer, run_in_background$/m);
  assert.doesNotMatch(recheck, /Agent routine-reviewer/);
  const short = buildRecheckLaunch({ brief: 'C:/n/brief-recheck-2.md', repo: 'C:/r', round: 2, engine: 'claude', risk: {}, short: true });
  assert.match(short, /Agent recheck-reviewer/, 'the short check after the last round is a re-check too');
  // The risk reviewer of a re-check stays the xhigh independent-reviewer.
  const withRisk = buildRecheckLaunch({ brief: 'C:/n/brief-recheck-2.md', repo: 'C:/r', round: 2, engine: 'claude', risk: { access: ['a.js'] }, files: [{ name: 'a.js' }] });
  assert.match(withRisk, /^## Re-check, risk files \(Claude\) — Agent independent-reviewer, run_in_background$/m);
  const big = buildLaunch({ brief: 'C:/n/brief.md', fresh: 'C:/n/brief-fresh.md', repo: 'C:/r', branch: 'b', size: 'big' });
  assert.doesNotMatch(big, /routine-reviewer|^## Whole diff/m, 'no Claude whole-diff seat (2026-11-28)');
  assert.doesNotMatch(big, /recheck-reviewer/);
});
