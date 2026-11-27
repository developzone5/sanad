// trusted.mjs — the records "ready" (sanad.mjs) and the gate's verdict (notes.mjs) may say yes on.
//
// 2026-11-28 (owner, batch b task 1): "ready" and the gate's verdict say yes only on records the guards already trust:
// the evidence.mjs receipt of the exact tree, the proof record, the review record and the scanner's reading. Never on a
// file in the notes folder, and never on the builder's words. A notes-folder value may still make an answer stricter
// (a larger size, one more side), never looser.
//
// What each reader here trusts:
// - sessionRuns: the shell calls of the session log and their output, read with the scanner's own reader (resultText).
// - seenReceipts: the CHECK_COMPLETED lines evidence.mjs printed in those calls; a passing one counts only when the
//   scanner's own reading (scan.passingReceipts) holds a passing receipt of the same tree and folder.
// - seenRecord: a record a tool keeps in the state folder counts only when the session shows the run that wrote it, on
//   this exact tree: a call that ran the tool and printed `SANAD-RECORD <kind> tree=<tree> id=<id>`, where id is the
//   record's own hash. A call whose command text holds the words SANAD-RECORD (an echo) is no such run.
// - reviewRecord: the hooks' review record (hooks/lib/review-store.cjs), written when an accepted REVIEW: PASS ended a
//   turn: a record of this repository whose HEAD and tree are HEAD's.
// - firstRound: for each seat of the size, a finished run of that seat in the scanner's runs. A re-check has the seat
//   're-check' and never fills a first-round seat. The other engine's seat has no run the scanner can see (owner,
//   2026-11-28: "Claude seats only"): it keeps today's rule, a report file of the other engine, newer than the first
//   first-round run of this task.
//
// Every reader fails closed: a missing or unreadable record is "not seen", with the reason.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const SCANNER = '../../../hooks/lib/transcript-scan.js';
const REVIEW_STORE = '../../../hooks/lib/review-store.cjs';

export const RECORD_WORD = 'SANAD-RECORD';
const RECORD_LINE = /^SANAD-RECORD ([a-z][a-z-]*) tree=([0-9a-f]{40,64}) id=([0-9a-f]{64})\s*$/gm;
export const recordId = (record) => crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex');
export const recordLine = (kind, tree, record) => `${RECORD_WORD} ${kind} tree=${tree} id=${recordId(record)}`;

function loadScanner() {
  try { const s = require(path.resolve(here, SCANNER)); return s && typeof s.resultText === 'function' ? s : null; } catch { return null; }
}
const SHELL = new Set(['Bash', 'PowerShell', 'shell', 'exec_command']);

/** The shell calls of one session log with their output: [{ id, command, output, at }]. An unreadable log gives []. */
export function sessionRuns(file, scan = loadScanner()) {
  if (!file || !scan) return [];
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const calls = new Map();
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const content = entry && entry.message && Array.isArray(entry.message.content) ? entry.message.content : [];
    for (const blk of content) {
      if (!blk || typeof blk !== 'object') continue;
      if (blk.type === 'tool_use' && SHELL.has(blk.name) && blk.input && typeof blk.input.command === 'string') calls.set(blk.id, { command: blk.input.command, at: String(entry.timestamp || '') });
      else if (blk.type === 'tool_result' && calls.has(blk.tool_use_id) && blk.is_error !== true) {
        const call = calls.get(blk.tool_use_id);
        let output = '';
        try { output = String(scan.resultText(blk, entry) || ''); } catch { output = ''; }
        out.push({ id: blk.tool_use_id, command: call.command, output, at: String(entry.timestamp || call.at) });
      }
    }
  }
  return out;
}

