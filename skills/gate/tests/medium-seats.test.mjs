// 2026-11-25 (owner): a medium round is the task's own fresh eyes and one review by the other engine. "ready" needs
// one of each: two runs of the task's own engine never count as both seats, with or without a session scan.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewProgress, reviewReported } from '../scripts/sanad.mjs';

const pin = { kind: 'full', seats: ['fresh eyes', 'other engine'], at: '2026-11-25T08:00:00.000Z' };
const t = (m) => Date.parse(`2026-11-25T08:${String(m).padStart(2, '0')}:00.000Z`);
const run = (id, m) => ({ id, seat: 'fresh eyes', launchAt: new Date(t(m)).toISOString(), doneAt: new Date(t(m + 3)).toISOString() });

test('a medium round: two Claude runs and no other-engine report are not both seats', () => {
  assert.equal(reviewReported(pin, [run('a', 1), run('b', 2)], [], []), false);
  assert.deepEqual([reviewProgress(pin, [run('a', 1), run('b', 2)], [], []).have, reviewProgress(pin, [run('a', 1)], [], []).need], [1, 2]);
});

test('a medium round: one own run and one other-engine report fill it; the report alone does not', () => {
  assert.equal(reviewReported(pin, [run('a', 1)], [t(9)], []), true);
  assert.equal(reviewReported(pin, [], [t(9)], []), false, 'the other engine alone');
  assert.equal(reviewReported(pin, [run('a', 1)], [t(9) - 3600000], []), false, 'a report older than the pin');
});

test('a medium round with no session scan: two files of the task engine are not both seats', () => {
  // A Codex task: `reports` holds the claude-* files (the other engine), `reportFiles` both prefixes.
  assert.equal(reviewReported(pin, null, [], [t(5), t(6)]), false, 'codex-fresh.md and codex-risk.md');
  assert.equal(reviewReported(pin, null, [t(6)], [t(5), t(6)]), true, 'codex-fresh.md and claude-fresh.md');
  assert.equal(reviewReported(pin, null, [t(6)], [t(6)]), false, 'claude-fresh.md alone');
});

test('small and big rounds count as before', () => {
  assert.equal(reviewReported({ ...pin, seats: ['fresh eyes'] }, [run('a', 1)], [], []), true);
  const big = { ...pin, seats: ['fresh eyes', 'risk files', 'whole diff', 'other engine'] };
  assert.equal(reviewReported(big, [run('a', 1), run('b', 1), run('c', 1)], [t(9)], []), true);
  assert.equal(reviewReported(big, [run('a', 1), run('b', 1)], [t(9)], []), false);
});
