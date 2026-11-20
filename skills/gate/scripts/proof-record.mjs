// proof-record.mjs — what red-proof.mjs proved, kept so pre-review can tell whether the current
// tests were ever seen failing under a break of the rule they test (2026-11-07: three rounds in a
// row, a "nothing happens" check passed review that no run had ever seen fail).
//
// One record file per repository, one entry per proof (2026-11-12): an entry is keyed by the proof's
// test command and folder, and a new proof adds or replaces only its own entry. Before, one record
// held every changed test file of both stacks and each proof overwrote it: a frontend break proof
// marked every backend "nothing happens" check proven (and the reverse), a single --break did the
// same, and a later --old-only run (no break) erased a proved record. Now an entry names only the
// test files that hold a test a caught break named (with their hashes), and the hashes of the files
// its breaks changed: when one of those changed since, the entry no longer counts.
//
// 2026-11-17 (audit: "one caught test certifies another rule's vacuous negative check" and "stale mutation
// proof survives dependency edits and even a failed re-proof"): an entry also names the TESTS its breaks made
// fail (`caught`: per test file, each test's line and title, and the full name the runner printed), and one id
// of the code under test (`code`: the working tree as git sees it, prose left out). A "nothing happens" check
// counts only when the test that holds its line is one of those tests, and only while today's code id is the
// entry's. A proof that starts and does not end PROVED leaves its entry as { ok: false, reason }, so an older
// success never outlives a newer failure. An entry in the format before (no `caught`, no `code`) proves nothing.
//
// 2026-11-19 (one result per break): an entry is all or nothing, so one break that timed out, or a stop before the
// end, lost the result of every break that had ended. The record now also holds one result per break (`perBreak`)
// and the facts of each run (`runs`), beside `entries` and never inside an entry: writing an entry does not touch
// them. A break's result counts only on the exact code tree its run was on (codeFingerprint), and only when the
// passing run passed on that same tree. Saving, losing or taking back one break's result never changes another's.
// There is no softer reader: after any code or test edit every result stops counting, as for an entry.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { TEST_FILE } from './check-ticket-lines.mjs';

export function proofDir() { return process.env.SANAD_STATE_DIR ? path.join(process.env.SANAD_STATE_DIR, 'proof') : path.join(os.homedir(), '.claude', 'state', 'proof'); }

function git(cwd, args) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

export function toplevelOf(dir) { return git(dir, ['rev-parse', '--show-toplevel']); }
export function defaultBase(top) { return 'origin/' + (git(top, ['config', '--get', 'sanad.integration']) || 'staging'); }

// Changed and new test files since the merge base with <base>, or null when there is none.
export function changedTestFiles(top, base) {
  const from = git(top, ['merge-base', base, 'HEAD']);
  if (!from) return null;
  const tracked = git(top, ['diff', '--name-only', '--diff-filter=d', from]).split(/\r?\n/);
  const untracked = git(top, ['ls-files', '--others', '--exclude-standard']).split(/\r?\n/);
  return [...new Set([...tracked, ...untracked].filter(f => f && TEST_FILE.test(f) && fs.existsSync(path.join(top, f))))].sort();
}

// Hashed with line endings made the same, so a rebase or checkout that rewrites LF as CRLF does not
// make a proven test look new (2026-11-08: after a rebase, pre-review called proven checks unproven).
// Product files (a break's target) are hashed the same way.
export function testFileHashes(top, files) {
  return Object.fromEntries(files.map(f => [f, crypto.createHash('sha256').update(fs.readFileSync(path.join(top, f), 'utf8').replace(/\r\n/g, '\n')).digest('hex')]));
}
function hashOrNull(top, file) {
  try { return testFileHashes(top, [file])[file]; } catch { return null; }
}

// Documentation Markdown (2026-11-18): a .md file under a folder named docs, doc, specs, memory, .claude, .github or .gitlab
// (any depth, any case), or named README, CHANGELOG, CHANGES, LICENSE, NOTICE, AUTHORS, NOTES, TODO, CLAUDE, AGENTS, SKILL or PLAN
// (the name before its first dot, any case). Any other .md may be a page text the product reads, so it counts.
// Repair (2026-11-18, round g): a .md below a source folder (src, app, content, pages, public, wwwroot, resources) is a page the
// product may read, whatever its name or a docs/memory folder below it. SKILL, CLAUDE, AGENTS and .claude/.github/.gitlab are
// no longer documentation here: the push guard treats them as code that needs proof, so a stale proof must not survive them.
const DOC_DIRS = new Set(['docs', 'doc', 'specs', 'memory']);
const DOC_NAMES = new Set(['readme', 'changelog', 'changes', 'license', 'notice', 'authors', 'notes', 'todo', 'plan']);
const SOURCE_DIRS = new Set(['src', 'app', 'content', 'pages', 'public', 'wwwroot', 'resources']);
export function isDocMarkdown(file) {
  const parts = String(file).replace(/\\/g, '/').split('/').filter(Boolean);
  const base = parts.pop() || '';
  if (!/\.md$/i.test(base)) return false;
  if (parts.some(d => SOURCE_DIRS.has(d.toLowerCase()))) return false;
  return parts.some(d => DOC_DIRS.has(d.toLowerCase())) || DOC_NAMES.has(base.split('.')[0].toLowerCase());
}

// The code under test as one id (2026-11-17, audit "stale mutation proof survives dependency edits"): an entry
// was accepted while its break targets and its test files were unchanged, so an edit to any other code a test
// depends on left the old proof valid. The id is the tree of the working folder as git sees it: HEAD's files plus
// every uncommitted and untracked (not ignored) change, with documentation Markdown (isDocMarkdown) left out; a .txt may be data the product reads, so it counts. So a
// commit of the same files, a reworded commit and a prose edit keep it; any other edit changes it. Built through
// a copy of the index, the way pre-review-cache.mjs builds its tree, so the real index is never touched.
// '' when git cannot say (no repository, a failed add or write-tree): nothing is recorded or proven then.
export function codeFingerprint(top) {
  let dir = '';
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanad-proof-index-'));
    const index = path.join(dir, 'index');
    const run = (args) => execFileSync('git', args, { cwd: top, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_INDEX_FILE: index } }).trim();
    const real = git(top, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    if (real && fs.existsSync(real)) fs.copyFileSync(real, index); else run(['read-tree', 'HEAD']);
    run(['add', '--all']);
    // Markdown counts unless it is documentation by its place or name (2026-11-18, audit finding 3).
    const docs = run(['ls-files', '-z']).split('\0').filter(isDocMarkdown);
    if (docs.length) execFileSync('git', ['update-index', '--force-remove', '-z', '--stdin'], { cwd: top, input: docs.join('\0') + '\0', windowsHide: true,
      stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, GIT_INDEX_FILE: index } });
    const tree = run(['write-tree']);
    return /^[0-9a-f]{40,64}$/.test(tree) ? tree : '';
  } catch { return ''; }
  finally { try { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } }
}

// One folder can have several spellings (a short 8.3 name such as RUNNER~1 on a CI machine, a link,
// another case): the writer and the reader must name it the same, so both ask git for the top level
// and the system for the real path (2026-11-07: CI saved a record under one name and read another).
export function canonicalTop(top) {
  let p = git(top, ['rev-parse', '--show-toplevel']) || path.resolve(top);
  try { p = fs.realpathSync.native(p); } catch { /* keep the git answer */ }
  return path.resolve(p).replace(/\\/g, '/').toLowerCase();
}
function recordPath(top) {
  return path.join(proofDir(), crypto.createHash('sha1').update(canonicalTop(top)).digest('hex').slice(0, 16) + '.json');
}

// The key of a proof's entry: its test command and the folder it ran in (relative to the repository).
export function recordKey(command, cwd = '') {
  return crypto.createHash('sha1').update(JSON.stringify([String(cwd).replace(/\\/g, '/'), ...command.map(String)])).digest('hex').slice(0, 16);
}

