'use strict';
/*
 * review-store.cjs — the review record (2026-11-18, audit finding 2).
 *
 * THE PROMISE: `REVIEW: PASS — reused` is accepted only when (1) a completed independent
 * review of the ORIGINAL commits is on record, and (2) the commits being pushed are equal to
 * those reviewed commits. Equal patches alone prove sameness, never that a review happened.
 *
 * A record is written when a normal (not "reused") review verdict is accepted: a completed
 * reviewer run after the last change, no reviewer still running, `REVIEW: PASS`, no open note.
 * The stop gate writes it (the user usually pushes by hand) and the push guard writes it when
 * it lets such a push through; writing the same record twice changes nothing. A "reused"
 * verdict never writes one.
 *
 * A record: the repository identity (remote.origin.url made uniform; the top folder when
 * there is none), the full hashes of the commits from the push base to HEAD, HEAD, the tree of
 * HEAD, the base, the time and the session id. It lives in <state folder>/review-records.json,
 * the hooks' state folder (SANAD_STATE_DIR overrides it, as for the scan cache); a transcript
 * that may not use the state folder (stateAllowed) neither writes nor reads records, so a
 * reuse there is refused.
 *
 * What the promise needs (the repair round, same day):
 *  - Only the folder the reviewed change lives in is recorded (reviewedDir: the repository of
 *    the session's last edit or git change), never the session folder by default.
 *  - A new record is made only at the stop that holds the verdict itself, or at the push the
 *    guard lets through. Any later stop or push may only ADD the commits of a HEAD whose tree
 *    and base equal a record's (a squash, a message-only amend): the same code, so the same
 *    review. A HEAD that moved to other content writes nothing.
 *  - A FAIL verdict or an open reviewer note withdraws this repository's records of HEAD.
 *  - The old side of a range-diff must be the WHOLE commit list of one record, not a part.
 *
 * Everything here fails closed for reading (no record) and silent for writing.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FILE = 'review-records.json';
const KEEP = 300;                       // the newest records kept
const FULL_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const GIT_MARK = /^<git(?:-remote)?>$/;

function scanLib() { return require(path.join(__dirname, 'transcript-scan.js')); }
function folder() { return scanLib().stateFolder(); }
function allowed(transcriptPath) { return scanLib().stateAllowed(transcriptPath); }

// Output of one git call, or null when it fails.
function run(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }).trim();
  } catch (e) { return null; }
}
// Same, but the output is kept as git wrote it (a -z list).
function runRaw(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  } catch (e) { return null; }
}

// One spelling for one remote: no scheme, no user, scp-style host:path as host/path, no ".git", no case.
function uniformUrl(url) {
  let u = String(url || '').trim().replace(/\\/g, '/');
  u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  u = u.replace(/^[^@/]*@/, '');
  u = u.replace(/^([^/:]+):(?!\/)/, '$1/');
  u = u.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  return u.toLowerCase();
}
function identity(cwd) {
  const url = run(cwd, ['config', '--get', 'remote.origin.url']);
  if (url) return 'url:' + uniformUrl(url);
  const top = run(cwd, ['rev-parse', '--show-toplevel']);
  return top ? 'dir:' + top.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : '';
}
function topOf(dir) {
  const top = dir ? run(dir, ['rev-parse', '--show-toplevel']) : null;
  return top ? top.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : '';
}

// The push base the push guard uses when no PR base was named: the merge-base with the integration branch.
function defaultBase(cwd) {
  const configured = run(cwd, ['config', '--get', 'sanad.integration']);
  for (const b of [configured, 'staging', 'develop', 'dev'].filter(Boolean)) {
    if (run(cwd, ['rev-parse', '--verify', '--quiet', 'origin/' + b])) return run(cwd, ['merge-base', 'origin/' + b, 'HEAD']) || '';
  }
  const up = run(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  return up ? run(cwd, ['merge-base', up, 'HEAD']) || '' : '';
}

// The folder the reviewed change lives in: the repository of the session's last edit (a file path) or of its
// last git change (the folder that command ran in). '' when the session touched nothing, or the folder cannot
// be found: then nothing is recorded (a review of another repository or worktree must not put the session
// folder's commits on record).
function reviewedDir(r, fallbackCwd) {
  try {
    if (!r || typeof r.lastEdit !== 'number' || r.lastEdit < 0) return '';
    const p = String(r.lastEditPath || '');
    let start;
    if (GIT_MARK.test(p)) start = String(r.lastGitRepo || '');
    else if (p && p[0] !== '<') start = path.dirname(path.isAbsolute(p) ? p : path.resolve(fallbackCwd || process.cwd(), p));
    else start = '';
    if (!start) return '';
    let dir = path.isAbsolute(start) ? start : path.resolve(fallbackCwd || process.cwd(), start);
    for (let i = 0; i < 64 && !(fs.existsSync(dir) && fs.statSync(dir).isDirectory()); i++) {
      const up = path.dirname(dir);
      if (up === dir) return '';
      dir = up;
    }
    return topOf(dir) ? dir : '';
  } catch (e) { return ''; }
}

// HEAD of a folder: repository identity, full HEAD hash, its tree and the push base; null when unknown.
function headInfo(cwd, base) {
  if (!cwd || !base) return null;
  const head = run(cwd, ['rev-parse', 'HEAD']);
  const tree = run(cwd, ['rev-parse', 'HEAD^{tree}']);
  const repo = identity(cwd);
  if (!head || !tree || !repo || !FULL_HASH.test(head) || !FULL_HASH.test(tree) || !FULL_HASH.test(base)) return null;
  return { repo, head: head.toLowerCase(), tree: tree.toLowerCase(), base: base.toLowerCase() };
}

// The files a dirty tracked state touches (status -z: a rename or copy carries its old name as a second field).
function dirtyFiles(cwd) {
  const out = runRaw(cwd, ['status', '--porcelain', '-z', '--untracked-files=no']);
  if (out === null) return null;
  const parts = out.split('\0'), files = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    files.push(e.slice(3));
    if (/[RC]/.test(e.slice(0, 2)) && i + 1 < parts.length) files.push(parts[++i]);
  }
  return files;
}

// What HEAD holds now, or null when it cannot be recorded: no base, no commit in the range, a changed tracked
// file that is one of the files of base..HEAD (the review may have covered the working tree, not the commits),
// or a git error. An unrelated local change (a dev settings file) does not touch the reviewed commits.
function snapshot(cwd, base) {
  const info = headInfo(cwd, base);
  if (!info) return null;
  const dirty = dirtyFiles(cwd);
  if (dirty === null) return null;
  if (dirty.length) {
    const changed = runRaw(cwd, ['diff', '--no-renames', '--name-only', '-z', base, 'HEAD']);
    if (changed === null) return null;
    const inRange = new Set(changed.split('\0').filter(Boolean));
    if (dirty.some((f) => inRange.has(f))) return null;
  }
  const list = run(cwd, ['rev-list', '--reverse', base + '..HEAD']);
  if (!list) return null;
  const commits = list.split(/\r?\n/).filter(Boolean).map((h) => h.toLowerCase());
  if (!commits.length || !commits.every((h) => FULL_HASH.test(h))) return null;
  return { repo: info.repo, head: info.head, tree: info.tree, base: info.base, commits };
}

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(folder(), FILE), 'utf8'));
    return data && Array.isArray(data.records) ? data.records.filter((x) => x && typeof x.repo === 'string' && Array.isArray(x.commits)) : [];
  } catch (e) { return []; }
}
function save(records) {
  const file = path.join(folder(), FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ records: records.slice(-KEEP) }));
  fs.renameSync(tmp, file);
}

// One lock for the whole read-change-save step (2026-11-18, audit finding 7): without it, processes writing at
// the same moment each saved their own copy and the last one won, so acknowledged records were lost.
// The lock is a file made with an exclusive create; a short retry loop (about 3 s); a lock older than about
// 10 s, or whose owner process is gone, is taken over. fn's result is returned; when the lock cannot be had
// the answer is false ("not written"), never a claim of success.
const LOCK_WAIT_MS = 3000, LOCK_STALE_MS = 10000;
function sleepMs(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { const end = Date.now() + ms; while (Date.now() < end); } }
function ownerGone(text) {
  const pid = parseInt(String(text).split(/\s+/)[0], 10);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; } catch (e) { return !!e && e.code === 'ESRCH'; }
}
// 2026-11-18 (repair): each lock holds a unique text (pid, time, random). A waiter judges the lock stale from the
// text it read, and removes it only under a second exclusive take-over file, after reading again that the lock still
// holds that exact text. So a lock a new owner made after the old one finished is never removed by mistake. The
// owner removes the lock only while it still holds its own text.
// The judged text of a stale lock, or null when the lock is not stale (or cannot be read).
function staleText(lock) {
  try {
    const age = Date.now() - fs.statSync(lock).mtimeMs;
    const text = fs.readFileSync(lock, 'utf8');
    return age > LOCK_STALE_MS || ownerGone(text) ? text : null;
  } catch (e) { return null; }
}
function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch (e) { return null; } }
function takeOver(lock, judged) {
  const gate = lock + '.takeover';
  let fd;
  try { fd = fs.openSync(gate, 'wx'); } catch (e) {
    // a take-over file left by a process that died is removed once old
    try { if (Date.now() - fs.statSync(gate).mtimeMs > LOCK_STALE_MS) fs.rmSync(gate, { force: true }); } catch (e2) { /* gone */ }
    return;
  }
  try {
    if (readText(lock) === judged) fs.rmSync(lock, { force: true });
  } catch (e) { /* someone else took it */ } finally {
    try { fs.closeSync(fd); } catch (e) { /* closed */ }
    try { fs.rmSync(gate, { force: true }); } catch (e) { /* old-file rule covers it */ }
  }
}
function withLock(fn) {
  const lock = path.join(folder(), FILE + '.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const mine = process.pid + ' ' + Date.now() + ' ' + Math.random().toString(36).slice(2);
  const stop = Date.now() + LOCK_WAIT_MS;
  let fd = null;
  for (let wait = 5; ; wait = Math.min(wait * 2, 80)) {
    try { fd = fs.openSync(lock, 'wx'); break; } catch (e) {
      // EPERM/EACCES/EBUSY: on Windows the lock file is being deleted while another process still has it open: busy, retry
      if (!e || !['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(e.code)) return false;
    }
    const judged = staleText(lock);
    if (judged !== null) { takeOver(lock, judged); if (Date.now() >= stop) return false; continue; }
    if (Date.now() >= stop) return false;
    sleepMs(wait);
  }
  try {
    try { fs.writeSync(fd, mine); } catch (e) { /* the file's time is enough */ }
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch (e) { /* closed */ }
    try { if (readText(lock) === mine) fs.rmSync(lock, { force: true }); } catch (e) { /* stale rule covers it */ }
  }
}

// The read-change-save step of write, to run under the lock.
function writeLocked(snap, session) {
  const records = load();
  if (records.some((x) => x.repo === snap.repo && x.head === snap.head && x.commits.join() === snap.commits.join())) return true;
  const rec = { repo: snap.repo, commits: snap.commits, head: snap.head, at: new Date().toISOString(), session: String(session || '') };
  if (snap.tree) rec.tree = snap.tree;
  if (snap.base) rec.base = snap.base;
  records.push(rec);
  save(records);
  return true;
}

// Writes the record of snap; the same repository and commits again changes nothing. Returns true when kept.
function write(transcriptPath, snap, session) {
  try {
    if (!snap || !allowed(transcriptPath)) return false;
    return withLock(() => writeLocked(snap, session)) === true;
  } catch (e) { return false; }
}

// Adds the commits of dir's HEAD when its tree and base equal those of a record of this repository: the same code
// as a reviewed one (a squash, a message-only amend), so the same review. Any other HEAD writes nothing.
function extend(transcriptPath, dir, session) {
  try {
    if (!dir || !allowed(transcriptPath)) return false;
    const snap = snapshot(dir, defaultBase(dir));
    if (!snap) return false;
    return withLock(() => {
      if (!load().some((x) => x.repo === snap.repo && x.tree === snap.tree && x.base === snap.base)) return false;
      return writeLocked(snap, session);
    }) === true;
  } catch (e) { return false; }
}

// Takes back this repository's records of dir's HEAD (its commit, or the same tree and base): a later FAIL or an
// open reviewer note means the review no longer stands.
function withdraw(transcriptPath, dir) {
  try {
    if (!dir || !allowed(transcriptPath)) return false;
    const info = headInfo(dir, defaultBase(dir)) || (() => {
      const head = run(dir, ['rev-parse', 'HEAD']), repo = identity(dir);
      return head && repo ? { repo, head: head.toLowerCase(), tree: '', base: '' } : null;
    })();
    if (!info) return false;
    return withLock(() => {
      const records = load();
      const kept = records.filter((x) => !(x.repo === info.repo && (x.commits.includes(info.head) || (info.tree && x.tree === info.tree && x.base === info.base))));
      if (kept.length === records.length) return false;
      save(kept);
      return true;
    }) === true;
  } catch (e) { return false; }
}

// Is the old side of a range-diff the whole commit list of one record of this repository? hashes may be short.
// { ok, last }: last is the newest old commit as written, for the message.
function reviewed(transcriptPath, cwd, oldHashes) {
  const list = Array.isArray(oldHashes) ? oldHashes : [];
  const last = list.length ? String(list[list.length - 1]) : '';
  try {
    if (!list.length || list.some((h) => !/^[0-9a-f]{4,64}$/i.test(String(h))) || !allowed(transcriptPath)) return { ok: false, last };
    const repo = identity(cwd);
    if (!repo) return { ok: false, last };
    const full = [];
    for (const h of list) {
      const f = run(cwd, ['rev-parse', '--verify', '--quiet', h + '^{commit}']);
      if (!f) return { ok: false, last };
      full.push(f.toLowerCase());
    }
    const same = (x) => x.repo === repo && x.commits.length === full.length && x.commits.every((c, i) => String(c).toLowerCase() === full[i]);
    return { ok: load().some(same), last };
  } catch (e) { return { ok: false, last }; }
}

const stripFences = (t) => String(t || '').replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '');
// The last `REVIEW:` line of a final message, outside code fences: { verdict, line } or null.
function saidReview(finalText) {
  if (finalText === null || finalText === undefined) return null;
  const m = [...stripFences(finalText).matchAll(/^REVIEW:\s*(PASS|FAIL)\b.*$/gm)].pop();
  return m ? { verdict: m[1], line: m[0] } : null;
}

// Has a normal review verdict been accepted? Same conditions as the push guard: a completed reviewer run
// after the last change (strict: a git sync is a change here), no reviewer still running after it, `REVIEW: PASS`
// that is not "reused", no open note. finalText: the stop hook's final message, which may not be in the transcript
// yet (null when there is none). editSeq: the last change the caller really judged by (the push guard relaxes it
// for a verified tree); the scanner's own last edit when omitted.
function accepted(r, finalText, editSeq) {
  try {
    if (!r || typeof r.lastEdit !== 'number') return false;
    const edit = typeof editSeq === 'number' ? editSeq : r.lastEdit;
    if (r.lastReviewerRun <= edit || r.lastReviewerResult === -1) return false;
    if (typeof r.lastRunningReviewer === 'number' && r.lastRunningReviewer > edit) return false;
    const said = saidReview(finalText);
    let verdict, line, open;
    if (said) {
      verdict = said.verdict; line = said.line;
      open = scanLib().openNotesAfter(r, finalText);
    } else {
      if (r.lastReview <= r.lastReviewerResult) return false;
      verdict = r.lastReviewVerdict; line = r.lastReviewText || '';
      open = Array.isArray(r.openReviewNotes) ? r.openReviewNotes : [];
    }
    return verdict === 'PASS' && !/reused/i.test(line) && open.length === 0;
  } catch (e) { return false; }
}

// What a stop does with the review record (the stop gate calls this once, never blocking).
//  - a FAIL verdict or an open reviewer note: withdraw the records of the folders' HEAD, write nothing;
//  - the final message itself holds an accepted `REVIEW: PASS`: record the reviewed folder (only that one);
//  - otherwise, unless the standing verdict is "reused": add the commits of a HEAD equal in tree and base to a record.
function atStop(transcriptPath, r, finalText, cwd, session) {
  try {
    if (!allowed(transcriptPath)) return;
    const dir = reviewedDir(r, cwd);
    const dirs = [...new Set([dir, cwd, r && r.lastGitRepo].filter(Boolean))];
    const said = saidReview(finalText);
    const open = finalText === null || finalText === undefined
      ? (Array.isArray(r.openReviewNotes) ? r.openReviewNotes : [])
      : scanLib().openNotesAfter(r, finalText);
    if ((said && said.verdict === 'FAIL') || open.length > 0) { for (const d of dirs) withdraw(transcriptPath, d); return; }
    if (dir && said && accepted(r, finalText)) write(transcriptPath, snapshot(dir, defaultBase(dir)), session);
    const standing = said ? said.line : String(r.lastReviewText || '');
    if (/reused/i.test(standing)) return;
    for (const d of [...new Set([dir, cwd].filter(Boolean))]) extend(transcriptPath, d, session);
  } catch (e) { /* the record is an extra */ }
}

// What the push guard does once it lets a push through. normal: the verdict it accepted is a normal one (not
// "reused"); dir: the reviewed folder; cwd/base: what is pushed.
function atPush(transcriptPath, normal, dir, cwd, base, session) {
  try {
    if (!normal || !allowed(transcriptPath)) return;
    if (dir && cwd && topOf(dir) === topOf(cwd)) write(transcriptPath, snapshot(cwd, base), session);
    extend(transcriptPath, cwd, session);
  } catch (e) { /* the record is an extra */ }
}

module.exports = { FILE, uniformUrl, identity, defaultBase, reviewedDir, snapshot, load, write, extend, withdraw, reviewed, accepted, saidReview, atStop, atPush };
