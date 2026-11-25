#!/usr/bin/env node
// pre-review.mjs — every check before review, at the same time, on the repository you are in, with
// one summary.
//
// 2026-11-06: five checks ran one after another (3.5 minutes on a one-line fix), and the project's
// mechanical check read another folder and called the wrong code clean. This runs them in parallel,
// always on the git top level of --repo (default: the current folder):
//   lint        ESLint on the changed script files of each package that has it
//   types       tsc --noEmit on each package with a changed .ts/.tsx file: once per project the root
//               tsconfig.json references (tsconfig.app.json and tsconfig.node.json, as `tsc -b` does),
//               else tsconfig.app.json or tsconfig.json
//               Both run here when the package's node_modules is here. A task's own folder (a new git
//               worktree) has none: they then run in the clone on the test machine (git config
//               sanad.remoteHost, sanad.remoteRepo), after a sync of this folder's exact code, and with
//               no test machine they show as NOT RUN and fail the run. Never left out silently.
//   format      `dotnet csharpier check` on the changed .cs, .csproj, .props and .targets files, from the
//               folder whose tool manifest (.config/dotnet-tools.json) lists CSharpier: the project's own
//               version, CI's command
//   ticket      check-ticket-lines.mjs, when --lines is given
//   asserts     check-test-asserts.mjs: new test lines — a range where the exact value is known, a "nothing
//               happens" check no break run proved, and (with --check) a check line with no [Cn] test
//   commits     check-commits.mjs: one commit, a Conventional subject that ends with the ticket ID
//   size        size-check.mjs on the real change (--was <size> fails when it grew)
//   one job     one-job.mjs: over about 400 logic lines or 30 code files, it fails until the user answers
//               "split it, or keep it as one job?" (a keep is saved with their words; user rule 2026-11-15)
//   places     places.mjs: the list of every place that uses what the change touches (--places), searched
//               again first, then every place needs `C<n>` or `none: <reason>` (with --check, n is one of
//               its lines). With no --places: skipped for a text-only change (size tiny), else NOT RUN, a
//               failure (2026-11-12: the rule "list every place by search" was text and was skipped)
//               2026-11-18 (audit): a changed function that has callers (the size check's "callers:" row) must also be
//               in the list's `Names:`, or the places check fails with `OPEN: <name> — changed, not on the places
//               list`; with --lines and --check the siblings check also fails when those lines are not the ones
//               the siblings were recorded for.
//   siblings    siblings.mjs --check (--siblings): every sibling another agent named before code (a place with
//               the same rule or defect that the places list missed) needs `P<n>` (with --places, a place on
//               that list) or `none: <reason>`. It starts after the places check, which rewrites the list. With
//               no --siblings: skipped for a text-only change, else NOT RUN, a failure (2026-11-14: three
//               sibling fields of a focus fix were found only at the final review, a full fix round)
//   mechanical  the project's own script, when `git config sanad.mechanical <path>` is set
// A part left out because its option is missing (--lines, --check, --was) is printed as skipped.
// A .NET change is built and tested by the test step, not here.
//
// Usage: node pre-review.mjs [--repo <path>] [--base <ref>] [--was <size>] [--notes <dir>] [--lines <file>] [--check <file>] [--places <file>] [--siblings <file>] [--node <path>] [--part lists|code] [--before-proof] [--no-cache]
//   --before-proof (2026-11-13): run right before red-proof.mjs. Everything runs except the proof part of
//   the test asserts check. A label, quote or commit fixed now does not void a proof; run it again after the
//   proof (Step 3.5), where every part runs.
//   --base defaults to origin/<sanad.integration | staging>; --node (or `git config sanad.node`)
//   is the Node that runs the package tools.
//   A check that passed on the exact same code, base and notes files is not run again (pre-review-cache.mjs,
//   2026-11-16: pre-review runs twice per fix round, and repeating lint and types on the test machine took half
//   of a small task's working time); it shows as `(same code: passed at <time>)`. --no-cache runs every check.
// 2026-11-19 (speed batch):
//   - Each check's line is printed when that check ends (two instant failures used to show only after the slowest
//     check, 96 s later); the summary line comes last. The places line waits for the size check, because the
//     changed functions with callers can still change it.
//   - A pass is kept by the tree, not by the commit (pre-review-cache.mjs): committing a checked tree runs only
//     the commits check again.
//   - --part lists|code runs one half only. lists: ticket lines, check lines, places, siblings (and the size
//     check, whose answer the places check needs). code: lint, types, format. A second run that finds the same
//     check running on the same code waits for it and reads its answer, so `--part code` can run in the
//     background right after the commit and the full run never starts a second lint or type check.
//   - The changed files come from change-set.mjs. A FOREIGN? answer (another session's folder sits untracked in
//     the repository) is one failed check, printed before any other check starts.
//   - --notes <dir> fills --lines, --check, --places and --siblings from the notes folder's own file names
//     (notes-dir.mjs). One of those options given with another file than the notes folder's is a usage error.
//   - A changed function with callers that is not on the places list is added to the list (writePlaces), so its
//     places show as open; the caller rows come from size-check --json (allCallers: every row, not the capped ones).
// Exit 0: every check passed. 1: a check failed. 2: usage error.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { isMain } from './is-main.mjs';
import { fileKind, format as formatSize, sizeTask } from './size-check.mjs';
import { bashEnv, gitBash } from './git-bash.mjs';
import { checkKey, claim, lookup, release, remember, runIdentity, runningNow, rememberBeforeProof, workTree, notesInputs, notesParts, inputsOf, BEFORE_PROOF_FILES } from './pre-review-cache.mjs';
import { changeSet, foreignLine } from './change-set.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = /\.(?:[cm]?[jt]sx?)$/i;

function git(cwd, args) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

// 2026-11-19: both lists come from the one change set (change-set.mjs), so every tool counts the same files.
// `set`: a change set already read for this run.
export function changedFiles(repo, base, set = changeSet(repo, base)) {
  const gone = new Set(set.deleted);
  return set.files.filter(f => !gone.has(f) && fs.existsSync(path.join(repo, f)));
}

// 2026-11-18 (audit): every changed path, deleted ones included, for the text-only rule: a deleted test or code
// file is a change that is not text.
export function allChangedPaths(repo, base, set = changeSet(repo, base)) {
  return [...set.files];
}

// The build-info file of one type check: one per package folder and config, outside the repo. The gate's own type
// check names the same file, so it also reads only what changed.
const tscInfoName = (where, config) => 'sanad-tsc-' + crypto.createHash('sha1').update(String(where).toLowerCase() + config).digest('hex').slice(0, 12) + '.tsbuildinfo';
export function tscInfoFile(pkg, config) {
  return path.join(os.tmpdir(), tscInfoName(pkg, config));
}

// --part: one half of the checks. lists also holds the size check: the places check needs its answer.
const LISTS = /^(?:ticket lines|check lines|places|siblings)$/;
const CODE = /^(?:lint|types|format) /;
export const PARTS = ['lists', 'code'];
const inPart = (part, name) => (part === 'lists' ? LISTS.test(name) || name === 'size' : CODE.test(name));

