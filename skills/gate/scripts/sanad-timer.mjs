#!/usr/bin/env node
// sanad-timer.mjs — the task's timer: one mark per step, and the table the user reads at the end.
//
//   node sanad-timer.mjs mark <notes-dir> <step words…>   start a step now (ends the step before it)
//   node sanad-timer.mjs wait <notes-dir> <why…>          start a wait (the user, a machine, a stuck run)
//   node sanad-timer.mjs pause <notes-dir> <why…>         other work in the middle (the user's side request)
//   node sanad-timer.mjs resume <notes-dir>               back to the task: its last step goes on
//   node sanad-timer.mjs report [notes-dir]               print each step's minutes and the total (no folder: this session's timer)
//   node sanad-timer.mjs week [timers-dir]                totals of the saved timers of the last 7 days
//   node sanad-timer.mjs request [--repo <path>]          a new task was routed: end the old timer, start the new one (Sanad Step 0)
//   node sanad-timer.mjs end <notes-dir>                  the task is done: stop the hooks' idle marks
//
// 2026-11-09 (TUW-238): the user asked three times "how much time … which parts take too long", and the
// answer had to be rebuilt from the session log. Each Sanad stage marks itself; `report` is the timer
// shown with the ship brief. Marks live in <notes-dir>/timer.tsv (ISO time, kind, words).
// mark and wait also name this timer as the active one, so the hooks mark the session's idle time
// themselves (hooks/lib/timer-idle.cjs): a stop starts a wait, the next tool call ends it.
// 2026-11-10: side work in the middle of a task (a workflow fix the user asked for) was counted as the
// task's work. Only one task's timer runs: marking another task pauses the one that ran, and a mark on
// it again goes on. Side work with no timer of its own uses pause and resume; the session runs them,
// never the user.
// Each session has its own active timer (2026-11-10: a session on another project held the one shared
// pointer, so its marks paused this task, and this session's stops were marked on its timer). The session
// is CLAUDE_CODE_SESSION_ID, the same id the hooks get; with none, the one shared name.
// 2026-11-17 (audit S7): the hooks start a task's timer at its first request, not at the last message before
// the first edit (the time before the user's "go" was lost). `report` names that request and the minutes
// before the first edit; a timer that ends or pauses stays named as the session's timer before
// (sanad-timer-last-<id>), so the hooks never start the next task at a message of this one.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { isMain } from './is-main.mjs';

const FILE = 'timer.tsv';
/** The pointer file's name for a session id: sanad-timer-active-<id>, or sanad-timer-active with no id. */
export const pointerName = (id) => { const key = String(id || '').replace(/[^A-Za-z0-9_-]/g, ''); return key ? `sanad-timer-active-${key}` : 'sanad-timer-active'; };
const pointer = () => path.join(process.env.SANAD_STATE_DIR || path.join(os.homedir(), '.claude', 'state'), pointerName(process.env.CLAUDE_CODE_SESSION_ID));
// The timer the session had before its active one: the same file name with "last" (hooks/lib/timer-idle.cjs).
const lastPointer = () => path.join(path.dirname(pointer()), path.basename(pointer()).replace('sanad-timer-active', 'sanad-timer-last'));
const PAUSED = 'paused: ';
// The time Sanad routed the task: the hooks start the timer there (hooks/lib/timer-idle.cjs routedAt).
const requestPointer = () => path.join(path.dirname(pointer()), path.basename(pointer()).replace('sanad-timer-active', 'sanad-task-start'));

/** The repo name a timer folder carries: the folder's git top, else the folder's own name (as the hooks name it). */
function repoName(dir) {
  const folder = path.resolve(dir || process.cwd());
  let top = '';
  try {
    let at = folder;
    while (at && !fs.existsSync(at)) { const up = path.dirname(at); if (up === at) break; at = up; }
    top = execFileSync('git', ['-C', at, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true }).trim();
  } catch { /* not in a repository: the folder's own name */ }
  return path.basename(top || folder).replace(/[^A-Za-z0-9_.-]/g, '_') || 'task';
}

/**
 * A new task was routed now: its first request. 2026-11-19: an older task of this session that never ended is
 * ended here, so the new task's marks go to a new timer. 2026-11-20: the new timer starts here too, with the
 * mark "start: the user's request" and as this session's active timer. Before, it waited for the hooks to see
 * a code edit in the session's own folder, and a task in another work tree ran with no timer at all, while
 * `report` showed the old task. `repo` is the task's folder (--repo), else the current folder.
 * Returns { ended, dir }: the timer it ended ('' for none) and the new timer's folder.
 */
