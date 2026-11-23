// notes-dir.mjs — the task's notes folder: one map of its file names, and three small saved records.
//
// 2026-11-19: each tool spelled the notes folder's file names itself (lines.mjs, siblings.mjs,
// review-brief.mjs, loop.md), and the author typed the same five paths three times a round. A task's state
// (which repository, which rounds were reviewed at which commit, what the owner decided) lived only in the
// chat. This file is the one home of those names and of three records the tools write:
//
//   paths(notes)                     every file of the folder by its name of today, plus the three below
//   readTask / writeTask             task.json        repo, base, branch, start time, sides
//   readPins / addPin                review-pin.json  one review round per pin: kind, commit, tree, merge base
//   readDecisions / addDecision      decisions.json   what the owner decided, in the owner's words: D1, D2, ...
//   taskDirOf / setTaskDir           <state>/sanad-task/<hash>.json: the notes folder of a work tree, hashed
//                                    from its canonical top as the proof record is (proof-record.mjs
//                                    canonicalTop). No session id is used, so it also works on a Codex host.
//
// Rules of every record:
//   - It has a version (1). A file that is broken or of another version is refused by its name (NotesError),
//     never read as empty: a tool that read "no pins" from a damaged file would start round 1 again.
//   - It is written under a lock folder (<file>.lock), to a temp file, then renamed over the old one. A writer
//     that cannot get the lock writes nothing and says which lock (NotesError 'locked'); it never goes on
//     without it. A killed writer leaves the old file whole. A lock whose writer is gone is taken over.
//   - NO GUARD READS THESE FILES. The author can write them, so a hook must never trust them: they hold
//     state for tools and for the printed steps only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonicalTop } from './proof-record.mjs';

export const VERSION = 1;
const OWNER = 'owner.json';
// A writer holds its lock for a few milliseconds. A lock folder with no readable owner file that is older than
// the first number was left between "made" and "signed". A signed one older than the second is held by nobody
// who still writes: its process id now belongs to another program (Windows gives ids out again fast), or its
// writer hangs. A writer waits a little longer than that, so such a lock costs one wait and no hand repair.
const UNSIGNED_DEAD_MS = 2000;
const STUCK_MS = 10000;
const LOCK_WAIT_MS = 12000;

// code: 'usage' (a wrong argument), 'broken' (not readable as this record), 'version' (another version),
// 'locked' (the lock was not ours: nothing written), 'write' (the rename failed: the old file is kept),
// 'other-task' (the folder or pointer belongs to another work tree's task). file: the file it is about.
export class NotesError extends Error {
  constructor(code, file, message) { super(message); this.name = 'NotesError'; this.code = code; this.file = file; }
}
const usage = (message) => new NotesError('usage', '', message);

// ---- The names ----

// The files of a notes folder. The names on the first four lines are the ones the tools use today
// (lines.mjs: lines.md and ticket.md; loop.md: check.md, places.md, breaks.json, proof.log; siblings.mjs:
// siblings*.md; review-brief.mjs: the brief given as --out, <brief>-fresh.md, launch.md, engine.txt, size.txt).
export function paths(notes) {
  if (typeof notes !== 'string' || !notes.trim()) throw usage('no notes folder given');
  const dir = path.resolve(notes);
  const at = (name) => path.join(dir, name);
  return {
    dir,
    ticket: at('ticket.md'), lines: at('lines.md'), check: at('check.md'), places: at('places.md'),
    siblings: at('siblings.md'), siblingsReport: at('siblings-report.md'), siblingsBrief: at('siblings-brief.md'),
    brief: at('brief.md'), fresh: at('brief-fresh.md'), launch: at('launch.md'), engine: at('engine.txt'), size: at('size.txt'),
    breaks: at('breaks.json'), proofLog: at('proof.log'),
    task: at('task.json'), pins: at('review-pin.json'), decisions: at('decisions.json'),
  };
}

// ---- The lock ----

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function ownerOf(lock) {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(lock, OWNER), 'utf8'));
    return o && Number.isInteger(o.pid) && typeof o.token === 'string' ? o : null;
  } catch { return null; }
}

// The owner of a lock nobody holds any more, or null while it may be held. Dead: its writer's process is gone
// (on this machine), or the lock is older than a writer ever holds one (see the numbers above).
function deadOwner(lock) {
  const owner = ownerOf(lock);
  if (owner && owner.host === os.hostname() && !alive(owner.pid)) return owner;
  let age;
  try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { return null; }
  return age > (owner ? STUCK_MS : UNSIGNED_DEAD_MS) ? owner || { token: '' } : null;
}

