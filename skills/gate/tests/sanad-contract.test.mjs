import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STEPS, LANES, pathFor } from '../scripts/steps.mjs';
import { USAGE } from '../scripts/sanad.mjs';

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

// Every line the table can print, for every size, with every optional line on.
function printed() {
  const pin = { round: 1, kind: 'full', commit: 'h1', ref: 'refs/sanad/review/t/1' };
  const f = {
    lane: 'small', size: 'small', last: true, round: 3, stop: 2, base: 'origin/staging', testsOnly: false,
    switches: { testsOnlyLane: false, designChoice: true, reviewEarly: true, remoteHost: 'pc2' },
    has: {}, open: { places: 1, siblings: 1 }, git: { tree: '', clean: false, ahead: 1 },
    pins: [pin], lastPin: pin, pinAtHead: false, proof: { done: false }, checks: {}, suite: { done: false, ci: '' },
    notes: { known: true, all: [], open: [{ n: 1, kind: 'Gap', text: 'rare' }] }, decisions: [], pushed: false,
  };
  const c = { gate: '/g', repo: '/r', notes: '/n', base: 'origin/staging', engine: 'claude', size: 'small', lane: 'small', sides: [{ name: 'api', cwd: '/r/api', test: 'dotnet test', server: true, fixFiles: ['a.cs'] }] };
  const lines = [];
  for (const lane of LANES) for (const s of pathFor(lane, { designChoice: true })) for (const l of s.lines({ ...c, lane }, { ...f, lane })) if (!l.plain) lines.push(l.text);
  return lines;
}

// tool file name → the flags the table prints for it (the words after "--" that end a command are the test command's own).
function flagsByTool() {
  const by = new Map();
  for (const line of printed()) {
    const m = /^node \S*\/([a-z-]+\.mjs)\b(.*)$/.exec(line);
    if (!m) continue;
    const own = m[2].split(' -- ')[0];
    const set = by.get(m[1]) || new Set();
    for (const flag of own.match(/(?<=\s)--[a-z][a-z-]*/g) || []) set.add(flag);
    by.set(m[1], set);
  }
  return by;
}

test('the table prints a command for every tool of the loop', () => {
  const tools = [...flagsByTool().keys()];
  // 2026-11-25 (owner, run 3): the size step runs the size check through `sanad.mjs size`, which saves its size.
  for (const name of ['lines.mjs', 'places.mjs', 'siblings.mjs', 'pre-review.mjs', 'breaks.mjs', 'red-proof.mjs', 'review-brief.mjs', 'notes.mjs', 'pr-watch.mjs', 'review-score.mjs', 'check-pr-body.mjs', 'sanad.mjs']) assert.ok(tools.includes(name), name);
  assert.equal(new Set(STEPS.map((s) => s.id)).size, STEPS.length);
});

for (const [name, flags] of flagsByTool()) {
  test('every flag the steps table prints for ' + name + ' is in that tool', (t) => {
    const file = path.join(scripts, name);
    if (!fs.existsSync(file)) { t.skip(name + ' is not in this tree yet'); return; }
    const text = name === 'sanad.mjs' ? USAGE : fs.readFileSync(file, 'utf8');
    const missing = [...flags].filter((flag) => !new RegExp('(?<![a-z-])' + flag + '(?![a-z-])').test(text));
    assert.deepEqual(missing, [], name + ' does not know ' + missing.join(', '));
  });
}
