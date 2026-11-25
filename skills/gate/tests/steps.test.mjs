import test from 'node:test';
import assert from 'node:assert/strict';
import { STEPS, LANES, pathFor, due, render, stopRound, askOwner, q, DEFAULT_STOP_ROUND, switchLines } from '../scripts/steps.mjs';

// The facts of a small task after its first commit; a test changes only what it is about.
function facts(over = {}) {
  const base = {
    lane: 'small', size: 'small', testsOnly: false, last: false, round: 0, stop: 3, base: 'origin/staging',
    switches: { stopRound: '', testsOnlyLane: false, designChoice: false, reviewEarly: false, remoteHost: '' },
    has: { lines: true, places: true, siblings: true, check: true, size: true, breaks: true },
    open: { places: 0, siblings: 0 },
    git: { head: 'h2', headTree: 't2', tree: 't2', clean: true, changed: false, ahead: 1, untracked: 0, foreign: false },
    pins: [], lastPin: null, pinAtHead: false,
    proof: { done: false, early: false, breaks: 0, entries: 0, progress: [], logs: [] },
    // The checks before the proof passed on this code (2026-11-23); a test of that order sets it false.
    checks: { code: undefined, all: undefined, beforeProof: true },
    suite: { done: false, receipt: null, ci: '', mark: 'full' },
    notes: { known: true, all: [], open: [] }, decisions: [], pushed: false,
    // The author read its own diff at this commit (the self-read step is done); a test of that step sets it.
    selfRead: 'h2',
  };
  for (const [k, v] of Object.entries(over)) base[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) ? { ...base[k], ...v } : v;
  return base;
}
const ctx = { gate: '/g', repo: '/r/my repo', notes: '/n', base: 'origin/staging', engine: 'claude', size: 'small', lane: 'small', sides: [{ name: 'page', cwd: '/r/my repo/web', test: 'npx vitest run a.test.ts', fixFiles: ['web/a.ts'] }] };
const text = (f) => render(due(f), ctx, f).join('\n');
const ids = (f) => due(f).map((s) => s.id);

// 2026-11-22 (owner, PR 3 item 1; attack): the author reads its own diff before the checks, and again after a fix
// committed after a review, before the re-check.
test('self-read is due after the commit until recorded for HEAD, and again for a fix after a review', () => {
  assert.deepEqual(ids(facts({ selfRead: '' })), ['self-read']);
  assert.deepEqual(ids(facts({ selfRead: 'h1' })), ['self-read'], 'a record for an older commit does not count');
  assert.notDeepEqual(ids(facts({ selfRead: 'h2' })), ['self-read']);
  const fixRound = { pins: [{ round: 1, kind: 'full', commit: 'h1', ref: 'refs/sanad/review/t/1' }], lastPin: { round: 1, kind: 'full', commit: 'h1', ref: 'refs/sanad/review/t/1' }, pinAtHead: false };
  assert.deepEqual(ids(facts({ ...fixRound, selfRead: 'h1' })), ['self-read'], 'the fix commit h2 is read before the re-check');
  assert.deepEqual(ids(facts({ ...fixRound, selfRead: 'h2' })), ['fix-round']);
  assert.match(text(facts({ selfRead: '' })), /\$ node \S*sanad\.mjs self-read --repo '\/r\/my repo' --notes \/n --found FOUND/);
});

test('step ids are unique', () => {
  const all = STEPS.map((s) => s.id);
  assert.equal(new Set(all).size, all.length);
});

test('every size has a full path from start to the steps after the push', () => {
  for (const lane of LANES) {
    const path = pathFor(lane).map((s) => s.id);
    assert.equal(path[0], 'start', lane);
    assert.equal(path[path.length - 1], 'after-push', lane);
    for (const need of ['size', 'tests-fix', 'commit', 'review', 'notes', 'fix-round', 'last-round', 'verdict', 'gate', 'ready']) assert.ok(path.includes(need), `${lane} has ${need}`);
  }
  // Text only has no list, no break and no proof; the others have all three.
  for (const id of ['places', 'second-look', 'breaks', 'proof']) {
    assert.equal(pathFor('text').some((s) => s.id === id), false, id);
    for (const lane of ['small', 'medium', 'big']) assert.ok(pathFor(lane).some((s) => s.id === id), `${lane} ${id}`);
  }
  assert.throws(() => pathFor('huge'), /unknown size/);
});

