import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildBrief, buildFreshBrief, buildLaunch, outsideItems, splitOutside, checkLines, missedClasses, decidedItems } from '../scripts/review-brief.mjs';

// 2026-11-07: a reviewer re-asked a question the user had closed; the slowest reviewer had the widest job.
test('decided questions go into both briefs; a small change gives the whole-diff reviewer one narrow job', () => {
  const list = '- 2026-11-06 · Twin · F.tsx:1 · open\n- 2026-11-06 · Wording question — CLOSED: the ticket decides (user: "is qa not mention")\n';
  const decided = decidedItems(list);
  assert.deepEqual(decided, ['Wording question — CLOSED: the ticket decides (user: "is qa not mention")']);
  const withDecided = { other: [], touched: [], decided };
  const args = { repo: 'C:/r', branch: 'b', base: 'origin/staging', mergeBase: 'a'.repeat(40), ticket: 't', checks: ['x'], outside: withDecided, facts: { stack: '', size: 'SIZE: small (diff)', callers: '' } };
  for (const brief of [buildBrief(args), buildFreshBrief({ ...args, missed: [] })]) assert.match(brief, /## Decided by the user — do not ask again\n\n- Wording question — CLOSED/);
  const small = buildLaunch({ brief: 'C:/n/brief.md', fresh: 'C:/n/brief-fresh.md', repo: 'C:/r', branch: 'b', focused: true });
  assert.match(small, /whole-diff pass[^\n]*For this small change do only this: check each Check line against its tagged test/);
  assert.doesNotMatch(small, /Fill the coverage checklist/);
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
  assert.match(brief, /## Known outside items — do not report again\n\n- Old twin message \(Other\.tsx:10\)/);
  assert.match(brief, /## Known items in the files this change touches — report only if this change alters or worsens it\n\n- Old-language error/);
  assert.equal((brief.split('## Rules')[1].match(/^- /gm) || []).length, 3, 'three standing rules, no more');
  assert.match(brief, /A `Question` is only for what the ticket lines above leave open/);
  assert.match(brief, /A test weakness is reported as a concrete break/);
  assert.match(brief, /## Focused brief/);
});

test('the fresh brief carries no author framing: no Check lines, no callers, no proof; it has the missed-bug classes', () => {
  const fresh = buildFreshBrief({ ...base, missed: ['wrong scope — catch: grep the guard'] });
  assert.doesNotMatch(fresh, /## Check|Callers:|Proof run|C1\./);
  assert.match(fresh, /fresh eyes/);
  assert.match(fresh, /## Bug classes this project missed before — check the change for each\n\n- wrong scope — catch: grep the guard/);
  assert.match(fresh, /git diff a{40}/);
  assert.match(fresh, /## Known outside items/);
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
  assert.deepEqual(items.map(i => i.what), ['Twin message', 'Slow test']);
  const split = splitOutside(items, ['web/src/Form.tsx']);
  assert.deepEqual(split.touched.map(i => i.what), ['Twin message']);
  assert.deepEqual(split.other.map(i => i.what), ['Slow test']);
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
  const notes = fs.mkdtempSync(path.join(root, 'notes-'));
  const ticket = path.join(notes, 'ticket.md'), check = path.join(notes, 'check.md'), outsideFile = path.join(notes, 'outside.md'), missedFile = path.join(notes, 'missed.md'), out = path.join(notes, 'brief.md'), proof = path.join(notes, 'proof.log');
  fs.writeFileSync(ticket, 'QA: "appear once"\n'); fs.writeFileSync(check, '- once on save\n- once twice\n');
  fs.writeFileSync(outsideFile, '- 2026-11-06 · Twin · F.tsx:1 · open\n- 2026-11-06 · Other · G.tsx:2 · open\n');
  fs.writeFileSync(missedFile, '- d · CLASS: lost line · WHY MISSED: z · CATCH: quote it\n');
  fs.writeFileSync(proof, 'RED-PROOF: RED ✓ — x\n  BREAK ✓ rule: all 1 named test(s) fail\nnoise line\n');
  git('config', 'sanad.outsideList', outsideFile); git('config', 'sanad.missedBugs', missedFile);
  const r = spawnSync(process.execPath, [script, '--out', out, '--ticket', ticket, '--check', check, '--repo', repo, '--base', 'main', '--proof-log', proof], { encoding: 'utf8', env, windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /BRIEF: .* · 2 check line\(s\) C1\.\.C2 · 2 known item\(s\), 1 in touched files, 0 decided · callers: .* · proof: yes/);
  assert.match(r.stdout, /FRESH: .*brief-fresh\.md · 1 missed-bug class\(es\)/);
  const brief = fs.readFileSync(out, 'utf8');
  assert.match(brief, /branch fix\/y/);
  assert.match(brief, /files this change touches[\s\S]*- Twin \(F\.tsx:1\)/);
  assert.match(brief, / {4}BREAK ✓ rule/);
  assert.doesNotMatch(brief, /noise line/);
  assert.match(fs.readFileSync(path.join(notes, 'brief-fresh.md'), 'utf8'), /- lost line — catch: quote it/);
  assert.match(fs.readFileSync(path.join(notes, 'launch.md'), 'utf8'), /brief-fresh\.md/);
  const missing = spawnSync(process.execPath, [script, '--out', out, '--ticket', ticket, '--repo', repo], { encoding: 'utf8', env, windowsHide: true });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--check is required/);
});