// The record: { top, entries: { <key>: { ok, breaks, files, targets, caught, code, ... } } }, or for a proof
// that did not end PROVED { ok: false, reason, ... } (2026-11-17). A file in the format
// before 2026-11-12 (one proof, no entries) reads as no entry: it may credit the other stack's tests.
// 2026-11-19: beside `entries` the record may hold
//   perBreak: { <key>: { <break id>: { id, name, file, state, tree, caught, files, ms, at, run, sum } } }
//   runs:     { <key>: { <tree>: { tree, run, green, redOld, files, at, sum } } }
// (see writeBreakResult and writeRunFacts). A reader of the format before ignores both, and a writer of the format
// before keeps them as they are, so a rollback loses nothing.
function readRecordFile(file) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  return raw && typeof raw.entries === 'object' && raw.entries ? raw : { top: raw?.top, entries: {} };
}
export function readRecord(top) { return readRecordFile(recordPath(top)); }

// One read-change-write under one short lock, for every writer of the record (2026-11-19). Before, a writer that
// could not take the lock in 200 tries wrote anyway, with no lock, and could lose the result another writer was
// saving. Now: no lock, no write. The caller gets the named error 'record busy' and the record stays as it was.
// `change(record)` edits the record in place; when it returns false nothing is written.
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// Whether the writer that made a lock is gone: the lock holds its process id. Unknown (no id yet) reads as alive.
function lockOwnerGone(lock) {
  let pid;
  try { pid = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8')); } catch { return false; }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; }
}
function changeRecordFile(file, change) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = file + '.lock';
  let locked = false, last = '';
  for (let i = 0; i < 200 && !locked; i++) {
    try { fs.mkdirSync(lock); locked = true; }
    catch (e) {
      // EPERM: on Windows, a lock folder that another writer is removing right now. It is free in a moment.
      if (e.code !== 'EEXIST' && e.code !== 'EPERM') throw e;
      last = e.code;
      // A lock left by a stopped writer is taken over: its process is gone, or it is older than 30 s.
      try { if (lockOwnerGone(lock) || Date.now() - fs.statSync(lock).mtimeMs > 30000) { fs.rmSync(lock, { recursive: true, force: true }); continue; } } catch { continue; }
      pause(25);
    }
  }
  if (!locked) {
    const busy = new Error(`record busy: another writer holds the lock of the proof record (${path.basename(lock)}, ${last}); nothing was written. Run the command again.`);
    busy.name = 'RecordBusy';
    busy.code = 'RECORD_BUSY';
    throw busy;
  }
  try {
    try { fs.writeFileSync(path.join(lock, 'pid'), String(process.pid)); } catch { /* the 30 s rule still frees it */ }
    const record = readRecordFile(file) || { entries: {} };
    if (change(record) === false) return false;
    const text = JSON.stringify(record, null, 2);
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, text);
    // The rename swaps the whole file at once, so a writer killed here leaves the record as it was. On Windows a
    // reader that has the file open makes the rename fail for a moment: try again before the plain write.
    let moved = false;
    for (let i = 0; i < 40 && !moved; i++) {
      try { fs.renameSync(temp, file); moved = true; } catch { pause(15); }
    }
    if (!moved) { fs.writeFileSync(file, text); fs.rmSync(temp, { force: true }); }
    return true;
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

// Adds or replaces one proof's entry; every other entry stays. Two proofs that end at once (the
// server's and the page's) each read, merge and write under a short lock, so neither loses the other.
export function writeEntry(top, key, entry) {
  changeRecordFile(recordPath(top), (record) => {
    record.top = path.resolve(top);
    record.entries[key] = { ...entry, at: new Date().toISOString() };
  });
}

// ---- One result per break (2026-11-19) ----

// The states a break's run can end in. Only 'caught' can ever count as proof.
export const BREAK_STATES = ['caught', 'not-caught', 'invalid', 'timeout', 'machine'];

const objOf = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const lf = (s) => String(s ?? '').replace(/\r\n/g, '\n');

// The id of one break: its name, file, find, put and mustFail, so two breaks with one name and another find text
// are two breaks, and a break whose text changed is a new break that must run. Line endings are made the same
// first, so a break list saved with CRLF names the same breaks.
export function breakId(brk) {
  const b = objOf(brk);
  const parts = [lf(b.name), String(b.file ?? '').replace(/\\/g, '/'), lf(b.find), lf(b.put), (Array.isArray(b.mustFail) ? b.mustFail : []).map(lf)];
  return crypto.createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

// Tests as the record keeps them: { <test file>: [{ line, title, ran? }] }, files in order. Takes a list of
// { file, line, title, ran } (what red-proof's caughtTests gives) or the kept shape itself. A test with no file,
// line or title is left out: it could not be matched to a test later.
function testsByFile(tests) {
  const list = Array.isArray(tests) ? tests
    : Object.entries(objOf(tests)).flatMap(([file, items]) => (Array.isArray(items) ? items : []).map(t => ({ ...objOf(t), file })));
  const by = {};
  for (const t of list) {
    if (!t || typeof t.file !== 'string' || !t.file || !Number.isInteger(t.line) || typeof t.title !== 'string') continue;
    (by[t.file.replace(/\\/g, '/')] ||= []).push({ line: t.line, title: t.title, ...(t.ran === undefined || t.ran === null ? {} : { ran: String(t.ran) }) });
  }
  return Object.fromEntries(Object.keys(by).sort().map(f => [f, by[f]]));
}
// The hash of each named file as it is now; a file that cannot be read has none, so its tests never count.
function hashesNow(top, files) {
  const out = {};
  for (const f of files) { const h = hashOrNull(top, f); if (h) out[f] = h; }
  return out;
}

// A check sum over the fields a reader trusts. A result or a run's facts whose fields were changed by hand (a state
// turned into 'caught', a tree id pasted in) no longer fits its sum and never counts. THE LIMIT that stays: the
// record is a plain file the author can write, so this stops an edit of one field, not a whole forged result.
const sumOf = (parts) => crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
const flatTests = (byFile) => Object.keys(objOf(byFile)).sort().map(f => [f, (Array.isArray(byFile[f]) ? byFile[f] : []).map(t => [t?.line ?? null, String(t?.title ?? ''), String(t?.ran ?? '')])]);
const flatFiles = (files) => Object.keys(objOf(files)).sort().map(f => [f, String(files[f])]);
const breakSum = (key, r) => sumOf(['break', key, r.id, r.name, r.file, r.state, r.tree, flatTests(r.caught), flatFiles(r.files), r.run]);
// `old` (the commit the old-code run used) is part of the sum only when it is set, so a record without it stays sound.
const factsSum = (key, f) => sumOf(['run', key, f.tree, f.run, f.green === true, flatTests(f.redOld), flatFiles(f.files), ...(typeof f.old === 'string' && f.old ? [f.old] : [])]);
const soundBreak = (key, id, r) => Boolean(r) && typeof r === 'object' && r.id === id && BREAK_STATES.includes(r.state) && typeof r.tree === 'string' && r.sum === breakSum(key, r);
const soundFacts = (key, tree, f) => Boolean(f) && typeof f === 'object' && f.tree === tree && f.sum === factsSum(key, f);

// Saves the result of one break's run; every other break's result stays as it is. `key` is the proof's recordKey.
// result: { state (one of BREAK_STATES), tree (the codeFingerprint the run was on), run (the run's id), caught (the
// tests the break made fail: a list of { file, line, title, ran }), ms, files (optional: the hash of each test
// file in `caught` as the run saw it; taken now when not given) }. Returns the break's id.
// A result with an empty tree (git could not say) is kept so its state can be shown, and never counts.
export function writeBreakResult(top, key, brk, result) {
  const res = objOf(result);
  if (!BREAK_STATES.includes(res.state)) throw new TypeError(`writeBreakResult: unknown state ${JSON.stringify(res.state)} (one of ${BREAK_STATES.join(', ')})`);
  const id = breakId(brk);
  const caught = res.state === 'caught' ? testsByFile(res.caught) : {};
  const given = objOf(res.files);
  const files = Object.keys(given).length ? Object.fromEntries(Object.keys(caught).filter(f => given[f]).map(f => [f, String(given[f])])) : hashesNow(top, Object.keys(caught));
  const kept = { id, name: String(objOf(brk).name ?? ''), file: String(objOf(brk).file ?? '').replace(/\\/g, '/'), state: res.state, tree: String(res.tree || ''),
    caught, files, ms: Number.isFinite(res.ms) ? res.ms : null, run: String(res.run ?? '') };
  kept.sum = breakSum(key, kept);
  changeRecordFile(recordPath(top), (record) => {
    record.top = path.resolve(top);
    const all = record.perBreak = objOf(record.perBreak);
    (all[key] = objOf(all[key]))[id] = { ...kept, at: new Date().toISOString() };
  });
  return id;
}

// Saves what one run found out about one code tree: whether the passing run passed on it (`green`), and the tests
// seen red on the old code (`redOld`: a list of { file, line, title }). facts: { tree, run, green?, redOld?, files? }.
// A second call of the same run for the same tree adds to the first (the passing run ends before the old-code run);
// a call of another run starts that tree's facts again, so facts never mix two runs. The red-on-old tests are the
// exception (2026-11-20): when the tree and the old commit (`old`) are the same, a new old-code run ADDS its red tests to
// the saved ones, and never drops an earlier one. Returns false, and writes
// nothing, when the tree id is empty: there is nothing to tie the facts to.
export function writeRunFacts(top, key, facts) {
  const f = objOf(facts), tree = String(f.tree || ''), run = String(f.run ?? '');
  if (!tree) return false;
  changeRecordFile(recordPath(top), (record) => {
    record.top = path.resolve(top);
    const all = record.runs = objOf(record.runs);
    const mine = all[key] = objOf(all[key]);
    const sound = soundFacts(key, tree, mine[tree]) ? mine[tree] : null;
    const had = sound && sound.run === run ? sound : {};
    const newOld = typeof f.old === 'string' ? f.old : '';
    const oldClash = Boolean(sound && sound.old && newOld && sound.old !== newOld);
    // The earlier red tests stay when this is the same run, or another run on the same old commit, unless the old commits differ.
    const priorRed = sound && !oldClash && (sound.run === run || (sound.old && sound.old === newOld)) ? sound : {};
    let redOld = objOf(had.redOld), files = objOf(had.files);
    // 2026-11-20: a run that gives no old-code tests (the passing run) keeps the red-on-old tests an earlier run of
    // this tree saved: they are facts about the old code. The reader still checks each test file's saved hash.
    if (f.redOld === undefined && sound && sound.run !== run && !oldClash && Object.keys(objOf(sound.redOld)).length) { redOld = objOf(sound.redOld); files = objOf(sound.files); }
    if (f.redOld !== undefined) {
      const prior = Object.entries(objOf(priorRed.redOld)).flatMap(([file, items]) => (Array.isArray(items) ? items : []).map(t => ({ ...objOf(t), file })));
      const fresh = testsByFile(f.redOld);
      const list = [...prior, ...Object.entries(fresh).flatMap(([file, items]) => items.map(t => ({ ...t, file })))];
      const seen = new Set();
      redOld = testsByFile(list.filter(t => { const k = JSON.stringify([t.file, t.line, t.title]); if (seen.has(k)) return false; seen.add(k); return true; }));
      const given = objOf(f.files), now = hashesNow(top, Object.keys(redOld));
      files = Object.fromEntries(Object.keys(redOld).map(n => [n, given[n] ? String(given[n]) : now[n]]).filter(([, h]) => h));
    }
    const kept = { tree, run, green: f.green === undefined ? had.green === true : f.green === true, redOld, files };
    const carried = f.redOld === undefined && sound && sound.run !== run && sound.old && Object.keys(redOld).length ? String(sound.old) : '';
    const oldKept = newOld || (priorRed.old ? String(priorRed.old) : '') || (had.old ? String(had.old) : '') || carried;
    if (oldKept) kept.old = oldKept;
    kept.sum = factsSum(key, kept);
    mine[tree] = { ...kept, at: new Date().toISOString() };
  });
  return true;
}

// Withdraws the saved "green on this tree" fact of one key at the start of a new run for that tree. The fact is
// written again only when the new passing run succeeds, so a later failed run leaves no earlier pass standing.
// The tests seen red on the old code are facts about the old code and the test files, so they stay (with their
// file hashes and old commit) while the pass is set to false; an entry with no such test is removed whole.
// Returns true when a fact was removed or changed.
export function withdrawRunFacts(top, key, tree) {
  const t = String(tree || '');
  if (!t) return false;
  let removed = false;
  changeRecordFile(recordPath(top), (record) => {
    const trees = objOf(objOf(record.runs)[key]);
    const entry = trees[t];
    if (!entry) return false;
    const keepRed = soundFacts(key, t, entry) && Object.keys(objOf(entry.redOld)).length > 0;
    if (!keepRed) { delete trees[t]; removed = true; return true; }
    if (entry.green !== true) return false;
    const kept = { tree: t, run: entry.run, green: false, redOld: entry.redOld, files: entry.files };
    if (typeof entry.old === 'string' && entry.old) kept.old = entry.old;
    kept.sum = factsSum(key, kept);
    trees[t] = { ...kept, at: new Date().toISOString() };
    removed = true;
    return true;
  });
  return removed;
}

// Takes back what one run saved: its breaks' results and its run facts, and nothing of any other run. For a run
// that ended on a machine or database failure, whose results say nothing about the code. takeBackRun(top, runId),
// or takeBackRun(runId) alone: then every record of the proof folder is looked at. Returns how many were removed.
export function takeBackRun(top, runId) {
  const id = String((runId === undefined ? top : runId) ?? '');
  if (!id) return 0;
  let files = [];
  if (runId === undefined) { try { files = fs.readdirSync(proofDir()).filter(n => /^[0-9a-f]{16}\.json$/.test(n)).map(n => path.join(proofDir(), n)); } catch { files = []; } }
  else files = [recordPath(top)];
  let removed = 0;
  for (const file of files) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (!text.includes(JSON.stringify(id))) continue;
    changeRecordFile(file, (record) => {
      let n = 0;
      for (const results of Object.values(objOf(record.perBreak))) {
        for (const [bid, r] of Object.entries(objOf(results))) if (r && String(r.run) === id) { delete results[bid]; n++; }
      }
      for (const trees of Object.values(objOf(record.runs))) {
        for (const [tree, facts] of Object.entries(objOf(trees))) if (facts && String(facts.run) === id) { delete trees[tree]; n++; }
      }
      removed += n;
      return n > 0;
    });
  }
  return removed;
}

// Whether the passing run of this proof passed on this exact tree.
const passedOn = (record, key, tree) => { const f = objOf(objOf(record?.runs)[key])[tree]; return Boolean(tree) && soundFacts(key, tree, f) && f.green === true; };
// Whether each kept test file is still the one the run saw.
const filesSame = (top, files) => Object.entries(objOf(files)).every(([f, h]) => hashOrNull(top, f) === h);

// For each break of a list, in the list's order: { id, name, state, saved, counts }. state is 'proved' when the
// break holds a caught result on this exact tree (the runner need not run it again), else 'run'. saved is the
// state kept for this tree ('timeout', 'not-caught', ...) or null. counts says whether the result also counts as
// proof today: the passing run passed on this tree too (provenTests reads the same rule).
export function breakStates(top, key, breaks, tree = codeFingerprint(top), record = readRecord(top)) {
  const saved = objOf(objOf(record?.perBreak)[key]);
  const passed = passedOn(record, key, tree);
  return (Array.isArray(breaks) ? breaks : []).map(b => {
    const id = breakId(b), r = saved[id];
    const here = Boolean(tree) && soundBreak(key, id, r) && r.tree === tree;
    const proved = here && r.state === 'caught' && filesSame(top, r.files);
    return { id, name: String(objOf(b).name ?? ''), state: proved ? 'proved' : 'run', saved: here ? r.state : null, counts: proved && passed };
  });
}

// The tests a current entry proved, by test file: Map { <test file> → [{ line, title, ... }] }. An entry counts
// when it caught at least one break and each file its breaks changed is as it was then; a test file counts when
// its hash is still the one proved. 2026-11-17 (audit): the entry must also name the tests its breaks made fail
// (a whole file is no longer proven by one caught test in it), and today's code id must be the one it holds (an
// edit to code outside the break targets left the proof valid). The id is asked of git once, and only when an
// entry gets that far.
// 2026-11-19: a break's own result counts too, by the same strict rule: it is 'caught', its tree is today's tree,
// the passing run of its proof passed on that same tree, and the test file is the one the run saw. A result on any
// other tree, with an empty tree, or with no passing run for its tree never counts. Each such test names its break
// in `by`. An entry is read exactly as before.
export function provenTests(top, record = readRecord(top)) {
  return provenOn(top, record, treeOnce(top));
}
// Today's tree id, asked of git at most once and only when a reader needs it.
const treeOnce = (top) => { let tree; return () => (tree === undefined ? (tree = codeFingerprint(top)) : tree); };
function provenOn(top, record, treeOf) {
  const proven = new Map();
  for (const entry of Object.values(record?.entries || {})) {
    if (!entry || !entry.ok || !(entry.breaks >= 1) || !entry.files || !entry.targets || !Object.keys(entry.targets).length) continue;
    if (!entry.code || !entry.caught || typeof entry.caught !== 'object') continue;
    if (!Object.entries(entry.targets).every(([f, h]) => hashOrNull(top, f) === h)) continue;
    const today = treeOf();
    if (!today || entry.code !== today) continue;
    for (const [f, h] of Object.entries(entry.files)) {
      if (hashOrNull(top, f) !== h) continue;
      const tests = (Array.isArray(entry.caught[f]) ? entry.caught[f] : []).filter(t => t && Number.isInteger(t.line) && typeof t.title === 'string');
      if (tests.length) proven.set(f, [...(proven.get(f) || []), ...tests]);
    }
  }
  for (const [key, results] of Object.entries(objOf(record?.perBreak))) {
    for (const [id, r] of Object.entries(objOf(results))) {
      if (!soundBreak(key, id, r) || r.state !== 'caught' || !r.tree) continue;
      const today = treeOf();
      if (!today || r.tree !== today || !passedOn(record, key, today)) continue;
      for (const [f, list] of Object.entries(objOf(r.caught))) {
        const h = objOf(r.files)[f];
        if (!h || hashOrNull(top, f) !== h) continue;
        const tests = (Array.isArray(list) ? list : []).filter(t => t && Number.isInteger(t.line) && typeof t.title === 'string').map(t => ({ ...t, by: r.name }));
        if (tests.length) proven.set(f, [...(proven.get(f) || []), ...tests]);
      }
    }
  }
  return proven;
}
// The test files that hold a test a current entry proved.
export function provenTestFiles(top, record = readRecord(top)) {
  return new Set(provenTests(top, record).keys());
}
// Whether the tests proved for a file (a provenTests value) hold this test (a testSpans item): the same line and
// title. The file's hash is the one proved, so its lines are where they were.
export function provenHas(tests, own) {
  return Boolean(own) && (tests || []).some(t => t.line === own.line && own.titles.includes(t.title));
}

// Why "nothing happens" checks read unproven although a proof ran (2026-11-17): one line per reason, for the
// test check's summary. An entry whose code id is not today's: the code changed after the proof. An entry that
// is not ok: the last run of that proof did not end PROVED.
export function recordNotes(top, record = readRecord(top)) {
  const entries = Object.values(record?.entries || {}).filter(Boolean);
  const notes = [];
  const failed = entries.filter(e => e.ok === false);
  for (const e of failed.slice(0, 3)) notes.push(`the last run of the proof \`${(e.command || []).join(' ').slice(0, 80)}\` did not end PROVED (${String(e.reason || 'no reason kept').slice(0, 160)})`);
  const kept = entries.filter(e => e.ok && e.code);
  const treeOf = treeOnce(top);
  if (kept.length) {
    const today = treeOf();
    if (kept.some(e => e.code !== today)) notes.push('the code changed after a proof ran (any edit but *.md voids it): run that proof again');
  }
  if (entries.some(e => e.ok && !e.code)) notes.push('a proof record written before 2026-11-17 names no test: run that proof again');
  // 2026-11-19: how many breaks hold a result on today's code, and how many still must run. The breaks that must
  // run are those of the proof's newest tree with no caught result on today's code; a result of an older tree is
  // an older wording of a break or an older plan, and is not counted.
  let held = 0, mustRun = 0, any = false, noPassingRun = false;
  for (const [key, results] of Object.entries(objOf(record?.perBreak))) {
    const list = Object.entries(objOf(results)).filter(([, r]) => r && typeof r === 'object');
    if (!list.length) continue;
    any = true;
    const today = treeOf();
    const mine = list.filter(([id, r]) => Boolean(today) && soundBreak(key, id, r) && r.tree === today && r.state === 'caught');
    const newest = list.reduce((a, b) => (String(b[1].at) > String(a[1].at) ? b : a))[1].tree;
    held += mine.length;
    mustRun += list.filter(e => e[1].tree === newest && !mine.includes(e)).length;
    if (mine.length && !passedOn(record, key, today)) noPassingRun = true;
  }
  if (any) notes.push(`${held} break(s) hold a caught result on today's code, ${mustRun} still must run`);
  if (noPassingRun) notes.push("the passing run did not pass on today's code, so the caught breaks do not count yet: run the proof again");
  return notes;
}

// What proves each new test today (2026-11-19): 'old code' (the test was seen red on the old code), 'break <name>'
// (a break made it fail), or 'none'. One item per test this change added: { file, line, title, titles, evidence,
// breaks }. Both kinds follow the strict rule of provenTests: the fact was saved on today's exact tree and the
// passing run passed on that tree. So after any code or test edit, a rename of the test file or a move of the test
// to another file, the answer is 'none' until the proof runs again. null when there is no merge base with <base>:
// the new tests are not known then, and that is not "nothing to prove".
// options: { base (default: the integration branch), record, tests (the tests to ask about, as { file, line,
// titles }, in place of the new tests found here) }.
export function evidenceOf(top, options = {}) {
  const tests = options.tests || newTests(top, options.base || defaultBase(top));
  if (!tests) return null;
  if (!tests.length) return [];
  const record = options.record === undefined ? readRecord(top) : options.record;
  const today = codeFingerprint(top);
  const proven = provenOn(top, record, () => today);
  const red = new Map();
  for (const [key, trees] of Object.entries(objOf(record?.runs))) {
    const facts = objOf(trees)[today];
    if (!today || !passedOn(record, key, today)) continue;
    for (const [f, list] of Object.entries(objOf(facts.redOld))) {
      const h = objOf(facts.files)[f];
      if (!h || hashOrNull(top, f) !== h) continue;
      red.set(f, [...(red.get(f) || []), ...(Array.isArray(list) ? list : [])]);
    }
  }
  return tests.map(d => {
    const titles = Array.isArray(d.titles) ? d.titles : [];
    const hits = (list) => (list || []).filter(t => t && t.line === d.line && titles.includes(t.title));
    const breaks = [...new Set(hits(proven.get(d.file)).map(t => String(t.by || 'with no name')))];
    const evidence = hits(red.get(d.file)).length ? 'old code' : breaks.length ? `break ${breaks[0]}` : 'none';
    return { file: d.file, line: d.line, title: titles[titles.length - 1] ?? '', titles, evidence, breaks };
  });
}

// The tests this change added, in the changed test files: { file, line, titles }. Counted as red-proof's
// markNewTests counts them: a test is older when the file at the merge base declared one with the same titles,
// once per time it did. A test file the base did not have (a new or a renamed file) holds only new tests.
function newTests(top, base) {
  const from = git(top, ['merge-base', base, 'HEAD']);
  const files = from ? changedTestFiles(top, base) : null;
  if (!files) return null;
  const found = [];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(path.join(top, f), 'utf8'); } catch { continue; }
    let baseText = null;
    try { baseText = execFileSync('git', ['show', `${from}:${f}`], { cwd: top, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }); }
    catch { baseText = null; }
    const before = new Map();
    for (const d of baseText === null ? [] : declaredTests(baseText, f)) {
      const k = JSON.stringify(d.titles);
      before.set(k, (before.get(k) || 0) + 1);
    }
    for (const d of declaredTests(text, f)) {
      const k = JSON.stringify(d.titles), n = before.get(k) || 0;
      if (n) before.set(k, n - 1); else found.push({ file: f, line: d.line, titles: d.titles });
    }
  }
  return found;
}