test('the tests-only light path drops the places list and the second look, and keeps the proof', () => {
  const light = pathFor('small', { testsOnlyLight: true }).map((s) => s.id);
  for (const id of ['places', 'second-look', 'places-closed']) assert.equal(light.includes(id), false, id);
  for (const id of ['breaks', 'proof']) assert.equal(light.includes(id), false, id);
  assert.ok(light.includes('review'));
  // Without the owner's switch a tests-only change keeps the whole Small path.
  assert.deepEqual(ids(facts({ testsOnly: true, has: { places: false } })), ['places']);
  assert.notDeepEqual(ids(facts({ testsOnly: true, has: { places: false }, switches: { testsOnlyLane: true } })), ['places']);
});

test('Y5: tests-only lane (switch on and tests only) prints no breaks and no proof step; otherwise both stay', () => {
  const noBreaks = { has: { breaks: false }, testsOnly: true, lane: 'small' };
  assert.ok(ids(facts({ ...noBreaks })).includes('breaks'));
  const on = facts({ ...noBreaks, switches: { testsOnlyLane: true } });
  assert.ok(!ids(on).includes('breaks') && !ids(on).includes('proof'));
  assert.ok(!/breaks\.mjs|red-proof/.test(text(on)));
  // The switch alone is not enough: the change must be tests only.
  assert.ok(ids(facts({ has: { breaks: false }, testsOnly: false, switches: { testsOnlyLane: true } })).includes('breaks'));
  // The last round of the light lane is done without a proof.
  const pin = { round: 1, kind: 'recheck', commit: 'h2', ref: 'r' };
  const last = facts({ testsOnly: true, switches: { testsOnlyLane: true }, pins: [pin], lastPin: pin, pinAtHead: true, suite: { done: true }, notes: { known: true, all: [], open: [] } });
  assert.ok(!ids(last).includes('last-round'));
});

test('Y5: the printed gate command carries --notes, so the goals can be counted', () => {
  const gate = STEPS.find((s) => s.id === 'gate');
  assert.match(gate.lines(ctx, facts()).map((l) => l.text).join('\n'), /verdict --gate --repo .* --notes \/n --tests/);
});

// 2026-11-22 (owner): from the stop round on, only a Blocker, a security note and a ticket-line note reopen a round;
// every other open note of the round goes to the owner's list.
test('Y5: the owner list never offers a security or a ticket-line note; any other note of the stop round goes to it', () => {
  const notes = [
    { n: 1, kind: 'Gap', text: 'a rare timing case on a slow network (RARE)', round: 2 },
    { n: 2, kind: 'Gap', text: 'the saved data is deleted on retry', round: 2 },
    { n: 3, kind: 'Gap', text: 'the ticket line 4 is not met (RARE)', round: 2 },
    { n: 4, kind: 'Gap', text: 'a user may get more permissions (RARE)', round: 2 },
    { n: 5, kind: 'Bug', text: 'T2: the header shows the filter count', round: 2 },
    { n: 6, kind: 'Bug', text: 'the add panel shows "no match" when its first page fails', round: 2 },
  ];
  assert.deepEqual(askOwner(notes, 2, 2).map((n) => n.n), [1, 2, 6]);
});

test('a Big task asks the owner for the design only with the switch on', () => {
  assert.equal(pathFor('big').some((s) => s.id === 'design-choice'), false);
  const f = facts({ lane: 'big', git: { ahead: 0 }, switches: { designChoice: true } });
  assert.deepEqual(ids(f), ['design-choice']);
  assert.match(text(f), /ASK: the two designs/);
  assert.notDeepEqual(ids(facts({ lane: 'big', git: { ahead: 0 }, switches: { designChoice: true }, decisions: [{ kind: 'design', words: 'the simple one' }] })), ['design-choice']);
});

test('the stop round comes from the owner number, and a Blocker is never on the owner list', () => {
  assert.equal(stopRound(undefined), DEFAULT_STOP_ROUND);
  assert.equal(stopRound('2'), 2);
  assert.equal(stopRound('zero'), 3);
  const notes = [
    { n: 1, kind: 'Gap', text: 'a rare timing case on a slow network', round: 2 },
    { n: 2, kind: 'Blocker', text: 'the list is empty for every teacher', round: 2 },
    { n: 3, kind: 'Bug', text: 'a student can read a file of another tenant (access)', round: 2 },
    { n: 4, kind: 'Gap', text: '[T2] the due date is not shown', round: 2 },
    { n: 5, kind: 'Gap', text: 'the saved total changes', round: 2, changesOutcome: true },
    { n: 6, kind: 'Bug', text: 'the crash the ticket names', round: 2, confirmedBug: true },
    { n: 7, kind: 'Gap', text: 'an old rare case from round 1', round: 1 },
  ];
  assert.deepEqual(askOwner(notes, 2, 3), []);
  assert.deepEqual(askOwner(notes, 2, 2).map((n) => n.n), [1, 5, 6]);
  assert.deepEqual(askOwner(notes.map((n) => ({ ...n, round: 3 })), 3).map((n) => n.n), [1, 5, 6, 7]);
});