// ---- Which shell call is a plain run of one of our tools (2026-11-28, owner, batch b task 1, hole 1) ----
//
// A call that only NAMED the tool (`cat x /h/pre-review.mjs`, `node -e "…" # evidence.mjs`) could print a forged record
// or receipt line, and it counted. Owner, 2026-11-28: COUNT ONLY in this PR. Nothing is refused for its shape: the gate
// and "ready" print one line, "N record lines came from a call that ran other commands too", with the shapes (test 4:
// 47 of 54 real runs were in such calls). The later design checks each record line against the tool's own saved receipt,
// so the shape of the call stops mattering. The plain shapes, which the count leaves out:
//   [cd <one folder> &&] [NAME=<one word> && ...] node <the installed tool> <arguments> [2>&1] [| tail -<n>]
// - `cd <one folder> &&` and `NAME=<one word> &&` (a shell variable for the arguments) may come first, any number of
//   times. `NAME=value node …` (a variable handed to the tool) is refused.
// - The program is node; the tool's path, after `~` and the cd folder are applied, must be the installed tool itself
//   (this folder's file, by its real path). A copy of the tool in another folder never counts. A path made of a variable
//   is refused.
// - After it only `2>&1` and `| tail -<n>` (tail only ever cuts lines). Any other pipe, `;`, `||`, a lone `&`, `>`, `<`,
//   `$(…)`, a backtick, a comment or a second line is refused. Inside double quotes `$(…)` and backticks run: refused.
const OP_BAD = 'bad';
function shellTokens(text) {
  const out = [];
  let cur = '', has = false, i = 0;
  const push = () => { if (has) out.push({ t: 'word', v: cur }); cur = ''; has = false; };
  while (i < text.length) {
    const c = text[i];
    if (c === "'") { const end = text.indexOf("'", i + 1); if (end < 0) return null; cur += text.slice(i + 1, end); has = true; i = end + 1; continue; }
    if (c === '"') {
      let j = i + 1, v = '';
      for (; j < text.length && text[j] !== '"'; j++) {
        if (text[j] === '\\' && j + 1 < text.length) { v += text[++j]; continue; }
        if (text[j] === '`' || (text[j] === '$' && text[j + 1] === '(')) return null;
        v += text[j];
      }
      if (j >= text.length) return null;
      cur += v; has = true; i = j + 1; continue;
    }
    if (c === '\n' || c === '\r' || c === '`' || c === ';' || c === '<') return null;
    if (c === '$' && text[i + 1] === '(') return null;
    if (c === '#' && !has) return null;
    if (c === ' ' || c === '\t') { push(); i++; continue; }
    if (c === '&' && text[i + 1] === '&') { push(); out.push({ t: 'op', v: '&&' }); i += 2; continue; }
    if (c === '|' && text[i + 1] === '|') return null;
    if (c === '|') { push(); out.push({ t: 'op', v: '|' }); i++; continue; }
    if (!has && text.startsWith('2>&1', i) && /[\s|]|$/.test(text[i + 4] || '')) { out.push({ t: 'op', v: '2>&1' }); i += 4; continue; }
    if (c === '&' || c === '>') return null;
    if (c === '\\' && i + 1 < text.length) { cur += text[i + 1]; has = true; i += 2; continue; }
    cur += c; has = true; i++;
  }
  push();
  return out;
}
const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\/([a-zA-Z])\//, '$1:/').replace(/\/+$/, '');
const realOf = (p) => { let r = p; try { r = fs.realpathSync.native(p); } catch { /* as written */ } return norm(path.resolve(r)).toLowerCase(); };
const homeDir = () => process.env.HOME || process.env.USERPROFILE || '';
/** Whether `command` is a real run of the installed `toolFile` (in `installedDir`) in one of the accepted shapes. */
export function isToolRun(command, toolFile, { installedDir = here } = {}) {
  const tokens = shellTokens(String(command || '').trim());
  if (!tokens || !tokens.length) return false;
  const parts = [[]];
  for (const tk of tokens) { if (tk.t === 'op' && tk.v === '&&') parts.push([]); else parts[parts.length - 1].push(tk); }
  let cwd = process.cwd();
  for (const p of parts.slice(0, -1)) {
    if (p.length === 2 && p.every((x) => x.t === 'word') && p[0].v === 'cd' && !p[1].v.includes('$')) {
      const d = p[1].v.replace(/^~(?=\/|$)/, homeDir());
      cwd = path.resolve(cwd, norm(d));
      continue;
    }
    if (p.length === 1 && p[0].t === 'word' && /^[A-Za-z_][A-Za-z0-9_]*=[^=]*$/.test(p[0].v) && !p[0].v.includes('$(')) continue;
    return false;
  }
  const last = parts[parts.length - 1];
  const pipe = last.findIndex((x) => x.t === 'op' && x.v === '|');
  const core = pipe < 0 ? last : last.slice(0, pipe);
  if (pipe >= 0) {
    const tail = last.slice(pipe + 1);
    if (!(tail.length === 2 && tail[0].t === 'word' && tail[0].v === 'tail' && tail[1].t === 'word' && /^-\d+$/.test(tail[1].v))) return false;
  }
  const words = core[core.length - 1] && core[core.length - 1].t === 'op' && core[core.length - 1].v === '2>&1' ? core.slice(0, -1) : core;
  if (words.length < 2 || words.some((x) => x.t !== 'word')) return false;
  const program = words[0].v;
  if (program.includes('$') || !/^node(?:\.exe)?$/i.test(norm(program).split('/').pop())) return false;
  const tool = words[1].v;
  if (tool.includes('$') || norm(tool).split('/').pop() !== toolFile) return false;
  const at = path.resolve(cwd, norm(tool.replace(/^~(?=\/|$)/, homeDir())));
  return realOf(at) === realOf(path.join(installedDir, toolFile));
}

