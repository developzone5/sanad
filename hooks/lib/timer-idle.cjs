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
//
// A timer that ends or pauses keeps its pointer as <state>/sanad-timer-last-<session id>: the timer this
// session had before (2026-11-17, audit S7), so the next task is never counted from what was typed up to its end. The task starts at the time
// sanad-timer.mjs request wrote when Sanad routed it (sanad-task-start-<session id>); with none, the start is
// a guess from the typed messages and the timer says "estimate".
// 2026-11-20: `request` now starts the new timer itself (it is then the active one, so no edit starts another):
// a task in another work tree than the session's folder had no timer for 45 minutes. The request file is
// still read here when an older script wrote one.
const fs = require('fs');
const os = require('os');
const path = require('path');

const IDLE = 'idle: the session stopped (waiting for the user or helpers)';
const STALE_HOURS = 8;

const stateDir = () => process.env.SANAD_STATE_DIR || path.join(os.homedir(), '.claude', 'state');
// 2026-11-22: an Orca session keeps its log under <APPDATA>/orca/claude-profiles/<id>/home/projects (or the projects
// folder of CLAUDE_CONFIG_DIR), so its timer got the start mark and nothing else: no stage, no wait. The trusted
// roots are the scanner's (session-root.cjs); a log under a .claude/projects folder still counts, as before.
const realSession = (input) => {
  const file = String((input && input.transcript_path) || '');
  return /\/\.claude\/projects\//i.test(file.replace(/\\/g, '/')) || require('./session-root.cjs').inSessionRoot(file);
};
function pointerName(input) {
  const id = (input && input.session_id) || path.basename(String((input && input.transcript_path) || '').replace(/\\/g, '/'), '.jsonl');
  const key = String(id || '').replace(/[^A-Za-z0-9_-]/g, '');
  return key ? `sanad-timer-active-${key}` : 'sanad-timer-active';
}
const lastName = (input) => pointerName(input).replace('sanad-timer-active', 'sanad-timer-last');

// A "side" line (a review that ran beside the stages) is not a moment of the timeline: the last mark is
// the last step or wait.
function lastMark(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l && l.split('\t')[1] !== 'side');
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
//          <state>/timers/<time>-<repo>. Its first mark is the time of the task's first request (the first
//          message the user typed since this session's last timer ended and since the last silence longer
//          than QUIET_MIN, at most START_BACK_MIN before the edit), else now.
//   end    a stop after a `GATE: PASS` line that came after the last code edit (the ship brief follows the
//          gate) ends the active timer, if the gate is newer than the timer's start.
// A timer paused by hand is not active, so a code edit starts a new one: resume a paused task first.
// 2026-11-17 (audit S7): the start was the LAST message, at most 60 minutes back. A request at 10:00 and a
// "go" at 10:20 started the task at 10:20, and a plan longer than an hour started it at the first edit: the
// time before the approval was never counted.
const START_BACK_MIN = 240;
// A message typed after a silence this long starts the task: the user came back. What was typed before it
// (the yes to the push of the task before, a question) is other talk, and the silence itself is no work.
// Without this, a second round three hours after a push would count from the yes to that push.
const QUIET_MIN = 30;
// The transcript is read from its end, a chunk at a time, SCAN_MAX at most: the first request can sit far
// above the last megabytes (the files read and the test output come after it).
const SCAN_CHUNK = 4 * 1024 * 1024;
// The time rule below ends the reading (an entry older than the window); this cap only bounds a runaway file.
const SCAN_MAX = 512 * 1024 * 1024;
// Entries are not always written in time order (real transcripts hold entries up to an hour older than the
// entry before them), so the reading goes on until an entry this much older than the time it looks for.
const OUT_OF_ORDER_MIN = 60;

/** Each line of a file, the last line first, until `each` returns false or `max` bytes are read. */
function linesBackward(file, max, each) {
  const fd = fs.openSync(file, 'r');
  try {
    let pos = fs.fstatSync(fd).size;
    const stop = Math.max(0, pos - max);
    let rest = Buffer.alloc(0); // the end of a line that began in the chunk before
    while (pos > stop) {
      const len = Math.min(SCAN_CHUNK, pos - stop);
      const buf = Buffer.alloc(len + rest.length);
      fs.readSync(fd, buf, 0, len, pos - len);
      rest.copy(buf, len);
      pos -= len;
      let end = buf.length;
      for (let nl = buf.lastIndexOf(10); nl >= 0; nl = end ? buf.lastIndexOf(10, end - 1) : -1) {
        if (each(buf.toString('utf8', nl + 1, end)) === false) return;
        end = nl;
      }
      rest = buf.subarray(0, end);
    }
    // The file's first line has no line break before it; a line cut by `max` is not a whole line.
    if (pos === 0 && rest.length) each(rest.toString('utf8'));
  } finally { fs.closeSync(fd); }
}

