#!/usr/bin/env node
// check-pr-body.mjs — refuse a PR body that parks a finding without the user's (or the ticket's) words.
//
// Sanad's rule: only the user parks a finding. A reviewer's finding is fixed, or the user accepts it
// in their own words; the author never keeps it "by decision". Seen 2026-11-05: a PR body said
// "Kept as they are by the author's decision" about two findings the reviews had raised; a
// teammate found both again after the push.
//
// Usage: node check-pr-body.mjs <pr-body.md> [--notes <task notes folder>]
//   prints `PR BODY: clean` and exits 0, or one `PARKED` line per flagged line and exits 1.
//   A `PLACEHOLDER` line (text left to fill in) also exits 1. With --notes, an `EVIDENCE` line names an
//   evidence block that is not for HEAD's tree or differs from what `sanad.mjs pr-body` prints now.
// A line passes when it quotes the user (`user said`, `user:` or `the user's words`, then their words
// in "…", “…” or «…») or a ticket (a key like TUW-160 and a quoted phrase) — the authority for leaving
// it as it is.
// A branch the user kept as one job (one-job.mjs --keep) also needs a `One job: <why>` line.
import fs from 'node:fs';
import path from 'node:path';
import { keptWords } from './one-job.mjs';

// Words that leave a known problem in place. Matched case-insensitively on each line.
// 2026-11-12 (audit C13): "out of scope", "by design" and the others below parked findings unseen.
export const PARKING = [
  /\bout of scope\b/i,
  /\bby design\b/i,
  /\bunchanged on purpose\b/i,
  /\bseparate PR\b/i,
  /\bfollow-?up PR\b/i,
  /\bnot in this PR\b/i,
  /\bauthor'?s? (?:own )?(?:decision|choice|call)\b/i,
  /\b(?:kept|left|leave|keep) (?:it |them |this |that )?as (?:it|they|is|are)\b/i,
  /\bas (?:it|they) (?:is|are) on purpose\b/i,
  /\bknown gaps?\b/i,
  /\bwon'?t fix\b/i,
  /\bnot fixed\b/i,
  /\bpre-?existing\b/i,
  /\bno (?:screen|page|caller|client|user) (?:sends|reads|uses|calls|hits|reaches) (?:it|them|this)\b/i,
  /\b(?:accepted|acceptable) (?:risk|gap|as is)\b/i,
  /\bleft for (?:a |the )?(?:follow-?up|later|another pr)\b/i,
  /\bdeferred\b/i,
];

// 2026-11-12 (audit C13): two apostrophes made a "quote" ("the teacher's list doesn't …") and the bare
// word "user" made it the user's. A quotation is now double, typographic or angle quotes only, and the
// user's words follow `user said`, `user:` or `the user's words`.
const QUOTE = String.raw`(?:"[^"]{3,}"|“[^”]{3,}”|«[^»]{3,}»)`;
const QUOTED = new RegExp(QUOTE);
const USER_WORDS = new RegExp(String.raw`\buser(?:\s+said\b|\s*:|['’]s\s+words\b)[^"“«]*` + QUOTE, 'i');
const TICKET = /\b[A-Z][A-Z0-9]+-\d+\b/;

// A flagged line passes with a quoted phrase plus who said it: the user or a ticket.
export function hasAuthority(line) {
  return USER_WORDS.test(line) || (QUOTED.test(line) && TICKET.test(line));
}

// 2026-11-12 (audit C13): "Fixes the pre-existing crash" was refused. A line that fixes an old problem
// parks nothing: the fix words are taken out before the parking words are looked for.
const FIXES_OLD = /\bfix(?:es|ed|ing)?\s+(?:the\s+|a\s+|an\s+)?(?:pre-?existing|existing)\b/gi;

const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+/;

// A lead line ending with ":" ("Left as it is on purpose:") speaks for the bullets under it: it
// passes only when every one of them carries its own authority.
function bulletsUnder(lines, i) {
  const out = [];
  for (let k = i + 1; k < lines.length && BULLET.test(lines[k]); k++) out.push(lines[k]);
  return out;
}

export function check(text) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const words = line.replace(FIXES_OLD, ' ');
    const hit = PARKING.find((re) => re.test(words));
    if (!hit || hasAuthority(line)) return;
    const under = line.trimEnd().endsWith(':') ? bulletsUnder(lines, i) : [];
    if (under.length && under.every(hasAuthority)) return;
    findings.push({ line: i + 1, text: line.trim(), words: words.match(hit)[0] });
  });
  return findings;
}

