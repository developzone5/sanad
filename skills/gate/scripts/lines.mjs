#!/usr/bin/env node
// lines.mjs — the task's lines file (loop.md Step 1.2), written from the ticket text as it is.
//
// 2026-11-13: the lines file was typed by hand at the start of every task (copy each ticket line, number it
// T1..Tn), and a task with no ticket also had to be told to the commit check by hand. This copies the
// ticket text, line by line, without changing a word:
//   - every non-empty line becomes `T<n>. <the line>`; a line that is only a heading mark (`#`, `##`) or a
//     list bullet keeps its words, without the mark
//   - the ticket text itself is copied next to it as ticket.md (review-brief.mjs --ticket reads it)
//   --no-ticket: the user said the task has no ticket. The text is then the user's own words, and the commit
//   check stops asking for a ticket ID on this branch: `git config branch.<branch>.sanadNoTicket true` in
//   --repo (check-commits.mjs reads it). Said once by the user, never asked again.
//
// Usage: node lines.mjs --from <ticket text file> --out <notes>/lines.md [--no-ticket --repo <path>]
// Exit 0: written. 2: usage error (no such file, no line in it, --no-ticket outside a branch).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isMain } from './is-main.mjs';

// The ticket's lines, in order: blank lines dropped, a heading or bullet mark taken off, the words untouched.
export function ticketLines(text) {
  return String(text).split(/\r?\n/)
    .map(l => l.trim().replace(/^#{1,6}\s+/, '').replace(/^[-*•]\s+/, '').trim())
    .filter(Boolean);
}

export function renderLines(lines, { noTicket = false, date = new Date() } = {}) {
  const day = date.toISOString().slice(0, 10);
  const head = noTicket ? `# Lines (no ticket: the user's own words, ${day})` : `# Lines (the ticket, verbatim, ${day})`;
  return [head, '', ...lines.map((l, i) => `T${i + 1}. ${l}`), ''].join('\n');
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// Marks the current branch of `repo` as a task without a ticket; returns the branch name.
export function markNoTicket(repo) {
  let branch = '';
  try { branch = git(repo, ['symbolic-ref', '--short', '-q', 'HEAD']); } catch { /* detached */ }
  if (!branch) throw new Error(`--no-ticket needs a branch checked out in ${repo} (HEAD is detached)`);
  git(repo, ['config', `branch.${branch}.sanadNoTicket`, 'true']);
  return branch;
}

function main(argv) {
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const from = opt('--from'), out = opt('--out'), noTicket = argv.includes('--no-ticket'), repo = opt('--repo');
  if (!from || !out) throw new Error('give --from <ticket text file> and --out <notes>/lines.md');
  if (noTicket && !repo) throw new Error('--no-ticket needs --repo <path> (the branch is marked there)');
  if (!fs.existsSync(from)) throw new Error('no such file: ' + from);
  const text = fs.readFileSync(from, 'utf8');
  const lines = ticketLines(text);
  if (!lines.length) throw new Error(`${from} has no line of text`);
  const dir = path.dirname(path.resolve(out));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.resolve(out), renderLines(lines, { noTicket }));
  const ticket = path.join(dir, 'ticket.md');
  if (path.resolve(from) !== path.resolve(ticket)) fs.writeFileSync(ticket, text);
  const branch = noTicket ? markNoTicket(path.resolve(repo)) : '';
  process.stdout.write(`LINES: ${lines.length} line(s) T1..T${lines.length} — ${path.resolve(out)}; ticket text in ${ticket}\n`);
  if (branch) process.stdout.write(`NO TICKET: branch ${branch} — the commit check asks for no ticket ID\n`);
}

if (isMain(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write('LINES: ' + error.message + '\nUsage: node lines.mjs --from <ticket text file> --out <notes>/lines.md [--no-ticket --repo <path>]\n');
    process.exitCode = 2;
  }
}