test('with sanad.stopRound 2 the round-2 fix prints the ASK THE OWNER list; with the default it prints at round 3', () => {
  const pin = (n) => ({ round: n, kind: 'full', commit: 'h1', ref: `refs/sanad/review/t/${n}` });
  const open = [{ n: 4, kind: 'Gap', text: 'a rare case on a slow network' }, { n: 5, kind: 'Blocker', text: 'the save is lost' }];
  const round2 = { round: 2, pins: [pin(1), pin(2)], lastPin: pin(2), notes: { known: true, all: open, open } };
  assert.doesNotMatch(text(facts({ ...round2, stop: 3 })), /ASK THE OWNER/);
  const two = text(facts({ ...round2, stop: 2 }));
  assert.match(two, /ASK THE OWNER \(round 2, stop round 2\)/);
  const ownerPart = two.slice(two.indexOf('ASK THE OWNER'));
  assert.match(ownerPart, /NOTE 4: a rare case/);
  assert.doesNotMatch(ownerPart, /NOTE 5/);
  // 2026-11-23: the Blocker is the builder's to fix, so the proof and the re-check wait for it; the owner's note does not hold them.
  assert.match(two, /the proof and the re-check wait: 1 note\(s\) still to fix and answer \(notes\.mjs answer\): NOTE 5/);
  assert.match(text(facts({ ...round2, round: 3, pins: [pin(1), pin(2), pin(3)], lastPin: pin(3), stop: 3 })), /ASK THE OWNER \(round 3, stop round 3\)/);
});

test('after a fix commit the fix round prints --before-proof and --changed-since with the last pin ref', () => {
  const pin = { round: 1, kind: 'full', commit: 'h1', ref: 'refs/sanad/review/t/1' };
  // 2026-11-23 (owner, one proof per round): the checks before the proof run first, in the foreground; the proof and
  // the re-check wait for their pass on this code.
  const unchecked = facts({ round: 1, pins: [pin], lastPin: pin, proof: { done: false }, checks: { beforeProof: false } });
  const first = text(unchecked);
  assert.match(first, /^ {2}\$ node \/g\/pre-review\.mjs --before-proof /m);
  assert.doesNotMatch(first, /BACKGROUND \$ node \/g\/pre-review/);
  assert.match(first, /the proof and the re-check wait: the checks before the proof have not passed on this code/);
  assert.doesNotMatch(first, /red-proof\.mjs|review-brief\.mjs --recheck/);
  const f = facts({ round: 1, pins: [pin], lastPin: pin, proof: { done: false } });
  assert.deepEqual(ids(f), ['fix-round']);
  const out = text(f);
  assert.doesNotMatch(out, /pre-review\.mjs --before-proof/, 'passed on this code: not printed again');
  assert.match(out, /red-proof\.mjs .*--changed-since refs\/sanad\/review\/t\/1 .*\(PARTIAL\)/);
  assert.match(out, /review-brief\.mjs --recheck /);
  assert.doesNotMatch(out, /the last round: the full proof/);
  // 2026-11-25 (owner, "the check fits the change"): next --last prints the partial proof too; the full proof and the
  // suite run once, at the end (the last-round step below), never in a fix round.
  const last = text(facts({ round: 1, pins: [pin], lastPin: pin, last: true }));
  assert.match(last, /red-proof\.mjs .*--changed-since refs\/sanad\/review\/t\/1 .*\(PARTIAL\)/);
  assert.doesNotMatch(last, /the last round: the full proof/);
  assert.doesNotMatch(last, /the full suite, once/);
  // After the last check, with no note open: the full proof and the suite, once.
  const re = { round: 2, kind: 'recheck', short: true, commit: 'h2', ref: 'refs/sanad/review/t/2' };
  const end = text(facts({ round: 1, pins: [pin, re], lastPin: re, pinAtHead: true, proof: { done: false }, notes: { known: true, all: [], open: [] } }));
  assert.match(end, /red-proof\.mjs (?:(?!--changed-since).)*--then-green/);
  assert.match(end, /the full suite, once/);
});

