#!/usr/bin/env node
/*
 * check-lock-guard.js — PreToolUse hook (Edit, Write, MultiEdit, NotebookEdit, Bash, PowerShell).
 *
 * A source-bound evidence check (skills/gate/scripts/evidence.mjs) records the
 * repository tree before and after it runs. Any change inside that repository
 * meanwhile voids the whole run (2026-11-05: a full suite was lost twice to an
 * edit made while it ran). evidence.mjs holds a lock file while it runs; this
 * hook refuses an edit that would change a locked repository's tree: a file
 * edit to a path git does not ignore, or a shell command that writes or deletes
 * such a file there, runs a git content change (switch, merge, stash), runs a
 * formatter, or regenerates files (package add, migrations add).
 *
 * A lock whose process is gone or whose deadline has passed is stale: it is
 * removed and never blocks. So is a lock whose process id now belongs to a
 * process that started after the lock's own process (sameProcess below).
 * No live lock → the hook exits at once.
 * Deterministic, no LLM. Fail-OPEN: any error → allow.
 *
 * Author: Eng. Mohammed Almutairi - Developzone.net
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function allow() { process.exit(0); }
function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }));
  process.exit(0);
}

let input = {};
try {
  let s = fs.readFileSync(0, 'utf8');
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  input = JSON.parse(s.trim() || '{}');
} catch (e) { allow(); }

// The first tool call after a stop ends the task timer's idle wait (lib/timer-idle.cjs).
try { require('./lib/timer-idle.cjs').resume(input); } catch (e) { /* the timer never blocks a tool call */ }
// A code edit while no task timer runs starts one (lib/timer-idle.cjs autoStart, 2026-11-11).
try { require('./lib/timer-idle.cjs').autoStart(input); } catch (e) { /* the timer never blocks a tool call */ }
// A new stage of the task (code, proof, checks, tests, review) marks itself (lib/timer-idle.cjs autoStage).
try { require('./lib/timer-idle.cjs').autoStage(input); } catch (e) { /* the timer never blocks a tool call */ }

// Same folder as checkLockDir() in evidence.mjs.
const LOCK_DIR = process.env.SANAD_CHECK_LOCK_DIR || path.join(os.homedir(), '.claude', 'state', 'check-locks');

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// 2026-11-13: on a CI runner the id of a finished process went to the next process at once, so alive()
// said yes and a stale lock blocked. evidence.mjs also writes when its process started (pidStartedAt). An
// id is handed out again only after its process ended, so a holder that started later than that is another
// process. The system is asked only for a lock that would refuse this call (Windows needs PowerShell, 2-3 s,
// more than 6 s under a full test suite's load, so it gets 10 s of the hook's 15; Linux reads /proc; macOS
// runs ps). A lock without pidStartedAt (the old format), or a start the system does not tell in time, keeps
// the id check alone; only an id now free counts as gone.
const GONE = 'gone';
// Reading error allowance (Linux ticks and uptime, a rounded clock). A process starts before it can note
// its own start, so the same process never reads as later than that.
const LATER_MS = 2000;
function systemStart(pid) {
  try {
    if (process.platform === 'linux') {
      let stat;
      try { stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? GONE : null; }
      // Field 22: the start in clock ticks (USER_HZ, 100) after boot; field 2, the name in (), may hold spaces.
      const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
      const age = Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]) - ticks / 100;
      return Number.isFinite(age) && age >= 0 ? Date.now() - age * 1000 : null;
    }
    if (process.platform === 'win32') {
      const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const out = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command',
        `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if (-not $p) { 'gone' } elseif ($p.StartTime) { $p.StartTime.ToFileTimeUtc() }`],
      { encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (out === GONE) return GONE;
      return /^\d+$/.test(out) ? Number(BigInt(out) / 10000n - 11644473600000n) : null; // FILETIME: 100 ns since 1601
    }
    let out;
    try {
      out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000, env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch (e) { return e.status === 1 && !String(e.stdout || '').trim() ? GONE : null; }
    const t = Date.parse(out);
    return Number.isFinite(t) ? t : null;
  } catch (e) { return null; }
}
function sameProcess(lock) {
  const noted = Date.parse(lock.pidStartedAt);
  if (!Number.isFinite(noted)) return true;
  const start = systemStart(lock.pid);
  if (start === GONE) return false;
  return start === null || start <= noted + LATER_MS;
}

