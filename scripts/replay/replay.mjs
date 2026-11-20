#!/usr/bin/env node
// Replay: run the BASE reader and the CANDIDATE reader of transcript-scan.js over saved real work and print
// every place where they answer differently. Prints only the summary line when they agree.
//   node replay.mjs run --base <dir> --cand <dir> [--logs <dir>]... [--corpus <dir>] [--state <dir>]
//                       [--max-session-mb N] [--max-seconds N] [--approved <file>]
//   node replay.mjs collect --logs <dir>... --corpus <dir>     (keeps distinct commands and reports, never in a PR)
// <dir> is a release tree with claude/hooks/lib/transcript-scan.js in it (the base and candidate copies).
// Exit: 0 no difference (or skipped), 1 differences all approved, 2 bad use, 4 a difference not approved, 5 the replay crashed. The REPLAY lines are the output contract.
// Level 1: every distinct saved shell command and reviewer report, in one process.
// Level 2: scanTranscript over each whole session, with its own temp state folder (the live cache is untouched).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const SHELL = new Set(['Bash', 'PowerShell']);
const AGENT = new Set(['Agent', 'Task']);
const OLD_START = '2000-01-01T00:00:00.000Z\n';

function parseArgs(argv) {
  const o = { cmd: argv[0], logs: [], base: '', cand: '', corpus: '', state: '', maxMb: 50, maxSeconds: 300, approved: '' };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (a === '--logs') { o.logs.push(v); i++; }
    else if (a === '--base') { o.base = v; i++; }
    else if (a === '--cand') { o.cand = v; i++; }
    else if (a === '--corpus') { o.corpus = v; i++; }
    else if (a === '--state') { o.state = v; i++; }
    else if (a === '--max-session-mb') { o.maxMb = Number(v); i++; }
    else if (a === '--max-seconds') { o.maxSeconds = Number(v); i++; }
    else if (a === '--approved') { o.approved = v; i++; }
    else { o.bad = a; }
  }
  return o;
}

function walk(dir, out) {
  let list;
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const d of list) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, out); else if (d.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function text(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('\n');
  return '';
}

// Commands and reviewer reports of one session log. A cut or bad line is skipped, never fatal.
function harvest(file, commands, reports) {
  let data;
  try { data = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
  const agentIds = new Set();
  for (const line of data.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch (err) { continue; }
    const content = e && e.message && e.message.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'tool_use') {
        if (SHELL.has(part.name) && part.input && typeof part.input.command === 'string') commands.add(part.input.command);
        if (AGENT.has(part.name) && part.id) agentIds.add(part.id);
      } else if (part.type === 'tool_result' && agentIds.has(part.tool_use_id)) {
        const t = text(part.content);
        if (t.length > 40) reports.add(t);
      }
    }
  }
}

function digest(s) { return crypto.createHash('sha1').update(s).digest('hex'); }

function usage() {
  console.error('usage: replay.mjs run --base <dir> --cand <dir> [--logs <dir>]... [--corpus <dir>] | collect --logs <dir>... --corpus <dir>');
  return 2;
}

function collect(o) {
  if (o.bad || !o.corpus || !o.logs.length) return usage();
  const commands = new Set(), reports = new Set();
  for (const d of o.logs) for (const f of walk(d, [])) harvest(f, commands, reports);
  for (const [name, set] of [['commands', commands], ['reports', reports]]) {
    const dir = path.join(o.corpus, name);
    fs.mkdirSync(dir, { recursive: true });
    for (const s of set) { const f = path.join(dir, digest(s) + '.txt'); if (!fs.existsSync(f)) fs.writeFileSync(f, s); }
  }
  console.log('REPLAY: collected ' + commands.size + ' commands and ' + reports.size + ' reports into ' + o.corpus);
  return 0;
}

function readCorpus(dir, name) {
  const d = path.join(dir, name);
  try { return fs.readdirSync(d).map((f) => fs.readFileSync(path.join(d, f), 'utf8')); } catch (e) { return []; }
}

function load(tree) {
  const f = path.join(path.resolve(tree), 'claude/hooks/lib/transcript-scan.js');
  return fs.existsSync(f) ? require(f) : null;
}

// One answer of a reader for a command or a report, as text. A crash is an answer too.
function answerCommand(r, cmd) {
  try {
    const segs = r.splitSegments(cmd);
    return JSON.stringify({ edits: r.shellEditPaths(cmd), verify: segs.map((s) => !!r.segmentIsVerify(s)) });
  } catch (e) { return 'CRASH: ' + (e && e.message); }
}
function answerReport(r, rep) {
  try { return JSON.stringify(r.reportNotes(rep)); } catch (e) { return 'CRASH: ' + (e && e.message); }
}

// The result fields the stop gate and the push guard read.
const FIELDS = ['lastEdit', 'lastVerify', 'lastVerifyResult', 'lastFailedVerify', 'lastPendingVerify', 'lastReviewerRun', 'lastReviewerResult', 'lastReview', 'lastReviewVerdict', 'lastGate', 'lastGateVerdict', 'turnClaim'];
function pick(res) {
  const o = {};
  for (const k of FIELDS) o[k] = res[k];
  o.openNotes = (res.openReviewNotes || []).map((n) => n.n);
  return JSON.stringify(o);
}

