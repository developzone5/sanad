#!/usr/bin/env node
// sanad-timer.mjs — the task's timer: one mark per step, and the table the user reads at the end.
//
//   node sanad-timer.mjs mark <notes-dir> <step words…>   start a step now (ends the step before it)
//   node sanad-timer.mjs wait <notes-dir> <why…>          start a wait (the user, a machine, a stuck run)
//   node sanad-timer.mjs pause <notes-dir> <why…>         other work in the middle (the user's side request)
//   node sanad-timer.mjs resume <notes-dir>               back to the task: its last step goes on
//   node sanad-timer.mjs report <notes-dir>               print each step's minutes and the total
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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMain } from './is-main.mjs';

const FILE = 'timer.tsv';
/** The pointer file's name for a session id: sanad-timer-active-<id>, or sanad-timer-active with no id. */
export const pointerName = (id) => { const key = String(id || '').replace(/[^A-Za-z0-9_-]/g, ''); return key ? `sanad-timer-active-${key}` : 'sanad-timer-active'; };
const pointer = () => path.join(process.env.SANAD_STATE_DIR || path.join(os.homedir(), '.claude', 'state'), pointerName(process.env.CLAUDE_CODE_SESSION_ID));
const PAUSED = 'paused: ';

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
  const steps = readMarks(dir).filter((m) => m.kind === 'step' && m.text !== 'resumed');
  const last = steps.length ? steps[steps.length - 1].text.replace(/^resumed: /, '') : 'work';
  setActive(dir, now);
  mark(dir, 'step', `resumed: ${last}`, now);
  return last;
}

/** The task is done: no more idle marks, for this timer only. */
export function clearActive(dir) {
  try { if (path.resolve(fs.readFileSync(pointer(), 'utf8').trim()) === path.resolve(dir)) fs.rmSync(pointer()); } catch { /* none */ }
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
  const beside = all.filter((m) => m.kind === 'side').map((m) => {
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
    const name = r.text.replace(/^resumed: /, '').replace(/^start \(auto\): the user's message.*$/, 'read and plan').replace(/^(?:start \(auto\): )?first code edit.*$/, 'code');
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
  return lines.join('\n');
}

if (isMain(import.meta.url)) {
  const [cmd, dir, ...words] = process.argv.slice(2);
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
