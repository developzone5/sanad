// hooks/lib/timer-idle.cjs: an Orca session's stages mark themselves (2026-11-22, owner: "the timer gets its stage
// marks without the builder typing them"). A re-run of a small task in Orca kept its log under
// <APPDATA>/orca/claude-profiles/<id>/home/projects/..., so the timer hooks took it for a test and wrote nothing:
// the timer had its start mark and no stage, and the report had no minutes per stage.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const hooks = process.env.WORKFLOW_HOOKS_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { autoStage, idle } = createRequire(import.meta.url)(path.join(hooks, 'lib', 'timer-idle.cjs'));

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'timer-orca-'));
const saved = { APPDATA: process.env.APPDATA, SANAD_STATE_DIR: process.env.SANAD_STATE_DIR, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
process.env.APPDATA = path.join(scratch, 'appdata');
delete process.env.CLAUDE_CONFIG_DIR;
test.after(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(scratch, { recursive: true, force: true });
});

const SID = 'orca-session';
// A session whose log sits under `logDir`, with a running timer of one start mark.
function session(logDir) {
  const root = fs.mkdtempSync(path.join(scratch, 's-'));
  const state = path.join(root, 'state'), timer = path.join(root, 'timer');
  for (const d of [state, timer, logDir]) fs.mkdirSync(d, { recursive: true });
  process.env.SANAD_STATE_DIR = state;
  fs.writeFileSync(path.join(timer, 'timer.tsv'), `${new Date().toISOString()}\tstep\tstart: the user's request — repo\n`);
  fs.writeFileSync(path.join(state, `sanad-timer-active-${SID}`), timer);
  const transcript = path.join(logDir, SID + '.jsonl');
  fs.writeFileSync(transcript, '');
  const marks = () => fs.readFileSync(path.join(timer, 'timer.tsv'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => l.split('\t').slice(1).join(' '));
  const run = (command) => autoStage({ session_id: SID, transcript_path: transcript, cwd: root, tool_name: 'Bash', tool_input: { command } });
  return { marks, run, transcript };
}

test('an Orca session (log under orca/claude-profiles/<id>/home/projects) marks its stages: proof, then review checks', () => {
  const s = session(path.join(process.env.APPDATA, 'orca', 'claude-profiles', 'p1', 'home', 'projects', 'C--repo'));
  assert.equal(s.run('node /x/gate/scripts/red-proof.mjs --test a.test.ts -- npx vitest run'), 'proof');
  assert.equal(s.run('node /x/gate/scripts/pre-review.mjs --repo .'), 'checks before review');
  assert.deepEqual(s.marks().filter((m) => m.startsWith('step')), ["step start: the user's request — repo", 'step proof', 'step checks before review']);
});

test('an Orca session gets its idle waits too', () => {
  const s = session(path.join(process.env.APPDATA, 'orca', 'claude-profiles', 'p2', 'home', 'projects', 'C--repo'));
  idle({ session_id: SID, transcript_path: s.transcript });
  assert.ok(s.marks().some((m) => m.startsWith('wait ')), s.marks().join(' | '));
});

test('a session in the projects folder of CLAUDE_CONFIG_DIR marks its stages', () => {
  const config = path.join(scratch, 'config-home');
  process.env.CLAUDE_CONFIG_DIR = config;
  try {
    const s = session(path.join(config, 'projects', 'C--repo'));
    assert.equal(s.run('node /x/gate/scripts/red-proof.mjs --test a.test.ts -- npx vitest run'), 'proof');
  } finally { delete process.env.CLAUDE_CONFIG_DIR; }
});

test('a log in a folder of the same names outside the trusted roots is no session: nothing is marked', () => {
  const s = session(path.join(scratch, 'elsewhere', 'claude-profiles', 'p3', 'home', 'projects', 'C--repo'));
  assert.equal(s.run('node /x/gate/scripts/red-proof.mjs --test a.test.ts -- npx vitest run'), '');
  assert.deepEqual(s.marks(), ["step start: the user's request — repo"]);
});
