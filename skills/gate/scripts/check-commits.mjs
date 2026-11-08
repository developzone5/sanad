#!/usr/bin/env node
// check-commits.mjs — the branch is one task in one clean commit (team rule 2026-11-08: "Keep each PR
// to one task and one commit. Write a clean Conventional Commit message with the ticket ID, e.g.
// fix(homework): clear filter on second click (TUW-225)").
//
// Checks the commits on HEAD since it left <base>:
//   - exactly one commit (none yet passes, with a note: the check runs again before the push)
//   - its subject is a Conventional Commit: type(scope): text, at most 72 characters
//   - the subject ends with exactly one ticket ID in brackets, e.g. (TUW-225): one task per PR
// A repository without tickets turns the ID part off: git config sanad.ticketRequired false.
//
// Usage: node check-commits.mjs [--repo <path>] [--base <ref>]
// Exit 0: all clear. 1: a rule is broken (each printed). 2: usage error.
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TYPES = 'feat|fix|perf|refactor|test|docs|chore|build|ci|style|revert';
const SUBJECT = new RegExp(`^(?:${TYPES})(?:\\([a-z0-9._/-]+\\))?!?: \\S.*$`);
const TICKET = /[A-Z][A-Z0-9]+-\d+/g;

// The problems with one commit subject.
export function subjectProblems(subject, { ticketRequired = true } = {}) {
  const problems = [];
  if (!SUBJECT.test(subject)) problems.push(`not a Conventional Commit subject ("type(scope): text", type one of ${TYPES.replace(/\|/g, ', ')}): ${subject}`);
  if (subject.length > 72) problems.push(`the subject has ${subject.length} characters; at most 72`);
  if (ticketRequired) {
    const ids = subject.match(TICKET) || [];
    if (!/ \([A-Z][A-Z0-9]+-\d+\)$/.test(subject)) problems.push(`the subject does not end with the ticket ID in brackets, e.g. "fix(homework): clear filter on second click (TUW-225)": ${subject}`);
    else if (ids.length > 1) problems.push(`the subject names ${ids.length} tickets (${ids.join(', ')}): one task per PR`);
  }
  return problems;
}

function git(cwd, args) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const top = git(path.resolve(opt('--repo') || process.cwd()), ['rev-parse', '--show-toplevel']);
  if (!top) { console.error('check-commits: not inside a git repository'); process.exit(2); }
  const base = opt('--base') || 'origin/' + (git(top, ['config', '--get', 'sanad.integration']) || 'staging');
  const from = git(top, ['merge-base', base, 'HEAD']);
  if (!from) { console.error('check-commits: no merge base with ' + base); process.exit(2); }
  const commits = (git(top, ['rev-list', '--reverse', `${from}..HEAD`]) || '').split(/\r?\n/).filter(Boolean);
  const ticketRequired = git(top, ['config', '--get', 'sanad.ticketRequired']) !== 'false';
  const problems = [];
  if (commits.length > 1) problems.push(`${commits.length} commits since ${base}: squash them into one before the push (one task, one commit per PR)`);
  for (const c of commits) for (const p of subjectProblems(git(top, ['log', '-1', '--format=%s', c]) || '', { ticketRequired })) problems.push(`${c.slice(0, 10)}: ${p}`);
  for (const p of problems) console.log('COMMIT: ' + p);
  console.log(problems.length ? `COMMITS: ${problems.length} problem(s)` : commits.length ? 'COMMITS: one clean commit' : 'COMMITS: no commit yet (checked again before the push)');
  process.exitCode = problems.length ? 1 : 0;
}
