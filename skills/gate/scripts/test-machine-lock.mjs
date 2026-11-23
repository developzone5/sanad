// test-machine-lock.mjs — a proof and a test run never use the test machine at the same time (2026-11-22, owner).
//
// A re-run of a small task ran the proof (8 copies) and the full suite on the test machine together: three suite tests
// timed out and two breaks were not seen. The proof also syncs the clone there, so a check that runs beside it ends on
// other code. red-proof.mjs takes the 'proof' side before it syncs, and evidence.mjs takes the 'check' side before it
// reads the clone: a side waits while the other side holds the machine. Runs of one side may share it (the server's
// and the page's proofs, as before).
//
// Each run writes <state>/test-machine/<host>/<side>-<pid>.json ({ pid, side, tool, at }) BEFORE it looks at the other
// side, so two runs that start together never both go on. The file is written whole (a temporary name, then a rename),
// so a reader never sees half of it. When both runs see each other, the later one (by time, then pid) takes its file
// back and waits; the earlier one keeps its file and goes on once the other side's files are gone. A file whose process
// has ended is removed by the next run that reads it; a file that cannot be read is removed only when it is old.
// A run that has waited `waitMs` stops (null): it never runs beside the other side (attack, 2026-11-22).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SIDES = ['proof', 'check'];
const STALE_MS = 60 * 1000;
const stateDir = () => process.env.SANAD_STATE_DIR || path.join(os.homedir(), '.claude', 'state');
const hostKey = (host) => String(host || 'default').replace(/^.*@/, '').toLowerCase().replace(/[^a-z0-9_.-]/g, '_');
export const lockDir = (host) => path.join(stateDir(), 'test-machine', hostKey(host));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const before = (a, b) => a.at < b.at || (a.at === b.at && a.pid < b.pid);

// The live runs of `side` on this host other than this process; files of ended processes are removed.
function holders(dir, side) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.startsWith(side + '-') || !name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    let held = null;
    try { held = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { held = null; }
    if (held && held.pid === process.pid) continue;
    if (!held || !Number.isInteger(held.pid) || !Number.isFinite(held.at)) {
      // Not readable: a file being replaced, or a broken one. Only an old one is removed.
      let age = 0;
      try { age = Date.now() - fs.statSync(file).mtimeMs; } catch { continue; }
      if (age > STALE_MS) { try { fs.unlinkSync(file); } catch { /* gone */ } continue; }
      out.push({ pid: 0, side, tool: 'a run whose lock is being written', at: 0 });
      continue;
    }
    if (!alive(held.pid)) { try { fs.unlinkSync(file); } catch { /* gone */ } continue; }
    out.push(held);
  }
  return out;
}

// Writes the whole file under a temporary name, then renames it into place. A rename that a reader holds up (Windows:
// EPERM, EBUSY) is tried again; one that keeps failing throws, and the caller stops: a run never goes on unlocked
// (re-check, 2026-11-22).
async function writeWhole(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value));
  for (let i = 0; ; i++) {
    try { fs.renameSync(temp, file); return; } catch (e) {
      if (i >= 20) { try { fs.unlinkSync(temp); } catch { /* gone */ } throw e; }
      await sleep(100);
    }
  }
}

/**
 * Waits until no run of the other side holds the test machine `host`, then holds it for `side` ('proof' or 'check').
 * Returns a release function (it also runs when the process exits), or null when the wait passed `waitMs`: the caller
 * then stops and says so, and never runs beside the other side.
 */
export async function holdTestMachine(host, side, tool, { waitMs = 90 * 60 * 1000, stepMs = 2000, say = (l) => process.stderr.write(l + '\n') } = {}) {
  if (!SIDES.includes(side)) throw new Error(`test-machine-lock: unknown side ${side}`);
  const other = SIDES.find((s) => s !== side);
  const dir = lockDir(host);
  const file = path.join(dir, `${side}-${process.pid}.json`);
  const cannot = (e) => { say(`TEST MACHINE: the lock file ${file} cannot be written (${String(e && (e.code || e.message) || e)}); this run stops and does not run unlocked.`); return null; };
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return cannot(e); }
  const started = Date.now();
  let mine = null, told = false;
  const drop = () => { try { fs.unlinkSync(file); } catch { /* gone */ } mine = null; };
  for (;;) {
    if (!mine) {
      mine = { pid: process.pid, side, tool, at: Date.now() };
      try { await writeWhole(file, mine); } catch (e) { mine = null; return cannot(e); }
    }
    const busy = holders(dir, other);
    if (!busy.length) break;
    if (busy.some((h) => before(h, mine))) drop();
    const first = busy.reduce((a, b) => (before(a, b) ? a : b));
    if (Date.now() - started > waitMs) {
      drop();
      say(`TEST MACHINE: still busy with ${first.tool}${first.pid ? ` (pid ${first.pid})` : ''} after ${Math.round(waitMs / 60000)} min; this run stops and does not run beside it. Run it again when that run ends.`);
      return null;
    }
    if (!told) { say(`TEST MACHINE: waiting for the ${first.tool} run${first.pid ? ` (pid ${first.pid})` : ''} on ${host} to end: a proof and a test run never share it`); told = true; }
    await sleep(stepMs);
  }
  let released = false;
  const release = () => { if (released) return; released = true; drop(); process.removeListener('exit', release); };
  process.on('exit', release);
  return release;
}