test('after a clean re-check the full proof and the suite are printed; a suite that passed on this tree is not printed again', () => {
  const pin = { round: 2, kind: 'recheck', commit: 'h2', ref: 'refs/sanad/review/t/2' };
  const f = facts({ round: 2, pins: [pin], lastPin: pin, pinAtHead: true, proof: { done: false } });
  assert.deepEqual(ids(f), ['last-round']);
  const out = text(f);
  assert.match(out, /red-proof\.mjs --repo '\/r\/my repo' --old origin\/staging --files web\/a\.ts --breaks \/n\/breaks\.json --then-green/);
  assert.doesNotMatch(out, /--changed-since/);
  assert.match(out, /the full suite, once/);
  const again = facts({ round: 2, pins: [pin], lastPin: pin, pinAtHead: true, proof: { done: true }, suite: { done: true, receipt: { runId: 'r' } } });
  assert.doesNotMatch(text(again), /the full suite, once/);
  // Small with the suite left to CI names the job and prints no suite run.
  const ci = facts({ round: 2, pins: [pin], lastPin: pin, pinAtHead: true, proof: { done: true }, suite: { done: true, ci: 'backend-tests' } });
  assert.match(text(ci), /left to CI: backend-tests/);
  assert.doesNotMatch(text(ci), /the full suite, once/);
});

// 2026-11-22 (owner): early review is the default; there is no switch for it.
test('the review starts with the proof once both first runs are in the log, with no switch', () => {
  assert.deepEqual(ids(facts({ checks: { code: true } })), ['proof']);
  assert.deepEqual(ids(facts({ checks: { code: true }, proof: { early: true } })), ['proof', 'review']);
  assert.ok(!ids(facts({ checks: { code: true }, proof: { early: true }, git: { clean: false } })).includes('review'), 'not on an unsaved tree');
  // The cheap checks have no record of their own, so the proof is printed beside them, not first: the review still starts.
  assert.ok(ids(facts({ checks: { code: undefined }, proof: { early: true } })).includes('review'), 'proof beside the checks');
});

test('a path with a space, a dollar sign, a backtick or Arabic letters is one shell word', () => {
  assert.equal(q('/a/b.md'), '/a/b.md');
  assert.equal(q('/a/my repo'), "'/a/my repo'");
  assert.equal(q('/a/$HOME`x`'), "'/a/$HOME`x`'");
  assert.equal(q("/a/it's"), "'/a/it'\\''s'");
  assert.equal(q('/a/ملف'), "'/a/ملف'");
});

test('the steps printed side by side: the second look with the check lines, the cheap checks with the breaks', () => {
  assert.deepEqual(ids(facts({ has: { siblings: false, check: false } })), ['check-lines', 'second-look']);
  // The owner set sanad.lateCheckLines false: the second look waits for check.md.
  assert.deepEqual(ids(facts({ has: { siblings: false, check: false }, switches: { lateCheckLines: false } })), ['check-lines']);
  assert.deepEqual(ids(facts({ has: { siblings: false, check: true }, switches: { lateCheckLines: false } })), ['second-look']);
  assert.deepEqual(ids(facts({ has: { breaks: false }, checks: { beforeProof: false } })), ['checks-before-proof', 'breaks']);
  // 2026-11-23: every part, in the foreground, and the proof waits for its pass (it was `--part code`, in the background).
  const cheap = text(facts({ has: { breaks: false }, checks: { beforeProof: false } }));
  assert.match(cheap, /^ {2}\$ node \/g\/pre-review\.mjs --before-proof --was/m);
  assert.doesNotMatch(cheap, /--part code|BACKGROUND \$ node \/g\/pre-review/);
  assert.match(cheap, /the proof waits until it passes on this commit/);
});

// Re-check 3, 2026-11-23: a full review pinned with a Blocker open holds the proof (its fix changes the code); the
// last round names the command that opens the proof when its checks have not passed.
test('a pinned full review with a note to fix holds the proof; the last round prints the checks command it waits for', () => {
  const pin = { round: 1, kind: 'full', commit: 'h1', ref: 'refs/sanad/review/t/1' };
  const blocker = { n: 1, kind: 'Blocker', text: 'the rows are lost' };
  const held = text(facts({ round: 1, pins: [pin], lastPin: pin, pinAtHead: true, proof: { done: false }, notes: { known: true, all: [blocker], open: [blocker] } }));
  assert.doesNotMatch(held, /red-proof\.mjs/);
  const re = { round: 1, kind: 'recheck', commit: 'h1', ref: 'refs/sanad/review/t/1r' };
  const last = text(facts({ round: 1, pins: [pin, re], lastPin: re, pinAtHead: true, checks: { beforeProof: false }, proof: { done: false }, notes: { known: true, all: [], open: [] } }));
  assert.match(last, /the proof waits/);
  assert.match(last, /^ {2}\$ node \/g\/pre-review\.mjs --before-proof/m);
});