// ---- Test titles and skipped tests (shared by red-proof.mjs and check-test-asserts.mjs) ----

// The index of the bracket that closes the one at text[open] ('(', '{' or '['), past strings and
// comments; -1 when there is none. A rough reader: enough for test files, not a parser.
function regexAllowedAt(text, i) {
  let k = i - 1;
  while (k >= 0 && (text[k] === ' ' || text[k] === '\t')) k--;
  // A regex also follows a keyword that ends an expression slot (2026-11-18, audit: `return /`/.test(c)` was read as
  // a division, and its backtick opened a template that swallowed the rest of the file).
  if (k >= 0 && /\w/.test(text[k]) && /(?<![\w$.])(?:return|typeof|case|throw|yield|await|void|in|of|do|else)$/.test(text.slice(Math.max(0, k - 8), k + 1))) return true;
  // 2026-11-18 (audit): `if (true) /name(rows)/.test(x)`: a `/` after the `)` that closes an if, while, for or with head
  // starts a regex, not a division, so its text is no code.
  if (k >= 0 && text[k] === ')') {
    // The scan runs on the text with its quoted strings blanked, so a `)` inside a string does not end the head.
    const base = Math.max(0, k - 700), seg = text.slice(base, k + 1).replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`[^`]*`/g, s => s[0] + ' '.repeat(s.length - 2) + s[s.length - 1]);
    let depth = 0, o = seg.length - 1;
    for (; o >= 0 && seg.length - 1 - o < 600; o--) { if (seg[o] === ')') depth++; else if (seg[o] === '(' && --depth === 0) break; }
    if (o >= 0 && depth === 0 && /(?<![\w$.])(?:if|while|for|with)\s*$/.test(seg.slice(Math.max(0, o - 12), o))) return true;
  }
  // 2026-11-18 (audit): a regex also follows an operator (`'a' + /x/.source`, `1 < /x/.lastIndex`) and a `}` (`if (a) {} /x/.test(y)`).
  return k < 0 || text[k] === '\n' || '(,=:!&|?{;[+-*%<>^~}'.includes(text[k]) || (text[k] === '>' && text[k - 1] === '=');
}
export function closeOf(text, open) {
  const want = { '(': ')', '{': '}', '[': ']' };
  const stack = [];
  for (let i = open; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (c === '/' && n === '/') { const e = text.indexOf('\n', i); if (e < 0) return -1; i = e; continue; }
    if (c === '/' && n === '*') { const e = text.indexOf('*/', i + 2); if (e < 0) return -1; i = e + 1; continue; }
    // A regex literal (a `/` right after `(`, `,`, `=`, `:`, `!`, `&`, `|`, `?`, `{`, `;`, `[` or a line start, closed on
    // the same line): its quotes and brackets are not the file's (2026-11-17, audit: a CSS-rule regex lost its test).
    if (c === '/' && regexAllowedAt(text, i)) {
      let j = i + 1, cls = false, closed = false;
      for (; j < text.length && text[j] !== '\n'; j++) {
        if (text[j] === '\\') j++;
        else if (text[j] === '[') cls = true;
        else if (text[j] === ']') cls = false;
        else if (text[j] === '/' && !cls) { closed = true; break; }
      }
      if (closed) { i = j; continue; }
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) { if (text[j] === '\\') j++; else if (c !== '`' && text[j] === '\n') break; j++; }
      i = j; continue;
    }
    if (want[c]) stack.push(want[c]);
    else if (c === ')' || c === '}' || c === ']') { if (stack.pop() !== c) return -1; if (!stack.length) return i; }
  }
  return -1;
}

