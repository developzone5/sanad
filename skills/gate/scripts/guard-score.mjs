#!/usr/bin/env node
// guard-score.mjs — how often each guard rule refused, per rule and per day. Read-only.
//
// It reads the session logs the host already saves (.jsonl, one JSON object per line) and counts two kinds of refusal:
//   stop block  : a user line whose text starts "Stop hook feedback:" (the stop gate's reason follows).
//   push denial : a tool result with is_error whose text holds "hook error:" or starts "Blocked by policy-guard".
// Only those two shapes count. A block text quoted inside an assistant message or a file is never counted.
// A rule is the id in round brackets in the reason, like (SG-FAILED); a reason with two ids counts for each.
// Else the family comes from the table below (older texts and the push guard). Else "unknown rule".
// The host deletes old logs, so daily counts are kept in <state>/guard-score.json, one entry per log file name.
// A log read again replaces its own entry, so two runs never double a count. The same file name on two
// machines counts once (the larger number wins).
// It also counts the escape hatches the assistant used: CHECK RETIRED, PROBE EXPECTED, NOTE user answers,
// and the flags --local, --no-cache, --before-proof in a command.
//
// Usage: node guard-score.mjs [--dir <projects folder>] [--days <n>] [--mark wrong <id>] [--unmark wrong <id>]
//   --dir   the folder of session logs (default SANAD_PROJECTS_DIR, else ~/.claude/projects), searched below.
//   --mark  adds one "wrong refusal" mark for a rule id; the printed rate is marks / blocks of that rule.
// <state> is SANAD_STATE_DIR, else ~/.claude/state. The only file written is <state>/guard-score.json.
// Exit 0: printed. 2: usage error.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { isMain } from './is-main.mjs';

const USAGE = 'Usage: node guard-score.mjs [--dir <projects folder>] [--days <n>] [--mark wrong <rule id>] [--unmark wrong <rule id>]';
export const UNKNOWN = 'unknown rule';
const stateDir = () => process.env.SANAD_STATE_DIR || path.join(os.homedir(), '.claude', 'state');
const projectsDir = () => process.env.SANAD_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
export const scoreFile = () => path.join(stateDir(), 'guard-score.json');

// Older texts and the push guard: first match wins. Order matters (specific before general).
export const FAMILIES = [
  [/reviewer note has no outcome|NOTE <n>/i, 'SG-NOTES'],
  [/never collected|still running or its completion/i, 'SG-PENDING'],
  [/CHECK RETIRED/, 'SG-FAILED'],
  [/no verification|unverified|without verification|Definition-of-Done/i, 'SG-UNVERIFIED'],
  [/send a text with no verdict line/i, 'SG-CLAIM'],
  [/REVIEW: PASS|completed independent reviewer/i, 'PG-REVIEW'],
  [/GATE: PASS/, 'PG-GATE'],
  [/verification evidence|evidence\.mjs|no passing check|PR verification|verified checked-out|push source/i, 'PG-EVIDENCE'],
  [/never merge|gh pr merge|merge endpoint|merges, releases/i, 'PG-MERGE'],
  [/explicit integration base|--base|PR base|never main|integration branch/i, 'PG-BASE'],
  [/git add/, 'PG-GIT-ADD'],
  [/gh api|graphql|gh release|gh repo|push\.default|remote\./i, 'PG-GH'],
  [/ExecuteUpdate|raw SQL|migration/i, 'PG-MIGRATION'],
];

/** The rule ids of one refusal text. */
export function rulesOf(text) {
  const ids = [...String(text).matchAll(/\((SG-[A-Z0-9-]+)\)/g)].map((m) => m[1]);
  if (ids.length) return [...new Set(ids)];
  for (const [re, id] of FAMILIES) if (re.test(text)) return [id];
  return [UNKNOWN];
}

