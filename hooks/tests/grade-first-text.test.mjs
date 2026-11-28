// 2026-11-28 (owner, batch c task 1, the text part only; the note reader is not changed in this branch). In the first
// reviewer run the Claude independent reviewer started each note with a status emoji, following the owner's chat
// rules, and the note reader read none of those 36 notes. Promise: every reviewer agent file, the Codex reviewer roles,
// the report shape and the review briefs say a note starts with its grade word and that the owner's chat rules do not
// apply to a review reply. Read from the staged candidate when there is one, else from the installed copy.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const hooks = process.env.WORKFLOW_HOOKS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const staged = path.resolve(hooks, '..', '..');
const candidate = fs.existsSync(path.join(staged, 'claude/skills/sanad/SKILL.md'));
const claudeRoot = candidate ? path.join(staged, 'claude') : path.join(os.homedir(), '.claude');
const codexRoot = candidate ? path.join(staged, 'codex') : path.join(os.homedir(), '.codex');

test('the reviewer files, the report shape and the review briefs say the grade word comes first', () => {
  const files = [
    path.join(claudeRoot, 'agents', 'independent-reviewer.md'), path.join(claudeRoot, 'agents', 'routine-reviewer.md'),
    path.join(claudeRoot, 'agents', 'recheck-reviewer.md'), path.join(codexRoot, 'agents', 'sanad-reviewer.toml'),
    path.join(codexRoot, 'agents', 'sanad-risk-reviewer.toml'), path.join(claudeRoot, 'skills', 'sanad', 'reference', 'review-checklist.md'),
  ];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /starts with its grade word[^.]*no status emoji, number, bullet or bold before it/, file);
    assert.match(text, /chat rules[^.]*do not apply to a review reply/, file);
  }
  const brief = fs.readFileSync(path.join(claudeRoot, 'skills', 'gate', 'scripts', 'review-brief.mjs'), 'utf8');
  assert.match(brief, /export const GRADE_FIRST = 'each line starts with its grade word, with no status emoji/);
  assert.equal(brief.split("one line each: ' + FINDING_SHAPE + '; ' + GRADE_FIRST + '; or").length - 1, 2, 'the review brief and the re-check brief');
});
