// new-lines.mjs — the lines a change adds, and its new "nothing happens" checks: one reading for
// check-test-asserts.mjs (after the proof) and red-proof.mjs (before any run), so both judge the same lines
// (2026-11-15: a proof read PROVED, then pre-review called one test file's checks UNPROVEN, and the whole proof
// ran again). It imports no other gate script but check-ticket-lines.mjs: check-test-asserts.mjs loads
// review-brief.mjs, and review-brief.mjs loads red-proof.mjs, so red-proof.mjs may not load check-test-asserts.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { TEST_FILE } from './check-ticket-lines.mjs';

// "Nothing happens" checks: a call that did not happen, an element or value that is absent, zero.
const NOTHING = /\.not\.toHaveBeenCalled|\.toHaveBeenCalledTimes\(\s*0\s*\)|\.not\.toBeInTheDocument\(|\.toBeNull\(\)|\.toBeUndefined\(\)|\.toHaveLength\(\s*0\s*\)|\.toBe\(\s*0\s*\)|\.toEqual\(\s*\[\s*\]\s*\)|\bTimes\.Never\b|\bAssert\.(?:Null|Empty)\s*\(|\.Should\(\)\.(?:BeNull|BeEmpty|BeFalse|NotContain)\s*\(|\.Should\(\)\.(?:Be|HaveCount)\(\s*0[mMdDfFlLuU]?\s*\)|\.DidNotReceive\(/;

export function nothingChecks(lines) {
  return lines.filter(l => TEST_FILE.test(l.file) && NOTHING.test(l.text));
}

function git(cwd, args) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }); }
  catch { return null; }
}

// Added lines of a unified diff with -U0, as { file, line, text }.
export function addedLines(diff) {
  const found = [];
  let file = null, line = 0;
  for (const raw of String(diff).split(/\r?\n/)) {
    if (raw.startsWith('+++ ')) { file = raw === '+++ /dev/null' ? null : raw.slice(4).replace(/^b\//, ''); continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (file && raw.startsWith('+')) { found.push({ file, line, text: raw.slice(1) }); line++; }
  }
  return found;
}

// The lines a change adds since the merge base with <base>, as { file, line, text }: the added lines of the
// diff, and every line of an untracked test file. null when there is no merge base.
export function newLines(top, base) {
  const from = (git(top, ['merge-base', base, 'HEAD']) || '').trim();
  if (!from) return null;
  const lines = addedLines(git(top, ['diff', '-U0', '--no-color', '--no-ext-diff', from]) || '');
  for (const f of (git(top, ['ls-files', '--others', '--exclude-standard']) || '').split(/\r?\n/).filter(Boolean)) {
    if (!TEST_FILE.test(f)) continue;
    fs.readFileSync(path.join(top, f), 'utf8').split(/\r?\n/).forEach((text, i) => lines.push({ file: f, line: i + 1, text }));
  }
  return lines;
}
