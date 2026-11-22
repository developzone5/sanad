import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ownerSaid } from '../scripts/notes.mjs';
import { loadScan } from '../scripts/note-check.mjs';

const hasExport = typeof loadScan().humanWords === 'function';

test('ownerSaid is not checked when there is no session log', () => {
  assert.equal(ownerSaid('keep it as one job', {}), null);
});

test('ownerSaid reads the owner words from a session log', { skip: !hasExport && 'humanWords is not exported yet (part P10)' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-'));
  const file = path.join(dir, 's.jsonl');
  const row = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text }, origin: { kind: 'human' } });
  fs.writeFileSync(file, row('Yes, keep it as one job please') + '\n');
  assert.equal(ownerSaid('keep it as one job', { transcript: file }), true);
  assert.equal(ownerSaid('split it in two parts', { transcript: file }), false);
});

// Codex fallback (2026-11-20): hand-made session files in the shape of the Codex CLI, with invented text.
function codexHome(repo, files) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cdx-'));
  for (const f of files) {
    const dir = path.join(home, 'sessions', ...f.day.split('-'));
    fs.mkdirSync(dir, { recursive: true });
    const meta = { type: 'session_meta', payload: { cwd: f.cwd ?? repo, source: f.helper ? { subagent: 'x' } : 'cli' } };
    fs.writeFileSync(path.join(dir, `rollout-${f.day}T10-00-00-${f.id}.jsonl`), [meta, ...f.rows].map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  return home;
}
const item = (text) => ({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text }] } } });
const legacy = (message) => ({ type: 'event_msg', payload: { type: 'user_message', message } });
const withCodex = (home, fn) => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-'));
  const keep = [process.env.SANAD_CODEX_DIR, process.env.SANAD_PROJECTS_DIR];
  process.env.SANAD_CODEX_DIR = home; process.env.SANAD_PROJECTS_DIR = empty;
  try { fn(); } finally { keep[0] === undefined ? delete process.env.SANAD_CODEX_DIR : (process.env.SANAD_CODEX_DIR = keep[0]); keep[1] === undefined ? delete process.env.SANAD_PROJECTS_DIR : (process.env.SANAD_PROJECTS_DIR = keep[1]); }
};

test('ownerSaid reads the typed messages of the newest Codex session of the repository', { skip: !hasExport && 'humanWords is not exported yet' }, () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  const home = codexHome(repo, [
    { day: '2026-11-19', id: 'a', rows: [item('older session words here')] },
    { day: '2026-11-20', id: 'b', rows: [item('Use the second option please'), legacy('legacy typed words')] },
    { day: '2026-11-20', id: 'c', helper: true, rows: [item('words of a helper agent')] },
    { day: '2026-11-20', id: 'd', cwd: path.join(os.tmpdir(), 'other-repo'), rows: [item('words of another repository')] },
  ]);
  withCodex(home, () => {
    assert.equal(ownerSaid('use the second option please', { repo }, true), true);
    assert.equal(ownerSaid('legacy typed words', { repo }, true), true);
    assert.equal(ownerSaid('use the second option', { repo }, true), false, 'exact: a part of a message is not the message');
    assert.equal(ownerSaid('use the second option', { repo }, false), true);
    assert.equal(ownerSaid('older session words here', { repo }, true), false, 'only the newest session of the repository');
    assert.equal(ownerSaid('words of a helper agent', { repo }, true), false);
    assert.equal(ownerSaid('words of another repository', { repo }, true), false);
  });
});

test('ownerSaid reads Claude first: a Claude log that holds the words wins, and no Codex session keeps the old answer', { skip: !hasExport && 'humanWords is not exported yet' }, () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  withCodex(codexHome(repo, []), () => assert.equal(ownerSaid('anything at all here', { repo }, true), null));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-'));
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content: 'claude typed words' }, origin: { kind: 'human' } }) + '\n');
  withCodex(codexHome(repo, [{ day: '2026-11-20', id: 'e', rows: [item('other words')] }]), () => {
    assert.equal(ownerSaid('claude typed words', { transcript: file, repo }, true), true);
    assert.equal(ownerSaid('claude typed words', { repo }, true), false);
  });
});