export function requestStart(now = new Date(), { repo, unlessFresh = false } = {}) {
  const state = path.dirname(pointer());
  fs.mkdirSync(state, { recursive: true });
  // `sanad.mjs start` asks again for a task whose `request` already ran: the timer of that request is kept
  // (its start is the earlier time). Fresh = the active timer began with a request less than an hour ago.
  if (unlessFresh) {
    try {
      const active = fs.readFileSync(pointer(), 'utf8').trim();
      const first = active ? readMarks(active)[0] : null;
      if (first && /^start: the user's request/.test(first.text) && now - first.at < 3600000) return { ended: '', dir: active };
    } catch { /* none active */ }
  }
  let ended = '';
  try {
    const before = fs.readFileSync(pointer(), 'utf8').trim();
    const last = before ? readMarks(before).pop() : null;
    if (last && !(last.kind === 'step' && /^end(?: \(|$)/.test(last.text))) mark(before, 'step', 'end (auto: a new task was routed)', now);
    if (before) { clearActive(before); ended = before; }
  } catch { /* no active timer */ }
  const name = repoName(repo);
  const dir = path.join(state, 'timers', now.toISOString().replace(/[:.]/g, '').slice(0, 15) + '-' + name);
  mark(dir, 'step', `start: the user's request — ${name}`, now);
  fs.writeFileSync(pointer(), dir);
  // The old request file (an older script wrote one) would start another timer at the next edit: gone.
  try { fs.rmSync(requestPointer()); } catch { /* none */ }
  return { ended, dir };
}

/** The folder the report reads with no folder given: this session's active timer, else the one before. */
export function sessionTimer() {
  for (const p of [pointer(), lastPointer()]) {
    try { const dir = fs.readFileSync(p, 'utf8').trim(); if (dir && fs.existsSync(path.join(dir, FILE))) return dir; } catch { /* none */ }
  }
  return '';
}

// 2026-11-22 (owner): no time limit and no time target. The stage budgets (budgets.json) and the OVER line
// are gone; the timer only measures and reports minutes per stage.

/** Names the timer the hooks mark idle time on. A different timer that was running pauses. */
export function setActive(dir, now = new Date()) {
  let before = '';
  try { before = fs.readFileSync(pointer(), 'utf8').trim(); } catch { /* none */ }
  if (before && path.resolve(before) !== path.resolve(dir)) {
    const last = readMarks(before).pop();
    // A timer last marked more than 8 hours ago is a finished or forgotten task: left as it is.
    if (last && last.kind !== 'wait' && now - last.at < 8 * 3600000) mark(before, 'wait', `${PAUSED}other task (${path.basename(path.resolve(dir))})`, now);
  }
  fs.mkdirSync(path.dirname(pointer()), { recursive: true });
  fs.writeFileSync(pointer(), path.resolve(dir));
}

/** Side work starts: this task waits, and the hooks stop marking it. */
export function pause(dir, why, now = new Date()) {
  mark(dir, 'wait', PAUSED + (String(why || '').trim() || 'other work'), now);
  clearActive(dir);
}

/** Back to the task: the last step before the pause goes on, and the timer is the active one again. */
export function resume(dir, now = new Date()) {
  const steps = readMarks(dir).filter((m) => m.kind === 'step' && m.text !== 'resumed' && !/^end(?: \(|$)/.test(m.text));
  const last = steps.length ? steps[steps.length - 1].text.replace(/^resumed: /, '') : 'work';
  setActive(dir, now);
  mark(dir, 'step', `resumed: ${last}`, now);
  return last;
}

/** The task is done: no more idle marks, for this timer only. */
// 2026-11-17: the pointer is kept as the timer before (lastPointer), not deleted; no timer is active either way.
export function clearActive(dir) {
  try {
    if (path.resolve(fs.readFileSync(pointer(), 'utf8').trim()) !== path.resolve(dir)) return;
    try { fs.renameSync(pointer(), lastPointer()); } catch { fs.rmSync(pointer()); }
  } catch { /* none */ }
}

export function mark(dir, kind, words, now = new Date()) {
  fs.mkdirSync(dir, { recursive: true });
  const text = String(words || '').replace(/[\t\r\n]+/g, ' ').trim() || '(unnamed)';
  fs.appendFileSync(path.join(dir, FILE), `${now.toISOString()}\t${kind}\t${text}\n`);
}

export function readMarks(dir) {
  const file = path.join(dir, FILE);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
    const [at, kind, ...rest] = line.split('\t');
    return { at: new Date(at), kind, text: rest.join(' ') };
  }).filter((m) => !Number.isNaN(m.at.getTime()));
}

// Each mark lasts until the next one; the last lasts until `now`. Waits are listed apart so the user sees
// what was work and what was waiting.
export function report(dir, now = new Date()) {
  const all = readMarks(dir);
  // A "side" line is a review that ran beside the stages ("review <start> <end>"): not a step of the timeline.
  const marks = all.filter((m) => m.kind !== 'side');
  // A "run" side line is one proof or check start: "run <tool> <tree id>". It counts runs, not minutes.
  const runs = all.filter((m) => m.kind === 'side' && m.text.startsWith('run ')).map((m) => m.text.split(' '));
  const beside = all.filter((m) => m.kind === 'side' && !m.text.startsWith('run ')).map((m) => {
    const [name, from, to] = m.text.split(' ');
    return { name, minutes: Math.max(0, (new Date(to) - new Date(from)) / 60000) };
  }).filter((s) => s.name && Number.isFinite(s.minutes));
  if (!marks.length) return 'TIMER: no marks yet';
  // An end mark is the task's last moment: it takes no time, however much later the report is read.
  const isEnd = (m) => m.kind === 'step' && /^end(?: \(|$)/.test(m.text);
  const rows = marks.map((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].at : isEnd(m) ? m.at : now;
    return { ...m, minutes: Math.max(0, (end - m.at) / 60000) };
  });
  const fmt = (n) => (n < 10 ? n.toFixed(1) : String(Math.round(n))).padStart(5);
  const total = rows.reduce((s, r) => s + r.minutes, 0);
  const waited = rows.filter((r) => r.kind === 'wait').reduce((s, r) => s + r.minutes, 0);
  const lines = rows.map((r) => `${fmt(r.minutes)} min  ${r.kind === 'wait' ? 'WAIT ' : ''}${r.text}`);
  for (const s of beside) lines.push(`${fmt(s.minutes)} min  BESIDE ${s.name} (it ran beside the stages above; not added to the total)`);
  lines.push(`${fmt(total)} min  total (work ${fmt(total - waited).trim()}, waiting ${fmt(waited).trim()})`);
  // A stage that stopped and went on ("resumed: proof") is one stage: its parts added together, the
  // longest first (2026-11-11: the slow part of a task was spread over a dozen lines).
  const byStage = new Map();
  let stage = '';
  for (const r of rows) {
    if (r.kind === 'wait') { byStage.set('waiting', (byStage.get('waiting') || 0) + r.minutes); continue; }
    // The automatic timer's first marks, by what happens in them: reading and planning, then code.
    const name = r.text.replace(/^resumed: /, '').replace(/^start(?: \(auto(?:, estimate)?\))?: the user's (?:message|request).*$/, 'read and plan').replace(/^(?:start \(auto\): )?first code edit.*$/, 'code');
    if (name !== 'resumed') stage = name;
    if (isEnd(r)) continue;
    byStage.set(stage || name, (byStage.get(stage || name) || 0) + r.minutes);
  }
  if (byStage.size < rows.filter((r) => !isEnd(r)).length || beside.length) {
    const parts = [...byStage].filter(([, n]) => n >= 0.05).sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} ${fmt(n).trim()}`);
    const sideSum = new Map();
    for (const s of beside) sideSum.set(s.name, (sideSum.get(s.name) || 0) + s.minutes);
    for (const [name, n] of sideSum) parts.push(`${name} ${fmt(n).trim()} (beside)`);
    lines.push(`by stage (min): ${parts.join(' · ')}`);
  }
  // 2026-11-17 (audit S7): the automatic timer starts at the task's first request. This line says when that
  // was and how long the reading, the plan and the wait for the user's "go" took before the first edit.
  // The time of day is the reader's own (the one local time here; the marks stay in UTC).
  const edit = marks.find((m) => m.kind === 'step' && m.text === 'first code edit');
  if (edit && /^start \(auto(?:, estimate)?\): the user's message/.test(marks[0].text)) {
    // No start was written down when the task was routed: the time is a guess from the typed messages.
    const estimate = /^start \(auto, estimate\)/.test(marks[0].text) ? ' (estimate)' : '';
    const clock = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    lines.push(`start: first request ${clock(marks[0].at)}${estimate} · first edit after ${fmt((edit.at - marks[0].at) / 60000).trim()} min`);
  }
  const extra = [];
  // 2026-11-19: the workflow minutes are the work that is neither reading and planning nor code. Report only.
  const work = total - waited;
  const read = byStage.get('read and plan') || 0, code = byStage.get('code') || 0;
  extra.push(`workflow minutes ${fmt(Math.max(0, work - read - code)).trim()} (work ${fmt(work).trim()} minus read and plan ${fmt(read).trim()} and code ${fmt(code).trim()})`);
  const perTool = new Map();
  for (const [, tool, tree] of runs) { const e = perTool.get(tool) || { n: 0, trees: new Set() }; e.n++; e.trees.add(tree || '?'); perTool.set(tool, e); }
  for (const [tool, e] of perTool) extra.push(`${tool}: ${e.n} run${e.n === 1 ? '' : 's'} on ${e.trees.size} tree${e.trees.size === 1 ? '' : 's'}`);
  // The start line stays the last line (the ship brief reads it there).
  const startAt = lines.findIndex((l) => l.startsWith('start: first request'));
  lines.splice(startAt < 0 ? lines.length : startAt, 0, ...extra);
  return lines.join('\n');
}

/** The totals of the saved timers of the last 7 days (each <timers-dir>/<stamp>-<repo>/timer.tsv). */
export function week(timersDir, now = new Date()) {
  let names = [];
  try { names = fs.readdirSync(timersDir); } catch { return `WEEK: no timers in ${timersDir}`; }
  const t = { timers: 0, work: 0, workflow: 0, proof: 0, review: 0 };
  for (const name of names) {
    const dir = path.join(timersDir, name);
    const marks = readMarks(dir).filter((m) => m.kind !== 'side');
    if (!marks.length || now - marks[0].at > 7 * 86400000) continue;
    const text = report(dir, now);
    const num = (re) => { const m = re.exec(text); return m ? Number(m[1]) : 0; };
    t.timers++;
    t.work += num(/total \(work (\d+(?:\.\d+)?),/);
    t.workflow += num(/^workflow minutes (\d+(?:\.\d+)?)/m);
    // 2026-11-22: the minutes of a stage are its own rows ("  2.0 min  proof"). The old pattern read them from
    // the OVER line, so a proof under its budget counted 0; with no OVER line it counted 0 always.
    const stage = (name) => [...text.matchAll(new RegExp(`^\\s*(\\d+(?:\\.\\d+)?) min {2}${name}$`, 'gm'))].reduce((s, m) => s + Number(m[1]), 0);
    t.proof += stage('proof');
    t.review += stage('review');
  }
  const f = (n) => n.toFixed(1);
  return `WEEK: ${t.timers} timers · work ${f(t.work)} min · workflow ${f(t.workflow)} min · proof ${f(t.proof)} min · review ${f(t.review)} min`;
}

if (isMain(import.meta.url)) {
  const [cmd, dir, ...words] = process.argv.slice(2);
  if (cmd === 'request') {
    const at = process.argv.indexOf('--repo');
    const { ended, dir: started } = requestStart(new Date(), { repo: at > 1 ? process.argv[at + 1] : '' });
    console.log(`TIMER request: the task starts now; its timer is ${started}${ended ? `; the timer before (${ended}) was ended` : ''}`);
    process.exit(0);
  }
  if (cmd === 'report' && !dir) {
    const found = sessionTimer();
    if (!found) { console.log('TIMER: no timer for this session'); process.exit(0); }
    console.log(`TIMER folder: ${found}`);
    console.log(report(found));
    process.exit(0);
  }
  if (cmd === 'week') {
    console.log(week(dir || path.join(process.env.SANAD_STATE_DIR || path.join(os.homedir(), '.claude', 'state'), 'timers')));
    process.exit(0);
  }
  if (!cmd || !dir) {
    console.error('Usage: sanad-timer.mjs mark|wait|pause|resume|report|end <notes-dir> [step words…]');
    process.exit(2);
  }
  if (cmd === 'mark' || cmd === 'wait') {
    try { setActive(dir); } catch { /* idle marks are a help, never a failure */ }
    mark(dir, cmd === 'wait' ? 'wait' : 'step', words.join(' '));
    console.log(`TIMER ${cmd}: ${words.join(' ')}`);
  }
  else if (cmd === 'pause') { pause(dir, words.join(' ')); console.log(`TIMER paused: ${words.join(' ') || 'other work'}`); }
  else if (cmd === 'resume') console.log(`TIMER resumed: ${resume(dir)}`);
  else if (cmd === 'report') console.log(report(dir));
  else if (cmd === 'end') { mark(dir, 'step', 'end'); clearActive(dir); console.log(report(dir)); }
  else { console.error(`Unknown command: ${cmd}`); process.exit(2); }
}
