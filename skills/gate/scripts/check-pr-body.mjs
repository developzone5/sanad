#!/usr/bin/env node
// check-pr-body.mjs — refuse a PR body that parks a finding without the user's (or the ticket's) words.
//
// Sanad's rule: only the user parks a finding. A reviewer's finding is fixed, or the user accepts it
// in their own words; the author never keeps it "by decision". Seen 2026-11-05: a PR body said
// "Kept as they are by the author's decision" about two findings the reviews had raised; a
// teammate found both again after the push.
//
// Usage: node check-pr-body.mjs <pr-body.md>
//   prints `PR BODY: clean` and exits 0, or one `PARKED` line per flagged line and exits 1.
// A line passes when it quotes the user (the word "user" and a quoted phrase) or a ticket
// (a key like TUW-160 and a quoted phrase) — the authority for leaving it as it is.
import fs from 'node:fs';

// Words that leave a known problem in place. Matched case-insensitively on each line.
export const PARKING = [
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

const QUOTED = /"[^"]{3,}"|“[^”]{3,}”|«[^»]{3,}»|'[^'\s][^']{2,}'/;
const USER = /\buser\b|\bthe user's\b/i;
const TICKET = /\b[A-Z][A-Z0-9]+-\d+\b/;

// A flagged line passes with a quoted phrase plus who said it: the user or a ticket.
export function hasAuthority(line) {
  return QUOTED.test(line) && (USER.test(line) || TICKET.test(line));
}

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
    const hit = PARKING.find((re) => re.test(line));
    if (!hit || hasAuthority(line)) return;
    const under = line.trimEnd().endsWith(':') ? bulletsUnder(lines, i) : [];
    if (under.length && under.every(hasAuthority)) return;
    findings.push({ line: i + 1, text: line.trim(), words: line.match(hit)[0] });
  });
  return findings;
}

function main(argv) {
  const file = argv[2];
  if (!file || !fs.existsSync(file)) {
    console.error('Usage: node check-pr-body.mjs <pr-body.md>');
    return 2;
  }
  const findings = check(fs.readFileSync(file, 'utf8'));
  if (!findings.length) {
    console.log('PR BODY: clean');
    return 0;
  }
  for (const f of findings)
    console.log(`PARKED — line ${f.line} ("${f.words}"): ${f.text.slice(0, 160)} — fix it, or quote the user's (or the ticket's) own words on this line`);
  console.log(`PR BODY: ${findings.length} parked line(s). Only the user parks a finding.`);
  return 1;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('check-pr-body.mjs')) process.exitCode = main(process.argv);