// The rule that decides today (unchanged in this PR): a call that names the tool and does not itself hold the record words.
const runsTool = (command, toolFile) => new RegExp(`(?:^|[\\s"'/\\\\])${toolFile.replace(/[.]/g, '\\.')}(?=["'\\s]|$)`).test(command) && !command.includes(RECORD_WORD) && !command.includes('CHECK_COMPLETED');

/** The shape of a call that ran `toolFile`, in words: 'plain' when isToolRun accepts it. */
export function callShape(command, toolFile, { installedDir = here } = {}) {
  if (isToolRun(command, toolFile, { installedDir })) return 'plain';
  const c = String(command || '');
  const bare = c.replace(/"[^"]*"|'[^']*'/g, 'Q');
  if (/\n/.test(c)) return 'more than one line';
  if (/\$\(|`/.test(c)) return 'a $(...) or backtick';
  if (/(?:^|\s)#/.test(bare)) return 'a comment';
  const segs = bare.split(/\s*(?:&&|\|\||;)\s*/).filter(Boolean);
  const own = segs.filter((s) => s.includes(toolFile));
  const others = segs.filter((s) => !s.includes(toolFile) && !/^cd\s+\S+$/.test(s) && !/^[A-Za-z_]\w*=\S*$/.test(s));
  if (others.length) return 'other commands in the same call';
  if (own.some((s) => /\|\s*(\w+)/.test(s) && !/\|\s*tail\s+-\d+\s*$/.test(s))) return 'piped into ' + own.map((s) => (/\|\s*(\w+)/.exec(s) || [])[1]).filter(Boolean)[0];
  if (/;/.test(bare)) return '";" in place of "&&"';
  if (own.some((s) => /^[A-Za-z_]\w*=\S+\s/.test(s))) return 'a variable handed to the tool';
  if (!own.some((s) => new RegExp(`(?:^|\\s)\\S*node(?:\\.exe)?\\s+\\S*${toolFile.replace(/[.]/g, '\\.')}`).test(s))) return 'the tool named, not run by node';
  return 'another copy of the tool or another shape';
}

/** Whether the session shows the run of `toolFile` that wrote the record `record` of `kind`, on `tree`. `found` (optional
 *  array) gets each call that showed it: { command, toolFile, shape }. */
export function seenRecord(runs, { toolFile, kind, tree, record, installedDir = here, found = null }) {
  if (!tree || !record) return false;
  const id = recordId(record);
  let seen = false;
  for (const r of runs) {
    if (!runsTool(r.command, toolFile) || ![...r.output.matchAll(RECORD_LINE)].some((m) => m[1] === kind && m[2] === tree && m[3] === id)) continue;
    seen = true;
    if (Array.isArray(found)) found.push({ command: r.command, toolFile, shape: callShape(r.command, toolFile, { installedDir }) });
  }
  return seen;
}

/** The lines of `found` calls that ran other commands too, as one line: '' when every call was plain. */
export function shapeLine(found) {
  const loose = (Array.isArray(found) ? found : []).filter((x) => x && x.shape && x.shape !== 'plain');
  if (!loose.length) return '';
  const by = new Map();
  for (const x of loose) by.set(x.shape, (by.get(x.shape) || 0) + 1);
  return `${loose.length} record line(s) came from a call that ran other commands too (${[...by].map(([s, n]) => `${n} × ${s}`).join('; ')}); counted only, nothing refused`;
}

/** The passing evidence.mjs receipts the session shows and the scanner also read as passing: [record]. `found` as above.
 *  Review (task 1 PR): each passing receipt needs its own scanner pass: when the session shows more passing receipts of
 *  one tree and folder than the scanner read as passing there, none of them counts (one pass never stands for two). And a
 *  receipt of the same command, folder and tree that FAILED later in the session takes the pass back. */
export function seenReceipts(runs, passing, { installedDir = here, found = null } = {}) {
  const ok = Array.isArray(passing) ? passing : [];
  const slash = (v) => String(v || '').replace(/\\/g, '/').toLowerCase();
  const all = [];
  runs.forEach((r, order) => {
    if (!runsTool(r.command, 'evidence.mjs')) return;
    for (const line of r.output.split('\n')) {
      if (!line.startsWith('CHECK_COMPLETED ')) continue;
      let rec;
      try { rec = JSON.parse(line.slice('CHECK_COMPLETED '.length)); } catch { continue; }
      if (!rec || typeof rec !== 'object') continue;
      const src = rec.source || {};
      const passed = rec.status === 'passed' && rec.nativeExitCode === 0 && !rec.reason && !rec.signal;
      all.push({ rec, run: r, order, passed, place: `${slash(rec.cwd)}\0${String(src.treeAfter || '')}`, what: JSON.stringify([rec.executable, ...(Array.isArray(rec.args) ? rec.args : []), slash(rec.cwd), String(src.treeAfter || '')]) });
    }
  });
  const scannerPasses = (place) => ok.filter((p) => p && p.treeAfter && p.treeAfter === p.treeBefore && `${slash(p.cwd)}\0${p.treeAfter}` === place).length;
  const out = [];
  for (const x of all) {
    const src = x.rec.source || {};
    if (!x.passed || !src.treeBefore || src.treeBefore !== src.treeAfter) continue;
    if (!scannerPasses(x.place)) continue;
    const sameKind = new Set(all.filter((y) => y.passed && y.place === x.place).map((y) => y.rec.runId || y.order));
    if (sameKind.size > scannerPasses(x.place)) continue;
    if (all.some((y) => !y.passed && y.what === x.what && y.order >= x.order && y !== x)) continue;
    out.push(x.rec);
    if (Array.isArray(found)) found.push({ command: x.run.command, toolFile: 'evidence.mjs', shape: callShape(x.run.command, 'evidence.mjs', { installedDir }), runId: x.rec.runId });
  }
  return out;
}

/** The reviewer launches of a session log: Map { tool-use id → prompt text }. An unreadable log gives an empty map. */
export function launchPrompts(file) {
  const out = new Map();
  if (!file) return out;
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    if (!line.includes('"tool_use"')) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    for (const blk of (entry && entry.message && Array.isArray(entry.message.content) ? entry.message.content : [])) {
      if (blk && blk.type === 'tool_use' && (blk.name === 'Agent' || blk.name === 'Task') && blk.input && typeof blk.input.prompt === 'string') out.set(blk.id, blk.input.prompt);
    }
  }
  return out;
}
/** Whether a reviewer's launch prompt names a file or folder inside this task's notes folder. */
export function promptNamesTask(prompt, notesDir) {
  if (!prompt || !notesDir) return false;
  const want = norm(path.resolve(notesDir)).toLowerCase();
  const text = String(prompt).replace(/\\/g, '/').toLowerCase();
  const at = text.indexOf(want);
  return at >= 0 && /^(?:[/"'\s`)]|$)/.test(text.slice(at + want.length, at + want.length + 1));
}

