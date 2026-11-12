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
 * removed and never blocks. No live lock → the hook exits at once.
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

for (const target of targets) {
  for (const lock of locks) {
    if (!inside(target.path, lock.toplevel)) continue;
    if (!target.folder && ignored(lock.toplevel, target.path)) continue;
    deny('A source-bound check is running on ' + lock.toplevel + ' (started ' + lock.startedAt + ': ' + String(lock.command || '').slice(0, 120) + '). ' +
      'Changing ' + target.shown + ' now changes that tree and voids the whole run. Wait for the check to finish, then make the change; ' +
      'collect other fixes meanwhile and apply them in one batch. If no check is running (its process was killed), the lock is stale: delete ' + lock.file + '.');
  }
}
allow();