const textOf = (c) => typeof c === 'string' ? c
  : Array.isArray(c) ? c.map((p) => (p && (p.text || textOf(p.content))) || '').join('\n') : '';

/** The refusals of one parsed log line: [{ kind, text }]. Only a user line counts. */
export function refusalsOf(entry) {
  if (!entry || typeof entry !== 'object' || entry.type !== 'user' || !entry.message) return [];
  const c = entry.message.content;
  if (typeof c === 'string') return /^Stop hook feedback:/.test(c) ? [{ kind: 'stop', text: c.slice('Stop hook feedback:'.length) }] : [];
  const found = [];
  if (Array.isArray(c)) for (const p of c) {
    if (!p || p.type !== 'tool_result' || p.is_error !== true) continue;
    const t = textOf(p.content);
    if (/hook error:/.test(t.slice(0, 120)) || /^\s*Blocked by policy-guard/.test(t)) found.push({ kind: 'push', text: t });
  }
  return found;
}

const HATCHES = [['CHECK RETIRED', /^\s*CHECK RETIRED:/m], ['PROBE EXPECTED', /^\s*PROBE EXPECTED:/m], ['NOTE user answer', /^\s*NOTE \d+: user\b/m]];
const FLAGS = [['--local', /(^|\s)--local(\s|$)/], ['--no-cache', /(^|\s)--no-cache(\s|$)/], ['--before-proof', /(^|\s)--before-proof(\s|$)/]];

/** The escape hatches one assistant line used (a text line, or a node/bash command). */
export function hatchesOf(entry) {
  const found = [];
  if (!entry || entry.type !== 'assistant' || !entry.message || !Array.isArray(entry.message.content)) return found;
  for (const p of entry.message.content) {
    if (!p) continue;
    if (p.type === 'text' && typeof p.text === 'string') for (const [n, re] of HATCHES) if (re.test(p.text)) found.push(n);
    if (p.type === 'tool_use' && p.input && typeof p.input.command === 'string' && /\b(node|bash|sh)\b/.test(p.input.command))
      for (const [n, re] of FLAGS) if (re.test(p.input.command)) found.push(n);
  }
  return found;
}

/** Counts of one log file: days { 'YYYY-MM-DD': { rule: n } } and hatches { name: n }. A bad or cut line is skipped. */
export async function readLogFile(file) {
  const days = {}, hatches = {};
  try {
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
      let entry; try { entry = JSON.parse(line); } catch { continue; }
      const day = String(entry.timestamp || '').slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(day)) for (const r of refusalsOf(entry)) for (const id of rulesOf(r.text)) {
        const d = days[day] || (days[day] = {});
        d[id] = (d[id] || 0) + 1;
      }
      for (const n of hatchesOf(entry)) hatches[n] = (hatches[n] || 0) + 1;
    }
  } catch { /* an unreadable file counts what was read */ }
  return { days, hatches };
}

function listLogs(dir) {
  const out = [];
  const walk = (d, depth) => {
    let names; try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const n of names) {
      const p = path.join(d, n.name);
      if (n.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (n.isFile() && n.name.toLowerCase().endsWith('.jsonl')) out.push(p);
    }
  };
  walk(dir, 0);
  return out.sort();
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(scoreFile(), 'utf8'));
    if (s && typeof s === 'object') return { logs: s.logs || {}, wrong: s.wrong || {} };
  } catch { /* none yet */ }
  return { logs: {}, wrong: {} };
}
function saveState(s) { fs.mkdirSync(stateDir(), { recursive: true }); fs.writeFileSync(scoreFile(), JSON.stringify(s, null, 1)); }

/** Totals from the kept state: per rule, per day, and the hatches. */
export function totalsOf(state) {
  const rules = {}, perDay = {}, hatches = {};
  for (const log of Object.values(state.logs)) {
    for (const [day, rs] of Object.entries(log.days || {})) for (const [r, n] of Object.entries(rs)) {
      rules[r] = (rules[r] || 0) + n;
      const d = perDay[day] || (perDay[day] = {}); d[r] = (d[r] || 0) + n;
    }
    for (const [n, c] of Object.entries(log.hatches || {})) hatches[n] = (hatches[n] || 0) + c;
  }
  return { rules, perDay, hatches };
}