// ---- When this task began in the session (2026-11-28, owner, batch b task 1, hole 5) ----
// A first-round seat counts only for a reviewer run launched after this task's start: the first `sanad.mjs start` call
// for this notes folder that the session shows (its output names the folder: "START: task notes <folder> for …"), or
// task.json's start time when that is later (a notes file can only make it stricter). A task that goes on in a new
// session runs that start again in it (the "no" line names the command). Owner: a start call in a LINKED earlier session
// of the same notes folder counts too, once that link exists: `linkedLogs` are those sessions' logs (notes-dir.mjs
// linkedSessions, when a release has it).
const sameDir = (a, b) => realOf(String(a || '')) === realOf(String(b || ''));
/** The time (ms) of the first start call for `notesDir` in `runs` or in the linked logs; NaN when none is seen. */
export function taskStartSeen(runs, notesDir, { linkedLogs = [], scan } = {}) {
  if (!notesDir) return NaN;
  const all = [...(Array.isArray(runs) ? runs : [])];
  for (const log of Array.isArray(linkedLogs) ? linkedLogs : []) all.push(...sessionRuns(log, scan || loadScanner()));
  let first = NaN;
  for (const r of all) {
    if (!runsTool(r.command, 'sanad.mjs')) continue;
    const m = /^START: task notes (.+?) for /m.exec(r.output || '');
    if (!m || !sameDir(m[1], notesDir)) continue;
    const t = Date.parse(r.at);
    if (Number.isFinite(t) && !(t >= first)) first = t;
  }
  return first;
}