function liveLocks() {
  let names;
  try { names = fs.readdirSync(LOCK_DIR).filter((n) => n.endsWith('.json')); } catch (e) { return []; }
  const now = Date.now();
  const out = [];
  for (const name of names) {
    const file = path.join(LOCK_DIR, name);
    let lock;
    try { lock = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { continue; } // being written: skip, never delete
    if (!lock || typeof lock.toplevel !== 'string' || !Number.isInteger(lock.pid) || !(Date.parse(lock.expiresAt) > now) || !alive(lock.pid)) {
      try { fs.rmSync(file, { force: true }); } catch (e) { /* the next run retries */ }
      continue;
    }
    out.push({ ...lock, file });
  }
  return out;
}

const locks = liveLocks();
if (!locks.length) allow();

const tool = String(input.tool_name || '');
const toolInput = input.tool_input || {};
const cwd = input.cwd ? path.resolve(String(input.cwd)) : process.cwd();

// Compare paths by their real location, case-blind on Windows.
function real(p) {
  let r = path.resolve(p);
  try { r = fs.realpathSync.native(r); } catch (e) {
    try { r = path.join(fs.realpathSync.native(path.dirname(r)), path.basename(r)); } catch (e2) { /* keep the resolved path */ }
  }
  r = r.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? r.toLowerCase() : r;
}
function inside(p, top) { const a = real(p), t = real(top); return a === t || a.startsWith(t + '/'); }

// Ignored paths are outside the tree the check records (it stages with `git add -A`).
function ignored(top, p) {
  try {
    execFileSync('git', ['-C', top, 'check-ignore', '-q', '--', p], { stdio: 'ignore', timeout: 5000, windowsHide: true });
    return true;
  } catch (e) { return false; } // exit 1 = not ignored; an error counts as not ignored
}

const targets = [];
if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
  const p = toolInput.file_path || toolInput.notebook_path;
  if (p) targets.push({ path: path.resolve(cwd, String(p)), shown: String(p) });
} else if (tool === 'Bash' || tool === 'PowerShell') {
  let scan, shell;
  try { scan = require(path.join(__dirname, 'lib', 'transcript-scan.js')); shell = require(path.join(__dirname, 'lib', 'shell-command.cjs')); } catch (e) { allow(); }
  const command = String(toolInput.command || '');
  const opts = { tool, home: os.homedir(), tmp: os.tmpdir() };
  for (const p of scan.shellEditPaths(command)) {
    if (p === '<git>' || p === '<generated>') {
      // A git content change or generated files land in the folder each segment runs in.
      const dirs = new Set([cwd]);
      try { for (const rec of shell.parseCommand(command, { cwd, ...opts })) { const d = (rec.git && rec.git.cwd) || rec.cwd; if (d) dirs.add(d); } } catch (e) { /* the session folder still counts */ }
      for (const d of dirs) targets.push({ path: d, shown: p === '<git>' ? 'a git content change in ' + d : 'generated files in ' + d, folder: true });
      continue;
    }
    const resolved = shell.shellPath(p, cwd, opts);
    if (resolved) targets.push({ path: resolved, shown: p });
  }
  // Any other file the command writes or deletes is in the recorded tree too, unless git ignores it
  // (2026-11-12, audit H14: a note or a spec written during a suite voided the run only at its end).
  try { for (const t of scan.shellWriteTargets(command, { cwd, ...opts })) if (!targets.some((x) => x.path === t.path)) targets.push(t); } catch (e) { /* the targets above still count */ }
}

const checked = new Map(); // lock file → still its own process
for (const target of targets) {
  for (const lock of locks) {
    if (!inside(target.path, lock.toplevel)) continue;
    if (!target.folder && ignored(lock.toplevel, target.path)) continue;
    if (!checked.has(lock.file)) checked.set(lock.file, sameProcess(lock));
    if (!checked.get(lock.file)) {
      try { fs.rmSync(lock.file, { force: true }); } catch (e) { /* the next run retries */ }
      continue;
    }
    deny('A source-bound check is running on ' + lock.toplevel + ' (started ' + lock.startedAt + ': ' + String(lock.command || '').slice(0, 120) + '). ' +
      'Changing ' + target.shown + ' now changes that tree and voids the whole run. Wait for the check to finish, then make the change; ' +
      'collect other fixes meanwhile and apply them in one batch. If no check is running (its process was killed), the lock is stale: delete ' + lock.file + '.');
  }
}
allow();
