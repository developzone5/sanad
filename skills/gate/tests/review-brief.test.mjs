import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { gitBash, bashEnv } from '../scripts/git-bash.mjs';
import { buildBrief, buildFreshBrief, buildLaunch, outsideItems, splitOutside, checkLines, decidedItems, checkSources, coverageProblems, chooseSize, sizeFacts, riskFiles, signalFiles, designerReport } from '../scripts/review-brief.mjs';

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
  const small = buildLaunch({ brief: 'C:/n/brief.md', fresh: 'C:/n/brief-fresh.md', repo: 'C:/r', branch: 'b', size: 'small' });
  // A tiny or small change gets one review (user rule 2026-11-11): the Claude fresh eyes, no whole-diff pass, no Codex.
  assert.match(small, /FRESH EYES whole-PR review\. Read and follow only the brief at C:\/n\/brief-fresh\.md/);
  assert.doesNotMatch(small, /whole-diff pass|codex exec|Fill the coverage checklist/);
  assert.doesNotMatch(small, /Test designer/, 'the designer is a Big-task seat (2026-11-13)');
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
  assert.equal((brief.split('## Rules')[1].match(/^- /gm) || []).length, 5, 'five standing rules, no more (2026-11-16: the design rule and the old-code rule)');
  assert.match(brief, /A `Question` is only for what the ticket lines above leave open/);
  assert.match(brief, /A test weakness on a Check line is reported as a concrete break/);
  assert.match(brief, /## Focused brief/);
});