// 2026-11-18 (audit): a locale script (.ts/.js) is text only while its changed lines (strings and comments
// taken out) hold no code: no function, arrow, import, call or control word.
const CODE_WORDS = /\b(?:function|import|return|if|else|for|while|switch|throw|new|class|await|async|const|let|var)\b|=>|\w\s*\(/;
function localeHoldsCode(repo, base, file) {
  if (!SCRIPT.test(file)) return false;
  const from = git(repo, ['merge-base', base, 'HEAD']);
  let text = git(repo, ['diff', '-U0', from, '--', file]).split(/\r?\n/).filter(l => /^[+-](?![+-]{2} )/.test(l)).map(l => l.slice(1)).join('\n');
  if (!text) { try { text = fs.readFileSync(path.join(repo, file), 'utf8'); } catch { text = ''; } }
  const bare = text.replace(/`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, '""').replace(/\/\/.*$/gm, '');
  return CODE_WORDS.test(bare);
}

// The nearest folder above a file that holds a package.json, up to the repo root.
function packageOf(repo, file) {
  for (let dir = path.dirname(path.join(repo, file)); dir.length >= repo.length; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    if (dir === repo) break;
  }
  return null;
}

// The nearest folder above a file whose .config/dotnet-tools.json lists CSharpier, up to the repo root.
function csharpierRootOf(repo, file) {
  for (let dir = path.dirname(path.join(repo, file)); dir.length >= repo.length; dir = path.dirname(dir)) {
    try {
      const manifest = path.join(dir, '.config', 'dotnet-tools.json');
      if (fs.existsSync(manifest) && /csharpier/i.test(fs.readFileSync(manifest, 'utf8'))) return dir;
    } catch { /* unreadable manifest: keep looking up */ }
    if (dir === repo) break;
  }
  return null;
}

// A tsconfig file is JSON with comments and trailing commas: both are dropped (outside strings) before
// JSON.parse. null when the file is missing or still not JSON.
export function readJsonc(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); } catch { return null; }
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1); i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else if (c === ',' && /^\s*(?:\/\/[^\n]*\s*|\/\*[\s\S]*?\*\/\s*)*[}\]]/.test(text.slice(i + 1))) {
      // a trailing comma: dropped
    } else out += c;
  }
  try { return JSON.parse(out); } catch { return null; }
}

// 2026-11-12 (audit C15): types ran only tsconfig.app.json, so vite.config.ts and vitest.config.ts (in
// tsconfig.node.json) were never type checked here, while `tsc -b` in the build checks both. Each project
// the root tsconfig.json references is its own check; a package with no references keeps the one config.
export function tsProjects(pkg) {
  const root = readJsonc(path.join(pkg, 'tsconfig.json'));
  const refs = root && Array.isArray(root.references) ? root.references.map(r => (r && typeof r.path === 'string' ? r.path : '')).filter(Boolean) : [];
  if (refs.length) {
    return refs.map(ref => {
      const config = ref.replace(/\\/g, '/').replace(/^\.\//, '');
      const label = /\.json$/i.test(config) ? path.posix.basename(config).replace(/^tsconfig\.?/i, '').replace(/\.json$/i, '') : '';
      return { config, label: label || config };
    });
  }
  const config = ['tsconfig.app.json', 'tsconfig.json'].find(c => fs.existsSync(path.join(pkg, c)));
  return config ? [{ config, label: '' }] : [];
}

// Does the package's own package.json list this tool? Then its check is owed, installed here or not.
function lists(pkg, tool) {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8'));
    return Boolean((json.devDependencies && json.devDependencies[tool]) || (json.dependencies && json.dependencies[tool]));
  } catch { return false; }
}

// The test machine and this repository's clone there (git config sanad.remoteHost, sanad.remoteRepo,
// sanad.remoteNode), or null when one of the two is not set.
export function remoteOf(repo) {
  const host = git(repo, ['config', '--get', 'sanad.remoteHost']);
  const there = git(repo, ['config', '--get', 'sanad.remoteRepo']).replace(/\\/g, '/').replace(/\/$/, '');
  return host && there ? { host, repo: there, node: git(repo, ['config', '--get', 'sanad.remoteNode']) || 'node' } : null;
}

// One command in a folder of the clone on the test machine, as the line its shell runs.
function remoteLine(remote, rel, words) {
  const windows = /^[A-Za-z]:\//.test(remote.repo);
  const dir = remote.repo + (rel && rel !== '.' ? '/' + rel : '');
  const q = (a) => (/[\s"&|<>^()]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a);
  // 2026-11-25 (owner, test 4): the pinned Node's folder goes first on the path too, so a program the check starts
  // (npx, npm, a child node) finds the pinned Node, not the machine's own. A folder with a sign the shell reads is left off.
  const nodeDir = /[\\/]/.test(remote.node || '') ? path.posix.dirname(String(remote.node).replace(/\\/g, '/')) : '';
  const first = !nodeDir || /["'%&|<>^`$!;\r\n]/.test(nodeDir) ? '' : windows ? `set "PATH=${nodeDir.replace(/\//g, '\\')};%PATH%" && ` : `PATH='${nodeDir}':"$PATH"; `;
  return windows ? `${first}cd /d ${q(dir.replace(/\//g, '\\'))} && ${words.map(q).join(' ')}` : `${first}cd '${dir}' && ${words.map(q).join(' ')}`;
}
const sshArgs = (remote, line) => ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30', remote.host, line];

// `remote`: the test machine (remoteOf); undefined reads it from git config, null means none.
// `part`: 'lists' or 'code' (--part). `set`: the change set of this run, when it is already read. `breaks`: the
// break list of the notes folder, `proofs`: each test folder's proof command [{ name, cmd, cwd }] (from --notes; `proof`
// and `proofCwd`: one command and its folder, as before).
export function planChecks({ repo, base, was, lines, check, places, siblings, node, remote, beforeProof, part, set, breaks, proof, proofCwd, proofs }) {
  if (!set) set = changeSet(repo, base);
  const files = changedFiles(repo, base, set);
  const checks = [];
  if (remote === undefined) remote = remoteOf(repo);
  const byPackage = new Map();
  for (const f of files.filter(f => SCRIPT.test(f))) {
    const pkg = packageOf(repo, f);
    if (!pkg) continue;
    if (!byPackage.has(pkg)) byPackage.set(pkg, []);
    byPackage.get(pkg).push(path.relative(pkg, path.join(repo, f)).replace(/\\/g, '/'));
  }
  for (const [pkg, list] of byPackage) {
    const name = path.relative(repo, pkg).replace(/\\/g, '/') || '.';
    const count = `${list.length} file${list.length === 1 ? '' : 's'}`;
    // 2026-11-11 (TUW-242, TUW-243): a task's own folder (a new git worktree) has no node_modules, so lint
    // and types were left out without a word, and the summary still read "6 of 6 checks passed". A check
    // the package lists is owed: it runs here, or in the clone on the test machine, or shows as NOT RUN.
    const owed = (kind, detail, words) => {
      const extra = [detail, remote ? `on ${remote.host}` : ''].filter(Boolean).join(', ');
      const label = `${kind} ${name}${extra ? ` (${extra})` : ''}`;
      if (remote) checks.push({ name: label, cmd: 'ssh', args: sshArgs(remote, remoteLine(remote, name, [remote.node, ...words])), cwd: repo, remote: true });
      else checks.push({ name: label, notRun: `no node_modules in ${name}, and no test machine is set (git config sanad.remoteHost and sanad.remoteRepo): run \`npm ci\` in ${name}, then pre-review again.` });
    };
    // Warnings do not fail this check (2026-11-12): 14 of the project's 757 script files carry old warnings, and
    // a task that edits one of them would go red for lines it did not write.
    const eslint = path.join(pkg, 'node_modules', 'eslint', 'bin', 'eslint.js');
    if (fs.existsSync(eslint)) checks.push({ name: `lint ${name} (${count})`, cmd: node, args: [eslint, ...list], cwd: pkg });
    else if (lists(pkg, 'eslint')) owed('lint', count, ['node_modules/eslint/bin/eslint.js', ...list]);
    const tsc = path.join(pkg, 'node_modules', 'typescript', 'bin', 'tsc');
    if (list.some(f => /\.tsx?$/i.test(f))) {
      for (const { config, label } of tsProjects(pkg)) {
        // Incremental, with its build info outside the repo: a repeat run reads only what changed.
        const infoName = tscInfoName(remote && !fs.existsSync(tsc) ? remote.repo + '/' + name : pkg, config);
        // `serial`: two type checks of one project write one build-info file, so they never run at the same
        // time, also when their code differs (a background `--part code`, then an edit and the full run).
        if (fs.existsSync(tsc)) checks.push({ name: `types ${name}${label ? ` (${label})` : ''}`, cmd: node, args: [tsc, '-p', config, '--noEmit', '--incremental', '--tsBuildInfoFile', tscInfoFile(pkg, config)], cwd: pkg, serial: 'one-' + infoName });
        else if (lists(pkg, 'typescript')) { owed('types', label, ['node_modules/typescript/bin/tsc', '-p', config, '--noEmit', '--incremental', '--tsBuildInfoFile', (remote && /^[A-Za-z]:\//.test(remote.repo) ? '%TEMP%\\' : '/tmp/') + infoName]); if (remote) checks.at(-1).serial = 'one-' + infoName; }
      }
    }
  }
  // 2026-11-10 (PR #767): CI's format check failed on two C# files that came in an earlier commit. The commit
  // guard checks only the files staged right then, and the user's own push runs no hook. Every changed .cs
  // file is checked here, with the same command CI runs. 2026-11-12 (audit C15): CSharpier 1.x also formats
  // .csproj, .props and .targets files, and CI runs it on the whole folder: changed ones are checked too.
  const byTool = new Map();
  for (const f of files.filter(f => /\.(?:cs|csproj|props|targets)$/i.test(f))) {
    const dir = csharpierRootOf(repo, f);
    if (!dir) continue;
    if (!byTool.has(dir)) byTool.set(dir, []);
    byTool.get(dir).push(path.relative(dir, path.join(repo, f)).replace(/\\/g, '/'));
  }
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  for (const [dir, list] of byTool) {
    const name = path.relative(repo, dir).replace(/\\/g, '/') || '.';
    const cs = list.filter(f => /\.cs$/i.test(f)).length;
    const what = [cs ? plural(cs, 'C# file') : '', list.length - cs ? plural(list.length - cs, 'project file') : ''].filter(Boolean).join(', ');
    checks.push({ name: `format ${name} (${what})`, cmd: 'dotnet', args: ['csharpier', 'check', ...list], cwd: dir });
  }
  // 2026-11-18 (audit finding 6): a genuine text-only change (every file is a doc or locale text: no test, no style, no
  // code) is asked for no new test (loop.md, Text only): the ticket-lines and tag checks are left out, named as skipped.
  const everyPath = allChangedPaths(repo, base, set);
  const textOnly = everyPath.length > 0 && everyPath.every(f => ['doc', 'locale'].includes(fileKind(f)) && !(fileKind(f) === 'locale' && localeHoldsCode(repo, base, f)));
  if (lines && !textOnly) checks.push({ name: 'ticket lines', cmd: process.execPath, args: [path.join(here, 'check-ticket-lines.mjs'), '--lines', lines, '--repo', repo, '--base', base], cwd: repo });
  // 2026-11-16: the Check lines' sources were read only by review-brief, after the proof; a line in the wrong shape
  // passed both pre-review runs. Checked here, in the first run.
  if (lines && check) checks.push({ name: 'check lines', cmd: process.execPath, args: [path.join(here, 'review-brief.mjs'), '--coverage', '--lines', lines, '--check', check], cwd: repo, show: true });
  // 2026-11-19 (owner yes): the tests-only light path. With `git config sanad.testsOnlyLane true`, a change size-check
  // calls tests only skips the new-test evidence part (one line says why). Switch off: the check runs as before.
  const lightLane = testsOnlyLane(repo, base);
  checks.push({ name: 'test asserts', cmd: process.execPath, args: [path.join(here, 'check-test-asserts.mjs'), '--repo', repo, '--base', base, ...(check && !textOnly ? ['--check', check] : []), ...(beforeProof ? ['--before-proof'] : []), ...(lightLane ? ['--tests-only-lane'] : [])], cwd: repo, show: true });
  checks.push({ name: 'commits', cmd: process.execPath, args: [path.join(here, 'check-commits.mjs'), '--repo', repo, '--base', base], cwd: repo });
  // 2026-11-19: asked as data (--json). The text shown is made from it (sizeView), and every caller row is kept
  // for the places check: the printed rows are capped.
  checks.push({ name: 'size', cmd: process.execPath, args: [path.join(here, 'size-check.mjs'), '--repo', repo, '--base', base, ...(was ? ['--was', was] : []), '--json'], cwd: repo, show: true });
  checks.push({ name: 'one job', cmd: process.execPath, args: [path.join(here, 'one-job.mjs'), '--repo', repo, '--base', base], cwd: repo, show: true });
  // 2026-11-12: the list is searched again in this folder before the check, so a place that appeared after
  // it was written (a new caller, a sibling path) shows as open and cannot be missed.
  if (places) checks.push({ name: 'places', cmd: process.execPath, args: [path.join(here, 'places.mjs'), '--refresh', places, '--repo', repo, '--check', places, ...(check ? ['--check-lines', check] : [])], cwd: repo, show: true });
  // 2026-11-14: a P<n> outcome is looked up in the places list, which the places check rewrites as it refreshes
  // it: this check starts when that one has ended (`after`), never while the list is half written.
  // 2026-11-19 (owner decision 8): the second look is tied to the ticket lines only, so one added check line no
  // longer asks for it again; the siblings check gets the ticket lines alone.
  if (siblings) checks.push({ name: 'siblings', cmd: process.execPath, args: [path.join(here, 'siblings.mjs'), '--check', siblings, ...(places ? ['--places', places] : []), ...(lines ? ['--lines', lines] : [])], cwd: repo, show: true, after: 'places' });
  const mechanical = git(repo, ['config', '--get', 'sanad.mechanical']);
  if (mechanical) checks.push({ name: 'mechanical', cmd: process.execPath, args: [mechanical, '--repo', repo, '--base', base], cwd: repo, show: true });
  // 2026-11-19: a break list with a mistake was found only by the proof, after the test machine was in use. With
  // --before-proof and the notes folder's break list, the proof's own checks before any run are one check here
  // (red-proof.mjs --check-plan: local, no test machine, no copy).
  // One check per test folder of the task (re-check 3, 2026-11-23: with two, only the first was checked, and the
  // pass counted for both). Every side's proof runs the same break list, so each side checks it with its own command.
  const sides = (Array.isArray(proofs) && proofs.length ? proofs : [{ cmd: proof, cwd: proofCwd }]).filter((s) => s && Array.isArray(s.cmd) && s.cmd.length);
  const planKnown = sides.length > 0;
  if (beforeProof && breaks) for (const s of sides) checks.push({ name: sides.length > 1 ? `break plan (${s.name || s.cwd || 'tests'})` : 'break plan', cmd: process.execPath, args: [path.join(here, 'red-proof.mjs'), '--repo', repo, '--breaks', breaks, '--base', base, ...(s.cwd ? ['--cwd', s.cwd] : []), '--check-plan', '--', ...s.cmd], cwd: repo });
  // 2026-11-23 (owner): with a break list and no test command the check was only named as skipped, and run 3 of the small
  // task went to its proofs with the plan unchecked. It is a failed check now: name the command, and it runs.
  if (beforeProof && breaks && !planKnown) checks.push({ name: 'break plan', notRun: 'the notes folder names no test command (task.json), so the break plan cannot be checked before the proof: start the task with it — node <gate>/sanad.mjs start --repo <repo> --notes <notes> --side <name> [--cwd <dir>] -- <test command> — then run pre-review again.' });
  // 2026-11-12 (audit C14): with no --lines, --check or --was those parts were left out without a word, and
  // the summary still read "N of N checks passed". Each is named as skipped (not a failure).
  const skipped = [
    lines ? (textOnly ? { name: 'ticket lines', why: 'a text-only change' } : null) : { name: 'ticket lines', why: 'no --lines' },
    check ? (textOnly ? { name: 'test labels', why: 'a text-only change' } : null) : { name: 'test labels', why: 'no --check' },
    was ? null : { name: 'size growth', why: 'no --was' },
  ].filter(Boolean);
  if (part) {
    const lists = part === 'lists';
    return { files, checks: checks.filter(c => inPart(part, c.name)), remote, skipped: lists ? skipped.filter(s => s.name !== 'test labels') : [], placesOwed: lists && !places, siblingsOwed: lists && !siblings };
  }
  return { files, checks, remote, skipped, placesOwed: !places, siblingsOwed: !siblings };
}

// With no --places, the size check's answer decides (preReview): a text-only change (size tiny) skips the
// list; any other change owes it, and the run fails with the command that makes it (2026-11-12).
export function placesWithout(sizeOut, repo) {
  if (/^SIZE: tiny\b/m.test(String(sizeOut || ''))) return { skipped: { name: 'places', why: 'a text-only change' } };
  const cmd = `node ${path.join(here, 'places.mjs')} --repo ${repo} --names <names> --out <notes>/places.md`.replace(/\\/g, '/');
  return { result: { name: 'places', notRun: true, code: 1, ms: 0, out: `list every place that uses what you change: ${cmd}` } };
}

// The same rule for the sibling check (2026-11-14): a text-only change skips it; any other change owes it, and
// the run fails with the steps that make it.
export function siblingsWithout(sizeOut, repo) {
  if (/^SIZE: tiny\b/m.test(String(sizeOut || ''))) return { skipped: { name: 'siblings', why: 'a text-only change' } };
  const cmd = `node ${path.join(here, 'siblings.mjs')} --brief --notes <notes> --repo ${repo}`.replace(/\\/g, '/');
  return { result: { name: 'siblings', notRun: true, code: 1, ms: 0, out: `look for the places the list misses, before code: ${cmd}; launch the line it prints, then --record <report> --notes <notes>, and give pre-review --siblings <notes>/siblings.md` } };
}

// 2026-11-18 (audit): the places list passed ("PLACES: 3 place(s), 0 open") while the size check of the same run printed
// "callers: ensureDue ×1 …; lateness ×3 …": a changed function with callers that was on no list, because nothing
// compared the functions the change touches with the names the list searched. The size check's caller rows are the
// changed functions that have callers (a row with ×0 is not named); each name that is not in the list's `Names:` is
// returned. `more`: how many changed functions the size check did not print (its rows are capped), which this
// cannot compare.
// 2026-11-18 (repair round): (1) a member of an object ("assignmentsApi.publishNow ×3", the project's API file shape)
// did not match the row and was skipped without a word: a dotted name is read, and it is searched when the list holds
// the full name or its last part; an entry that cannot be read is returned in `unreadable`, and fails the check.
// (2) a handler declared inside a function and called only inside that same function (a form's own handleSubmit)
// is not shared: it owes no name. That needs `opts.repo` and `opts.changed` (the changed files) to read the code;
// without them every changed function with callers is owed, as before.
const NAME = '[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*';
// One line as code only: strings emptied, comments removed (a short local copy: this script runs alone, with no
// other script of the folder, in the lock-start test).
const codeOnly = (line) => String(line).replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""').replace(/\/\*.*?\*\//g, ' ').replace(/\/\/.*$/, '');
export function unsearchedCallers(sizeOut, listed, opts = {}) {
  const row = /^\s*callers: (.*)$/m.exec(String(sizeOut || ''));
  const names = [], unreadable = [], seen = new Set(listed || []);
  let more = 0;
  for (const raw of row ? row[1].split('; ') : []) {
    const entry = raw.trim();
    const m = new RegExp(`^(?:[^\\s:;]+:)?(${NAME}) ×(\\?|\\d+)`).exec(entry);
    if (m) {
      const last = m[1].slice(m[1].lastIndexOf('.') + 1);
      if (m[2] !== '0' && !seen.has(m[1]) && !seen.has(last) && !localHandler(m, entry, opts)) { seen.add(m[1]); names.push(m[1]); }
      continue;
    }
    const k = /^\(\+(\d+) more /.exec(entry);
    if (k) more = Number(k[1]);
    else if (entry) unreadable.push(entry);
  }
  return { names, more, unreadable };
}

// A changed function that is declared inside another function and called only inside it: every caller is listed
// ("×n" with n files:lines), all in one file, and that file declares the name once, within one function's braces
// that hold every caller line. Anything else (a caller outside, a name declared twice, an object member, a file that
// cannot be read, a capped list) is shared.
function localHandler(m, entry, { repo, changed } = {}) {
  if (!repo || !changed || !/^\d+$/.test(m[2]) || m[1].includes('.')) return false;
  const where = /\[([^\]]*)\]\s*$/.exec(entry);
  if (!where) return false;
  const spots = where[1].split(',').map(s => /^(.+):(\d+)$/.exec(s.trim()));
  if (spots.some(s => !s) || spots.length !== Number(m[2])) return false;
  const files = [...new Set(spots.map(s => s[1]))];
  if (files.length !== 1 || !/\.[cm]?[jt]sx?$/i.test(files[0])) return false;
  const found = files[0].includes('/') ? changed.filter(f => f === files[0]) : changed.filter(f => path.basename(f) === files[0]);
  if (found.length !== 1) return false;
  let lines;
  try { lines = fs.readFileSync(path.join(repo, found[0]), 'utf8').split(/\r?\n/); } catch { return false; }
  const decl = new RegExp(`(?:\\bfunction\\s+|\\b(?:const|let|var)\\s+)${m[1].replace(/\$/g, '\\$')}\\b`);
  const at = lines.map((l, i) => (decl.test(codeOnly(l)) ? i : -1)).filter(i => i >= 0);
  if (at.length !== 1) return false;
  // The unmatched `{` above the declaration, and the line where it closes.
  let need = 0, open = -1;
  for (let k = at[0] - 1; k >= 0 && open < 0; k--) {
    const code = codeOnly(lines[k]);
    for (let c = code.length - 1; c >= 0; c--) {
      if (code[c] === '}') need++;
      else if (code[c] === '{') { if (need) need--; else { open = k; break; } }
    }
  }
  if (open < 0 || !/(?:=>|\))\s*(?::\s*[\w<>\[\]|. ]+)?\s*\{?\s*$/.test(codeOnly(lines[open]).replace(/\{\s*$/, '').trimEnd())) return false;
  let depth = 0, end = -1;
  for (let k = open; k < lines.length && end < 0; k++) {
    for (const ch of codeOnly(lines[k])) { if (ch === '{') depth++; else if (ch === '}' && --depth === 0) { end = k; break; } }
  }
  return end >= 0 && spots.every(s => Number(s[2]) - 1 > open && Number(s[2]) - 1 <= end);
}

// Same folder as checkLockDir() in evidence.mjs: a lock per source-bound check that runs right now.
export function otherTaskOnRemote(repo, remote) {
  const dir = process.env.SANAD_CHECK_LOCK_DIR || path.join(os.homedir(), '.claude', 'state', 'check-locks');
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  // 2026-11-14: an id handed to a later process kept a stale lock "alive" here, and the sync (with lint and
  // types on the test machine) was skipped. The lock counts only while the process that wrote it holds the id
  // (hooks/lib/process-start.cjs, as in check-lock-guard.js), asked last, for a lock that would count. No
  // helper: the id check alone, as before.
  const sameProcess = (lock) => { try { return createRequire(import.meta.url)('../../../hooks/lib/process-start.cjs').sameProcess(lock); } catch { return true; } };
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => n.endsWith('.json')); } catch { return ''; }
  for (const n of names) {
    try {
      const lock = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (!(Date.parse(lock.expiresAt) > Date.now()) || same(String(lock.toplevel || ''), repo)) continue;
      try { process.kill(lock.pid, 0); } catch (e) { if (e.code !== 'EPERM') continue; }
      if (new RegExp(`(?:^|[\\s@])${remote.host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`).test(String(lock.command || '')) && sameProcess(lock)) return String(lock.toplevel);
    } catch { /* a lock being written: not a running check yet */ }
  }
  return '';
}

// Puts this folder's exact code on the test machine (scripts/remote/remote-sync.sh), unless another task's
// check runs there now: the clone is one folder, and a sync would change the code under that check.
function syncRemote(repo, remote) {
  const other = otherTaskOnRemote(repo, remote);
  if (other) return { ok: false, text: `another task's check runs on ${remote.host} now (${other}), and a sync would change the code under it. Run pre-review again when it ends.` };
  // 2026-11-19: not a blocking call any more. The checks that run here start and print while the sync runs;
  // only the checks on the test machine wait for it.
  return new Promise(resolve => {
    const done = (out) => {
      const synced = /^SYNCED \S+ \S+ tree (\S+)/m.exec(out);
      const via = /^VIA (\S+)/m.exec(out);
      resolve(synced ? { ok: true, tree: synced[1], via: via ? via[1] : '' } : { ok: false, text: (out.split(/\r?\n/).find(l => l.trim()) || 'the sync printed nothing').trim() });
    };
    let out = '', child;
    try { child = spawn(gitBash().exe, [path.join(os.homedir(), '.claude', 'scripts', 'remote', 'remote-sync.sh')], { cwd: repo, env: bashEnv(), windowsHide: true, timeout: 10 * 60 * 1000, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { done(String(e.message)); return; }
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('error', e => done(out || String(e.message)));
    child.on('close', () => done(out));
  });
}

function runOne(check) {
  return new Promise(resolve => {
    const started = Date.now();
    let out = '';
    let child;
    // A check that could not run is a failed check with its reason, never a missing line.
    if (check.notRun) { resolve({ ...check, code: 1, out: check.notRun, ms: 0 }); return; }
    try { child = spawn(check.cmd, check.args, { cwd: check.cwd, windowsHide: true, shell: false, ...(check.remote ? { timeout: 10 * 60 * 1000 } : {}) }); }
    catch (e) { resolve({ ...check, code: -1, out: String(e.message), ms: 0 }); return; }
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('error', e => resolve({ ...check, code: -1, out: out + String(e.message), ms: Date.now() - started }));
    child.on('close', code => resolve({ ...check, code, out, ms: Date.now() - started }));
  });
}

// 2026-11-12 (audit C14): a failing check showed only its last 12 lines, so a ✗ or GAP line above them was
// lost. Every line that names a problem is shown, plus the last 12 lines, each once, in their own order.
const PROBLEM = /^(?:✗|GAP|BUG|UNTAGGED|UNPROVEN|NOT PROVEN|NO EVIDENCE|NOT RUN|OPEN)/;
export function failureLines(text) {
  const keep = new Set(text.flatMap((l, i) => (PROBLEM.test(l.trim()) ? [i] : [])));
  for (let i = Math.max(0, text.length - 12); i < text.length; i++) keep.add(i);
  return [...keep].sort((a, b) => a - b).map(i => text[i]);
}

// The checks that can be slow or run on the test machine: lint, the type check and the formatter (2026-11-25). Every
// other check is cheap and runs first.
export const isHeavyCheck = (c) => Boolean(c && (c.remote || /^(?:lint|types|format)\b/.test(String(c.name))));

// One `FIX <check>:` line per failed check, with the command that fixes it (2026-11-25, owner: "one run names every
// failure, each with the exact command that fixes it"). A check that did not run because one above failed gets none.
export function fixLines(results, { repo = '<repo>', base = '<base>', notes = '<notes>' } = {}) {
  const gate = here.replace(/\\/g, '/'), n = (f) => `${String(notes || '<notes>').replace(/\\/g, '/')}/${f}`;
  const q = (s) => (/[\s"'$`]/.test(String(s)) ? `"${String(s)}"` : String(s));
  const out = [];
  for (const r of results || []) {
    if (!r || r.code === 0 || /^not run: a check above failed/.test(String(r.out || ''))) continue;
    const text = String(r.out || '') + ' ' + String(r.notRun || '');
    const name = String(r.name);
    let fix;
    if (name === 'commits') fix = `make one commit: git reset --soft $(git merge-base ${q(base)} HEAD) && git commit -m "<type(scope): what>"`;
    else if (name === 'places') fix = /not on the places list/.test(text)
      ? `add the changed code's places: node ${q(gate + '/places.mjs')} --refresh ${q(n('places.md'))} --repo ${q(repo)} --add-changed --base ${q(base)}; then open and close each OPEN place: node ${q(gate + '/places.mjs')} --close ${q(n('places.md'))} --set "P<n>=C<k>" (or "P<n>=none: <why>")`
      : `open each OPEN place above, then close it: node ${q(gate + '/places.mjs')} --close ${q(n('places.md'))} --set "P<n>=C<k>" (or "P<n>=none: <why>")`;
    else if (name === 'siblings') fix = `give each S and J line its outcome in ${q(n('siblings.md'))}: → P<n>, → none: <reason>, → reuse or → not: <why>`;
    else if (name === 'ticket lines') fix = 'each T line named above needs a test that quotes it, in its name or a comment above it';
    else if (name === 'check lines') fix = `add a check line for each T line named above to ${q(n('check.md'))}`;
    else if (name === 'test labels') fix = 'tag each test named above with its check line, [Cn], in its title';
    else if (name === 'test asserts') fix = /NOT PROVEN TEST|no evidence/.test(text)
      ? 'a new or changed test has no proof yet: run the proof first (sanad.mjs next prints it), then this check again'
      : 'fix each test named above';
    else if (name === 'break plan') fix = /no test command/.test(text)
      ? `name the test command: node ${q(gate + '/sanad.mjs')} start --repo ${q(repo)} --notes ${q(notes)} --side <name> [--cwd <dir>] -- <test command>`
      : `make each break named above again on the code as it is now: node ${q(gate + '/breaks.mjs')} add --breaks ${q(n('breaks.json'))} --repo ${q(repo)} --file <f> --line <n> --put-file <file> --must-fail <words of a test title>`;
    else if (name === 'size') fix = 'add what the larger size needs (SIZE GREW), or bring the owner\'s words';
    else if (name === 'one job') fix = `ask the owner: split it, or keep it as one job (node ${q(gate + '/one-job.mjs')} --keep "<their words>")`;
    else fix = 'fix what the lines above name';
    out.push(`FIX ${name}: ${fix}`);
  }
  return out;
}

// Every check at once, results in plan order. A check with `after` starts when the named check (planned before
// it) has ended (2026-11-14: siblings reads the list the places check rewrites). `run`: tests only.
export function runChecks(checks, run = runOne) {
  const running = new Map();
  return Promise.all(checks.map(c => {
    const first = c.after && checks.find(o => o.name === c.after && running.has(o));
    const p = first ? running.get(first).then(() => run(c)) : run(c);
    running.set(c, p);
    return p;
  }));
}

// One result as its printed lines: the ✓ or ✗ line, then what it shows.
function resultLines(r) {
  const when = r.cached ? new Date(r.cached.at).toTimeString().slice(0, 5) : '';
  const lines = [`  ${r.code === 0 ? '✓' : '✗'} ${r.name}${r.notRun ? ' — NOT RUN' : r.cached ? ` (same code: passed at ${when})` : ` (${(r.ms / 1000).toFixed(1)} s)`}`];
  const text = String(r.out || '').replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).filter(l => l.trim());
  if (r.code !== 0) lines.push(...failureLines(text).map(l => '      ' + l));
  // The project check's GAP and NOTE lines are leads for the review: shown also when it passes (2026-11-12).
  else if (r.show) lines.push(...text.filter(l => /^(?:SIZE|SIZE GREW|MECHANICAL|GAP|NOTE|PLACES|WIDE|SIBLINGS|  callers|  roles|EVIDENCE SKIPPED|NOT PROVEN TEST|NO EVIDENCE|  → the missing-run-evidence)/.test(l)).map(l => '      ' + l.trim()));
  return lines;
}

// True when the lane switch `sanad.testsOnlyLane` is on and size-check says the change is tests only.
// The size is only asked when the switch is on. A failed size answer means false: the full check runs.
export function testsOnlyLane(repo, base) {
  if (git(repo, ['config', '--get', 'sanad.testsOnlyLane']).toLowerCase() !== 'true') return false;
  try { return sizeTask({ repo, base }).testsOnly === true; } catch { return false; }
}

// 2026-11-19: the size check answers as data (--json). The text shown is made here, as size-check prints it, and
// `callersText` holds the row of every changed function (allCallers), not only the printed, capped rows. An
// answer that is not that data (an error text, a fake check in a test) is kept as it is.
function sizeView(r, was) {
  let j = null;
  try { j = JSON.parse(String(r.out || '').trim()); } catch { return r; }
  if (!j || typeof j !== 'object' || !j.size || !j.signals || !Array.isArray(j.callers)) return r;
  try {
    const all = Array.isArray(j.allCallers) ? j.allCallers : null;
    return { ...r, out: formatSize(j, was), callersText: formatSize({ ...j, callers: all || j.callers, moreSymbols: all ? 0 : j.moreSymbols }, ''), json: j };
  } catch { return r; }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// opts.sync: tests only (in place of the real sync to the test machine). opts.noCache: run every check.
// opts.print: called with each check's lines when that check ends, then with the summary (the command line passes
// it; without it nothing is printed). The text given back keeps its shape: the summary, then the plan's order.
export async function preReview(opts) {
  const say = typeof opts.print === 'function' ? opts.print : () => {};
  const label = (opts.beforeProof ? 'PRE-REVIEW (before the proof)' : 'PRE-REVIEW') + (opts.part ? ` (part: ${opts.part})` : '');
  // 2026-11-19: another session's folder sat untracked in the repository, and one check read its 1,498 files for
  // 852 s. That is one failed check now, before any other check starts.
  const began = Date.now();
  const set = changeSet(opts.repo, opts.base);
  if (set.foreign.length) {
    const block = resultLines({ name: 'changed files', code: 1, out: foreignLine(set), ms: Date.now() - began });
    const summary = `${label}: 0 of 1 checks passed · ${opts.repo}`;
    say(block.join('\n')); say(summary);
    return { ok: false, text: [summary, ...block].join('\n') };
  }
  // The list files as they are before the checks are chosen (re-check 3: a break list that appeared after the plan was
  // made, but before this read, got a pass with no break plan check). The same for the code (its tree).
  const startInputs = opts.beforeProof && !opts.part && opts.notes ? notesInputs(BEFORE_PROOF_FILES.filter((n) => n !== 'places.md').map((n) => path.join(opts.notes, n))) : '';
  const firstTree = opts.beforeProof && !opts.part && opts.notes ? workTree(opts.repo) : '';
  const firstHead = firstTree ? git(opts.repo, ['rev-parse', 'HEAD']) : '';
  // The base as a commit, read before the checks (last check, 2026-11-23: a base that moved during the run was saved).
  const baseAt = () => (opts.base ? git(opts.repo, ['rev-parse', '--verify', '--quiet', String(opts.base) + '^{commit}']) : '');
  const firstBase = firstTree ? baseAt() : '';
  const { files, checks, remote, skipped, placesOwed, siblingsOwed } = planChecks({ ...opts, set });
  // Checks that passed on this exact code before are read, not run (pre-review-cache.mjs).
  const ident = opts.noCache ? null : runIdentity(opts.repo, opts.base);
  const startTree = ident ? ident.tree : (opts.beforeProof && !opts.part ? workTree(opts.repo) : '');
  for (const c of checks) {
    c.key = checkKey(c, ident);
    const hit = lookup(c.key);
    if (hit) c.cached = hit;
  }
  // The sync to the test machine runs once, when the first check that needs it starts.
  let synced = '', syncing = null;
  const syncOnce = () => {
    if (!syncing) {
      syncing = Promise.resolve().then(() => (opts.sync || syncRemote)(opts.repo, remote)).then(sync => {
        if (sync.ok) { synced = `  (no node_modules here: lint and types run on ${remote.host}, on this folder's code${sync.tree ? ', tree ' + String(sync.tree).slice(0, 12) : ''})`; say(synced); }
        return sync;
      });
    }
    return syncing;
  };
  const exec = opts.run || runOne;
  // A check with `serial` waits for its turn: one at a time per name, across runs (at most 10 minutes, then it
  // runs: a waiting check is never a lost check).
  const inTurn = async (c, work) => {
    if (!c.serial || c.notRun) return work();
    for (let tries = 0; tries < 2400 && !claim(c.serial); tries++) await sleep(250);
    try { return await work(); } finally { release(c.serial); }
  };
  const fresh = async (c) => {
    if (c.remote) {
      const sync = await syncOnce();
      if (!sync.ok) c.notRun = `not run on ${remote.host}: ${sync.text}`;
      else if (sync.via) c.args = ['-o', 'HostName=' + sync.via, ...c.args];
    }
    return inTurn(c, () => exec(c));
  };
  // One check: read when it is kept, else run, and kept at once when it passed. A check that another run has on
  // this very code right now is not started a second time: this run waits for it and reads its answer. When that
  // run ended with no kept pass (it failed, or it was stopped), this run runs the check itself.
  const one = async (c) => {
    if (c.cached) return { ...c, code: 0, out: c.cached.out, ms: 0 };
    if (!c.key || c.notRun) return fresh(c);
    for (let tries = 0; ; tries++) {
      if (tries > 2 || claim(c.key)) {
        try {
          // Another run may have finished between our lookup and our lock: read again before starting.
          const late = lookup(c.key);
          if (late) return { ...c, cached: late, code: 0, out: late.out, ms: 0 };
          const r = await fresh(c); remember([r]); return r;
        }
        finally { release(c.key); }
      }
      while (runningNow(c.key)) await sleep(250);
      const hit = lookup(c.key);
      if (hit) return { ...c, cached: hit, code: 0, out: hit.out, ms: 0 };
      await sleep(50);
    }
  };
  // 2026-11-18 (audit): every changed function that has callers is searched on the list, or the places check fails.
  // 2026-11-19: the names that are missing are added to the list here (writePlaces), so their places show as open;
  // the author no longer adds each by hand. The places check then runs once more on the new list, and fails.
  const withCallers = async (listed, size, check) => {
    if (!opts.places || !size || listed.notRun) return listed;
    let names = [];
    try { const m = /^Names: (.*)$/m.exec(fs.readFileSync(opts.places, 'utf8')); names = m ? m[1].split(',').map(s => s.trim()).filter(Boolean) : []; } catch { /* the places check says so */ }
    const { names: missing, more, unreadable } = names.length ? unsearchedCallers(size.callersText || size.out, names, { repo: opts.repo, changed: files }) : { names: [], more: 0, unreadable: [] };
    if (missing.length) {
      // All at once; when the list refuses one name (too wide, or no hit), each alone, so the others still join.
      let added = [];
      try {
        const { writePlaces } = await import('./places.mjs');
        try { writePlaces({ repo: opts.repo, names: missing, out: opts.places }); added = [...missing]; }
        catch {
          for (const n of missing) { try { writePlaces({ repo: opts.repo, names: [n], out: opts.places }); added.push(n); } catch { /* named below, for the author */ } }
        }
      } catch { /* the list tool cannot be loaded: every name is named below */ }
      if (added.length) {
        const again = await exec(check);
        listed = { ...again, ms: (listed.ms || 0) + (again.ms || 0) };
      }
      listed.code = 1;
      listed.out = String(listed.out || '') + '\n' + missing.map(n => `OPEN: ${n} — changed, not on the places list: it has callers; ${added.includes(n) ? 'it is added to the list now, close each of its places' : `search it with places.mjs --names ${n} and close each place`}`).join('\n');
    }
    // 2026-11-18 (repair round): a callers entry that cannot be read is no pass.
    if (unreadable.length) {
      listed.code = 1;
      listed.out += '\n' + unreadable.map(e => `OPEN: callers entry not readable — "${e.slice(0, 80)}": compare that changed function with the list's Names yourself, search it with places.mjs --names and close each place`).join('\n');
    }
    if (more) listed.out += `\nNOTE: ${more} more changed function(s) are not named by the size check (it prints a few rows); compare them with the list's Names yourself`;
    return listed;
  };
  // Each check's lines are printed when it ends. The places line waits for the size check: it can still change.
  const owedResults = [];
  let sizeEnded;
  const sizeDone = new Promise(resolve => { sizeEnded = resolve; });
  if (!checks.some(c => c.name === 'size')) sizeEnded(null);
  const emit = (r) => say(resultLines(r).join('\n'));
  const run = async (c) => {
    let r = null;
    try { r = await one(c); if (c.name === 'size') r = sizeView(r, opts.was); }
    finally { if (c.name === 'size') sizeEnded(r); }
    if (c.name === 'size') {
      // With no --places or --siblings the size decides: skipped for a text-only change, else NOT RUN, at once.
      for (const [owes, without] of [[placesOwed, placesWithout], [siblingsOwed, siblingsWithout]]) {
        if (!owes) continue;
        const owed = without(r.out, opts.repo);
        if (owed.skipped) skipped.push(owed.skipped); else owedResults.push(owed.result);
      }
    }
    if (c.name === 'places') r = await withCallers(r, await sizeDone, c);
    emit(r);
    if (c.name === 'size') owedResults.forEach(emit);
    return r;
  };
  // The list checks start first; the results keep the plan's order.
  // 2026-11-25 (owner, "the checks pass the first time"): the cheap checks run first (all but lint and the type check,
  // which may run on the test machine). When one of them fails the run stops there: lint and the type check are named
  // as not run, so no sync and no slow run is spent on code that must change anyway. Every cheap failure is named at
  // once, each with its fix (fixLines).
  const order = [...checks].sort((a, b) => Number(!LISTS.test(a.name)) - Number(!LISTS.test(b.name)));
  const cheap = order.filter((c) => !isHeavyCheck(c)), heavy = order.filter(isHeavyCheck);
  const firstEnded = await runChecks(cheap, run);
  const cheapFailed = firstEnded.some((r) => r && r.code !== 0);
  // A heavy check with a pass kept for this exact code is still read and shown: reading it runs nothing.
  const heavyEnded = cheapFailed
    ? await Promise.all(heavy.map(async (c) => {
      if (c.cached) return run(c);
      const r = { ...c, code: 1, out: 'not run: a check above failed — fix it first (see FIX), then run again', ms: 0 }; emit(r); return r;
    }))
    : await runChecks(heavy, run);
  const ended = order.map((c) => (cheap.includes(c) ? firstEnded[cheap.indexOf(c)] : heavyEnded[heavy.indexOf(c)]));
  const results = [...checks.map(c => ended[order.indexOf(c)]), ...owedResults];
  const skippedText = skipped.length ? ` · ${skipped.length} skipped: ${skipped.map(s => s.name).join(', ')}` : '';
  const summary = `${label}: ${results.filter(r => r.code === 0).length} of ${results.length} checks passed${skippedText} · ${files.length} changed file(s) · ${opts.repo}`;
  const lines = [summary];
  if (synced) lines.push(synced);
  for (const r of results) lines.push(...resultLines(r));
  for (const s of skipped) lines.push(`  – ${s.name}: skipped (${s.why})`);
  for (const s of skipped) say(`  – ${s.name}: skipped (${s.why})`);
  const fixes = fixLines(results, { repo: opts.repo, base: opts.base, notes: opts.notes || (opts.places ? path.dirname(opts.places) : '') });
  for (const l of fixes) { lines.push(l); say(l); }
  say(summary);
  const ok = results.every(r => r.code === 0);
  // 2026-11-23: a whole before-proof run (no --part) keeps its answer by the tree it began on; a tree that moved during
  // the run keeps no pass (pre-review-cache.mjs rememberBeforeProof).
  // Only a run with --notes keeps a pass (re-check, 2026-11-23): without it the break plan is not checked. The list files
  // must be the same at the end as at the start, but for places.md, which the places check rewrites itself.
  if (opts.beforeProof && !opts.part && opts.notes) {
    const began = ident?.tree || startTree;
    const files = BEFORE_PROOF_FILES.map((n) => path.join(opts.notes, n));
    // The pass is saved under the list files as they were at the START (re-check 2: an edit between two reads at the end
    // got the pass). places.md is read once at the end: the places check rewrites it itself.
    const parts = notesParts(files);
    const steady = inputsOf(parts.filter(([name]) => name !== 'places.md')) === startInputs;
    const sameHead = Boolean(firstHead) && firstHead === git(opts.repo, ['rev-parse', 'HEAD']);
    const sameBase = firstBase === baseAt();
    rememberBeforeProof(opts.repo, began, ok && steady && sameHead && sameBase && began === firstTree && began === workTree(opts.repo), inputsOf(parts), firstHead, firstBase);
  }
  return { ok, text: lines.join('\n') };
}

// 2026-11-19: which checks are a kept pass for the code as it is now, running nothing (for the printed status).
// { foreign, checks: [{ name, kept, at, running, keyed }] }: `kept` a pass is kept for these exact inputs (`at`:
// when it passed); `running` another run has it right now; `keyed` false for a check that is never kept or cannot
// run here. `foreign`: the FOREIGN? line, when the change set stops the checks.
export function checkStatus(opts) {
  const set = changeSet(opts.repo, opts.base);
  if (set.foreign.length) return { foreign: foreignLine(set), checks: [] };
  const { checks } = planChecks({ ...opts, set });
  const ident = runIdentity(opts.repo, opts.base);
  return {
    foreign: '',
    checks: checks.map(c => {
      const key = checkKey(c, ident);
      const hit = lookup(key);
      return { name: c.name, kept: Boolean(hit), at: hit ? hit.at : '', running: Boolean(runningNow(key)), keyed: Boolean(key) };
    }),
  };
}

function parse(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--before-proof') { o.beforeProof = true; continue; }
    if (k === '--no-cache') { o.noCache = true; continue; }
    if (!['--repo', '--base', '--was', '--lines', '--check', '--places', '--siblings', '--node', '--part', '--notes'].includes(k) || argv[i + 1] === undefined) throw new Error('Unknown or empty option: ' + k);
    o[k.slice(2)] = argv[++i];
  }
  if (o.part !== undefined && !PARTS.includes(o.part)) throw new Error('--part must be one of: ' + PARTS.join(', '));
  return o;
}

// --notes (2026-11-19): the notes folder's own files stand for --lines, --check, --places and --siblings (each one
// that is there). One of those options given with another file is a usage error, never a silent choice. With
// --before-proof the folder's break list and the task's test command give the break plan check.
async function fromNotes(o) {
  if (!o.notes) return {};
  const { paths, readTask } = await import('./notes-dir.mjs');
  const p = paths(o.notes);
  if (!fs.existsSync(p.dir)) throw new Error('--notes: no such folder: ' + p.dir);
  const norm = (f) => (process.platform === 'win32' ? path.resolve(f).toLowerCase() : path.resolve(f));
  for (const k of ['lines', 'check', 'places', 'siblings']) {
    if (o[k] === undefined) { if (fs.existsSync(p[k])) o[k] = p[k]; }
    else if (norm(o[k]) !== norm(p[k])) throw new Error(`--${k} ${o[k]} is not the notes folder's file (${p[k]}): give --notes alone, or the same file`);
  }
  if (!o.beforeProof || !fs.existsSync(p.breaks)) return {};
  let sides = [];
  try { const task = readTask(o.notes); sides = (task && task.sides || []).filter(s => s && Array.isArray(s.testCommand) && s.testCommand.length); } catch { /* a task file that cannot be read: the break plan fails as unchecked */ }
  return { breaks: p.breaks, proofs: sides.map((s) => ({ name: String(s.name || ''), cmd: s.testCommand, cwd: s.cwd || '' })) };
}

if (isMain(import.meta.url)) {
  try {
    const o = parse(process.argv.slice(2));
    const repo = git(path.resolve(o.repo || process.cwd()), ['rev-parse', '--show-toplevel']);
    if (!repo) throw new Error('not inside a git repository: ' + (o.repo || process.cwd()));
    const integration = git(repo, ['config', '--get', 'sanad.integration']) || 'staging';
    const node = o.node || git(repo, ['config', '--get', 'sanad.node']) || process.execPath;
    const notes = await fromNotes(o);
    // Each check's lines are printed when it ends; the summary comes last.
    const { ok } = await preReview({ repo: path.resolve(repo), base: o.base || 'origin/' + integration, was: o.was, lines: o.lines && path.resolve(o.lines), check: o.check && path.resolve(o.check), places: o.places && path.resolve(o.places), siblings: o.siblings && path.resolve(o.siblings), node, beforeProof: !!o.beforeProof, noCache: !!o.noCache, part: o.part, notes: o.notes ? path.resolve(o.notes) : '', ...notes, print: (text) => process.stdout.write(text + '\n') });
    process.exitCode = ok ? 0 : 1;
  } catch (error) {
    process.stderr.write('PRE-REVIEW: ' + error.message + '\nUsage: node pre-review.mjs [--repo <path>] [--base <ref>] [--was <size>] [--notes <dir>] [--lines <file>] [--check <file>] [--places <file>] [--siblings <file>] [--node <path>] [--part lists|code] [--before-proof] [--no-cache]\n');
    process.exitCode = 2;
  }
}