export function reportLines(state, days) {
  const { rules, perDay, hatches } = totalsOf(state);
  const keep = Object.keys(perDay).sort().slice(-days);
  const inRange = {};
  for (const d of keep) for (const [r, n] of Object.entries(perDay[d])) inRange[r] = (inRange[r] || 0) + n;
  const total = Object.values(inRange).reduce((a, b) => a + b, 0);
  const lines = [`GUARD SCORE: ${total} refusal(s) over ${keep.length} day(s)`];
  for (const [r, n] of Object.entries(inRange).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) {
    const w = Number(state.wrong[r]) || 0;
    lines.push(`  ${r}: ${n}` + (w ? ` (${w} marked wrong, ${Math.round((100 * w) / (rules[r] || n))}% wrong)` : ''));
  }
  for (const d of keep) lines.push(`  ${d}: ` + Object.entries(perDay[d]).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([r, n]) => `${r} x${n}`).join(', '));
  lines.push('ESCAPE HATCHES: ' + (Object.keys(hatches).length ? Object.entries(hatches).sort().map(([n, c]) => `${n} x${c}`).join(', ') : 'none'));
  return lines;
}

function usage(m) { return Object.assign(new Error(m), { usage: true }); }
function parseArgs(argv) {
  const o = { days: 14 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--dir' && argv[i + 1] && !argv[i + 1].startsWith('--')) o.dir = argv[++i];
    else if (k === '--days' && /^\d+$/.test(argv[i + 1] || '')) o.days = Number(argv[++i]);
    else if ((k === '--mark' || k === '--unmark') && argv[i + 1] === 'wrong' && argv[i + 2] && !argv[i + 2].startsWith('--')) { o[k.slice(2)] = argv[i + 2]; i += 2; }
    else throw usage('Unknown or empty option: ' + k);
  }
  return o;
}

export async function main(argv, out = (l) => process.stdout.write(l + '\n')) {
  const o = parseArgs(argv);
  const state = loadState();
  const dir = o.dir || projectsDir();
  const files = listLogs(dir);
  if (!files.length && !Object.keys(state.logs).length) out(`GUARD SCORE: no session log found in ${dir}`);
  for (const f of files) {
    const prev = state.logs[path.basename(f)];
    const now = await readLogFile(f);
    // The same session file on two machines: keep the larger count per day and rule, never the sum.
    state.logs[path.basename(f)] = prev ? mergeMax(prev, now) : now;
  }
  if (o.mark) state.wrong[o.mark] = (Number(state.wrong[o.mark]) || 0) + 1;
  if (o.unmark) state.wrong[o.unmark] = Math.max(0, (Number(state.wrong[o.unmark]) || 0) - 1);
  try { saveState(state); } catch (e) { out('GUARD SCORE: could not keep the daily counts (' + e.message + ')'); }
  reportLines(state, o.days).forEach(out);
  return 0;
}

function mergeMax(a, b) {
  const days = {}, hatches = {};
  for (const src of [a, b]) {
    for (const [day, rs] of Object.entries(src.days || {})) for (const [r, n] of Object.entries(rs)) {
      const d = days[day] || (days[day] = {}); d[r] = Math.max(d[r] || 0, n);
    }
    for (const [n, c] of Object.entries(src.hatches || {})) hatches[n] = Math.max(hatches[n] || 0, c);
  }
  return { days, hatches };
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }).catch((error) => {
    process.stderr.write('GUARD SCORE: ' + error.message + '\n' + (error.usage ? USAGE + '\n' : ''));
    process.exitCode = 2;
  });
}