function scanWith(reader, file, stateDir) {
  fs.rmSync(stateDir, { recursive: true, force: true });   // a folder inside this run's own private folder
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'review-notes-since'), OLD_START);   // else both readers see no notes
  process.env.SANAD_STATE_DIR = stateDir;
  try { return pick(reader.scanTranscript(file)); } catch (e) { return 'CRASH: ' + (e && e.message); }
}

function oneLine(s) { return String(s).replace(/\s+/g, ' ').slice(0, 300); }

function run(o) {
  if (process.env.SANAD_REPLAY === 'none') { console.log('REPLAY: skipped (SANAD_REPLAY=none)'); return 0; }
  if (o.bad || !o.base || !o.cand) return usage();
  const logDirs = o.logs.length ? o.logs : [path.join(os.homedir(), '.claude', 'projects')];
  const commands = new Set(), reports = new Set();
  if (o.corpus) { readCorpus(o.corpus, 'commands').forEach((s) => commands.add(s)); readCorpus(o.corpus, 'reports').forEach((s) => reports.add(s)); }
  const sessions = [];
  for (const d of logDirs) for (const f of walk(d, [])) sessions.push(f);
  if (!commands.size && !reports.size && !sessions.length) { console.log('REPLAY: skipped (no corpus and no logs)'); return 0; }
  o.base = path.resolve(o.base); o.cand = path.resolve(o.cand);
  const base = load(o.base), cand = load(o.cand);
  if (!base) { console.log('REPLAY: skipped (the base has no transcript reader)'); return 0; }
  if (!cand) { console.log('REPLAY: skipped (the candidate has no transcript reader)'); return 0; }
  const approved = [];
  if (o.approved) { try { for (const l of fs.readFileSync(o.approved, 'utf8').split('\n')) if (l.trim() && !l.startsWith('#')) approved.push(l.trim()); } catch (e) { /* none */ } }
  const started = Date.now();
  const diffs = [], left = [];
  const add = (kind, label, a, b) => diffs.push('REPLAY DIFF ' + kind + ' ' + label + '\n  base: ' + oneLine(a) + '\n  cand: ' + oneLine(b));
  for (const f of sessions) harvest(f, commands, reports);
  for (const c of commands) { const a = answerCommand(base, c), b = answerCommand(cand, c); if (a !== b) add('command', JSON.stringify(oneLine(c)), a, b); }
  for (const r of reports) { const a = answerReport(base, r), b = answerReport(cand, r); if (a !== b) add('report', JSON.stringify(oneLine(r).slice(0, 120)), a, b); }
  // Each run gets its own new private folder, so it never deletes a folder the caller already had.
  if (o.state) fs.mkdirSync(path.resolve(o.state), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(o.state ? path.resolve(o.state) : os.tmpdir(), 'sanad-replay-'));
  const saved = process.env.SANAD_STATE_DIR;
  let scanned = 0;
  try {
    for (const f of sessions) {
      let size = 0;
      try { size = fs.statSync(f).size; } catch (e) { continue; }
      if (size > o.maxMb * 1048576) { left.push(f + ' (' + Math.round(size / 1048576) + ' MB over the cap)'); continue; }
      if ((Date.now() - started) / 1000 > o.maxSeconds) { left.push(f + ' (out of time)'); continue; }
      const a = scanWith(base, f, path.join(tmp, 'base')), b = scanWith(cand, f, path.join(tmp, 'cand'));
      scanned++;
      if (a !== b) add('session', f, a, b);
    }
  } finally {
    if (saved === undefined) delete process.env.SANAD_STATE_DIR; else process.env.SANAD_STATE_DIR = saved;
    if (!o.state) fs.rmSync(tmp, { recursive: true, force: true });   // a given --state keeps this run's folder to look at
  }
  let notApproved = 0;
  for (const d of diffs) {
    const ok = approved.some((p) => d.includes(p));
    console.log(d + (ok ? '\n  (approved)' : ''));
    if (!ok) notApproved++;
  }
  for (const l of left) console.log('REPLAY: left out ' + l);
  console.log('REPLAY: ' + commands.size + ' commands, ' + reports.size + ' reports, ' + scanned + ' sessions, ' + diffs.length + ' differences (' + notApproved + ' not approved)');
  // 0 = no difference, or every difference approved; 4 = at least one not approved (the installer reads this one).
  // Any other code (a Node start failure is 1) is a replay error.
  return notApproved ? 4 : 0;
}

const o = parseArgs(process.argv.slice(2));
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let code;
  try { code = o.cmd === 'collect' ? collect(o) : o.cmd === 'run' ? run(o) : usage(); }
  catch (e) { console.log('REPLAY: crashed: ' + oneLine(e && e.message)); code = 5; }   // 5 = the replay itself broke
  process.exit(code);
}