// Re-check, 2026-11-23: at a pinned commit the checks step is over, so the proof step itself names the command that opens it.
test('a pinned commit without passing checks: the proof waits and its step prints the checks command', () => {
  const pin = { round: 1, kind: 'full', commit: 'h1', ref: 'refs/sanad/review/t/1' };
  const out = text(facts({ round: 1, pins: [pin], lastPin: pin, pinAtHead: true, checks: { beforeProof: false }, proof: { done: false }, notes: { known: true, all: [], open: [] } }));
  assert.match(out, /the proof waits/);
  assert.match(out, /^ {2}\$ node \/g\/pre-review\.mjs --before-proof/m);
});

// 2026-11-23 (owner, one proof per round): the proof is offered only after every code change of the round.
test('one proof per round: the proof is not offered before the checks pass on this code, nor while a note to fix is open', () => {
  // Before the first review: the checks before the proof come first, and the proof is not printed beside them.
  assert.deepEqual(ids(facts({ checks: { beforeProof: false } })), ['checks-before-proof']);
  assert.deepEqual(ids(facts({ checks: { beforeProof: true } })), ['proof']);
  // A fix round: a Bug or a Gap still open holds the proof and the re-check; a Question or a note that asks the owner does not.
  const pin = { round: 1, kind: 'full', commit: 'h1', ref: 'refs/sanad/review/t/1' };
  const round = (open) => text(facts({ round: 1, pins: [pin], lastPin: pin, notes: { known: true, all: open, open } }));
  const held = round([{ n: 3, kind: 'Bug', text: 'the list skips a row' }]);
  assert.match(held, /the proof and the re-check wait: 1 note\(s\) still to fix and answer \(notes\.mjs answer\): NOTE 3/);
  assert.doesNotMatch(held, /red-proof\.mjs|review-brief\.mjs --recheck/);
  const free = round([{ n: 4, kind: 'Question', text: 'keep the old order?' }, { n: 5, kind: 'Gap', text: 'you decide: a known limit', asks: true }]);
  assert.match(free, /red-proof\.mjs .*\(PARTIAL\)/);
  assert.match(free, /review-brief\.mjs --recheck/);
  // The builder's own read not recorded for this commit: that step comes first.
  assert.deepEqual(ids(facts({ round: 1, pins: [pin], lastPin: pin, selfRead: 'h1' })), ['self-read']);
});