// 2026-11-19: a PR text went out with two placeholders still in it. A line outside a code block that
// holds <…>, TODO, TBD, ?? or {{…}} is refused. Code is left alone: a fenced block and an inline `span`
// may hold a generic type such as List<string>. HTML the page really uses (a comment, <details>, <br>,
// a link in angle brackets) is no placeholder. A placeholder inside a link is still one.
const HTML_TAG = 'details|summary|br|hr|p|b|i|u|em|strong|a|img|sub|sup|kbd|code|pre|div|span|table|thead|tbody|tr|td|th|ul|ol|li|h[1-6]|blockquote|picture|source|video|del|ins|s|samp|var|q|dl|dt|dd';
const ANGLE = new RegExp(String.raw`<(?!!--)(?!\/?(?:${HTML_TAG})(?:[\s/>]))(?![a-z][a-z0-9+.-]*:\/\/)(?!mailto:)(?![^<>\s]+@[^<>\s]+>)[^\s<>](?:[^<>\n]*[^\s<>])?>`, 'i');
const PLACEHOLDER = [[ANGLE, '<…>'], [/\bTODO\b/, 'TODO'], [/\bTBD\b/i, 'TBD'], [/\?\?/, '??'], [/\{\{[^}\n]*\}\}/, '{{…}}']];
// The evidence block is skipped ONLY when the caller says it passed the exact comparison in this run
// (opts.blockChecked). Otherwise it is scanned like the rest.
export function placeholders(text, opts = {}) {
  const found = [];
  let fence = '';
  const all = String(text).split(/\r?\n/);
  // The generated evidence block is checked on its own, by exact comparison. A quoted finding in it may hold
  // words like TBD: only the author's own prose is scanned here.
  const from = !opts.blockChecked ? -1 : all.findIndex((l) => BLOCK_OPEN.test(l.trimEnd()));
  const to = from < 0 ? -1 : all.findIndex((l, i) => i > from && l.trimEnd() === BLOCK_CLOSE);
  all.forEach((line, i) => {
    if (from >= 0 && to > from && i >= from && i <= to) return;
    const mark = /^\s*(`{3,}|~{3,})/.exec(line);
    if (mark) { if (!fence) fence = mark[1][0]; else if (mark[1][0] === fence) fence = ''; return; }
    if (fence) return;
    const prose = line.replace(/`[^`\n]*`/g, ' ');
    for (const [re, name] of PLACEHOLDER) {
      const m = re.exec(prose);
      if (m) { found.push({ line: i + 1, text: line.trim(), words: m[0], kind: name }); break; }
    }
  });
  return found;
}

// The evidence block sanad.mjs pr-body printed must be for HEAD's tree and unchanged, line for line.
// `facts` is sanad.mjs readFacts(); `block` (for a test) replaces what pr-body would print now.
const BLOCK_OPEN = /^<!-- sanad-evidence tree=([0-9a-f]*) -->$/, BLOCK_CLOSE = '<!-- /sanad-evidence -->';
export function evidenceProblems(text, facts, block = null) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trimEnd());
  const from = lines.findIndex((l) => BLOCK_OPEN.test(l));
  const to = lines.indexOf(BLOCK_CLOSE, from + 1);
  if (from < 0 || to < 0) return ['no evidence block: paste the lines `sanad.mjs pr-body` prints'];
  const tree = BLOCK_OPEN.exec(lines[from])[1];
  const head = facts?.git?.headTree || '';
  if (!head || tree !== head) return [`the evidence block is for tree ${tree.slice(0, 10) || '(none)'}, HEAD's tree is ${head.slice(0, 10) || '(not read)'}: run pr-body again`];
  const now = block || [];
  const mine = lines.slice(from, to + 1);
  const out = [];
  for (let i = 0; i < Math.max(mine.length, now.length); i++) if (mine[i] !== now[i]) { out.push(`evidence line differs from pr-body: "${String(mine[i] ?? '(missing)').slice(0, 120)}" — the records say "${String(now[i] ?? '(no such line)').slice(0, 120)}"`); break; }
  return out;
}

// A change the user kept as one job says why in the PR text (user rule 2026-11-15).
const ONE_JOB_LINE = /^\s*(?:[-*+]\s+)?(?:\*\*)?One job\b(?:\*\*)?\s*:/im;
export function missingOneJob(text, kept) {
  return Boolean(kept) && !ONE_JOB_LINE.test(text);
}

async function main(argv) {
  const file = argv[2];
  const at = argv.indexOf('--notes');
  const notes = at > 2 ? argv[at + 1] : '';
  if (!file || !fs.existsSync(file) || (at > 2 && !notes) || argv.slice(3).some((a, i) => a.startsWith('--') ? a !== '--notes' : argv[i + 2] !== '--notes')) {
    console.error('Usage: node check-pr-body.mjs <pr-body.md> [--notes <task notes folder>]');
    return 2;
  }
  const text = fs.readFileSync(file, 'utf8');
  const kept = keptWords(process.cwd());
  if (missingOneJob(text, kept)) {
    console.log(`ONE JOB — the user kept this change as one PR ("${kept}"): add a line "One job: <why this is one PR>"`);
    return 1;
  }
  let evidence = [];
  let compared = false;
  if (notes) {
    // The block is compared with what the records say now, for the repository this command runs in.
    try {
      const { readFacts, evidenceBlock, loadNotesTools } = await import('./sanad.mjs');
      await loadNotesTools();
      const facts = readFacts({ repo: process.cwd(), notes: path.resolve(notes), deep: true });
      evidence = evidenceProblems(text, facts, evidenceBlock(facts));
      compared = evidence.length === 0;
    } catch (error) { evidence = [`the evidence block could not be checked (${String(error && error.message || error).split(/\r?\n/)[0]})`]; }
  }
  const holes = placeholders(text, { blockChecked: compared });
  for (const h of holes)
    console.log(`PLACEHOLDER — line ${h.line} ("${h.words.slice(0, 40)}"): ${h.text.slice(0, 160)} — write the real words, or put code in a code block`);
  for (const e of evidence) console.log(`EVIDENCE — ${e}`);
  if (holes.length || evidence.length) {
    console.log(`PR BODY: ${holes.length} placeholder line(s), ${evidence.length} evidence problem(s).`);
    return 1;
  }
  const findings = check(text);
  if (!findings.length) {
    console.log('PR BODY: clean');
    return 0;
  }
  for (const f of findings)
    console.log(`PARKED — line ${f.line} ("${f.words}"): ${f.text.slice(0, 160)} — fix it, or quote the user's (or the ticket's) own words on this line`);
  console.log(`PR BODY: ${findings.length} parked line(s). Only the user parks a finding.`);
  return 1;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('check-pr-body.mjs')) process.exitCode = await main(process.argv);