// Removes a dead lock. Only one waiter at a time may do it (a second folder, <lock>.clear), and it looks
// again once it is alone: without that, two waiters that both saw the dead lock could each remove it, the
// second one removing the first one's new lock.
function clearDead(lock) {
  const dead = deadOwner(lock);
  if (!dead) return false;
  const alone = lock + '.clear';
  try { fs.mkdirSync(alone); }
  catch {
    try { if (Date.now() - fs.statSync(alone).mtimeMs > 30000) fs.rmSync(alone, { recursive: true, force: true }); } catch { /* gone */ }
    return false;
  }
  try {
    const still = deadOwner(lock);
    if (!still || still.token !== dead.token) return false;
    fs.rmSync(lock, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    return true;
  } catch { return false; }
  finally { try { fs.rmdirSync(alone); } catch { /* gone */ } }
}

// Runs fn(mine) while this process holds <file>.lock; mine() says whether the lock is still ours.
function withLock(file, waitMs, fn) {
  const lock = file + '.lock', token = crypto.randomBytes(8).toString('hex');
  const refused = (why) => new NotesError('locked', file, `${why}; nothing was written to ${file}`);
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); }
  catch (e) { throw refused(`the folder ${path.dirname(file)} cannot be made (${e.code})`); }
  const end = Date.now() + waitMs;
  for (let last = ''; ;) {
    try { fs.mkdirSync(lock); break; }
    catch (e) {
      // EEXIST: another writer holds it. The others: Windows, while that folder is being removed.
      if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw refused(`the lock ${lock} cannot be made (${e.code})`);
      last = e.code;
    }
    if (clearDead(lock)) continue;
    if (Date.now() >= end) {
      const o = ownerOf(lock);
      throw refused(`the lock ${lock} is held by ${o ? `process ${o.pid} since ${o.at}` : `another writer (${last})`} and did not open in ${Math.round(waitMs / 100) / 10} s. If no Sanad tool is running, delete that folder`);
    }
    pause(20);
  }
  const mine = () => { const o = ownerOf(lock); return Boolean(o && o.token === token); };
  const release = () => { try { fs.rmSync(lock, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); } catch { /* our process id is on it: the next writer clears it when we are gone */ } };
  try { fs.writeFileSync(path.join(lock, OWNER), JSON.stringify({ pid: process.pid, host: os.hostname(), token, at: new Date().toISOString() })); }
  catch (e) { release(); throw refused(`the lock ${lock} cannot be signed (${e.code})`); }
  try { return fn(mine); }
  finally { if (mine()) release(); }
}

// ---- Read and write ----