const lineAt = (text, index) => text.slice(0, index).split('\n').length;
const isCs = (file) => /\.cs$/i.test(file);

// The text with comments and the text of string, template and regex literals replaced by spaces (2026-11-18, audit
// finding 4: a helper call written in a comment or a string counted as a call, so a helper check that no test ran
// read as proven). Same length and same line breaks, so every index and line still fits the original. Code inside a
// `${}` hole of a JS template or a `{}` hole of a C# interpolated string stays: it runs. JavaScript/TypeScript and C#
// (// and /* */ comments; ' " ` strings, regex literals; C# @"verbatim", $"interpolated", """raw""" and 'c' chars).
export function executableText(text, file = '') {
  const src = String(text), cs = isCs(file), out = src.split('');
  const blank = (a, b) => { for (let k = a; k < b && k < out.length; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' '; };
  const holes = [];
  let depth = 0;
  // Scan string content from j; returns the index just past the closing quote, or { hole } at an interpolation hole.
  const scan = (j, s) => {
    const from = j;
    for (; j < src.length; j++) {
      const c = src[j];
      if (s.raw) { if (src.startsWith(s.q.repeat(s.raw), j)) { blank(from, j); return { end: j + s.raw }; } continue; }
      if (c === '\n' && !s.multi) { blank(from, j); return { end: j }; }
      if (c === '\\' && !s.verbatim) { j++; continue; }
      if (s.q === '`' && c === '$' && src[j + 1] === '{') { blank(from, j); return { hole: j + 2 }; }
      if (s.interp && c === '{') { if (src[j + 1] === '{') { j++; continue; } blank(from, j); return { hole: j + 1 }; }
      if (c === s.q) { if (s.verbatim && src[j + 1] === s.q) { j++; continue; } blank(from, j); return { end: j + 1 }; }
    }
    blank(from, src.length);
    return { end: src.length, eof: true };
  };
  let i = 0;
  // `start` is where the literal opened. A literal that has no end before the end of the file means the scan lost its
  // way (2026-11-18, audit: a misread quote blanked every later test): the text from there on is kept as written, so
  // tests cannot vanish silently.
  let lostAt = -1;
  const lose = (start) => { if (lostAt < 0 || start < lostAt) lostAt = start; };
  const resume = (j, s, start) => {
    const r = scan(j, s);
    if (r.hole !== undefined) { holes.push({ s, depth, start }); depth++; return r.hole; }
    if (r.eof && (s.multi || s.raw)) lose(start);
    return r.end;
  };
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { const e = src.indexOf('\n', i); const to = e < 0 ? src.length : e; blank(i, to); i = to; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); const to = e < 0 ? src.length : e + 2; blank(i, to); i = to; continue; }
    if (!cs && c === '/' && regexAllowedAt(src, i)) {
      let j = i + 1, cls = false, closed = false;
      for (; j < src.length && src[j] !== '\n'; j++) {
        if (src[j] === '\\') j++;
        else if (src[j] === '[') cls = true;
        else if (src[j] === ']') cls = false;
        else if (src[j] === '/' && !cls) { closed = true; break; }
      }
      if (closed) { blank(i + 1, j); i = j + 1; continue; }
    }
    if (c === '"' || c === "'" || c === '`') {
      if (cs && c === '"') {
        // The prefix: $, @ or both, right before the quote. With an @ the string is verbatim whatever follows: `@"""x"" y"`
        // is one verbatim string that starts with a doubled quote, not a raw string (2026-11-18, audit).
        let k = i - 1, interp = false, verbatim = false;
        while (k >= 0 && (src[k] === '$' || src[k] === '@')) { if (src[k] === '$') interp = true; else verbatim = true; k--; }
        let q = 1;
        while (src[i + q] === '"') q++;
        if (q >= 3 && !verbatim) { i = resume(i + q, { q: '"', raw: q }, i); continue; }
        i = resume(i + 1, { q: '"', interp, verbatim, multi: verbatim }, i);
        continue;
      }
      i = resume(i + 1, { q: c, multi: c === '`' }, i);
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      const top = holes[holes.length - 1];
      if (top && depth === top.depth) { holes.pop(); i = resume(i + 1, top.s, top.start); continue; }
    }
    i++;
  }
  if (holes.length) lose(holes[0].start);
  if (lostAt >= 0) for (let k = lostAt; k < src.length; k++) out[k] = src[k];
  // C# `#if false` ... `#else`/`#elif`/`#endif`: code that never compiles is no code, like a comment (2026-11-18, audit
  // finding 7). Any other `#if` condition is not decided here (see the limit at helperCallers).
  if (cs) {
    const rows = out.join('').split('\n');
    let dead = 0, nest = 0;
    for (let r = 0; r < rows.length; r++) {
      const t = rows[r].trim();
      if (dead) {
        if (/^#\s*if\b/.test(t)) nest++;
        else if (/^#\s*endif\b/.test(t)) { if (nest) nest--; else dead = 0; }
        else if (!nest && /^#\s*(?:else|elif)\b/.test(t)) dead = 0;
        else rows[r] = rows[r].replace(/[^\r]/g, ' ');
      } else if (/^#\s*if\s+\(?\s*false\s*\)?\s*$/.test(t)) { dead = 1; nest = 0; }
    }
    return rows.join('\n');
  }
  return out.join('');
}

// A declaration match is live when it sits in executable code, not in a comment or a string (2026-11-18).
// Only the first two characters are compared: a title string inside the match is blank in `exec`.
const liveAt = (exec, m) => exec.slice(m.index, m.index + 2) === m[0].slice(0, 2);

// The class whose braces hold the character at `index` (2026-11-18, audit finding 5: the last `class X` written above a
// test named a closed nested class). `exec` is executableText, so a brace or the word class in a comment or a string
// is not counted. The innermost class, record or struct wins; undefined when the index is in none.
function csClasses(exec) {
  const found = [];
  for (const m of exec.matchAll(/\b(?:class|record|struct|interface)\s+(\w+)/g)) {
    if (m[1] === 'where') continue;
    // `where T : class Foo`-style constraints and `: class` are not declarations.
    if (/[:,]\s*$/.test(exec.slice(Math.max(0, m.index - 4), m.index))) continue;
    const from = m.index + m[0].length;
    const b = exec.slice(from).search(/[{;]/);
    if (b < 0 || exec[from + b] === ';') continue;
    const open = from + b;
    let d = 0, close = -1;
    for (let k = open; k < exec.length; k++) {
      if (exec[k] === '{') d++;
      else if (exec[k] === '}' && --d === 0) { close = k; break; }
    }
    if (close < 0) close = exec.length;
    // The base list (`class X<T>(int a) : Base<T>, IFoo where T : class`) and the `abstract` modifier (2026-11-18, audit:
    // the runner prints an inherited test with the derived class).
    // 2026-11-18 (audit): brackets inside the base call (`: BaseTests(db, new Options())`) are stripped from the inside out.
    let head = exec.slice(from, open).replace(/\bwhere\b[\s\S]*$/, '');
    for (let prev = ''; prev !== head;) { prev = head; head = head.replace(/\([^()]*\)/g, ''); }
    const colon = head.indexOf(':');
    const bases = colon < 0 ? [] : head.slice(colon + 1).replace(/<[^<>]*>/g, '').replace(/<[^<>]*>/g, '').split(',').map(s => s.trim().split('.').pop()).filter(Boolean);
    const abstract = /\babstract\b/.test(exec.slice(exec.lastIndexOf('\n', m.index) + 1, m.index));
    found.push({ name: m[1], open, close, bases, abstract });
  }
  return found;
}
const csClassAt = (classes, index) => classes.filter(c => c.open < index && index < c.close).sort((a, b) => b.open - a.open)[0];
// The class of a C# test, for a test item: `klass`, and `inherited` when the runner may print another class for it:
// the class is abstract, or another class in the file names it as a base (a base declared in another file and not
// abstract cannot be seen from here).
const csIdentity = (classes, index) => {
  const c = csClassAt(classes, index);
  if (!c) return {};
  const inherited = c.abstract || classes.some(o => o !== c && o.bases.includes(c.name));
  return { klass: c.name, ...(inherited ? { inherited: true } : {}) };
};
// The classes of a C# file with their base lists, for the cross-file base map of red-proof (2026-11-18, audit: an
// inherited test was credited by any class's failure; only a class known to derive from the declaring class may
// credit it, and that needs the classes of every test file the run reads, not of one file).
export function csClassList(text, file = 'A.cs') {
  return csClasses(executableText(String(text), file)).map(c => ({ name: c.name, bases: c.bases }));
}
// The file's classes ride on a test item without showing in its fields (a deep compare of items is unchanged).
const withClasses = (item, classes) => Object.defineProperty(item, 'classes', { value: classes.map(c => ({ name: c.name, bases: c.bases })), enumerable: false });
const CS_METHOD = /\b(?:void|Task|ValueTask)(?:<[^>]*>)?\s+(\w+)\s*\(/g;
// A test attribute: [Fact] and [Theory], and any attribute named ...Fact or ...Theory ([SkippableFact], [MySqlFact(...)],
// [Xunit.Fact]); 2026-11-18, audit: a test under a custom fact attribute was no test.
const CS_TEST_ATTR = /\[\s*[\w.]*(?:Fact|Theory)\b/g;

// The lines (1-based) that belong to a skipped test (2026-11-12: a [Cn] tag or a ticket quote on
// it.skip, it.todo, describe.skip, xit or [Fact(Skip = ...)] counted as a tested check line, though the
// test never runs): the skipped call or method, and the comment lines right above it.
export function skippedLines(text, file = '') {
  const src = String(text);
  const lines = src.split('\n');
  const skipped = new Set();
  const mark = (from, to) => {
    for (let l = from; l <= to; l++) skipped.add(l);
    // The comment (and, in C#, attribute) lines right above, where a test's tag often sits.
    for (let l = from - 1; l >= 1; l--) {
      const t = lines[l - 1].trim();
      if (/^(?:\/\/|\/\*|\*)/.test(t) || (isCs(file) && /^\[/.test(t))) skipped.add(l); else break;
    }
  };
  const exec = executableText(src, file);
  if (isCs(file)) {
    for (const m of src.matchAll(CS_TEST_ATTR)) {
      if (!liveAt(exec, m)) continue;
      const end = closeOf(src, m.index);
      if (end < 0 || !/\bSkip\s*=/.test(src.slice(m.index, end))) continue;
      CS_METHOD.lastIndex = end;
      const method = CS_METHOD.exec(exec);
      let last = end;
      if (method) {
        const params = closeOf(src, method.index + method[0].length - 1);
        const body = params < 0 ? -1 : src.slice(params).search(/[{;]|=>/);
        if (body >= 0) {
          const at = params + body;
          last = src[at] === '{' ? closeOf(src, at) : src.indexOf(';', at);
          if (last < 0) last = method.index;
        }
      }
      mark(lineAt(src, m.index), lineAt(src, last));
    }
    return skipped;
  }
  for (const m of src.matchAll(/(?<![\w$.])(?:(?:describe|it|test|suite)\.(?:skip|todo)\b|x(?:describe|it|test)\b)/g)) {
    if (!liveAt(exec, m)) continue;
    const open = src.indexOf('(', m.index + m[0].length);
    if (open < 0 || src.slice(m.index + m[0].length, open).trim()) continue;
    const end = closeOf(src, open);
    mark(lineAt(src, m.index), lineAt(src, end < 0 ? open : end));
  }
  return skipped;
}

// The tests a test file declares, each with its own titles: a vitest/jest it() or test() title, or a C#
// [Fact]/[Theory] method name and its DisplayName. Skipped tests are left out (they never fail), and so
// are .each tables (their titles are filled in at run time).
export function declaredTests(text, file = '') {
  const src = String(text);
  const skip = skippedLines(src, file);
  const tests = [];
  const exec = executableText(src, file);
  if (isCs(file)) {
    const classes = csClasses(exec);
    for (const m of src.matchAll(CS_TEST_ATTR)) {
      if (!liveAt(exec, m)) continue;
      const end = closeOf(src, m.index);
      if (end < 0) continue;
      const attr = src.slice(m.index, end + 1);
      if (/\bSkip\s*=/.test(attr) || skip.has(lineAt(src, m.index))) continue;
      CS_METHOD.lastIndex = end;
      const method = CS_METHOD.exec(exec);
      if (!method) continue;
      const display = /DisplayName\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(attr);
      // file and class (2026-11-18): the shown result (survivors) takes the same identity as the saved record (caughtTests).
      tests.push(withClasses({ file, line: lineAt(src, m.index), titles: [method[1], ...(display ? [display[1].replace(/\\(.)/g, '$1')] : [])], ...csIdentity(classes, m.index) }, classes));
    }
    return tests;
  }
  for (const m of src.matchAll(/(?<![\w$.])(x?)(?:it|test)((?:\.(?:only|concurrent|sequential|fails|skip|todo))*)\s*\(\s*(['"`])((?:\\.|(?!\3)[^\\])*)\3/g)) {
    if (!liveAt(exec, m)) continue;
    const line = lineAt(src, m.index);
    if (m[1] || /skip|todo/.test(m[2]) || skip.has(line)) continue;
    tests.push({ file, line, titles: [m[4].replace(/\\(.)/g, '$1')] });
  }
  return tests;
}

// ---- The test that holds a line (2026-11-17, audit "one caught test certifies another rule's vacuous negative
// check") ----

// Every test a test file declares, with the lines it spans: { file, line, end, titles, skipped }. `line` and
// `titles` are as declaredTests gives them (a C# test starts at its [Fact]/[Theory] attribute; its titles are
// the method and its DisplayName). Unlike declaredTests, a .each/.for table test is here too (its title keeps its
// placeholders, which a row's printed name fills in), and so is a skipped test, marked: a check line needs its
// test even when no break can make that test fail. A test with no title written as text has no titles.
export function testSpans(text, file = '') {
  const src = String(text);
  const skip = skippedLines(src, file);
  const spans = [];
  const exec = executableText(src, file);
  if (isCs(file)) {
    const classes = csClasses(exec);
    for (const m of src.matchAll(CS_TEST_ATTR)) {
      if (!liveAt(exec, m)) continue;
      const end = closeOf(src, m.index);
      if (end < 0) continue;
      const attr = src.slice(m.index, end + 1);
      CS_METHOD.lastIndex = end;
      const method = CS_METHOD.exec(exec);
      if (!method) continue;
      // The method's body: its block, or an expression body up to its `;` (as skippedLines reads it).
      const params = closeOf(src, method.index + method[0].length - 1);
      const body = params < 0 ? -1 : src.slice(params).search(/[{;]|=>/);
      if (body < 0) continue;
      const at = params + body;
      const last = src[at] === '{' ? closeOf(src, at) : src.indexOf(';', at);
      if (last < 0) continue;
      const display = /DisplayName\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(attr);
      const line = lineAt(src, m.index);
      // The class whose braces hold the method (2026-11-18, audit: the last `class X` written above it named a closed
      // nested class); caughtTests and survivors match a printed class to it.
      spans.push(withClasses({ file, line, end: lineAt(src, last), titles: [method[1], ...(display ? [display[1].replace(/\\(.)/g, '$1')] : [])],
        skipped: /\bSkip\s*=/.test(attr) || skip.has(line), ...csIdentity(classes, m.index) }, classes));
    }
    return spans;
  }
  for (const m of src.matchAll(/(?<![\w$.])(x?)(?:it|test)((?:\.(?:only|concurrent|sequential|fails|skip|todo|each|for|skipIf|runIf))*)\s*(?=[(`])/g)) {
    if (!liveAt(exec, m)) continue;
    let at = m.index + m[0].length;
    // it.each(table)(title, fn), it.each`table`(title, fn), it.skipIf(when)(title, fn): the first bracket is not the test's.
    if (/\.(?:each|for|skipIf|runIf)$/.test(m[2])) {
      const close = src[at] === '`' ? src.indexOf('`', at + 1) : closeOf(src, at);
      if (close < 0) continue;
      at = close + 1;
      while (/\s/.test(src[at] || '')) at++;
    }
    if (src[at] !== '(') continue;
    let close = closeOf(src, at);
    // The reader lost the call's end (a quote or a bracket it misread): the test ends where the next one starts, or
    // at the end of the file, so its lines still have a test (2026-11-17, audit: such a test was dropped and every
    // check in it refused).
    if (close < 0) {
      const next = /(?<![\w$.])x?(?:it|test)(?:\.\w+)*\s*[(`]/g;
      next.lastIndex = at + 1;
      const n = next.exec(exec);
      close = n ? n.index - 1 : src.length - 1;
    }
    const title = /^\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/.exec(src.slice(at + 1, close));
    const line = lineAt(src, m.index);
    spans.push({ file, line, end: Math.max(line, lineAt(src, close)), titles: title ? [title[2].replace(/\\(.)/g, '$1')] : [],
      skipped: Boolean(m[1]) || /\.(?:skip|todo)(?![A-Za-z])/.test(m[2]) || skip.has(line) });
  }
  return spans;
}

// The test that holds a line (1-based): the innermost span around it, or null when the line is in no test (a
// helper, a hook, the top of the file).
export function enclosingTest(spans, line) {
  let own = null;
  for (const s of spans) if (s.line <= line && line <= s.end && (!own || s.line >= own.line)) own = s;
  return own;
}

// The tests that call the helper a line is in (2026-11-17, audit: a check in an arrange/assert helper sat in no
// test and could never be proven). The helper is the nearest function declaration that encloses the line (a hook,
// a describe or a test on the way up means no helper); a test calls it when its name appears in the test's lines
// as a call. Skipped tests are left out. [] when the line is in no helper or no test calls it.
// 2026-11-18 (audit finding 4): a call counts only in executable code (executableText): the text of a comment, a
// string, a template or a regex is not a call, and a declaration `function name(` is not one either. THE LIMIT that
// stays: a static check cannot prove that a conditional assertion ran; a call behind `if (false)`, in a branch that
// never runs, or after an early return still counts here, and only a break that makes the test fail proves it. C#
// `#if false` blocks are left out like comments; a call under any other `#if` condition (DEBUG, a symbol) counts, as
// the compiler's symbols are not known here.
const NOT_A_METHOD = /^(?:if|for|foreach|while|switch|using|lock|catch|return|new|await|else|do|throw|var)$/;
export function helperCallers(text, spans, line) {
  const rows = executableText(String(text), spans[0]?.file || '').split('\n');
  const indent = (s) => /^\s*/.exec(s)[0].replace(/\t/g, '    ').length;
  let cur = indent(rows[line - 1] || '');
  let name = null, declRow = -1;
  for (let i = line - 2; i >= 0 && !name; i--) {
    const r = rows[i];
    // A lone `{` (Allman style) sits at the signature's indent: it must not hide the signature above it (2026-11-18).
    if (!r.trim() || r.trim() === '{' || indent(r) >= cur) continue;
    if (/^\s*(?:beforeEach|afterEach|beforeAll|afterAll|describe|it|test|suite)\b/.test(r)) return [];
    const js = /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*(\w+)/.exec(r)
      || /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|\w+\s*=>)/.exec(r);
    // Only a declaration names the helper (2026-11-18, audit: `await waitFor(() => {` or `await WithDbAsync(async db =>`
    // was taken for one, so any test that called the wrapper certified the check inside it). The C# shape is for .cs
    // files only, and the word before the name must be a type, not a statement keyword.
    const cs = isCs(spans[0]?.file || '') && /^\s*(?:(?:public|private|protected|internal|static|async|override|virtual|sealed)\s+)*([\w<>\[\],.?]+(?:<[^>]*>)?)\s+(\w+)\s*\(/.exec(r);
    const csName = cs && !/^(?:await|return|new|throw|yield|else|case|using|lock|goto)$/.test(cs[1]) ? cs[2] : undefined;
    const found = js ? js[1] : csName;
    if (found && !NOT_A_METHOD.test(found)) { name = found; declRow = i; } else cur = indent(r);
  }
  if (!name) return [];
  // 2026-11-18 (audit): the function that holds a nested helper (a factory such as `function setup() { const name = ...;
  // return { name }; }`). A test that calls that function reaches the helper through its result, so a member call or a
  // same-name local in that test is the helper itself. JavaScript only; a helper at file or describe level has none.
  let factory = '';
  if (!isCs(spans[0]?.file || '')) {
    let c2 = indent(rows[declRow]);
    for (let i = declRow - 1; i >= 0; i--) {
      const r = rows[i];
      if (!r.trim() || r.trim() === '{' || indent(r) >= c2) continue;
      if (/^\s*(?:beforeEach|afterEach|beforeAll|afterAll|describe|it|test|suite)\b/.test(r)) break;
      const f = /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*(\w+)/.exec(r)
        || /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|\w+\s*=>)/.exec(r);
      if (f && !NOT_A_METHOD.test(f[1])) { factory = f[1]; break; }
      c2 = indent(r);
    }
  }
  // 2026-11-18 (audit): a matching NAME is not yet a call of THE helper. A call counts only when it can be the helper
  // itself: not a member call on another object (`other.name(`), unless the object is `this` or, in C#, the class that
  // declares the helper; not in a test whose own body declares a function, const, let, var or local of the same name
  // (it shadows the helper); and never inside a regex literal (executableText blanks it). THE LIMIT that stays: a
  // static check cannot follow every alias (`const f = expectNoRows; f(rows)` is not seen as a call, a parameter named
  // like the helper is not seen as a shadow, and a call that is never reached still counts).
  const nm = name.replace(/[$]/g, '\\$');
  const call = new RegExp('(?<!\\bfunction\\s*\\*?\\s*)\\b' + nm + '\\s*(?:<[^>()]*>)?\\s*\\(', 'g');
  const cs = isCs(spans[0]?.file || '');
  // 2026-11-18 (audit, round 2): a declaration of the same name in the test body shadows the helper in any form: a
  // destructuring pattern, a later declarator, a class, a method or type member declared in the body (a fake object),
  // and in C# a local function or delegate of any type (built-in, nested generic).
  const JS_SHADOW = '(?<![\\w$.])(?:function\\s*\\*?\\s*' + nm + '(?![\\w$])|class\\s+' + nm + '(?![\\w$])|(?:const|let|var)\\s+' + nm + '(?![\\w$])'
    + '|(?:const|let|var)\\s*[{\\[][^}\\]]*?(?<![\\w$.])' + nm + '(?![\\w$])(?!\\s*:)|(?:const|let|var)\\s+[^;\\n]*?,\\s*' + nm + '\\s*=(?![=>]))';
  const csShadow = (body) => {
    if (new RegExp('(?<![\\w$.])(?:void|var|Task(?:<[^>]*>)?|ValueTask(?:<[^>]*>)?)[ \\t]+' + nm + '\\s*(?:=(?!=)|<[^>()]*>\\s*\\(|\\()').test(body)) return true;
    const re = new RegExp('(?<![\\w$.])([A-Za-z_][\\w.]*(?:<[^;(){}=]*>)?(?:\\[\\])*\\??)[ \\t]+' + nm + '\\s*(=(?!=)|<[^>()]*>\\s*\\(|\\()', 'g');
    for (let m; (m = re.exec(body));) {
      if (/^(?:await|return|new|throw|yield|else|case|using|lock|goto|in|is|as|not|and|or|out|ref|when)$/.test(m[1])) continue;
      if (m[2] === '=') return true;
      const open = m.index + m[0].length - 1, close = closeOf(body, open);
      if (close >= 0 && /^\s*(?:\{|=>)/.test(body.slice(close + 1))) return true;
    }
    return false;
  };
  const jsShadow = new RegExp(JS_SHADOW);
  let owner = '', extension = false;
  if (cs) {
    const at = rows.slice(0, line - 1).join('\n').length + 1;
    owner = csClassAt(csClasses(rows.join('\n')), at)?.name || '';
    extension = /\(\s*(?:in\s+|ref\s+)?this\s/.test(rows[declRow]);
  }
  // A same-name declaration in a scope that holds the test (a describe-level const over a file-level helper), other
  // than the helper's own declaration. JavaScript only.
  const full = rows.join('\n'), starts = [];
  for (let a = 0, r = 0; r <= rows.length; r++) { starts.push(a); a += (rows[r] || '').length + 1; }
  let pairs = null;
  const scopeShadow = (s) => {
    if (cs) return false;
    if (!pairs) {
      pairs = [];
      const stack = [];
      for (let k = 0; k < full.length; k++) { if (full[k] === '{') stack.push(k); else if (full[k] === '}' && stack.length) pairs.push([stack.pop(), k]); }
    }
    const t = starts[s.line - 1];
    const re = new RegExp(JS_SHADOW, 'g');
    for (let m; (m = re.exec(full));) {
      if (m.index >= starts[declRow] && m.index < starts[declRow + 1]) continue;
      if (m.index >= t) break;
      if (pairs.some(([o, c]) => o < m.index && c > t)) return true;
    }
    return false;
  };
  const own = (body, s) => {
    const viaFactory = Boolean(factory) && new RegExp('(?<![\\w$.])' + factory.replace(/[$]/g, '\\$') + '\\s*\\(').test(body);
    if (!viaFactory && ((cs ? csShadow(body) : jsShadow.test(body)) || scopeShadow(s))) return false;
    call.lastIndex = 0;
    const found = [];
    for (let m; (m = call.exec(body));) {
      const open = m.index + m[0].length - 1, close = closeOf(body, open);
      const before = body.slice(0, m.index);
      // A method or type member written in the body (`name(x) {`, `{ name(x: T): void }`) is a declaration, not a call.
      if (close >= 0 && !viaFactory) {
        const after = body.slice(close + 1);
        if (/^[ \t]*\{/.test(after) || (/^\s*:/.test(after) && /(?:^|[{,;])\s*$/.test(before))) return false;
      }
      found.push([m, before]);
    }
    for (const [, before] of found) {
      const dot = /(?:([\w$]+)|[)\]'"`}])\s*[?!]?\.\s*$/.exec(before);
      if (!dot) return true;
      if (viaFactory) return true;
      const who = dot[1], head = before.slice(0, dot.index);
      if (who === 'this' && !/[\w$)\]]\s*[?!]?\.\s*$/.test(head)) return true;
      if (cs) {
        if (who === 'base' && !/[\w$)\]]\s*[?!]?\.\s*$/.test(head)) return true;
        if (who && owner && who === owner) return true;
        // A call through a member counts when C# can only reach the helper that way: an extension method, or a helper of
        // another class than the test's own (a fixture, a base class).
        if (extension || (owner && s.klass && s.klass !== owner)) return true;
      }
    }
    return false;
  };
  return spans.filter(s => !s.skipped && own(rows.slice(s.line - 1, s.end).join('\n'), s));
}

// Whether a mustFail part names a test: the part, in lower case, inside one of the test's titles, as red-proof's
// survivors() matches a part to the declared tests. A skipped test is never named: it cannot fail.
export function namedBy(parts, own) {
  return Boolean(own) && !own.skipped && own.titles.some(t => parts.some(p => String(t).toLowerCase().includes(String(p).toLowerCase())));
}

// What to tell the author of an unproven "nothing happens" check: the test that holds the line, and the mustFail
// name that would prove it. `own` is that test (a testSpans item) or null.
export function proofHint(own) {
  if (!own || !own.titles.length) return 'the test that holds this line cannot be worked out (it is in no it()/test() call or [Fact]/[Theory] method with a written title), so no break can prove it: move the check into its test';
  const names = own.titles.map(t => `"${t}"`).join(' / ');
  if (own.skipped) return `test ${names} is skipped: it never runs, so no break can make it fail`;
  return `its test ${names} is named by no caught break: a break of that test's rule whose mustFail names it (${JSON.stringify(own.titles[0])}) would prove it`;
}
