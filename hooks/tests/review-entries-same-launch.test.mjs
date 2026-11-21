import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// 2026-11-20: `reviews` keeps each finished reviewer run as its own entry, even when two share a launch time,
// and each entry carries `id` (the tool-use id of the launch) and `seat`. Old entries without `id` stay valid.
const hooks = process.env.WORKFLOW_HOOKS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const realRequire = createRequire(import.meta.url);
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'review-entries-')));
const stateDir = path.join(root, 'state');
process.env.SANAD_STATE_DIR = stateDir;
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, 'review-notes-since'), '2026-01-01T00:00:00.000Z\n');
const scan = realRequire(path.join(hooks, 'lib', 'transcript-scan.js'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const at = (n) => new Date(Date.UTC(2026, 10, 20, 6, 0, 0) + n * 1000).toISOString();
const msg = (role, content, n, rest = {}) => ({ type: role, message: { role, content }, timestamp: at(n), ...rest });
const result = (id, content, n, toolUseResult) => msg('user', [{ type: 'tool_result', tool_use_id: id, content, is_error: false }], n, { toolUseResult });
const FRESH = 'You are the independent reviewer — FRESH EYES whole-PR review. Read and follow only the brief at C:/notes/fresh.md. Read-only.';
const RISK = 'You are the independent reviewer — risk files pass (Pass A). Read and follow the brief at C:/notes/brief.md.';
const WHOLE = 'You are the independent reviewer — whole-diff pass. Read and follow the brief at C:/notes/brief.md.';
let n = 0;
const file = (entries) => { const f = path.join(root, 't' + (n++) + '.jsonl'); fs.writeFileSync(f, entries.map((e) => JSON.stringify(e) + '\n').join('')); return f; };

// Three reviewers launched in ONE message (one timestamp), each answering synchronously.
const calls = [['toolu_a', FRESH], ['toolu_b', RISK], ['toolu_c', WHOLE]];
const oneMessage = () => [
  msg('assistant', calls.map(([id, prompt]) => ({ type: 'tool_use', id, name: 'Agent', input: { description: 'Review', subagent_type: 'independent-reviewer', prompt } })), 1),
  ...calls.map(([id], i) => result(id, 'RECOMMEND: PASS', 10 + i, { status: 'completed', agentId: 'agent_' + id })),
];

test('three reviewers launched in one message give three entries with their ids and seats', () => {
  const r = scan.scanTranscript(file(oneMessage()));
  assert.equal(r.reviews.length, 3);
  assert.deepEqual(r.reviews.map((x) => x.id).sort(), ['toolu_a', 'toolu_b', 'toolu_c']);
  const seatOf = Object.fromEntries(r.reviews.map((x) => [x.id, x.seat]));
  assert.deepEqual(seatOf, { toolu_a: 'fresh eyes', toolu_b: 'risk files', toolu_c: 'whole diff' });
  for (const x of r.reviews) { assert.equal(x.launchAt, at(1)); assert.ok(x.doneAt); }
});

test('the same transcript scanned again keeps three entries (saved state)', () => {
  const f = file(oneMessage());
  const first = scan.scanTranscript(f);
  assert.deepEqual(scan.scanTranscript(f).reviews, first.reviews);
});
