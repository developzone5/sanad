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
// busy: a check or helper of this work still runs (2026-11-11: a proof running on the test machine counted as
// waiting, so TUW-242 showed 11 work minutes of 18). The machine is working, so the task is too.
function idle(input, now = new Date(), { busy = false } = {}) {
  if (!realSession(input) || busy) return false;
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
  // The step that goes on is named, so the report can add a stage's parts together.
  const stage = lastStage(t.file);
  append(t.file, 'step', stage ? `resumed: ${stage}` : 'resumed', now);
  return true;
}

// The stage a timer is in: its last step, without the "resumed: " of a step that went on.
const stageName = (text) => String(text || '').replace(/^resumed: /, '');
function lastStage(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const [, kind, ...rest] = lines[i].split('\t');
    const name = stageName(rest.join(' '));
    if (kind === 'step' && name && name !== 'resumed') return name;
  }
  return '';
}

// ---------------------------------------------------------------------------------------------------------
// The timer starts and ends by itself (2026-11-11, TUW-242: a small task's timer was started by hand 10
// minutes late, and small and medium timers were never ended).
//   start  the first code edit in a git repository while this session has no active timer starts one in
//          <state>/timers/<time>-<repo>. Its first mark is the time of the user's message the work answers
//          (the last real prompt in the transcript, at most START_BACK_MIN before), else now.
//   end    a stop after a `GATE: PASS` line that came after the last code edit (the ship brief follows the
//          gate) ends the active timer, if the gate is newer than the timer's start.
// A timer paused by hand is not active, so a code edit starts a new one: resume a paused task first.
const START_BACK_MIN = 60;

function readTail(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally { fs.closeSync(fd); }
}

/** The time of the last message the user typed (not a hook note, a tool result or a system notice), or null. */
function lastPromptAt(transcriptPath) {
  let lines;
  try { lines = readTail(transcriptPath, 4 * 1024 * 1024).split(/\r?\n/); } catch (e) { return null; }
  for (let i = lines.length - 1; i >= 0; i--) {
    let e;
    try { e = JSON.parse(lines[i]); } catch (err) { continue; }
    if (!e || e.type !== 'user' || e.isMeta || !e.message) continue;
    const c = e.message.content;
    const blocks = Array.isArray(c) ? c : [{ type: 'text', text: String(c || '') }];
    if (blocks.some((b) => b && b.type === 'tool_result')) continue;
    const text = blocks.filter((b) => b && b.type === 'text').map((b) => b.text || '').join(' ').trim();
    if (!text || text.startsWith('<')) continue;
    const at = new Date(e.timestamp);
    if (!Number.isNaN(at.getTime())) return at;
  }
  return null;
}