function readStore(file) {
  let text;
  for (let tries = 0; text === undefined; tries++) {
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (e) {
      if (e.code === 'ENOENT') return null;
      // Windows: a writer is replacing the file at this moment.
      if (tries < 20 && ['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { pause(10); continue; }
      throw new NotesError('broken', file, `${file} cannot be read (${e.code}). Fix or delete the file.`);
    }
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let data;
  try { data = JSON.parse(text); } catch { data = undefined; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new NotesError('broken', file, `${file} is not a saved record (not a JSON object). Fix or delete the file.`);
  if (data.version !== VERSION) throw new NotesError('version', file, `${file} is version ${JSON.stringify(data.version) ?? 'none'}; this tool reads version ${VERSION}. Update the workflow, or delete the file.`);
  return data;
}
const broken = (file, why) => new NotesError('broken', file, `${file} ${why}. Fix or delete the file.`);

// Temp file, then rename: a reader sees the old file or the new one, never a part. Called with the lock held.
function writeStore(file, data, mine) {
  const dir = path.dirname(file), base = path.basename(file);
  // Only the lock's holder writes a temp file, so one that is here now was left by a stopped writer.
  for (const name of fs.readdirSync(dir)) if (name.startsWith(base + '.') && name.endsWith('.tmp')) fs.rmSync(path.join(dir, name), { force: true });
  const temp = path.join(dir, `${base}.${process.pid}.tmp`);
  const fd = fs.openSync(temp, 'w');
  try { fs.writeSync(fd, JSON.stringify(data, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (!mine()) { fs.rmSync(temp, { force: true }); throw new NotesError('locked', file, `the lock of ${file} was taken by another writer; nothing was written to ${file}`); }
  for (let tries = 0; ; tries++) {
    try { fs.renameSync(temp, file); return; }
    catch (e) {
      // Windows: a reader or a scanner holds the old file for a moment.
      if (tries < 20 && ['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { pause(15); continue; }
      fs.rmSync(temp, { force: true });
      throw new NotesError('write', file, `${file} could not be replaced (${e.code}); the file as it was is kept`);
    }
  }
}

const isoTime = (value, what) => {
  const d = value === undefined || value === null || value === '' ? new Date() : new Date(value);
  if (Number.isNaN(d.getTime())) throw usage(`${what} is not a time: ${JSON.stringify(value)}`);
  return d.toISOString();
};
const str = (value, what) => {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw usage(`${what} must be text, not ${JSON.stringify(value)}`);
  return value;
};
const strList = (value, what) => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v)) throw usage(`${what} must be a list of words, not ${JSON.stringify(value)}`);
  return [...value];
};
const waitOf = (opts) => (opts && Number.isFinite(opts.waitMs) && opts.waitMs >= 0 ? opts.waitMs : LOCK_WAIT_MS);

// ---- task.json ----

// The task of this notes folder, or null when none was written.
export function readTask(notes) {
  const file = paths(notes).task, data = readStore(file);
  if (!data) return null;
  if (typeof data.repo !== 'string' || !data.repo || typeof data.top !== 'string' || !Array.isArray(data.sides)) throw broken(file, 'names no repository or has no sides list');
  return data;
}

// Writes the task: { repo, base, branch, startedAt, sides: [{ name, cwd, testCommand: [words], fixFiles: [paths] }] }.
// `top` (the repository's canonical top) is added here. Other fields the caller gives are kept as they are.
// A notes folder that holds another work tree's task is refused: two tasks never share one folder.
export function writeTask(notes, task, opts) {
  const p = paths(notes), t = task || {};
  if (typeof t.repo !== 'string' || !t.repo.trim()) throw usage('a task needs repo: the folder of its repository');
  if (t.sides !== undefined && !Array.isArray(t.sides)) throw usage('task.sides must be a list');
  const seen = new Set();
  const sides = (t.sides || []).map((s, i) => {
    const what = `task.sides[${i}]`;
    if (!s || typeof s.name !== 'string' || !s.name.trim()) throw usage(`${what} needs a name`);
    if (seen.has(s.name)) throw usage(`two sides are named ${s.name}`);
    seen.add(s.name);
    const testCommand = strList(s.testCommand, `${what}.testCommand`);
    if (!testCommand.length) throw usage(`${what} needs testCommand: the words of its test command`);
    return { ...s, name: s.name, cwd: str(s.cwd, `${what}.cwd`), testCommand, fixFiles: strList(s.fixFiles, `${what}.fixFiles`) };
  });
  const repo = path.resolve(t.repo), top = canonicalTop(repo);
  const saved = { ...t, version: VERSION, repo, top, base: str(t.base, 'task.base'), branch: str(t.branch, 'task.branch'), startedAt: isoTime(t.startedAt, 'task.startedAt'), sides };
  return withLock(p.task, waitOf(opts), (mine) => {
    const before = readTask(p.dir);
    if (before && before.top !== top) throw new NotesError('other-task', p.task, `${p.task} is the task of ${before.repo}; a task of ${repo} needs its own notes folder`);
    writeStore(p.task, saved, mine);
    return saved;
  });
}

// ---- review-pin.json ----

const GIT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

// Every pinned review round, oldest first; [] when none was saved.
export function readPins(notes) {
  const file = paths(notes).pins, data = readStore(file);
  if (!data) return [];
  if (!Array.isArray(data.pins)) throw broken(file, 'has no pins list');
  return data.pins;
}

// Saves one review round: { kind: 'full' | 'recheck', commit, tree, mergeBase, seats: [names], frozen: <folder or ''>, at }.
// The round number is given here, under the lock: one more than the last. A pin with the kind, commit and tree
// of the last pin is that same round written again (the brief was made twice), not a new round, so the count
// of rounds is the count of reviewed commits. Returns the saved pin.
export function addPin(notes, pin, opts) {
  const file = paths(notes).pins, p = pin || {};
  if (p.kind !== 'full' && p.kind !== 'recheck') throw usage(`a pin's kind is full or recheck, not ${JSON.stringify(p.kind)}`);
  for (const key of ['commit', 'tree', 'mergeBase']) if (typeof p[key] !== 'string' || !GIT_ID.test(p[key])) throw usage(`a pin needs ${key} as a full git id, not ${JSON.stringify(p[key])}`);
  const fields = { kind: p.kind, commit: p.commit, tree: p.tree, mergeBase: p.mergeBase, seats: strList(p.seats, 'pin.seats'), frozen: str(p.frozen, 'pin.frozen'), at: isoTime(p.at, 'pin.at') };
  return withLock(file, waitOf(opts), (mine) => {
    const pins = readPins(notes);
    const last = pins[pins.length - 1];
    const again = Boolean(last) && last.kind === fields.kind && last.commit === fields.commit && last.tree === fields.tree;
    const round = again ? last.round : pins.reduce((max, x) => Math.max(max, Number.isInteger(x.round) ? x.round : 0), 0) + 1;
    // The same round written again keeps its first time: earlier reports of that round still count.
    // A round written again keeps its first note count too (review-brief's round limit: the notes after it are that
    // round's own, re-check 2026-11-22).
    const saved = { ...p, ...fields, round, ...(again && last.at ? { at: last.at } : {}), ...(again && Number.isInteger(last.noteCount) ? { noteCount: last.noteCount } : {}) };
    writeStore(file, { version: VERSION, pins: again ? [...pins.slice(0, -1), saved] : [...pins, saved] }, mine);
    return saved;
  });
}

// ---- decisions.json ----

// Every decision of the task, oldest first; [] when none was saved.
export function readDecisions(notes) {
  const file = paths(notes).decisions, data = readStore(file);
  if (!data) return [];
  if (!Array.isArray(data.decisions)) throw broken(file, 'has no decisions list');
  return data.decisions;
}

// Saves one decision: { kind, question, words: <the owner's exact words>, source: <where the words came from>,
// notes: [note numbers such as 'N12'], at }. Its id (D1, D2, ...) is given here, under the lock. Returns it saved.
export function addDecision(notes, decision, opts) {
  const file = paths(notes).decisions, d = decision || {};
  if (typeof d.kind !== 'string' || !d.kind.trim()) throw usage('a decision needs a kind');
  if (typeof d.words !== 'string' || !d.words.trim()) throw usage("a decision needs words: the owner's own words");
  const fields = { kind: d.kind, question: str(d.question, 'decision.question'), words: d.words, source: str(d.source, 'decision.source'), notes: strList(d.notes, 'decision.notes'), at: isoTime(d.at, 'decision.at') };
  return withLock(file, waitOf(opts), (mine) => {
    const decisions = readDecisions(notes);
    const n = decisions.reduce((max, x) => { const m = /^D(\d+)$/.exec(String(x && x.id)); return m ? Math.max(max, Number(m[1])) : max; }, 0) + 1;
    const saved = { ...d, ...fields, id: `D${n}` };
    writeStore(file, { version: VERSION, decisions: [...decisions, saved] }, mine);
    return saved;
  });
}

// ---- The work tree's pointer ----

const stateDir = () => process.env.SANAD_STATE_DIR || path.join(os.homedir(), '.claude', 'state');
const pointerFile = (top) => path.join(stateDir(), 'sanad-task', crypto.createHash('sha1').update(top).digest('hex').slice(0, 16) + '.json');

// The repository of the task a notes folder holds, when it is not the work tree `top`; '' otherwise. A
// task.json that cannot be read says nothing here: its own reader reports it.
function otherTask(dir, top) {
  let task = null;
  try { task = readTask(dir); } catch { /* reported by readTask where it is needed */ }
  return task && task.top !== top ? task.repo : '';
}

// The notes folder of the task in this work tree, or '' when none was set. Each work tree of a repository
// has its own. A pointer that names another work tree's task is refused, never followed.
export function taskDirOf(repo) {
  const top = canonicalTop(repo), file = pointerFile(top), data = readStore(file);
  if (!data) return '';
  if (data.top !== top || typeof data.notes !== 'string' || !data.notes) throw broken(file, `is not the task pointer of ${repo}`);
  const other = otherTask(data.notes, top);
  if (other) throw new NotesError('other-task', file, `the task pointer of ${repo} (${file}) names ${data.notes}, which holds the task of ${other}. Start this task again with its own notes folder.`);
  return data.notes;
}

// Names `notes` as the notes folder of the task in this work tree. The pointer is replaced whole, so a
// broken one is healed by setting it again. Returns the folder's full path.
export function setTaskDir(repo, notes, opts) {
  const top = canonicalTop(repo), dir = paths(notes).dir, file = pointerFile(top);
  const other = otherTask(dir, top);
  if (other) throw new NotesError('other-task', paths(dir).task, `${paths(dir).task} is the task of ${other}; the task of ${repo} needs its own notes folder`);
  return withLock(file, waitOf(opts), (mine) => {
    writeStore(file, { version: VERSION, top, repo: path.resolve(repo), notes: dir, at: new Date().toISOString() }, mine);
    return dir;
  });
}