// The time the user typed an entry, or null for an entry that is no request: a hook note, a tool result, a
// system notice (its words start with a tag), the summary after a compaction, an interruption.
// Claude Code names the sender (origin.kind): a human's entry counts whatever it starts with, because pasted
// text arrives as <pasted_content …>. An entry with no human sender is judged by its words.
function typedAt(e) {
  if (!e || e.type !== 'user' || e.isMeta || e.isCompactSummary || !e.message) return null;
  const c = e.message.content;
  const blocks = Array.isArray(c) ? c : [{ type: 'text', text: String(c || '') }];
  if (blocks.some((b) => b && b.type === 'tool_result')) return null;
  if (!(e.origin && e.origin.kind === 'human')) {
    const text = blocks.filter((b) => b && b.type === 'text').map((b) => b.text || '').join(' ').trim();
    if (!text || text.startsWith('<') || /^\[Request interrupted by user/.test(text)) return null;
  }
  const at = new Date(e.timestamp);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** The user entries of a transcript from `from` to `until`, the oldest first: { at, typed }. */
// typed: the user typed it (typedAt). The others are tool results and notices: the signs that work went on.
function userEntries(transcriptPath, from, until) {
  const found = [];
  try {
    linesBackward(transcriptPath, SCAN_MAX, (line) => {
      // Only a line that can be a user entry is parsed: the logged API requests hold most of a long
      // session's bytes (63 of 73 MB in one), and parsing them took over a second.
      if (!/"type"\s*:\s*"user"/.test(line)) return true;
      let e;
      try { e = JSON.parse(line); } catch (err) { return true; }
      if (!e || e.type !== 'user') return true;
      const at = new Date(e.timestamp);
      if (at < from - OUT_OF_ORDER_MIN * 60000) return false;
      if (at >= from && at <= until) found.push({ at, typed: !!typedAt(e) });
      return true;
    });
  } catch (err) { /* no transcript to read: no entry */ }
  // The file is read backward: reversed first, so entries of the same millisecond (a message and the notice
  // written right after it for a pasted picture) keep their file order through the stable sort.
  return found.reverse().sort((a, b) => a.at - b.at);
}

// The last mark of the timer this session had before (lastName), or null: the next task begins after it.
// paused: that task is not over (sanad-timer.mjs pause), other work came in the middle of it.
function previousTimer(input) {
  try {
    const dir = fs.readFileSync(path.join(stateDir(), lastName(input)), 'utf8').trim();
    const last = dir ? lastMark(path.join(dir, 'timer.tsv')) : null;
    if (!last || Number.isNaN(last.at.getTime())) return null;
    return { at: last.at, paused: last.kind === 'wait' && last.text.startsWith('paused: ') };
  } catch (e) { return null; }
}

// The time Sanad wrote down when it routed this task (sanad-timer.mjs request): the task's real start.
// Read once and removed. It is ignored when it is older than the window, or not after the end of the
// timer before (a leftover of a task that is over).
const requestName = (input) => pointerName(input).replace('sanad-timer-active', 'sanad-task-start');
function routedAt(input, now, prev) {
  const file = path.join(stateDir(), requestName(input));
  let at;
  try { at = new Date(fs.readFileSync(file, 'utf8').trim()); } catch (e) { return null; }
  try { fs.rmSync(file); } catch (e) { /* already gone */ }
  if (Number.isNaN(at.getTime()) || at > now || now - at > STALE_HOURS * 3600000) return null;
  if (prev && !prev.paused && at <= prev.at) return null;
  return at;
}

/** When the task was first asked for: { at, estimate, entries }, or null (the user typed nothing). */
// estimate: no start was written down at routing, so the time is a guess from the typed messages.
function firstRequestAt(input, now) {
  const back = new Date(now.getTime() - START_BACK_MIN * 60000);
  const prev = previousTimer(input);
  // The timer before ended: what the user typed up to its end belongs to that task, never to this one.
  const ended = prev && !prev.paused && prev.at > back ? prev.at : null;
  const routed = routedAt(input, now, prev);
  const entries = userEntries(input.transcript_path, routed || ended || back, now);
  if (routed) return { at: routed, estimate: false, entries };
  let asked = entries.filter((e) => e.typed && !(ended && e.at <= ended));
  // Other work in the middle of a paused task was asked for by the last message before the pause.
  const beforePause = prev && prev.paused ? asked.filter((e) => e.at <= prev.at).length : 0;
  if (beforePause) asked = asked.slice(beforePause - 1);
  // The user came back after a long silence (QUIET_MIN): the task is counted from that message.
  for (let i = asked.length - 1; i > 0; i--) {
    const before = entries[entries.indexOf(asked[i]) - 1];
    if (asked[i].at - before.at > QUIET_MIN * 60000) return { at: asked[i].at, estimate: true, entries };
  }
  return asked.length ? { at: asked[0].at, estimate: true, entries } : null;
}

// The waits for the user between the task's start and its first edit: each message the user typed after the
// start, with the span since the entry before it (the user was thinking, or away): [from, to].
const WAIT_MIN = 1;
function waitsForUser(entries, start) {
  const inTask = entries.filter((e) => e.at >= start);
  const waits = [];
  for (let i = 1; i < inTask.length; i++) {
    if (inTask[i].typed && inTask[i].at - inTask[i - 1].at >= WAIT_MIN * 60000) waits.push([inTask[i - 1].at, inTask[i].at]);
  }
  return waits;
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
  } catch (e) {
    // Git did not answer (slow, a safety setting): the nearest folder with a .git entry (a folder, or the
    // file a linked work tree has) is the top. A folder with none is no repository: no timer.
    for (let d = dir; ; d = path.dirname(d)) {
      if (fs.existsSync(path.join(d, '.git'))) return d;
      if (path.dirname(d) === d) return '';
    }
  }
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
  const first = firstRequestAt(input, now);
  const start = first ? first.at : now;
  fs.mkdirSync(dir, { recursive: true });
  const tsv = path.join(dir, 'timer.tsv');
  const startText = first ? `start (auto${first.estimate ? ', estimate' : ''}): the user's message — ${repo}` : `start (auto): first code edit — ${repo}`;
  append(tsv, 'step', startText, start);
  if (first) {
    // The wait for the user's go is waiting, not work (2026-11-17, audit S7).
    for (const [from, to] of waitsForUser(first.entries, start)) {
      append(tsv, 'wait', 'waiting for the user', from);
      append(tsv, 'step', `resumed: ${startText}`, to);
    }
    append(tsv, 'step', 'first code edit', now);
  }
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
  // No timer is active now; the ended one stays named as the timer before (previousTimer, 2026-11-17).
  const active = path.join(stateDir(), pointerName(input));
  try { fs.renameSync(active, path.join(stateDir(), lastName(input))); } catch (e) { try { fs.rmSync(active); } catch (err) { /* already gone */ } }
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
    // 2026-11-19: the places list, the second look and the note check are stages too.
    if (runs('places')) return 'places';
    if (runs('siblings')) return 'second look';
    if (runs('note-check') || runs('notes')) return 'notes';
  }
  return editedCodeFiles(input, isCode).length ? 'code' : '';
}