/** The hooks' review record of HEAD: { ok, why }. */
export function reviewRecord(top, head, tree, store = null) {
  let s = store;
  if (!s) { try { s = require(path.resolve(here, REVIEW_STORE)); } catch { s = null; } }
  if (!s || typeof s.load !== 'function' || typeof s.identity !== 'function') return { ok: false, why: 'the hooks\' review record cannot be read (hooks/lib/review-store.cjs)' };
  let repo = '', list = [];
  try { repo = s.identity(top); list = s.load(); } catch { return { ok: false, why: 'the review record cannot be read' }; }
  if (!repo || !head || !tree) return { ok: false, why: 'no commit to look up' };
  const low = (v) => String(v || '').toLowerCase();
  const hit = list.some((x) => x && x.repo === repo && low(x.head) === low(head) && low(x.tree) === low(tree));
  return hit ? { ok: true, why: '' } : { ok: false, why: `no accepted REVIEW: PASS is on the review record for HEAD ${String(head).slice(0, 10)}: write the REVIEW line (notes.mjs verdict --review) in a message of its own; the stop gate saves the record when that message ends` };
}

/** For each seat the size asks for, a finished first-round run: { need, have, missing }. `since` (ms): only runs launched
 *  at or after it count (hole 5); NaN or missing counts none. Without the option every run counts (the older callers). */
export function firstRound(seats, reviews, otherReportTimes = [], opts = {}) {
  const want = [...new Set((Array.isArray(seats) ? seats : []).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean))];
  const bound = 'since' in opts ? Number(opts.since) : -Infinity;
  // Review (task 1 PR): with `prompts` (launch id → prompt) and `notesDir`, a run counts only when its launch prompt names
  // this task's notes folder (its brief lives there): a later task's reviewer in the same session is not this task's.
  const ours = (r) => !(opts.prompts instanceof Map) || (r.id && promptNamesTask(opts.prompts.get(r.id), opts.notesDir));
  const runs = (Array.isArray(reviews) ? reviews : []).filter((r) => r && r.launchAt && Number.isFinite(Date.parse(r.doneAt)) && Date.parse(r.launchAt) >= bound && ours(r));
  const firstAt = Math.min(...runs.filter((r) => String(r.seat || '') !== 're-check').map((r) => Date.parse(r.launchAt)).filter(Number.isFinite));
  const missing = [];
  for (const seat of want) {
    if (seat === 'other engine') {
      const filed = Number.isFinite(firstAt) && (Array.isArray(otherReportTimes) ? otherReportTimes : []).some((t) => Number.isFinite(t) && t > firstAt);
      if (!filed) missing.push(seat);
      continue;
    }
    if (!runs.some((r) => String(r.seat || '').toLowerCase() === seat)) missing.push(seat);
  }
  return { need: want.length, have: want.length - missing.length, missing };
}
