'use strict';
// process-start.cjs — is the process that now holds a lock's id the one that wrote the lock?
//
// 2026-11-13: on a CI runner the id of a finished process went to the next process at once, so a check of
// the id alone said yes and a stale lock blocked. evidence.mjs also writes when its process started
// (pidStartedAt). An id is handed out again only after its process ended, so a holder that started later
// than that is another process. Callers ask only for a lock that would otherwise count (Windows needs
// PowerShell, 2-3 s, more than 6 s under a full test suite's load, so it gets 10 s; Linux reads /proc;
// macOS runs ps). A lock without pidStartedAt (the old format), or a start the system does not tell in
// time, keeps the id check alone; only an id now free counts as gone.
// 2026-11-14: moved here from check-lock-guard.js, so remote-busy.mjs and pre-review.mjs (otherTaskOnRemote)
// use the same check: they asked the id alone, and a reused id kept a stale lock alive there.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const GONE = 'gone';
// Reading error allowance (Linux ticks and uptime, a rounded clock). A process starts before it can note
// its own start, so the same process never reads as later than that.
const LATER_MS = 2000;

/** When the process now holding `pid` started (ms since 1970), GONE when no process holds it, null when unknown. */
function systemStart(pid) {
  // 2026-11-14: the id goes into a PowerShell command on Windows; any text but a whole number would run as
  // code there. Callers that pass such an id keep their own id check (unknown start).
  if (!Number.isInteger(pid)) return null;
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

/** false when the lock's id is free now or held by a process that started after the lock's own process. */
function sameProcess(lock) {
  const noted = Date.parse(lock.pidStartedAt);
  if (!Number.isFinite(noted)) return true;
  const start = systemStart(lock.pid);
  if (start === GONE) return false;
  return start === null || start <= noted + LATER_MS;
}

module.exports = { GONE, LATER_MS, systemStart, sameProcess };
