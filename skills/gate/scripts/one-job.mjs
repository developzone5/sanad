#!/usr/bin/env node
// one-job.mjs — one job per PR (user rule 2026-11-15: "small prs all the time and each prs one thing";
// "some pr can not be 400 and its one job").
//
// A change over about 400 logic lines or 30 code files stops here once: the author asks the user "Split
// it, or keep it as one job?". Tests, texts, styles and generated files do not count (size-check.mjs
// counts the rest). A keep is saved on the branch with the user's exact words, and the PR text then needs
// a `One job:` line (check-pr-body.mjs). It is a question, never a size: the risk size does not change.
//
// Usage: node one-job.mjs [--repo <path>] [--base <ref>]                         check the change
//        node one-job.mjs [--repo <path>] --keep "<the user's exact words>"      save a keep for this branch
//   --base defaults to origin/<sanad.integration | staging>.
// Exit 0: under the line, or kept. 1: over the line and not kept yet. 2: usage error.
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isMain } from './is-main.mjs';
import { sizeTask } from './size-check.mjs';

export const MAX_LINES = 400;
export const MAX_FILES = 30;
const KEY = 'sanadOneJob';

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function gitOr(repo, args) {
  try { return git(repo, args); } catch { return ''; }
}

// The user's saved words for this branch, or '' (also outside a repository or on a detached head).
export function keptWords(repo) {
  const branch = gitOr(repo, ['branch', '--show-current']);
  return branch ? gitOr(repo, ['config', '--get', `branch.${branch}.${KEY}`]) : '';
}

export function keep(repo, words) {
  const said = String(words || '').trim();
  if (said.length < 8) throw new Error('--keep needs the user\'s own words (8 characters or more)');
  const branch = gitOr(repo, ['branch', '--show-current']);
  if (!branch) throw new Error('not on a branch: a keep is saved per branch');
  git(repo, ['config', `branch.${branch}.${KEY}`, said]);
  return branch;
}

export function verdict({ lines, codeFiles }, kept) {
  const measure = `${lines} logic lines in ${codeFiles} code files`;
  if (lines <= MAX_LINES && codeFiles <= MAX_FILES) return { code: 0, text: `ONE JOB: ${measure}` };
  if (kept) return { code: 0, text: `ONE JOB: ${measure}, kept as one job — the user: "${kept}". The PR text needs a "One job:" line.` };
  return {
    code: 1,
    text: `ONE JOB: ${measure}, over about ${MAX_LINES} lines or ${MAX_FILES} files. Ask the user: "Split it, or keep it as one job?" ` +
      `Keep → node one-job.mjs --keep "<the user's exact words>"; split → show the PR plan.`,
  };
}

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (!['--repo', '--base', '--keep'].includes(k) || argv[i + 1] === undefined) throw new Error('Unknown or empty option: ' + k);
    o[k.slice(2)] = argv[i + 1];
  }
  if (o.keep !== undefined && o.base) throw new Error('--keep and --base do not go together');
  return o;
}

function main(argv) {
  const o = args(argv);
  const repo = path.resolve(git(path.resolve(o.repo || '.'), ['rev-parse', '--show-toplevel']));
  if (o.keep !== undefined) {
    const branch = keep(repo, o.keep);
    process.stdout.write(`ONE JOB: kept as one job on ${branch} — the user: "${o.keep.trim()}"\n`);
    return 0;
  }
  const base = o.base || 'origin/' + (gitOr(repo, ['config', '--get', 'sanad.integration']) || 'staging');
  const r = verdict(sizeTask({ repo, base }), keptWords(repo));
  process.stdout.write(r.text + '\n');
  return r.code;
}

if (isMain(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write('ONE JOB: ' + error.message + '\nUsage: node one-job.mjs [--repo <path>] [--base <ref>] | [--repo <path>] --keep "<the user\'s exact words>"\n');
    process.exitCode = 2;
  }
}