// A short id of the tree a run starts on: HEAD plus a hash of the uncommitted diff. '?' when git does not answer.
function treeId(cwd) {
  try {
    const git = (args) => require('child_process').execFileSync('git', ['-C', cwd || process.cwd(), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    const head = git(['rev-parse', 'HEAD']).trim();
    const diff = git(['diff', 'HEAD']);
    return head.slice(0, 8) + (diff ? '+' + require('crypto').createHash('sha1').update(diff).digest('hex').slice(0, 8) : '');
  } catch (e) { return '?'; }
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
  // 2026-11-19: every proof or pre-review start is a "run" side line with the tree id, so the report can tell
  // a retry from overlapping work. The step itself is still added once.
  // 2026-11-23 (owner): a proof call that runs no test (--help, --check-plan, --show-remote, --warm) is no proof run: run 3
  // of the small task counted 10 "runs", 4 of them such calls.
  // A quoted flag counts too (attack, 2026-11-23: "--warm"); only the proof's own options are read, the part before its
  // ` -- ` (re-check: a test filter "--warm" after it is the test command's).
  // From the proof's own name on (re-check 3: a `git diff -- src` before it ended the read too early).
  const whole = String((input.tool_input || {}).command || '');
  const own = whole.slice(Math.max(0, whole.indexOf('red-proof.mjs'))).split(/\s["']?--["']?(?=\s)/)[0];
  const noRun = stage === 'proof' && /(?:^|[\s"'])--(?:help|check-plan|show-remote|warm)(?=["'\s]|$)/.test(own);
  if ((stage === 'proof' && !noRun) || stage === 'checks before review') append(t.file, 'side', `run ${stage.split(' ')[0]} ${treeId(input.cwd)}`, now);
  if (same && t.last.kind !== 'wait') return '';
  append(t.file, 'step', stage, now);
  return stage;
}

// ---------------------------------------------------------------------------------------------------------
// A review runs beside the other stages (the checks and the suite go on while it reads), so it is no step
// of the timeline. Each finished reviewer run is written once as a "side" line, "review <start> <end>", and
// sanad-timer.mjs report lists it apart (2026-11-11: the report of a task showed no review time at all; the
// hook that marks stages does not see the launch of a helper).
/** At an allowed stop (stop-gate), before the timer can end: the reviews that finished since the timer began. */
function sideReviews(input, scan, now = new Date()) {
  if (!realSession(input) || !scan || !Array.isArray(scan.reviews) || !scan.reviews.length) return 0;
  const t = activeTimer(input, now);
  if (!t) return 0;
  const text = fs.readFileSync(t.file, 'utf8');
  const started = new Date(text.split('\t')[0]);
  let added = 0;
  for (const r of scan.reviews) {
    const from = new Date(r.launchAt), to = new Date(r.doneAt);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to < from || from < started) continue;
    if (text.includes(`\tside\treview ${from.toISOString()} `)) continue;
    append(t.file, 'side', `review ${from.toISOString()} ${to.toISOString()}`, now);
    added++;
  }
  return added;
}

module.exports = { idle, resume, autoStart, autoEnd, autoStage, sideReviews, userEntries, pointerName, IDLE, STALE_HOURS };