// The code files a tool call writes: a file tool's path, or the files a shell command writes.
function editedCodeFiles(input, isCode) {
  const tool = String(input.tool_name || '');
  const toolInput = input.tool_input || {};
  const cwd = input.cwd ? path.resolve(String(input.cwd)) : process.cwd();
  const scan = require('./transcript-scan.js');
  const files = [];
  if (scan.EDIT_TOOLS.has(tool)) {
    const p = toolInput.file_path || toolInput.notebook_path;
    if (p) files.push(path.resolve(cwd, String(p)));
  } else if (tool === 'Bash' || tool === 'PowerShell') {
    const shell = require('./shell-command.cjs');
    const opts = { tool, home: os.homedir(), tmp: os.tmpdir() };
    // A name written after `cd <dir> &&` lands in that folder, not in the session's (2026-11-11: an edit in
    // another repository started a timer named after the session's project).
    let dir = cwd;
    for (const seg of scan.splitSegments(String(toolInput.command || ''))) {
      const cd = /^\s*(?:cd|Set-Location|pushd)\s+(?:\/d\s+)?("[^"]+"|'[^']+'|[^\s;&|]+)\s*$/i.exec(seg);
      if (cd) { dir = shell.shellPath(cd[1].replace(/^["']|["']$/g, ''), dir, opts) || dir; continue; }
      for (const p of scan.shellEditPaths(seg)) {
        if (p.startsWith('<')) continue;
        const resolved = shell.shellPath(p, dir, opts);
        if (resolved) files.push(resolved);
      }
    }
  }
  return files.filter((f) => (isCode || scan.isCodePath)(f));
}

function repoTop(file) {
  let dir = path.dirname(file);
  while (dir && !fs.existsSync(dir)) { const up = path.dirname(dir); if (up === dir) return ''; dir = up; }
  try {
    return require('child_process').execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true }).trim();
  } catch (e) { return ''; }
}

/** At a tool call (check-lock-guard): a code edit with no active timer starts one. Returns its folder, or null. */
// isCode: tests only (their files live in the temp folder, which never counts as code).
function autoStart(input, now = new Date(), { isCode } = {}) {
  if (!realSession(input) || activeTimer(input, now)) return null;
  const file = editedCodeFiles(input, isCode)[0];
  const top = file && repoTop(file);
  if (!top) return null;
  const repo = path.basename(top).replace(/[^A-Za-z0-9_.-]/g, '_');
  const dir = path.join(stateDir(), 'timers', now.toISOString().replace(/[:.]/g, '').slice(0, 15) + '-' + repo);
  const asked = lastPromptAt(input.transcript_path);
  const start = asked && asked <= now && now - asked <= START_BACK_MIN * 60000 ? asked : now;
  fs.mkdirSync(dir, { recursive: true });
  append(path.join(dir, 'timer.tsv'), 'step', `start (auto): ${start === now ? 'first code edit' : "the user's message"} — ${repo}`, start);
  if (start !== now) append(path.join(dir, 'timer.tsv'), 'step', 'first code edit', now);
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(path.join(stateDir(), pointerName(input)), dir);
  return dir;
}

/** At an allowed stop (stop-gate): a GATE: PASS after the last code edit ends the active timer. */
function autoEnd(input, scan, now = new Date()) {
  if (!realSession(input) || !scan || !(scan.lastGate > scan.lastEdit) || !/^PASS$/i.test(String(scan.lastGateVerdict || ''))) return false;
  const gateAt = new Date(scan.lastGateAt || '');
  const t = activeTimer(input, now);
  if (!t || Number.isNaN(gateAt.getTime())) return false;
  const [first] = fs.readFileSync(t.file, 'utf8').split(/\r?\n/);
  const started = new Date(String(first || '').split('\t')[0]);
  if (Number.isNaN(started.getTime()) || gateAt < started) return false;
  append(t.file, 'step', 'end (auto: the gate passed; the ship brief)', now);
  try { fs.rmSync(path.join(stateDir(), pointerName(input))); } catch (e) { /* already gone */ }
  return true;
}

// ---------------------------------------------------------------------------------------------------------
// Stages mark themselves (2026-11-11, TUW-243: the automatic timer showed one step, "first code edit: 35
// min", so the slow part could not be seen). A tool call that starts another stage adds a step:
//   code                    an edit of a code file
//   proof                   red-proof.mjs
//   checks before review    pre-review.mjs
//   tests                   evidence.mjs (a build or test run with a receipt)
//   review                  an independent reviewer is launched
// The same stage twice in a row adds nothing. sanad-timer.mjs report adds a stage's parts together.
function stageOf(input, isCode) {
  const tool = String(input.tool_name || '');
  const toolInput = input.tool_input || {};
  if (tool === 'Agent') return /^\s*You are the independent reviewer\b/i.test(String(toolInput.prompt || '')) ? 'review' : '';
  if (tool === 'Bash' || tool === 'PowerShell') {
    const command = String(toolInput.command || '');
    // The script is RUN by node. Its name in other words (`git add …/red-proof.mjs`, a `sed` on it) is no
    // stage (2026-11-11: work on these scripts themselves read as a 23-minute proof).
    const runs = (name) => new RegExp(`(?:^|[\\s;&|(])["']?(?:\\S*[\\\\/])?node(?:\\.exe)?["']?\\s+["']?[^\\s"']*[\\\\/]${name}\\.mjs(?:["'\\s]|$)`).test(command);
    if (runs('red-proof')) return 'proof';
    if (runs('pre-review')) return 'checks before review';
    if (runs('evidence')) return 'tests';
  }
  return editedCodeFiles(input, isCode).length ? 'code' : '';
}

/** At a tool call (check-lock-guard): a new stage of the task marks itself. Returns the stage marked, or ''. */
function autoStage(input, now = new Date(), { isCode } = {}) {
  if (!realSession(input)) return '';
  const t = activeTimer(input, now);
  if (!t) return '';
  const stage = stageOf(input, isCode);
  if (!stage) return '';
  const current = lastStage(t.file);
  // The timer's own first marks are the code stage already. A wait someone marked by hand ends here.
  const same = current === stage || (stage === 'code' && /^(?:first code edit|start \(auto\))/.test(current));
  if (same && t.last.kind !== 'wait') return '';
  append(t.file, 'step', stage, now);
  return stage;
}

module.exports = { idle, resume, autoStart, autoEnd, autoStage, lastPromptAt, pointerName, IDLE, STALE_HOURS };