// 2026-11-12 (user: the workflow must not depend on a list of old bugs): the missed-bug classes left the brief.
test('the fresh brief carries no author framing: no Check lines, no callers, no proof, no missed-bug classes', () => {
  const fresh = buildFreshBrief({ ...base, missed: ['wrong scope — catch: grep the guard'] });
  assert.doesNotMatch(fresh, /## Check|Callers:|Proof run|C1\./);
  assert.match(fresh, /fresh eyes/);
  assert.doesNotMatch(fresh, /Bug classes this project missed|wrong scope/);
  assert.match(fresh, /git diff a{40}/);
  assert.match(fresh, /## Problems outside the ticket — known/);
});

// 2026-11-12: rule 1 ("list every place that uses what you change, by search") was text and was skipped: a
// date rule was fixed on the "schedule" path and missed on the "publish now" path.
test('both briefs list every place with its outcome and tell the reviewer to check each none: and search for more', () => {
  const places = { repo: 'C:/r', names: ['dueAfterPublish', 'DUE_CODE'], places: [
    { n: 1, mark: '', name: 'dueAfterPublish', file: 'src/Service.cs', fn: 'ScheduleAsync', lines: '3, 9', outcome: 'C1' },
    { n: 2, mark: 'new', name: 'dueAfterPublish', file: 'src/Service.cs', fn: 'PublishNowAsync', lines: '40', outcome: 'none: reads it only for a log line' },
    { n: 3, mark: 'gone', name: 'DUE_CODE', file: 'src/old.ts', lines: 'none', outcome: '' },
  ], tests: new Map([['dueAfterPublish', ['src/rules.test.ts']], ['DUE_CODE', []]]) };
  for (const text of [buildBrief({ ...base, places }), buildFreshBrief({ ...base, places })]) {
    assert.match(text, /## Places that use what this change touches\n\nFor each `none:` line, read that place and check the reason; a place that needs the change and has none is a Bug\.\nSearch yourself for a place this list misses; a missing place is a Bug\.\n/);
    assert.match(text, /Names searched \(whole words\): dueAfterPublish, DUE_CODE/);
    // 2026-11-12: each function that uses the name is its own place, named in the brief.
    assert.match(text, /- P1 · dueAfterPublish · src\/Service\.cs · ScheduleAsync · lines 3, 9 → C1\n- P2 \(new\) · dueAfterPublish · src\/Service\.cs · PublishNowAsync · lines 40 → none: reads it only for a log line\n/);
    assert.match(text, /- P3 \(gone\) · DUE_CODE · src\/old\.ts · \(file\) · lines none → \n/, 'a place with no function part is the file\'s own');
    assert.match(text, /- Tests that mention dueAfterPublish: src\/rules\.test\.ts\n- Tests that mention DUE_CODE: none\n/);
  }
  assert.doesNotMatch(buildBrief(base), /## Places that use/, 'no list given, no section');
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
  assert.match(launch, /risk files pass \(Pass A\)\. Read and follow the brief at C:\/n\/brief\.md/);
  assert.match(launch, /codex exec -s read-only[\s\S]*brief at C:\/n\/brief-fresh\.md/);
});

test('lists: open outside items split by touched files; CLOSED left out; check lines numbered', () => {
  const list = ['Format: date · what · where · status.', '', '- 2026-11-06 · Twin message · Form.tsx:10 · open',
    '- 2026-11-06 · Slow test · src/x.test.ts · open', '- 2026-11-06 · Wording question — CLOSED: the ticket decides'].join('\n');
  const items = outsideItems(list);
  // 2026-11-12: an item is its whole line (less the date), not the second part by position.
  assert.deepEqual(items.map(i => i.what), ['Twin message · Form.tsx:10 · open', 'Slow test · src/x.test.ts · open']);
  const split = splitOutside(items, ['web/src/Form.tsx']);
  assert.deepEqual(split.touched.map(i => i.what), ['Twin message · Form.tsx:10 · open']);
  assert.deepEqual(split.other.map(i => i.what), ['Slow test · src/x.test.ts · open']);
  assert.deepEqual(checkLines('# heading\n- one\n\n2. two\n- C3. three\n'), ['one', 'two', 'three']);
});

const placesScript = path.join(path.dirname(script), 'places.mjs');
// The places list for `names` in `repo`, outside it, each place given `outcome` ('' leaves it open).
function placesFor(repo, names, outcome) {
  const out = path.join(fs.mkdtempSync(path.join(root, 'places-')), 'places.md');
  const made = spawnSync(process.execPath, [placesScript, '--repo', repo, '--names', names, '--out', out], { encoding: 'utf8', windowsHide: true });
  assert.equal(made.status, 0, made.stdout + made.stderr);
  fs.writeFileSync(out, fs.readFileSync(out, 'utf8').replace(/→ $/gm, '→ ' + outcome));
  return out;
}

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
  const places = placesFor(repo, 'n', 'C1');
  const r = spawnSync(process.execPath, [script, '--out', out, '--ticket', ticket, '--lines', lines, '--check', check, '--repo', repo, '--base', 'main', '--proof-log', proof, '--places', places], { encoding: 'utf8', env, windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /BRIEF: .* · 2 check line\(s\) C1\.\.C2 · 2 known item\(s\), 1 in touched files, 0 decided · callers: .* · proof: yes · .* · places: 1, 0 open/);
  // 2026-11-12: the missed-bugs file is no longer read, and its count left the output line.
  assert.match(r.stdout, /^FRESH: .*brief-fresh\.md$/m);
  const brief = fs.readFileSync(out, 'utf8');
  assert.match(brief, /branch fix\/y/);
  assert.match(brief, /files this change touches[\s\S]*- Twin · F\.tsx:1 · open/);
  assert.match(brief, / {4}BREAK ✓ rule/);
  assert.doesNotMatch(brief, /noise line/);
  assert.doesNotMatch(fs.readFileSync(path.join(notes, 'brief-fresh.md'), 'utf8'), /lost line|missed before/);
  for (const text of [brief, fs.readFileSync(path.join(notes, 'brief-fresh.md'), 'utf8')]) assert.match(text, /^- P1 · n · New\.tsx · \(file\) · lines 1 → C1$/m);
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
  const launch = buildLaunch({ brief: 'C:/n/brief.md', fresh: 'C:/n/brief-fresh.md', repo: 'C:/r', branch: 'b', size: 'big', sizeNote: 'size: routed small, measured big → using big' });
  assert.match(launch, /^size: routed small, measured big → using big$/m);
  assert.match(launch, /whole-diff pass/);
});

// 2026-11-12 (user-approved sizes): Small and Medium get one fresh-eyes review; only Big gets the full round.
// The focused budget stays for tiny and small: a medium change keeps the full brief and the checklist sentence.
test('a medium change gets one review, the Claude fresh eyes with the full brief; a big change keeps every launch line', () => {
  const args = { brief: 'C:/n/brief.md', fresh: 'C:/n/brief-fresh.md', repo: 'C:/r', branch: 'b' };
  const reviewers = text => text.split('\n').filter(l => l.startsWith('You are the independent reviewer'));
  const medium = buildLaunch({ ...args, size: 'medium' });
  assert.match(medium, /^\(A medium change: one review, with the full brief; user-approved sizes 2026-11-12\.\)$/m);
  assert.equal(reviewers(medium).length, 1);
  assert.match(reviewers(medium)[0], /FRESH EYES whole-PR review\. Read and follow only the brief at C:\/n\/brief-fresh\.md/);
  assert.match(reviewers(medium)[0], /Fill the coverage checklist lines that apply/, 'the one review fills the checklist the whole-diff pass filled');
  assert.doesNotMatch(medium, /whole-diff pass|codex exec|A tiny or small change/);
  assert.doesNotMatch(medium, /Test designer/, 'the designer is a Big-task seat (2026-11-13)');
  assert.match(buildLaunch({ ...args, size: 'big' }), /## Test designer/, 'a big change keeps the designer line');
  const mediumFacts = { ...facts, size: 'SIZE: medium (diff) — the shared API contract (src/api/x.ts)' };
  assert.doesNotMatch(buildBrief({ ...base, facts: mediumFacts }), /## Focused brief/);
  assert.doesNotMatch(buildFreshBrief({ ...base, facts: mediumFacts }), /## Focused brief/);
  for (const size of ['tiny', 'small']) {
    const one = buildLaunch({ ...args, size });
    assert.match(one, /^\(A tiny or small change: only this one review, user rule 2026-11-11\.\)$/m, size);
    assert.equal(reviewers(one).length, 1, size);
    assert.doesNotMatch(one, /Fill the coverage checklist|whole-diff pass|codex exec/, size + ' keeps the focused review');
  }
  const big = buildLaunch({ ...args, size: 'big' });
  // 2026-11-15: a big change also gets the risk-files reviewer, right after the Claude fresh eyes.
  assert.deepEqual(reviewers(big).map(l => l.split('. ')[0]), ['You are the independent reviewer — FRESH EYES whole-PR review', 'You are the independent reviewer — risk files pass (Pass A)', 'You are the independent reviewer — whole-diff pass']);
  assert.match(big, /codex exec -s read-only/);
  assert.doesNotMatch(reviewers(big)[0], /Fill the coverage checklist/, 'big: the fresh eyes line is unchanged');
  assert.doesNotMatch(big, /A medium change|A tiny or small change/);
});

// 2026-11-15: loop.md and CLAUDE.md give a Big change a risk reviewer on the risk files with a trace list, and
// launch.md had no such line: the author typed its prompt by hand. The Test designer's area was a placeholder.
const riskArgs = { brief: 'C:/n/brief.md', fresh: 'C:/n/brief-fresh.md', repo: 'C:/r', branch: 'b' };
const riskChanged = [{ name: 'Api/Controllers/FilesController.cs' }, { name: 'Api/Services/Storage.cs', untracked: true }, { name: 'web/src/Page.tsx' }, { name: 'Api.Tests/FilesControllerTests.cs' }];
const riskFacts = { stack: '', size: 'SIZE: big (diff) — server access rules (FilesController.cs); server file or URL handling (FilesController.cs, Storage.cs)', callers: '', signals: { access: ['FilesController.cs'], files: ['FilesController.cs', 'Storage.cs'] } };
const riskBlock = launch => launch.split('## Risk files (Claude) — Agent independent-reviewer, run_in_background\n\n')[1].split('\n\n')[0];
const ACCESS_Q = 'Can a caller without the right role, school/tenant or ownership read or change data through any changed path? Trace anonymous, wrong role, and a signed-in user who does not own the row.';
const FILES_Q = 'Can a caller-supplied key, path, id or URL reach a stored object or URL it does not own (every spelling the code normalizes: encoded, relative, absolute, doubled prefixes, dot segments)?';
const CLOSING_Q = 'Does a refused or failed request leave any row half-written, or leak an internal value (a key, a signature, whether an object exists)?';

test('a big change adds the risk-files reviewer after the Claude fresh eyes: repo paths, one question per signal, the closing question', () => {
  const launch = buildLaunch({ ...riskArgs, size: 'big', facts: riskFacts, changed: riskChanged });
  assert.deepEqual(launch.split(/^## /m).slice(1).map(s => s.split('\n')[0]), ['Test designer — Agent braintrust-expert-sonnet, run_in_background',
    'Fresh eyes (Claude) — Agent independent-reviewer, run_in_background', 'Risk files (Claude) — Agent independent-reviewer, run_in_background',
    'Whole diff (Claude) — Agent routine-reviewer, run_in_background', 'Fresh eyes (Codex) — Bash, run_in_background']);
  const risk = riskBlock(launch);
  assert.ok(risk.startsWith('You are the independent reviewer — risk files pass (Pass A). Read and follow the brief at C:/n/brief.md, including its Rules section. Do not open any other file in that folder.'), risk);
  // The stop and push guards count a reviewer run by this start (hooks/lib/transcript-scan.js, REVIEWER_PROMPT).
  assert.match(risk, /^\s*You are the independent reviewer\b/i);
  assert.match(risk, /Read-only: no builds, no tests, no edits\./);
  assert.match(risk, /^- Api\/Controllers\/FilesController\.cs — server access rules; server file or URL handling$/m);
  assert.match(risk, /^- Api\/Services\/Storage\.cs — server file or URL handling \(new, not in git yet: read the whole file — `git diff` does not show it\)$/m);
  assert.doesNotMatch(risk, /Page\.tsx|FilesControllerTests/, 'only the files the size check names');
  assert.deepEqual(risk.split('\nTrace list:\n')[1].split('\n'), [`1. ${ACCESS_Q}`, `2. ${FILES_Q}`, `3. ${CLOSING_Q}`]);
  // The Test designer's area: every changed file, code first, then the changed tests.
  assert.match(launch, /Area: the changed files Api\/Controllers\/FilesController\.cs, Api\/Services\/Storage\.cs, web\/src\/Page\.tsx; the changed tests Api\.Tests\/FilesControllerTests\.cs\. Deliver per your guide\./);
  assert.doesNotMatch(launch, /author fills/);
});

test('a tiny, small or medium change gets no risk-files line and no designer, whatever the size check named', () => {
  for (const size of ['tiny', 'small', 'medium']) {
    const plain = buildLaunch({ ...riskArgs, size });
    assert.equal(buildLaunch({ ...riskArgs, size, facts: riskFacts, changed: riskChanged }), plain, size);
    assert.doesNotMatch(plain, /Risk files|risk files pass|Area:/, size);
  }
});

test('a big change with no risk file named puts every changed file that is not a test in scope and asks every question', () => {
  const unknown = riskBlock(buildLaunch({ ...riskArgs, size: 'big', facts: { stack: '', size: '', callers: '', failed: 'x', signals: null }, changed: riskChanged }));
  assert.match(unknown, /\nRisk files \(the size check gave no signals: every changed file that is not a test\):\n- Api\/Controllers\/FilesController\.cs\n- Api\/Services\/Storage\.cs \(new, not in git yet[^\n]*\n- web\/src\/Page\.tsx\nTrace list \(the size check gave no signals: answer each question that applies; n\/a for the rest\):\n1\. /);
  const questions = unknown.split(/\nTrace list[^\n]*\n/)[1].split('\n');
  assert.equal(questions.length, 16, 'fifteen signal questions and the closing one');
  assert.ok(questions.includes(`1. ${ACCESS_Q}`) && questions.some(q => q.endsWith(FILES_Q)));
  assert.equal(questions[questions.length - 1], `16. ${CLOSING_Q}`);
  // Routed big, measured with no risk signal: the same, with its own reason.
  assert.match(riskBlock(buildLaunch({ ...riskArgs, size: 'big', facts: { ...riskFacts, signals: { clientState: ['Page.tsx'] } }, changed: riskChanged })), /\nRisk files \(the size check named no risk file: every changed file that is not a test\):\n/);
  const empty = buildLaunch({ ...riskArgs, size: 'big', facts: riskFacts, changed: [] });
  assert.match(riskBlock(empty), /^- FilesController\.cs — server access rules; server file or URL handling$/m, 'a name no changed file has stays as the check gave it');
  assert.match(riskBlock(buildLaunch({ ...riskArgs, size: 'big' })), /\n- none yet: the files in the brief's Changed files section\n/);
  assert.match(empty, /Area: no changed file yet: the places on the brief's places list\. Deliver per your guide\./);
});

test('risk files: a base name two changed files share names both; a function with many callers names its file; the split and client state name none', () => {
  const changed = [{ name: 'a/Service.cs' }, { name: 'b/Service.cs' }, { name: 'src/Rules.cs' }];
  assert.deepEqual(riskFiles({ money: ['Gone.cs'], access: ['Service.cs'] }, changed).map(f => f.name), ['a/Service.cs', 'b/Service.cs', 'Gone.cs']);
  const signals = signalFiles({ signals: { callersMany: ['Apply ×18'], split: ['31 code files, 500 lines'], clientState: ['Page.tsx'] },
    callers: [{ name: 'Apply', file: 'src/Rules.cs', count: 18 }, { name: 'Other', file: 'src/O.cs', count: 2 }] });
  assert.deepEqual(signals, { callersMany: ['src/Rules.cs'], split: [], clientState: ['Page.tsx'] });
  assert.deepEqual(riskFiles(signals, changed).map(f => [f.name, f.labels.join('; ')]), [['src/Rules.cs', 'a changed function with more than 10 callers']]);
});

// 2026-11-17: the size check writes "name ×?" for an unknown count and "base:name ×n" in plan mode; the row is found by the function name.
test('risk files: an unknown caller count, a plan-mode prefix and two same-named definitions still name their files', () => {
  const callers = [{ name: 'Apply', file: 'src/Rules.cs', count: null }, { name: 'Apply', file: 'src/Other.cs', count: 12 }, { name: 'Else', file: 'src/E.cs', count: 3 }];
  assert.deepEqual(signalFiles({ signals: { callersMany: ['Apply ×?'] }, callers }).callersMany, ['src/Rules.cs', 'src/Other.cs']);
  assert.deepEqual(signalFiles({ signals: { callersMany: ['Rules.cs:Apply ×?'] }, callers }).callersMany, ['src/Rules.cs', 'src/Other.cs']);
  assert.deepEqual(signalFiles({ signals: { callersMany: ['Apply ×18'] }, callers: [callers[0]] }).callersMany, ['src/Rules.cs']);
  assert.deepEqual(signalFiles({ signals: { callersMany: ['Apply ×?'] }, callers: [callers[2]] }).callersMany, [], 'a different name is not listed');
});

test('the command gives a big change its risk-files line from the size check, as repo paths', () => {
  const repo = fs.mkdtempSync(path.join(root, 'repo-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'F'); git('config', 'user.email', 'f@example.invalid');
  fs.mkdirSync(path.join(repo, 'Api/Controllers'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'Api/Controllers/FilesController.cs'), 'public class FilesController\n{\n    public int Upload(int file) => 1;\n}\n');
  git('add', '-A'); git('commit', '-qm', 'base'); git('switch', '-q', '-c', 'fix/r');
  fs.writeFileSync(path.join(repo, 'Api/Controllers/FilesController.cs'), 'public class FilesController\n{\n    [Authorize(Roles = "Admin")]\n    public int Upload(IFormFile file) => 1;\n}\n');
  const notes = fs.mkdtempSync(path.join(root, 'notes-'));
  const ticket = path.join(notes, 'ticket.md'), lines = path.join(notes, 'lines.md'), check = path.join(notes, 'check.md'), out = path.join(notes, 'brief.md');
  fs.writeFileSync(ticket, 'only admins upload\n'); fs.writeFileSync(lines, '- only admins upload\n'); fs.writeFileSync(check, '- [T1] only admins upload\n');
  const r = spawnSync(process.execPath, [script, '--out', out, '--ticket', ticket, '--lines', lines, '--check', check, '--repo', repo, '--base', 'main', '--outside', path.join(notes, 'none.md'),
    '--places', placesFor(repo, 'Upload', 'C1')], { encoding: 'utf8', env, windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(out, 'utf8'), /^SIZE: big \(diff\) — server access rules \(FilesController\.cs\); server file or URL handling \(FilesController\.cs\)$/m, 'the brief keeps the size check\'s own text line');
  const launch = fs.readFileSync(path.join(notes, 'launch.md'), 'utf8');
  const risk = riskBlock(launch);
  assert.match(risk, /^You are the independent reviewer — risk files pass \(Pass A\)\. Read and follow the brief at .*\/brief\.md, including its Rules section\./);
  assert.match(risk, /^- Api\/Controllers\/FilesController\.cs — server access rules; server file or URL handling$/m);
  assert.deepEqual(risk.split('\nTrace list:\n')[1].split('\n'), [`1. ${ACCESS_Q}`, `2. ${FILES_Q}`, `3. ${CLOSING_Q}`]);
  assert.match(launch, /Area: the changed files Api\/Controllers\/FilesController\.cs\. Deliver per your guide\./);
});

test('the command gives a change measured medium one review, with the full brief', () => {
  const repo = fs.mkdtempSync(path.join(root, 'repo-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'F'); git('config', 'user.email', 'f@example.invalid');
  fs.mkdirSync(path.join(repo, 'src/api'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src/api/users.ts'), 'export const getUsers = () => 1;\n');
  git('add', '-A'); git('commit', '-qm', 'base'); git('switch', '-q', '-c', 'fix/m');
  fs.writeFileSync(path.join(repo, 'src/api/users.ts'), 'export const getUsers = () => 2;\n');
  const notes = fs.mkdtempSync(path.join(root, 'notes-'));
  const ticket = path.join(notes, 'ticket.md'), lines = path.join(notes, 'lines.md'), check = path.join(notes, 'check.md'), out = path.join(notes, 'brief.md');
  fs.writeFileSync(ticket, 'users is 2\n'); fs.writeFileSync(lines, '- users is 2\n'); fs.writeFileSync(check, '- [T1] users is 2\n');
  const r = spawnSync(process.execPath, [script, '--out', out, '--ticket', ticket, '--lines', lines, '--check', check, '--repo', repo, '--base', 'main', '--outside', path.join(notes, 'none.md'),
    '--places', placesFor(repo, 'getUsers', 'C1')], { encoding: 'utf8', env, windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(out, 'utf8'), /^SIZE: medium /m, 'the fixture measures medium');
  const launch = fs.readFileSync(path.join(notes, 'launch.md'), 'utf8');
  assert.match(launch, /A medium change: one review, with the full brief/);
  assert.equal(launch.split('\n').filter(l => l.startsWith('You are the independent reviewer')).length, 1);
  assert.doesNotMatch(launch, /codex exec/);
  for (const name of ['brief.md', 'brief-fresh.md']) assert.doesNotMatch(fs.readFileSync(path.join(notes, name), 'utf8'), /## Focused brief/, name);
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
  // --missed is still accepted, and ignored (2026-11-12).
  const r = spawnSync(process.execPath, [script, '--out', out, '--ticket', ticket, '--lines', lines, '--check', check, '--repo', repo, '--base', 'main', '--size', 'small', '--outside', path.join(notes, 'none.md'), '--missed', path.join(notes, 'none.md'),
    '--places', placesFor(repo, 'AddX', 'none: the new migration is the change itself')], { encoding: 'utf8', env, windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^size: routed small, measured big → using big$/m);
  const launch = fs.readFileSync(path.join(notes, 'launch.md'), 'utf8');
  assert.match(launch, /^size: routed small, measured big → using big$/m);
  assert.match(launch, /whole-diff pass/, 'the full round');
  assert.doesNotMatch(fs.readFileSync(out, 'utf8'), /## Focused brief/);
  const bad = spawnSync(process.execPath, [script, '--out', out, '--ticket', ticket, '--lines', lines, '--check', check, '--repo', repo, '--base', 'main', '--size', 'huge'], { encoding: 'utf8', env, windowsHide: true });
  assert.equal(bad.status, 2, 'an unknown --size is a usage error');
});

// 2026-11-12: rule 1 as a program. A change that is not text only gets no brief until every place that uses
// what it touches is listed by search and has an outcome.
test('the command refuses a change that is not tiny with no places list, or with an open place', () => {
  const repo = fs.mkdtempSync(path.join(root, 'repo-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'F'); git('config', 'user.email', 'f@example.invalid');
  fs.writeFileSync(path.join(repo, 'rules.js'), 'export const dueAfterPublish = (d, p) => d > p;\n');
  fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
  git('add', '-A'); git('commit', '-qm', 'base'); git('switch', '-q', '-c', 'fix/p');
  const notes = fs.mkdtempSync(path.join(root, 'notes-'));
  const ticket = path.join(notes, 'ticket.md'), lines = path.join(notes, 'lines.md'), check = path.join(notes, 'check.md'), out = path.join(notes, 'brief.md');
  fs.writeFileSync(ticket, 'due after publish\n'); fs.writeFileSync(lines, '- due after publish\n'); fs.writeFileSync(check, '- [T1] due after publish on both paths\n');
  const brief = (...extra) => spawnSync(process.execPath, [script, '--out', out, '--ticket', ticket, '--lines', lines, '--check', check, '--repo', repo, '--base', 'main', '--outside', path.join(notes, 'none.md'), ...extra], { encoding: 'utf8', env, windowsHide: true });

  // A text-only change needs no list.
  fs.writeFileSync(path.join(repo, 'README.md'), 'y\n');
  const tiny = brief();
  assert.equal(tiny.status, 0, tiny.stderr);
  assert.match(tiny.stdout, /places: none \(text-only change\)/);
  assert.doesNotMatch(fs.readFileSync(out, 'utf8'), /## Places that use/);
  fs.rmSync(out);

  fs.writeFileSync(path.join(repo, 'rules.js'), 'export const dueAfterPublish = (d, p) => d >= p;\n');
  const none = brief();
  assert.equal(none.status, 2);
  // The repo as git names it: on CI the temp folder is RUNNER~1 to Node and runneradmin to git (2026-11-13).
  const cmd = `node ${placesScript.replace(/\\/g, '/')} --repo ${fs.realpathSync.native(repo).replace(/\\/g, '/')} --names <names> --out <notes>/places.md`;
  assert.ok(none.stderr.split(/\r?\n/)[0].toLowerCase().startsWith(('REVIEW-BRIEF: no --places: a small change needs the list of every place that uses what it changes: ' + cmd).toLowerCase()), none.stderr);
  assert.equal(fs.existsSync(out), false, 'no brief written');

  const open = brief('--places', placesFor(repo, 'dueAfterPublish', ''));
  assert.equal(open.status, 2);
  assert.match(open.stderr.split(/\r?\n/)[0], /^REVIEW-BRIEF: places: 1 open place\(s\) in .*places\.md \(P1\): write C<n> or none: <reason> after each →, then run this again$/);
  const beyond = brief('--places', placesFor(repo, 'dueAfterPublish', 'C2'));
  assert.equal(beyond.status, 2, 'C2 names no check line: there is one');
  assert.match(beyond.stderr, /\(P1 — C2 is not a check line \(C1\.\.C1\)\)/);
  assert.equal(fs.existsSync(out), false, 'no brief written');

  // A place that appears after the list was written is found again here, and is open.
  const list = placesFor(repo, 'dueAfterPublish', 'C1');
  fs.writeFileSync(path.join(repo, 'publish.js'), "import { dueAfterPublish } from './rules.js';\n");
  const late = brief('--places', list);
  assert.equal(late.status, 2);
  assert.match(late.stderr, /1 open place\(s\) in .* \(P2\)/);
  fs.writeFileSync(list, fs.readFileSync(list, 'utf8').replace(/→ $/m, '→ C1'));
  const ok = brief('--places', list);
  assert.equal(ok.status, 0, ok.stderr);
  const written = fs.readFileSync(out, 'utf8');
  assert.match(written, /^- P1 · dueAfterPublish · rules\.js · dueAfterPublish · lines 1 → C1$/m, 'the brief names the function of each place');
  assert.match(written, /^- P2 \(new\) · dueAfterPublish · publish\.js · \(file\) · lines 1 → C1$/m);
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

// 2026-11-12 (audit C23): a size check that crashed or timed out left "Callers: none yet" in the brief.
test('a failed size check is named in the brief', () => {
  const brief = buildBrief({ ...base, facts: { stack: '', size: '', callers: '', failed: 'fatal: bad revision' } });
  assert.match(brief, /^SIZE CHECK FAILED: fatal: bad revision$/m);
  assert.doesNotMatch(brief, /Callers: none yet/);
  const dir = fs.mkdtempSync(path.join(root, 'fake-'));
  const crash = path.join(dir, 'crash.mjs'), slow = path.join(dir, 'slow.mjs');
  fs.writeFileSync(crash, "process.stderr.write('SIZE: fatal: Not a valid object name main\\nUsage: x\\n'); process.exit(2);\n");
  fs.writeFileSync(slow, 'setTimeout(() => {}, 20000);\n');
  assert.equal(sizeFacts(dir, 'main', { script: crash }).failed, 'fatal: Not a valid object name main');
  assert.equal(sizeFacts(dir, 'main', { script: crash }).signals, null, 'no answer, no signals: launch.md then asks every question');
  assert.match(sizeFacts(dir, 'main', { script: slow, timeout: 700 }).failed, /^timed out after \d+ s$/);
});

// 2026-11-16 (PR #784: a teammate found 6 real issues after 5 reviewers passed it). The author's design choice was a
// plain Check line that reviewers only confirmed, and weak spots passed because "the old code does it too".
test('[design] Check lines are accepted, and both briefs list them as claims to attack', () => {
  const ticketLines = ['send the role change to core-api'];
  const checks = ['[T1] the new role reaches core-api', '[design] the send removes only the role this edit removed', '[T1, design] the send runs after the save'];
  assert.deepEqual(coverageProblems(ticketLines, checks), []);
  assert.deepEqual(checkSources('[T1, design] x'), ['T1', 'design']);
  const args = { repo: 'C:/r', branch: 'b', base: 'origin/staging', mergeBase: 'a'.repeat(40), ticket: 't', ticketLines, checks, outside: { other: [], touched: [] }, facts: { stack: '', size: '', callers: '' } };
  for (const brief of [buildBrief(args), buildFreshBrief(args)]) {
    const block = brief.split("## Author's design choices — attack these: is there a better way, or one the repo already uses?")[1];
    assert.ok(block, brief);
    const listed = block.trim().split(/\n\n/)[0].split('\n');
    assert.deepEqual(listed, ['- C2. [design] the send removes only the role this edit removed', '- C3. [T1, design] the send runs after the save']);
  }
  // Fresh eyes still get no plain Check line: only the design claims.
  assert.doesNotMatch(buildFreshBrief(args), /the new role reaches core-api/);
  assert.doesNotMatch(buildBrief({ ...args, checks: ['[T1] the new role reaches core-api'] }), /Author's design choices/);
});

test('the rules make reviewers attack the design and refuse "the old code does it too"', () => {
  const args = { repo: 'C:/r', branch: 'b', base: 'origin/staging', mergeBase: 'a'.repeat(40), ticket: 't', ticketLines: ['x y z'], checks: ['[T1] x'], outside: { other: [], touched: [] }, facts: { stack: '', size: '', callers: '' } };
  for (const brief of [buildBrief(args), buildFreshBrief(args)]) {
    const rules = brief.split('## Rules')[1];
    assert.match(rules, /Attack the design, not only the code: is this the best way to do the job, and does the repo already do the same kind of job another way/);
    assert.match(rules, /"The old code does it too" or "the other calls do the same" is never a pass/);
  }
});

test('--coverage: a Check line in the wrong shape fails with its reason; a right one passes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-coverage-'));
  const lines = path.join(dir, 'lines.md'), check = path.join(dir, 'check.md');
  fs.writeFileSync(lines, '# Lines\n\nT1. the notice can name the wrong section\n');
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'review-brief.mjs');
  const run = () => spawnSync(process.execPath, [script, '--coverage', '--lines', lines, '--check', check], { encoding: 'utf8', windowsHide: true });
  fs.writeFileSync(check, '- C1 [T1] the wrong shape: the number before the source\n');
  let r = run();
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^C1 names no source \(\[T1\], \[change\], \[rule: \.\.\.\] or \[design\]\)/m);
  assert.match(r.stdout, /^T1 has no Check line/m);
  fs.writeFileSync(check, '- [T1] the right shape\n- [design] the author\'s choice\n');
  r = run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^CHECK LINES: 2 line\(s\), each with its source; T1\.\.T1 covered$/m);
  fs.rmSync(dir, { recursive: true, force: true });
});

// 2026-11-17 (audit S4): on a Big task the Test designer runs before code and its cases become the tests. launch.md
// listed it again after the proof, and "launch every line" repeated the planning.
test('a big launch holds no Test designer line once the designer ran, and says why in one line; small and medium are unchanged', () => {
  const args = { ...riskArgs, facts: riskFacts, changed: riskChanged };
  const headings = text => text.split(/^## /m).slice(1).map(s => s.split(' — ')[0]);
  const reviewers = ['Fresh eyes (Claude)', 'Risk files (Claude)', 'Whole diff (Claude)', 'Fresh eyes (Codex)'];
  const fromFreshEyes = text => text.slice(text.indexOf('## Fresh eyes (Claude)'));
  // Big, and a size not known (the full round too).
  for (const size of ['big', '']) {
    const open = buildLaunch({ ...args, size });
    assert.deepEqual(headings(open), ['Test designer', ...reviewers], 'no report yet: the designer line stays');
    assert.match(open, /^\(Launch it before code\. After that, launch it only for a requirement that changed after the plan: /m, 'the kept line says when to launch it again');
    assert.doesNotMatch(open, /already ran before code/);
    for (const done of ['test-designer.md', '--designer-done']) {
      const launch = buildLaunch({ ...args, size, designerDone: done });
      assert.deepEqual(headings(launch), reviewers, done);
      assert.doesNotMatch(launch, /Seat: Test designer|braintrust-expert-sonnet|a requirement that changed/, done);
      assert.equal(launch.split('\n').filter(l => l.startsWith('Test designer')).join('|'), `Test designer: already ran before code (${done})`, 'one line says why it is not launched');
      assert.equal(fromFreshEyes(launch), fromFreshEyes(open), 'the four reviewers are launched as before');
    }
  }
  // Small and Medium never had the line: a saved report changes nothing for them.
  for (const size of ['tiny', 'small', 'medium']) {
    const one = buildLaunch({ ...args, size, designerDone: 'test-designer.md' });
    assert.equal(one, buildLaunch({ ...args, size }), size);
    assert.doesNotMatch(one, /Test designer/, size);
  }
});

test('the command leaves the Test designer out of a big launch when its report is in the notes folder, or with --designer-done', () => {
  const repo = fs.mkdtempSync(path.join(root, 'repo-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'F'); git('config', 'user.email', 'f@example.invalid');
  fs.mkdirSync(path.join(repo, 'Api/Controllers'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'Api/Controllers/FilesController.cs'), 'public class FilesController\n{\n    public int Upload(int file) => 1;\n}\n');
  git('add', '-A'); git('commit', '-qm', 'base'); git('switch', '-q', '-c', 'fix/d');
  fs.writeFileSync(path.join(repo, 'Api/Controllers/FilesController.cs'), 'public class FilesController\n{\n    [Authorize(Roles = "Admin")]\n    public int Upload(IFormFile file) => 1;\n}\n');
  const notes = fs.mkdtempSync(path.join(root, 'notes-'));
  const ticket = path.join(notes, 'ticket.md'), lines = path.join(notes, 'lines.md'), check = path.join(notes, 'check.md'), out = path.join(notes, 'brief.md');
  fs.writeFileSync(ticket, 'only admins upload\n'); fs.writeFileSync(lines, '- only admins upload\n'); fs.writeFileSync(check, '- [T1] only admins upload\n');
  const places = placesFor(repo, 'Upload', 'C1');
  // The extra options come first, so --designer-done is followed by another option: it takes no value.
  const launchLines = (...extra) => {
    const r = spawnSync(process.execPath, [script, ...extra, '--out', out, '--ticket', ticket, '--lines', lines, '--check', check, '--repo', repo, '--base', 'main', '--outside', path.join(notes, 'none.md'), '--places', places], { encoding: 'utf8', env, windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
    return fs.readFileSync(path.join(notes, 'launch.md'), 'utf8').split(/\r?\n/);
  };
  const reviewerCount = rows => rows.filter(l => l.startsWith('You are the independent reviewer')).length;
  // No report (an empty file is none): the line stays and says when to launch it again.
  fs.writeFileSync(path.join(notes, 'test-designer.md'), '\n');
  let rows = launchLines();
  assert.ok(rows.includes('## Test designer — Agent braintrust-expert-sonnet, run_in_background'), 'the fixture is big and has no report: the designer line stays');
  assert.equal(rows.filter(l => /only for a requirement that changed after the plan/.test(l)).length, 1);
  assert.ok(!rows.some(l => /already ran before code/.test(l)));
  fs.rmSync(path.join(notes, 'test-designer.md'));
  for (const name of ['test-designer.md', 'test-designer-report.md', 'test-design.md']) {
    fs.writeFileSync(path.join(notes, name), 'SETUP\n- an admin\nCASES\n1. an admin uploads\nBREAKS\n- drop the role\n');
    rows = launchLines();
    assert.ok(!rows.some(l => /^## Test designer|Seat: Test designer/.test(l)), name + ': no designer launch');
    assert.ok(rows.includes(`Test designer: already ran before code (${name})`), name + ': the reason line names the file');
    assert.equal(reviewerCount(rows), 3, name + ': the reviewers stay');
    assert.ok(rows.some(l => l.includes('codex exec -s read-only')), name + ': the other engine stays');
    fs.rmSync(path.join(notes, name));
  }
  rows = launchLines('--designer-done');
  assert.ok(!rows.some(l => /^## Test designer|Seat: Test designer/.test(l)), '--designer-done: no designer launch');
  assert.ok(rows.includes('Test designer: already ran before code (--designer-done)'));
  assert.equal(reviewerCount(rows), 3);
  // A requirement changed after the report was saved: the designer must run again, so its line stays.
  const report = path.join(notes, 'test-designer.md');
  fs.writeFileSync(report, 'SETUP\nCASES\nBREAKS\n');
  const hourAgo = new Date(Date.now() - 3600e3);
  fs.utimesSync(report, hourAgo, hourAgo);
  rows = launchLines();
  assert.ok(rows.includes('## Test designer — Agent braintrust-expert-sonnet, run_in_background'), 'stale report: the designer line stays');
  assert.ok(!rows.some(l => /already ran before code/.test(l)));
  const old = new Date(Date.now() - 7200e3);
  fs.utimesSync(lines, old, old); fs.utimesSync(check, old, old);
  rows = launchLines();
  assert.ok(rows.includes('Test designer: already ran before code (test-designer.md)'), 'report newer than the requirements: left out');
});

// 2026-11-17 (audit, review brief): fresh eyes never see the Check lines, and a ticket seldom names every access,
// concurrency or rollback rule. A missing test for a rule the change itself adds was only an EXTRA TEST line.
test('a missing test for a rule this change adds, widens or newly exposes is a Gap in both briefs; EXTRA TEST stays for the rest', () => {
  const args = { repo: 'C:/r', branch: 'b', base: 'origin/staging', mergeBase: 'a'.repeat(40), ticket: 't', ticketLines: ['x y z'], checks: ['[T1] x'], outside: { other: [], touched: [] }, facts: { stack: '', size: '', callers: '' } };
  for (const [name, brief] of [['framed', buildBrief(args)], ['fresh', buildFreshBrief(args)]]) {
    const rules = brief.split('## Rules')[1].split(/\r?\n/).filter(l => l.startsWith('- '));
    assert.equal(rules.length, 5, name + ': still five rules, the sentence joins the test rule');
    const rule = rules.find(l => l.includes('`EXTRA TEST:` line')) || '';
    assert.match(rule, /^- A test weakness on a Check line is reported as a concrete break/, name);
    assert.match(rule, /a missing test for a correctness or security rule that this change adds, widens or newly exposes \(access, tenant, a concurrent or repeated request, a rollback, a failure path\) is a `Gap` finding, whatever the ticket says/, name);
    assert.match(rule, /`EXTRA TEST:` is for every other case\.$/, name);
  }
});

// 2026-11-18 (audit finding 6): buildLaunch had no engine input. Every size printed "Fresh eyes (Claude)", and a Big plan
// printed Claude seats plus Codex as the other engine, whatever engine the task had chosen.
const engArgs = { brief: 'C:/n/brief.md', fresh: 'C:/n/brief-fresh.md', repo: 'C:/r', branch: 'b' };
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const seats = t => t.split(/^## /m).slice(1).map(s => s.split('\n')[0]);
const stripEngine = t => t.replace(/^Engine: [^\n]*\n\n/m, '');

// MUST NOT CHANGE (fails only on the engine line on the old code): the Claude plan is byte for byte today's.
test('the Claude plan is unchanged except its engine line', () => {
  const gold = { small: 'e63e00d983b7d592c25f66b326c13151bef8daebcc6dd02d892f86b4e8d90caf', medium: 'f14462e6112ef3469d1bab02d8f4c97d456fd358f5f43662e9bf072e9db6a09a', big: '8eb4a517fcf9b9101897ba02e9aa19b19dbc7e1db59aeeed23253d6a2f9b5256' };
  for (const size of ['small', 'medium', 'big']) {
    assert.equal(sha(stripEngine(buildLaunch({ ...engArgs, size, engine: 'claude' }))), gold[size], size);
    assert.equal(buildLaunch({ ...engArgs, size }), buildLaunch({ ...engArgs, size, engine: 'claude' }), size + ': claude is the default');
  }
});

test('every launch file says in its first lines which engine it was built for', () => {
  for (const size of ['small', 'medium', 'big', '']) {
    const claude = buildLaunch({ ...engArgs, size, engine: 'claude' }).split('\n').slice(0, 4).join('\n');
    const codex = buildLaunch({ ...engArgs, size, engine: 'codex' }).split('\n').slice(0, 4).join('\n');
    assert.match(claude, /^Engine: Claude\b/m, size);
    assert.match(codex, /^Engine: Codex\b/m, size);
  }
});

test('a Codex task: small and medium get one Codex fresh-eyes review and no Claude agent', () => {
  for (const size of ['tiny', 'small', 'medium']) {
    const launch = buildLaunch({ ...engArgs, size, engine: 'codex' });
    assert.deepEqual(seats(launch), ['Fresh eyes (Codex) — Bash, run_in_background'], size);
    assert.doesNotMatch(launch, /Agent independent-reviewer|Agent routine-reviewer|Agent braintrust|Fresh eyes \(Claude\)/, size);
    assert.match(launch, /codex exec -s read-only -c model_reasoning_effort="xhigh" -C "C:\/r" -o "C:\/n\/codex-fresh\.md"/, size);
    // 2026-11-18 (finding 2): fresh eyes is the risk reviewer again (loop-rare-cases.md), not the whole-diff role.
    assert.match(launch, /Your Codex role is sanad-risk-reviewer/, size);
    assert.doesNotMatch(launch, /sanad-reviewer\b/, size);
    assert.match(launch, /Read and follow only the brief at C:\/n\/brief-fresh\.md/, size);
    assert.equal((launch.match(/"You are the independent reviewer/g) || []).length, 1, size);
  }
  assert.match(buildLaunch({ ...engArgs, size: 'medium', engine: 'codex' }), /Fill the coverage checklist lines that apply/);
  assert.doesNotMatch(buildLaunch({ ...engArgs, size: 'small', engine: 'codex' }), /Fill the coverage checklist/);
});

const CLAUDE_OTHER = 'Fresh eyes (Claude) — Bash, run_in_background (claude -p)';
test('a Codex task: a big plan is Codex designer, fresh eyes, risk files and whole diff, and Claude is the one other engine', () => {
  const launch = buildLaunch({ ...engArgs, size: 'big', engine: 'codex', facts: riskFacts, changed: riskChanged });
  assert.deepEqual(seats(launch), ['Test designer — Bash, run_in_background (Codex sanad-practical-expert)', 'Fresh eyes (Codex) — Bash, run_in_background', 'Risk files (Codex) — Bash, run_in_background',
    'Whole diff (Codex) — Bash, run_in_background', CLAUDE_OTHER]);
  assert.equal((launch.match(/codex exec -s read-only -c model_reasoning_effort="xhigh"/g) || []).length, 4);
  for (const role of ['sanad-practical-expert', 'sanad-reviewer', 'sanad-risk-reviewer']) assert.match(launch, new RegExp(role));
  // Finding 5: the designer's output file is the name the tool accepts as its saved report, so its line leaves after it ran.
  for (const f of ['test-designer.md', 'codex-fresh.md', 'codex-risk.md', 'codex-whole.md']) assert.match(launch, new RegExp(`-o "C:/n/${f.replace('.', '\\.')}"`), f);
  assert.doesNotMatch(launch, /codex-designer\.md/);
  // Finding 4: the other engine is a shell line a Codex host can run (claude -p), never the Claude-only Agent tool.
  assert.equal((launch.match(/Agent /g) || []).length, 0, 'no Claude Agent tool call in a Codex host');
  assert.equal((launch.match(/claude -p --agent independent-reviewer --permission-mode plan /g) || []).length, 1, 'one Claude launch, the other engine');
  assert.match(launch, /> "C:\/n\/claude-fresh\.md" 2> "C:\/n\/claude-fresh\.log"/);
  assert.doesNotMatch(launch, /Agent routine-reviewer|Agent braintrust/);
  // The risk files and the trace list reach the Codex prompt.
  assert.match(launch, /Api\/Controllers\/FilesController\.cs — server access rules/);
  assert.ok(launch.includes(ACCESS_Q) && launch.includes(CLOSING_Q));
  // The Claude other-engine seat is the same one-line fresh eyes.
  assert.match(launch, /You are the independent reviewer — FRESH EYES whole-PR review\. Read and follow only the brief at C:\/n\/brief-fresh\.md/);
  // The designer already ran: the line leaves, the reason stays, the reviewers stay.
  const done = buildLaunch({ ...engArgs, size: 'big', engine: 'codex', designerDone: 'test-designer.md' });
  assert.deepEqual(seats(done), ['Fresh eyes (Codex) — Bash, run_in_background', 'Risk files (Codex) — Bash, run_in_background', 'Whole diff (Codex) — Bash, run_in_background', CLAUDE_OTHER]);
  assert.match(done, /^Test designer: already ran before code \(test-designer\.md\)$/m);
});

test('hostile characters in a risk file name cannot break out of the Codex prompt quotes', () => {
  const nasty = [{ name: 'Api/Controllers/Files"$(id)`x`Controller.cs' }];
  const launch = buildLaunch({ ...engArgs, size: 'big', engine: 'codex', facts: { ...riskFacts, signals: { access: ['Files"$(id)`x`Controller.cs'] } }, changed: nasty });
  assert.doesNotMatch(launch, /[^\\]\$\(id\)|[^\\]`x`/);
  assert.match(launch, /\\"\\\$\(id\)\\`x\\`/);
});

test('the command takes --engine, writes it into launch.md, and refuses another value', () => {
  const repo = fs.mkdtempSync(path.join(root, 'repo-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'F'); git('config', 'user.email', 'f@example.invalid');
  fs.writeFileSync(path.join(repo, 'README.md'), 'x\n'); git('add', '-A'); git('commit', '-qm', 'base'); git('switch', '-q', '-c', 'fix/e');
  fs.writeFileSync(path.join(repo, 'README.md'), 'y\n');
  const notes = fs.mkdtempSync(path.join(root, 'notes-'));
  const ticket = path.join(notes, 'ticket.md'), lines = path.join(notes, 'lines.md'), check = path.join(notes, 'check.md'), out = path.join(notes, 'brief.md');
  fs.writeFileSync(ticket, 'edit\n'); fs.writeFileSync(lines, '- edit\n'); fs.writeFileSync(check, '- [T1] edited\n');
  const run = (...extra) => spawnSync(process.execPath, [script, '--out', out, '--ticket', ticket, '--lines', lines, '--check', check, '--repo', repo, '--base', 'main', '--outside', path.join(notes, 'none.md'), ...extra], { encoding: 'utf8', env, windowsHide: true });
  const launch = () => fs.readFileSync(path.join(notes, 'launch.md'), 'utf8');
  let r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(launch(), /^Engine: Claude\b/m);
  assert.match(r.stdout, /^ENGINE: claude$/m);
  r = run('--engine', 'codex');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ENGINE: codex$/m);
  assert.match(launch(), /^Engine: Codex\b/m);
  assert.match(launch(), /codex exec/);
  assert.doesNotMatch(launch(), /Agent independent-reviewer/);
  r = run('--engine', 'gemini');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--engine must be one of claude, codex/);
});

// Finding 1: the tool runs twice per task (before code, after the proof) and the written command has no --engine.
// The engine is saved in the notes folder when given, read back when absent, and a different value is refused.
test('the engine is kept in the notes folder: a run without --engine keeps it, a different one is refused', () => {
  const repo = fs.mkdtempSync(path.join(root, 'repo-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'F'); git('config', 'user.email', 'f@example.invalid');
  fs.writeFileSync(path.join(repo, 'README.md'), 'x\n'); git('add', '-A'); git('commit', '-qm', 'base'); git('switch', '-q', '-c', 'fix/e');
  fs.writeFileSync(path.join(repo, 'README.md'), 'y\n');
  const notes = fs.mkdtempSync(path.join(root, 'notes-'));
  const ticket = path.join(notes, 'ticket.md'), lines = path.join(notes, 'lines.md'), check = path.join(notes, 'check.md'), out = path.join(notes, 'brief.md');
  fs.writeFileSync(ticket, 'edit\n'); fs.writeFileSync(lines, '- edit\n'); fs.writeFileSync(check, '- [T1] edited\n');
  const run = (...extra) => spawnSync(process.execPath, [script, '--out', out, '--ticket', ticket, '--lines', lines, '--check', check, '--repo', repo, '--base', 'main', '--outside', path.join(notes, 'none.md'), ...extra], { encoding: 'utf8', env, windowsHide: true });
  const launch = () => fs.readFileSync(path.join(notes, 'launch.md'), 'utf8');
  let r = run('--engine', 'codex');
  assert.equal(r.status, 0, r.stderr);
  // The command as loop.md writes it (no --engine): the saved Codex plan stays a Codex plan.
  r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ENGINE: codex$/m);
  assert.match(launch(), /^Engine: Codex\b/m);
  assert.match(launch(), /codex exec/);
  r = run('--engine', 'codex');
  assert.equal(r.status, 0, r.stderr);
  // A different engine for the same task is refused and nothing is rewritten.
  r = run('--engine', 'claude');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /this task's engine is codex/);
  assert.match(launch(), /^Engine: Codex\b/m);
  // An unreadable saved value is refused too, never read as claude.
  fs.writeFileSync(path.join(notes, 'engine.txt'), 'gemini\n');
  r = run();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /engine\.txt/);
});

// Finding 5: the designer's saved report is the file its own launch line writes, so a second run drops the line.
test('a Codex designer report written where its launch line says counts as saved', () => {
  const notes = fs.mkdtempSync(path.join(root, 'notes-'));
  const first = buildLaunch({ brief: notes.replace(/\\/g, '/') + '/brief.md', fresh: notes.replace(/\\/g, '/') + '/brief-fresh.md', repo: 'C:/r', branch: 'b', size: 'big', engine: 'codex' });
  const named = /-o "([^"]*)"/.exec(first.split('## Test designer')[1])[1];
  fs.writeFileSync(named, 'SETUP\nCASES\nBREAKS\n');
  assert.equal(designerReport(notes), path.basename(named));
});

// The remote launcher starts Claude agents only: a Codex task is refused with one line, before any ssh.
const launcher = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'remote', 'orca-launch.sh');
test('orca-launch.sh: --engine codex is refused in one line before ssh; claude is accepted; the file parses', () => {
  // Git's own bash, never plain `bash`: on the test machine that name is the WSL launcher, which has no
  // /bin/bash (2026-11-18: this test failed there and rolled the install back; see scripts/git-bash.mjs).
  const sh = gitBash().exe;
  const shEnv = bashEnv();
  const pathKey = Object.keys(shEnv).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const bash = spawnSync(sh, ['-n', launcher], { encoding: 'utf8', windowsHide: true, env: shEnv });
  assert.equal(bash.status, 0, bash.stderr);
  // ssh and orca are made to fail loudly: a refusal must never reach them.
  const bin = fs.mkdtempSync(path.join(root, 'bin-'));
  for (const n of ['ssh', 'orca']) fs.writeFileSync(path.join(bin, n), '#!/usr/bin/env bash\necho CALLED-' + n + ' >&2\nexit 99\n', { mode: 0o755 });
  const run = (...a) => spawnSync(sh, [launcher, ...a], { encoding: 'utf8', windowsHide: true, env: { ...shEnv, [pathKey]: bin + path.delimiter + (shEnv[pathKey] || '') } });
  for (const args of [['--engine', 'codex', 'env', 'C:/w', 'C:/b.md'], ['--role', 'review', '--engine', 'codex', 'env', 'C:/w', 'C:/b.md'], ['--engine', 'codex', '--role', 'review', 'env', 'C:/w', 'C:/b.md']]) {
    const r = run(...args);
    assert.equal(r.status, 2, args.join(' ') + r.stdout + r.stderr);
    assert.equal(r.stdout.trim().split(/\r?\n/).length, 1, 'one line');
    assert.match(r.stdout, /^REFUSED: remote launches support Claude tasks only/);
    assert.doesNotMatch(r.stdout + r.stderr, /CALLED-/);
  }
  // Finding 3: an option after the positional arguments is refused, never ignored and never put in the prompt.
  for (const args of [['env', 'C:/w', 'C:/b.md', '--engine', 'codex'], ['env', 'C:/w', 'C:/b.md', 'note for part 2', '--engine', 'codex'], ['--engine=codex', 'env', 'C:/w', 'C:/b.md'],
    ['env', 'C:/w', 'C:/b.md', '--engine=codex'], ['env', 'C:/w', 'C:/b.md', 'note', 'extra'], ['env', 'C:/w', 'C:/b.md', '--role', 'review']]) {
    const r = run(...args);
    assert.equal(r.status, 2, args.join(' ') + r.stdout + r.stderr);
    assert.equal(r.stdout.trim().split(/\r?\n/).length, 1, 'one line');
    assert.match(r.stdout, /^REFUSED: /);
    assert.doesNotMatch(r.stdout + r.stderr, /CALLED-/, args.join(' '));
  }
  const bad = run('--engine', 'gemini', 'env', 'C:/w', 'C:/b.md');
  assert.equal(bad.status, 2);
  assert.match(bad.stdout, /^REFUSED: unknown engine/);
  // Claude passes the argument check and reaches ssh (the fake one).
  const ok = run('--engine', 'claude', 'env', 'C:/w', 'C:/b.md');
  assert.match(ok.stdout + ok.stderr, /CALLED-ssh|REFUSED: brief not found/);
  assert.doesNotMatch(ok.stdout, /remote launches support Claude tasks only/);
});