test('the start step adds --no-ticket when the ticket text file holds no ticket ID', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-'));
  const f = facts({ has: { lines: false } });
  const cmd = (body) => { fs.writeFileSync(path.join(dir, 'ticket-text.md'), body); return render(due(f), { ...ctx, notes: dir.split(path.sep).join('/') }, f).join('\n'); };
  assert.doesNotMatch(cmd('TUW-243 show the date'), /--no-ticket/);
  assert.match(cmd('show the date in the list'), /lines\.mjs --from .* --out .* --no-ticket --repo '\/r\/my repo'/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('P20: a stop round below 2 is invalid; switch lines show scope and origin; the steps print the new tool flags', () => {
  assert.equal(stopRound('1'), 3);
  assert.equal(stopRound('0'), 3);
  const lines = switchLines({ switchHits: [{ key: 'stopRound', value: '1', scope: 'local', origin: '.git/config' }, { key: 'testsOnlyLane', value: 'true', scope: 'global', origin: '~/.gitconfig' }] });
  assert.match(lines[0], /^Owner switch invalid: sanad\.stopRound = 1 \(local; origin: \.git\/config\)/);
  assert.match(lines[1], /^Owner switch on: sanad\.testsOnlyLane = true \(global; origin: ~\/\.gitconfig\)/);
  const c = { gate: '/g', repo: '/r', notes: '/n', base: 'origin/staging', sides: [{ name: 'api', test: 't', server: true }] };
  const text = (id, f) => render([STEPS.find((s) => s.id === id)], c, f).join('\n');
  assert.match(text('breaks', {}), /--put-file/);
  assert.match(text('start', { switches: { remoteHost: 'pc2' } }), /remote-preflight\.sh --connect[\s\S]*remote-preflight\.sh --db/);
  assert.doesNotMatch(text('start', { switches: { remoteHost: '' } }), /--db/);
  assert.match(text('after-push', {}), /review-brief\.mjs --drop-pins --notes/);
});

test('the gate step shows verdict --gate with every evidence flag', () => {
  const gate = STEPS.find((s) => s.id === 'gate');
  const out = gate.lines(ctx, facts()).map((l) => l.text).join('\n');
  for (const flag of ['--tests', '--build', '--attack', '--security', '--ran']) assert.ok(out.includes(flag), flag);
  assert.match(out, /real result/);
});

test('U3: on the tests-only lane the review-brief command has no --proof-log; the normal lane keeps it', () => {
  const pin = { round: 1, kind: 'full', commit: 'h1' };
  const light = facts({ testsOnly: true, switches: { testsOnlyLane: true }, pins: [], git: { clean: true, ahead: 1 } });
  const lightText = text(facts({ ...light, has: { breaks: false } }));
  assert.match(lightText, /review-brief\.mjs --pin/);
  assert.doesNotMatch(lightText, /--proof-log/);
  assert.match(text(facts({ proof: { done: true }, proofLogs: ['/n/proof-page.log'] })), /review-brief\.mjs --pin .*--proof-log \/n\/proof-page\.log/);
  const fix = facts({ testsOnly: true, switches: { testsOnlyLane: true }, pins: [pin], lastPin: pin, pinAtHead: false });
  assert.doesNotMatch(text(fix), /--proof-log/);
});

test('U3: a text-path change that adds a test file has the breaks and proof steps; without a test it has neither', () => {
  assert.equal(pathFor('text', { textProof: true }).some((s) => s.id === 'breaks'), true);
  assert.equal(pathFor('text', { textProof: true }).some((s) => s.id === 'proof'), true);
  assert.equal(pathFor('text').some((s) => s.id === 'proof'), false);
  const withTest = facts({ lane: 'text', size: 'tiny', textProof: true, has: { breaks: false } });
  assert.ok(ids(withTest).includes('breaks'));
  const noTest = facts({ lane: 'text', size: 'tiny', textProof: false, has: { breaks: false } });
  assert.ok(!ids(noTest).includes('breaks'));
  // The proof log is passed to the brief on this path, as the proof exists.
  const pinned = facts({ lane: 'text', size: 'tiny', textProof: true, proof: { done: true }, proofLogs: ['/n/proof-page.log'] });
  assert.match(text(pinned), /--proof-log/);
  // The last round asks for the proof on the text path with a test, and not without one.
  const pin = { round: 2, kind: 'recheck', commit: 'h2', ref: 'r' };
  const last = (textProof) => facts({ lane: 'text', size: 'tiny', textProof, pins: [pin], lastPin: pin, pinAtHead: true, suite: { done: true }, notes: { known: true, all: [], open: [] } });
  assert.ok(ids(last(true)).includes('last-round'));
  assert.ok(!ids(last(false)).includes('last-round'));
});

// 2026-11-20 (timed task): a page proof and a server proof make two logs; the printed review-brief command named one,
// and the author joined the files by hand. Every proof log of the notes folder goes in, as one comma list.
test('the review step passes every proof log of the folder; before any log exists, one per side', () => {
  const two = text(facts({ proof: { done: true }, proofLogs: ['/n/proof-page.log', '/n/proof-server.log'] }));
  assert.match(two, /review-brief\.mjs --pin .*--proof-log \/n\/proof-page\.log --proof-log \/n\/proof-server\.log /);
});

// 2026-11-20 (fix round): one quoted --proof-log per log (a folder name may hold a comma); with no log on disk the
// option is left out, never the name of a file that is not there.
test('the review step names one --proof-log per existing log, and none when no log exists', () => {
  const commaDir = text(facts({ proof: { done: true }, proofLogs: ['/n,x/proof-page.log', '/n,x/proof-server.log'] }));
  assert.match(commaDir, /--proof-log \/n,x\/proof-page\.log --proof-log \/n,x\/proof-server\.log /);
  assert.doesNotMatch(text(facts({ proof: { done: true } })), /--proof-log/);
  assert.doesNotMatch(text(facts({ proof: { done: true }, proofLogs: [] })), /--proof-log/);
});
