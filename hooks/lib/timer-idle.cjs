'use strict';
// timer-idle.cjs — the task timer's idle time, marked by the hooks so no one has to remember.
//
// skills/gate/scripts/sanad-timer.mjs keeps a task's marks in <notes>/timer.tsv and names the active one in
// <state>/sanad-timer-active. When the session stops (stop-gate allows the stop) a "wait" starts; the first tool
// call after it (check-lock-guard) ends it with "resumed". 2026-11-09: a 45-minute gap — helpers done, the
// session asleep — was counted as work, because only stage changes were marked.
//
// Only a real session acts: its transcript sits under .claude/projects. Hook tests use temporary transcripts,
// so a test run never writes into a real task's timer. A timer whose last mark is older than STALE_HOURS is a
// finished or forgotten task and is left alone.
//
// Each session reads only its own pointer, <state>/sanad-timer-active-<session id> (2026-11-10: with one shared
// pointer, a session on another project had its timer marked by this session's stops). The id is the hook
// input's session_id, else the transcript's file name (<session id>.jsonl); the timer script names the file
// from CLAUDE_CODE_SESSION_ID, the same id.
const fs = require('fs');
const os = require('os');
const path = require('path');

const IDLE = 'idle: the session stopped (waiting for the user or helpers)';
const STALE_HOURS = 8;

const stateDir = () => process.env.SANAD_STATE_DIR || path.join(os.homedir(), '.claude', 'state');
const realSession = (input) => /\/\.claude\/projects\//i.test(String((input && input.transcript_path) || '').replace(/\\/g, '/'));
function pointerName(input) {
  const id = (input && input.session_id) || path.basename(String((input && input.transcript_path) || '').replace(/\\/g, '/'), '.jsonl');
  const key = String(id || '').replace(/[^A-Za-z0-9_-]/g, '');
  return key ? `sanad-timer-active-${key}` : 'sanad-timer-active';
}

function lastMark(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const [at, kind, ...rest] = (lines.pop() || '').split('\t');
  return { at: new Date(at), kind, text: rest.join(' ') };
}

// The active timer file, or null (none, gone, or stale).
function activeTimer(input, now) {
  let dir = '';
  try { dir = fs.readFileSync(path.join(stateDir(), pointerName(input)), 'utf8').trim(); } catch (e) { return null; }
  const file = dir && path.join(dir, 'timer.tsv');
  if (!file || !fs.existsSync(file)) return null;
  const last = lastMark(file);
  if (Number.isNaN(last.at.getTime()) || now - last.at > STALE_HOURS * 3600000) return null;
  return { file, last };
}

const append = (file, kind, text, now) => fs.appendFileSync(file, `${now.toISOString()}\t${kind}\t${text}\n`);

/** At an allowed stop: a wait starts, unless one is already open. */
function idle(input, now = new Date()) {
  if (!realSession(input)) return false;
  const t = activeTimer(input, now);
  if (!t || t.last.kind === 'wait') return false;
  append(t.file, 'wait', IDLE, now);
  return true;
}

/** At the first tool call after a stop: the automatic wait ends. A wait someone marked by hand stays open. */
function resume(input, now = new Date()) {
  if (!realSession(input)) return false;
  const t = activeTimer(input, now);
  if (!t || t.last.kind !== 'wait' || t.last.text !== IDLE) return false;
  append(t.file, 'step', 'resumed', now);
  return true;
}

module.exports = { idle, resume, pointerName, IDLE, STALE_HOURS };
