// 2026-11-22 (owner): no time limit and no time target anywhere in the task loop. The timer only measures.
// A size line, a seat's brief or a review brief that sets minutes for the work (a target, a cap, a "still
// running at N minutes" step) fails here. Timeouts that stop a hung program are not work targets and stay.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const skills = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(skills, rel), 'utf8');
const codeOnly = (rel) => read(rel).split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
const WORK_TIME = [
  /Target:\s*\d/i,                                   // "Target: 5–10 minutes"
  /\babout \d+ minutes\b/i,                          // "about 4 minutes and 40 tool uses"
  /still running at \d+ minutes/i,                   // the 8-minute message
  /\bnone at \d+\b/i,                                // "none at 12"
  /\btool (?:calls|uses) and \d+ minutes\b/i,        // "About 15 tool calls and 2 minutes"
];

test('the loop, the seat rules and the review brief set no minutes for the work', async () => {
  const texts = {
    'sanad/reference/loop.md': read('sanad/reference/loop.md'),
    'sanad/reference/loop-rare-cases.md': read('sanad/reference/loop-rare-cases.md'),
    'braintrust/SKILL.md': read('braintrust/SKILL.md'),
    'gate/scripts/review-brief.mjs': read('gate/scripts/review-brief.mjs'),
    // The prompts the tools hand to agents (code comments, which hold history, are left out).
    'gate/scripts/siblings.mjs': codeOnly('gate/scripts/siblings.mjs'),
    'gate/scripts/note-check.mjs': codeOnly('gate/scripts/note-check.mjs'),
    ...Object.fromEntries(fs.readdirSync(path.join(skills, 'braintrust', 'experts')).filter((n) => n.endsWith('.md')).map((n) => ['braintrust/experts/' + n, read('braintrust/experts/' + n)])),
  };
  for (const [name, text] of Object.entries(texts)) {
    for (const re of WORK_TIME) assert.doesNotMatch(text, re, `${name} sets a time for the work: ${re}`);
  }
  // The tool-use cap and the scope rules stay.
  assert.match(texts['braintrust/SKILL.md'], /40 tool uses/);
  assert.match(texts['braintrust/SKILL.md'], /direct callers, not the whole repository; stop once the position is stable/);
  assert.match(texts['sanad/reference/loop-rare-cases.md'], /40 tool uses/);
});

test('the stage budgets file is gone', () => {
  assert.equal(fs.existsSync(path.join(skills, 'gate', 'scripts', 'budgets.json')), false);
});
