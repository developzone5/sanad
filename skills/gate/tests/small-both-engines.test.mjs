// 2026-11-28 (owner, batch c task 2; the first reviewer run: the Codex fresh eyes caught 24 faults in 2.3 minutes, the
// Claude fresh eyes 12 in 1.6). A tiny or small round is the task's own fresh eyes and the other engine, as Medium:
// "ready" needs one finished first-round report from each engine, and two runs of the task's own engine never fill both
// seats. The Claude whole-diff seat (routine-reviewer) leaves the Big round; a Codex task keeps its own whole diff.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewSeats } from '../scripts/review-brief.mjs';
import { reviewReported, reviewProgress } from '../scripts/sanad.mjs';

const at = '2026-11-28T08:00:00.000Z';
const t = (m) => Date.parse(`2026-11-28T08:${String(m).padStart(2, '0')}:00.000Z`);
const run = (id, m) => ({ id, seat: 'fresh eyes', launchAt: new Date(t(m)).toISOString(), doneAt: new Date(t(m + 2)).toISOString() });

test('a tiny or small round pins both engines, and ready needs a finished report from each', () => {
  for (const size of ['tiny', 'small']) {
    const pin = { kind: 'full', seats: reviewSeats(size), at };
    assert.deepEqual(pin.seats, ['fresh eyes', 'other engine'], size);
    assert.equal(reviewReported(pin, [run('a', 1)], [], []), false, size + ': the Claude fresh eyes alone');
    assert.equal(reviewReported(pin, [run('a', 1), run('b', 2)], [], []), false, size + ': two Claude runs are not both engines');
    assert.equal(reviewReported(pin, [], [t(5)], []), false, size + ': the other engine alone');
    assert.equal(reviewReported(pin, [run('a', 1)], [t(5)], []), true, size + ': one of each');
    assert.equal(reviewReported(pin, [run('a', 1)], [t(0) - 60000], []), false, size + ': an other-engine report older than the pin');
    assert.equal(reviewProgress(pin, [run('a', 1)], [], []).need, 2, size);
  }
});

test('a Big round has no Claude whole-diff seat; a Codex task keeps its own', () => {
  assert.deepEqual(reviewSeats('big'), ['fresh eyes', 'risk files', 'other engine']);
  assert.deepEqual(reviewSeats('big', 'claude'), ['fresh eyes', 'risk files', 'other engine']);
  assert.deepEqual(reviewSeats('big', 'codex'), ['fresh eyes', 'risk files', 'whole diff', 'other engine']);
  assert.deepEqual(reviewSeats(''), ['fresh eyes', 'risk files', 'other engine'], 'a size not known is the full round');
  assert.deepEqual(reviewSeats('medium'), ['fresh eyes', 'other engine'], 'medium is unchanged');
  const big = { kind: 'full', seats: reviewSeats('big'), at };
  assert.equal(reviewReported(big, [run('a', 1), run('b', 1)], [t(9)], []), true, 'fresh eyes, risk files and the other engine');
  assert.equal(reviewReported(big, [run('a', 1), run('b', 1)], [], []), false, 'no other-engine report');
});

// The text half: the Codex reviewer roles get the one "not a note" rule, and the rule pages say the new seats. Read from
// the staged candidate when there is one, else from the installed copy.
const here = path.dirname(fileURLToPath(import.meta.url));
const staged = path.resolve(here, '..', '..', '..', '..');
const candidate = fs.existsSync(path.join(staged, 'claude/skills/sanad/SKILL.md'));
const claudeRoot = candidate ? path.join(staged, 'claude') : path.join(os.homedir(), '.claude');
const codexRoot = candidate ? path.join(staged, 'codex') : path.join(os.homedir(), '.codex');
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8').replace(/\r\n/g, '\n');
test('the Codex reviewer roles say what is not a note, and the rule pages give Small both engines', () => {
  for (const role of ['sanad-reviewer.toml', 'sanad-risk-reviewer.toml']) {
    assert.match(read(codexRoot, 'agents', role), /Three things are not notes, so never write them as a Blocker, Bug, Gap or Question line: a missing test, a file that is not in the change, and behavior the ticket asks for\./, role);
  }
  assert.match(read(claudeRoot, 'CLAUDE.md'), /Small and Medium get one FRESH EYES review[^\n]*and the other engine's fresh eyes, launched together/);
  assert.match(read(claudeRoot, 'skills', 'gate', 'SKILL.md'), /fresh eyes and the other engine for Small and Medium \(one finished report from each engine\)/);
  const loop = read(claudeRoot, 'skills', 'sanad', 'reference', 'loop.md');
  assert.match(loop, /\*\*Small\*\* — [^\n]*Fresh eyes and the other engine, started with the proof's first two runs\./);
  assert.doesNotMatch(loop, /one review|One quick review|the whole diff, fresh eyes/);
  assert.match(read(claudeRoot, 'skills', 'sanad', 'reference', 'full-pr-review.md'), /Small and Medium fresh eyes and the other engine, Big the full round/);
  assert.doesNotMatch(read(claudeRoot, 'agents', 'recheck-reviewer.md'), /The whole-diff review of a Big task uses routine-reviewer/);
});
