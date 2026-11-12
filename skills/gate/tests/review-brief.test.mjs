import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildBrief, buildFreshBrief, buildLaunch, outsideItems, splitOutside, checkLines, missedClasses, decidedItems, checkSources, coverageProblems, chooseSize, sizeFacts } from '../scripts/review-brief.mjs';

// 2026-11-08 (user: "check lines should comes from all tickets"): every ticket line has a Check line,
// every Check line names its source, and cases outside the ticket are EXTRA TEST lines for the user.
test('every ticket line needs a Check line, and every Check line names its source', () => {
  const ticketLines = ['create a homework, proceed or save as a draft/publish', 'The message should appear once', 'Required when the type includes a file'];
  const good = ['[T1, T2] Once after Save, Next and Publish', '[T2] Once before saving', '[T3] Nothing saved without a type', '[rule: both languages] Arabic and English', '[change] Still announced'];
  assert.deepEqual(coverageProblems(ticketLines, good), []);
  assert.deepEqual(checkSources('[T1, change] x'), ['T1', 'change']);
  // 2026-11-09: separate brackets were cut to the first one, so each step needed its own line.
  assert.deepEqual(checkSources('[T1] [T2] [T3] the path'), ['T1', 'T2', 'T3']);
  assert.deepEqual(coverageProblems(['a b c', 'd e f'], ['[T1] [T2] both']), []);
  assert.equal(checkSources('no tag here'), null);
  assert.equal(checkSources('[maybe] x'), null);
  const bad = coverageProblems(ticketLines, ['[T2] Once before saving', 'untagged line', '[T9] beyond the ticket']);
  assert.ok(bad.some(p => /^T1 has no Check line/.test(p)));
  assert.ok(bad.some(p => /^T3 has no Check line/.test(p)));
  assert.ok(bad.some(p => /^C2 names no source/.test(p)));
  assert.ok(bad.some(p => /^C3 names T9, but the ticket has T1\.\.T3/.test(p)));
  const brief = buildBrief({ repo: 'C:/r', branch: 'b', base: 'origin/staging', mergeBase: 'a'.repeat(40), ticket: 't', ticketLines, checks: good, outside: { other: [], touched: [] }, facts: { stack: '', size: '', callers: '' } });
  assert.match(brief, /## Ticket lines — every one has a Check line\n\n- T1\. create a homework/);
  assert.match(brief, /- C1\. \[T1, T2\] Once after Save/);
  assert.match(brief, /`EXTRA TEST:` line/);
  assert.match(brief, /## Problems outside the ticket — known, do not report again/);
});

// 2026-11-07: a reviewer re-asked a question the user had closed; the slowest reviewer had the widest job.
test('decided questions go into both briefs; a small change gets one review, the Claude fresh eyes', () => {
  const list = '- 2026-11-06 · Twin · F.tsx:1 · open\n- 2026-11-06 · Wording question — CLOSED: the ticket decides (user: "is qa not mention")\n';
  const decided = decidedItems(list);
  assert.deepEqual(decided, ['Wording question — CLOSED: the ticket decides (user: "is qa not mention")']);
  const withDecided = { other: [], touched: [], decided };
  const args = { repo: 'C:/r', branch: 'b', base: 'origin/staging', mergeBase: 'a'.repeat(40), ticket: 't', checks: ['x'], outside: withDecided, facts: { stack: '', size: 'SIZE: small (diff)', callers: '' } };
  for (const brief of [buildBrief(args), buildFreshBrief({ ...args, missed: [] })]) assert.match(brief, /## Decided by the user — do not ask again\n\n- Wording question — CLOSED/);
  const small = buildLaunch({ brief: 'C:/n/brief.md', fresh: 'C:/n/brief-fresh.md', repo: 'C:/r', branch: 'b', focused: true });
  // A tiny or small change gets one review (user rule 2026-11-11): the Claude fresh eyes, no whole-diff pass, no Codex.
  assert.match(small, /FRESH EYES whole-PR review\. Read and follow only the brief at C:\/n\/brief-fresh\.md/);
  assert.doesNotMatch(small, /whole-diff pass|codex exec|Fill the coverage checklist/);
  assert.match(small, /Test designer/, 'the designer keeps its line');
  assert.match(buildLaunch({ brief: 'C:/n/brief.md', fresh: 'C:/n/brief-fresh.md', repo: 'C:/r', branch: 'b' }), /Fill the coverage checklist/);
});

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'review-brief.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-brief-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const env = { ...process.env, SANAD_STATE_DIR: path.join(root, 'state') };

const facts = { stack: 'Stack: React 19 + Vite 7 · tests: Vitest', size: 'SIZE: small (diff) — behavior code with no risk signal', callers: 'Form ×2 [src/Page.tsx:4]' };
const outside = { other: [{ what: 'Old twin message', where: 'Other.tsx:10' }], touched: [{ what: 'Old-language error', where: 'Form.tsx err() :835' }] };
const base = { repo: 'C:/r', branch: 'fix/x', base: 'origin/staging', mergeBase: 'a'.repeat(40), ticket: 'Expected: "The message should appear once"', checks: ['Once after Save', 'Once after saving twice'], outside, facts };

test('the framed brief: numbered Check lines, pinned diff, callers, both known lists, three rules', () => {
  const brief = buildBrief(base);
  assert.match(brief, /- C1\. Once after Save\n- C2\. Once after saving twice/);
  assert.match(brief, /git diff a{40}/, 'the diff is pinned to the merge base, never a moving branch');
  assert.match(brief, /^Callers: Form ×2 \[src\/Page\.tsx:4\]$/m);
  assert.match(brief, /## Problems outside the ticket — known, do not report again\n\n- Old twin message \(Other\.tsx:10\)/);
  // 2026-11-12: the touched items' heading now tells the reviewer to CHECK them (it said "report only if").
  assert.match(brief, /## Problems outside the ticket in the files this change touches — CHECK each one against the change: report it if this change alters or worsens it\n\n- Old-language error/);
  assert.equal((brief.split('## Rules')[1].match(/^- /gm) || []).length, 3, 'three standing rules, no more');
  assert.match(brief, /A `Question` is only for what the ticket lines above leave open/);
  assert.match(brief, /A test weakness on a Check line is reported as a concrete break/);
  assert.match(brief, /## Focused brief/);
});

test('the fresh brief carries no author framing: no Check lines, no callers, no proof; it has the missed-bug classes', () => {
  const fresh = buildFreshBrief({ ...base, missed: ['wrong scope — catch: grep the guard'] });
  assert.doesNotMatch(fresh, /## Check|Callers:|Proof run|C1\./);
  assert.match(fresh, /fresh eyes/);
  assert.match(fresh, /## Bug classes this project missed before — check the change for each\n\n- wrong scope — catch: grep the guard/);
  assert.match(fresh, /git diff a{40}/);
  assert.match(fresh, /## Problems outside the ticket — known/);
});

test('the proof run result goes into the framed brief only', () => {
  const brief = buildBrief({ ...base, proof: ['RED-PROOF: PROVED ✓ — 1 break(s) caught'] });
  assert.match(brief, /## Proof run \(red-proof\.mjs\)\n\n {4}RED-PROOF: PROVED ✓/);
});

test('a small change gets the focused budget; a big one and an unknown size do not', () => {
  assert.match(buildBrief(base), /## Focused brief/);
  assert.doesNotMatch(buildBrief({ ...base, facts: { ...facts, size: 'SIZE: big (diff) — migration' } }), /## Focused brief/);
  assert.doesNotMatch(buildBrief({ ...base, size: 'medium' }), /## Focused brief/);
});

test('launch lines name the briefs exactly: the fresh brief for both fresh-eyes reviewers, the framed one for the rest', () => {
  const launch = buildLaunch({ brief: 'C:/n/brief.md', fresh: 'C:/n/brief-fresh.md', repo: 'C:/r', branch: 'fix/x' });
  assert.match(launch, /Test designer[\s\S]*The task's brief: C:\/n\/brief\.md/);
  assert.match(launch, /FRESH EYES whole-PR review\. Read and follow only the brief at C:\/n\/brief-fresh\.md/);
  assert.match(launch, /whole-diff pass\. Read and follow the brief at C:\/n\/brief\.md/);
  assert.match(launch, /codex exec -s read-only[\s\S]*brief at C:\/n\/brief-fresh\.md/);
});

test('lists: open outside items split by touched files; CLOSED left out; missed-bug classes short and unique', () => {
  const list = ['Format: date · what · where · status.', '', '- 2026-11-06 · Twin message · Form.tsx:10 · open',
    '- 2026-11-06 · Slow test · src/x.test.ts · open', '- 2026-11-06 · Wording question — CLOSED: the ticket decides'].join('\n');
  const items = outsideItems(list);
  // 2026-11-12: an item is its whole line (less the date), not the second part by position.
  assert.deepEqual(items.map(i => i.what), ['Twin message · Form.tsx:10 · open', 'Slow test · src/x.test.ts · open']);
  const split = splitOutside(items, ['web/src/Form.tsx']);
  assert.deepEqual(split.touched.map(i => i.what), ['Twin message · Form.tsx:10 · open']);
  assert.deepEqual(split.other.map(i => i.what), ['Slow test · src/x.test.ts · open']);
  assert.deepEqual(checkLines('# heading\n- one\n\n2. two\n- C3. three\n'), ['one', 'two', 'three']);
  const missed = missedClasses('- a · b · CLASS: wrong scope · WHY MISSED: x · CATCH: grep it\n- c · CLASS: wrong scope · WHY MISSED: y · CATCH: grep it\nno class here\n');
  assert.deepEqual(missed, ['wrong scope — catch: grep it']);
});

test('the command writes all three files from git and the files, and refuses missing inputs', () => {
  const repo = fs.mkdtempSync(path.join(root, 'repo-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'F'); git('config', 'user.email', 'f@example.invalid');
  fs.writeFileSync(path.join(repo, 'F.tsx'), 'x\n'); git('add', '-A'); git('commit', '-qm', 'base'); git('switch', '-q', '-c', 'fix/y');
  fs.writeFileSync(path.join(repo, 'F.tsx'), 'y\n');
  fs.writeFileSync(path.join(repo, 'New.tsx'), 'export const n = 1;\n');
  const notes = fs.mkdtempSync(path.join(root, 'notes-'));
  const ticket = path.join(notes, 'ticket.md'), check = path.join(notes, 'check.md'), outsideFile = path.join(notes, 'outside.md'), missedFile = path.join(notes, 'missed.md'), out = path.join(notes, 'brief.md'), proof = path.join(notes, 'proof.log');
  const lines = path.join(notes, 'lines.md');
  fs.writeFileSync(ticket, 'QA: "appear once"\n'); fs.writeFileSync(lines, '- appear once\n'); fs.writeFileSync(check, '- [T1] once on save\n- [T1] once twice\n');
  fs.writeFileSync(outsideFile, '- 2026-11-06 · Twin · F.tsx:1 · open\n- 2026-11-06 · Other · G.tsx:2 · open\n');
  fs.writeFileSync(missedFile, '- d · CLASS: lost line · WHY MISSED: z · CATCH: quote it\n');
  fs.writeFileSync(proof, 'RED-PROOF: RED ✓ — x\n  BREAK ✓ rule: all 1 named test(s) fail\nnoise line\n');
  git('config', 'sanad.outsideList', outsideFile); git('config', 'sanad.missedBugs', missedFile);
  const r = spawnSync(process.execPath, [script, '--out', out, '--ticket', ticket, '--lines', lines, '--check', check, '--repo', repo, '--base', 'main', '--proof-log', proof], { encoding: 'utf8', env, windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /BRIEF: .* · 2 check line\(s\) C1\.\.C2 · 2 known item\(s\), 1 in touched files, 0 decided · callers: .* · proof: yes/);
  assert.match(r.stdout, /FRESH: .*brief-fresh\.md · 1 missed-bug class\(es\)/);
  const brief = fs.readFileSync(out, 'utf8');
  assert.match(brief, /branch fix\/y/);
  assert.match(brief, /files this change touches[\s\S]*- Twin · F\.tsx:1 · open/);
  assert.match(brief, / {4}BREAK ✓ rule/);
  assert.doesNotMatch(brief, /noise line/);
  assert.match(fs.readFileSync(path.join(notes, 'brief-fresh.md'), 'utf8'), /- lost line — catch: quote it/);
  // 2026-11-12 (audit C1): reviewers start before the commit, and `git diff` never shows an untracked file.
  for (const text of [brief, fs.readFileSync(path.join(notes, 'brief-fresh.md'), 'utf8')]) {
    assert.match(text, /## Changed files[^\n]*\n\n- F\.tsx\n- New\.tsx \(new, not in git yet: read the whole file — `git diff` does not show it\)\n/);
    assert.match(text, /git diff [0-9a-f]{40}/, 'the diff line stays');
  }
  assert.match(fs.readFileSync(path.join(notes, 'launch.md'), 'utf8'), /brief-fresh\.md/);
  const missing = spawnSync(process.execPath, [script, '--out', out, '--ticket', ticket, '--lines', lines, '--repo', repo], { encoding: 'utf8', env, windowsHide: true });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--check is required/);
  fs.writeFileSync(lines, '- appear once\n- save as a draft\n');
  const uncovered = spawnSync(process.execPath, [script, '--out', out, '--ticket', ticket, '--lines', lines, '--check', check, '--repo', repo, '--base', 'main'], { encoding: 'utf8', env, windowsHide: true });
  assert.equal(uncovered.status, 2, 'a ticket line with no Check line stops the brief');
  assert.match(uncovered.stderr, /T2 has no Check line: save as a draft/);
});

test('both briefs list the changed files, new untracked ones marked to be read whole', () => {
  const changed = [{ name: 'src/Page.tsx' }, { name: 'src/NewDialog.tsx', untracked: true }];
  for (const text of [buildBrief({ ...base, changed }), buildFreshBrief({ ...base, missed: [], changed })]) {
    assert.match(text, /## Changed files[^\n]*\n\n- src\/Page\.tsx\n- src\/NewDialog\.tsx \(new, not in git yet: read the whole file — `git diff` does not show it\)\n/);
  }
});

// 2026-11-12 (audit C8a): `--size small` on a change measured big gave the focused brief and one reviewer.
test('the larger of the routed and the measured size is used, and a difference is named', () => {
  const big = { ...facts, size: 'SIZE: big (diff) — database schema or migration (X.cs)' };
  assert.deepEqual(chooseSize(big, 'small'), { size: 'big', note: 'size: routed small, measured big → using big' });
  assert.deepEqual(chooseSize(facts, 'medium'), { size: 'medium', note: 'size: routed medium, measured small → using medium' });
  assert.deepEqual(chooseSize(facts, 'small'), { size: 'small', note: '' });
  assert.deepEqual(chooseSize(facts, undefined), { size: 'small', note: '' });
  assert.deepEqual(chooseSize({ stack: '', size: '', callers: '' }, 'tiny'), { size: 'tiny', note: '' }, 'no measure: the routed size');
  assert.doesNotMatch(buildBrief({ ...base, size: 'small', facts: big }), /## Focused brief/);
  assert.doesNotMatch(buildFreshBrief({ ...base, missed: [], size: 'small', facts: big }), /## Focused brief/);
  const launch = buildLaunch({ brief: 'C:/n/brief.md', fresh: 'C:/n/brief-fresh.md', repo: 'C:/r', branch: 'b', focused: false, sizeNote: 'size: routed small, measured big → using big' });
  assert.match(launch, /^size: routed small, measured big → using big$/m);
  assert.match(launch, /whole-diff pass/);
});

test('the command uses the larger size for launch.md and says so', () => {
  const repo = fs.mkdtempSync(path.join(root, 'repo-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'F'); git('config', 'user.email', 'f@example.invalid');
  fs.writeFileSync(path.join(repo, 'README.md'), 'x\n'); git('add', '-A'); git('commit', '-qm', 'base'); git('switch', '-q', '-c', 'fix/z');
  fs.mkdirSync(path.join(repo, 'Api/Migrations'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'Api/Migrations/20260101_AddX.cs'), 'public partial class AddX : Migration { }\n');
  const notes = fs.mkdtempSync(path.join(root, 'notes-'));
  const ticket = path.join(notes, 'ticket.md'), lines = path.join(notes, 'lines.md'), check = path.join(notes, 'check.md'), out = path.join(notes, 'brief.md');
  fs.writeFileSync(ticket, 'add X\n'); fs.writeFileSync(lines, '- add X\n'); fs.writeFileSync(check, '- [T1] X is added\n');
  const r = spawnSync(process.execPath, [script, '--out', out, '--ticket', ticket, '--lines', lines, '--check', check, '--repo', repo, '--base', 'main', '--size', 'small', '--outside', path.join(notes, 'none.md'), '--missed', path.join(notes, 'none.md')], { encoding: 'utf8', env, windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^size: routed small, measured big → using big$/m);
  const launch = fs.readFileSync(path.join(notes, 'launch.md'), 'utf8');
  assert.match(launch, /^size: routed small, measured big → using big$/m);
  assert.match(launch, /whole-diff pass/, 'the full round');
  assert.doesNotMatch(fs.readFileSync(out, 'utf8'), /## Focused brief/);
  const bad = spawnSync(process.execPath, [script, '--out', out, '--ticket', ticket, '--lines', lines, '--check', check, '--repo', repo, '--base', 'main', '--size', 'huge'], { encoding: 'utf8', env, windowsHide: true });
  assert.equal(bad.status, 2, 'an unknown --size is a usage error');
});

// 2026-11-12 (audit C9), lines in the shape of the real outside list.
test('outside list: whole lines kept, touched by a file named anywhere, FIXED and merged items left out', () => {
  const list = [
    'Format: date · what happens · where · status (open / own PR / ticket / ignored + the user\'s words).',
    '',
    '- 2026-11-09 · TUW-238 end list — status: open, one by one: (1) attempts cap; (3) names in Swal titles as HTML on GroupsPage.tsx:586 (XSS class fixed in ExamResultsPanel); (6) extra tests',
    '- 2026-11-09 · time limit up to 600 minutes · exam-form-schema.ts timeLimitMin · open · 2026-11-11: FIXED in PR #765 commit 1ea7955f08',
    '- 2026-11-10 (from #767 reviews, user kept out): exam start path can still add one attempt (AttemptService.CreateAsync reads the limit without the exam-row lock) · old exams with MaxAttempts 0 · no MySQL test',
    '- 2026-11-10 · teammate PR #770 merged: the due-date order · HomeworkList.tsx:12 · Fixed in PR #770',
    '- 2026-11-06 · Slow export test times out once the exam is closed · src/utils/exam-results-export.test.ts · open',
    '- 2026-11-06 · Wording question — CLOSED: the ticket decides',
  ].join('\n');
  const items = outsideItems(list);
  const texts = items.map(i => i.what);
  assert.equal(items.length, 3, JSON.stringify(texts));
  assert.match(texts[0], /^TUW-238 end list[\s\S]*GroupsPage\.tsx:586/, 'a line with two parts is kept whole');
  assert.match(texts[1], /^2026-11-10 \(from #767 reviews, user kept out\): exam start path[\s\S]*no MySQL test$/, 'the first of five joined items is kept');
  assert.match(texts[2], /^Slow export test times out once the exam is closed/, 'a lowercase "closed" in the text is not a status');
  assert.ok(!texts.some(t => /600 minutes|due-date order/.test(t)), 'FIXED and "Fixed in PR" items are not open');
  assert.deepEqual(decidedItems(list), ['Wording question — CLOSED: the ticket decides']);
  const split = splitOutside(items, ['eduquest-frontend/src/pages/groups/GroupsPage.tsx', 'EduQuest/EduQuest.Infrastructure/Services/AttemptService.cs']);
  assert.equal(split.touched.length, 2, JSON.stringify(split));
  assert.equal(split.other.length, 1);
  assert.equal(splitOutside([{ what: 'Twin message · HomeworkForm.tsx:10 · open', where: '' }], ['src/Form.tsx']).touched.length, 0, 'HomeworkForm.tsx is another file than Form.tsx');
  assert.equal(splitOutside([{ what: 'x · src/utils/a-b.ts · open', where: '' }], ['web/src/utils/a-b.ts']).touched.length, 1, 'a base name inside a path');
  const brief = buildBrief({ ...base, outside: { ...split, decided: [] } });
  assert.match(brief, /CHECK each one against the change[^\n]*\n\n- TUW-238 end list[^\n]*\n- 2026-11-10 \(from #767/);
  assert.match(brief, /known, do not report again\n\n- Slow export test/);
});

// 2026-11-12 (audit C23): the missed-bugs file's own "Format:" line was read as a bug class, and a size
// check that crashed or timed out left "Callers: none yet" in the brief.
test('the missed-bugs Format line is not a class; a failed size check is named in the brief', () => {
  const missed = missedClasses('Format: `- <date> · PR #n → fix #m · <bug> · CLASS: <short class> · WHY MISSED: <reason> · CATCH: <the check>`\n- d · CLASS: lost line · WHY MISSED: z · CATCH: quote it\n');
  assert.deepEqual(missed, ['lost line — catch: quote it']);
  const brief = buildBrief({ ...base, facts: { stack: '', size: '', callers: '', failed: 'fatal: bad revision' } });
  assert.match(brief, /^SIZE CHECK FAILED: fatal: bad revision$/m);
  assert.doesNotMatch(brief, /Callers: none yet/);
  const dir = fs.mkdtempSync(path.join(root, 'fake-'));
  const crash = path.join(dir, 'crash.mjs'), slow = path.join(dir, 'slow.mjs');
  fs.writeFileSync(crash, "process.stderr.write('SIZE: fatal: Not a valid object name main\\nUsage: x\\n'); process.exit(2);\n");
  fs.writeFileSync(slow, 'setTimeout(() => {}, 20000);\n');
  assert.equal(sizeFacts(dir, 'main', { script: crash }).failed, 'fatal: Not a valid object name main');
  assert.match(sizeFacts(dir, 'main', { script: slow, timeout: 700 }).failed, /^timed out after \d+ s$/);
});
