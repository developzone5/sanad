#!/usr/bin/env node
// sanad-timer.mjs — the task's timer: one mark per step, and the table the user reads at the end.
//
//   node sanad-timer.mjs mark <notes-dir> <step words…>   start a step now (ends the step before it)
//   node sanad-timer.mjs wait <notes-dir> <why…>          start a wait (the user, a machine, a stuck run)
//   node sanad-timer.mjs report <notes-dir>               print each step's minutes and the total
//
// 2026-11-09 (TUW-238): the user asked three times "how much time … which parts take too long", and the
// answer had to be rebuilt from the session log. Each Sanad stage marks itself; `report` is the timer
// shown with the ship brief. Marks live in <notes-dir>/timer.tsv (ISO time, kind, words).
import fs from 'node:fs';
import path from 'node:path';

const FILE = 'timer.tsv';

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
  const marks = readMarks(dir);
  if (!marks.length) return 'TIMER: no marks yet';
  const rows = marks.map((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].at : now;
    return { ...m, minutes: Math.max(0, (end - m.at) / 60000) };
  });
  const fmt = (n) => (n < 10 ? n.toFixed(1) : String(Math.round(n))).padStart(5);
  const total = rows.reduce((s, r) => s + r.minutes, 0);
  const waited = rows.filter((r) => r.kind === 'wait').reduce((s, r) => s + r.minutes, 0);
  const lines = rows.map((r) => `${fmt(r.minutes)} min  ${r.kind === 'wait' ? 'WAIT ' : ''}${r.text}`);
  lines.push(`${fmt(total)} min  total (work ${fmt(total - waited).trim()}, waiting ${fmt(waited).trim()})`);
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  const [cmd, dir, ...words] = process.argv.slice(2);
  if (!cmd || !dir) {
    console.error('Usage: sanad-timer.mjs mark|wait|report <notes-dir> [step words…]');
    process.exit(2);
  }
  if (cmd === 'mark' || cmd === 'wait') { mark(dir, cmd === 'wait' ? 'wait' : 'step', words.join(' ')); console.log(`TIMER ${cmd}: ${words.join(' ')}`); }
  else if (cmd === 'report') console.log(report(dir));
  else { console.error(`Unknown command: ${cmd}`); process.exit(2); }
}
