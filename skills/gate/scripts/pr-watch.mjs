#!/usr/bin/env node
// pr-watch.mjs — after the user pushes, watch the pull request's checks and bring back the failure.
//
// 2026-11-17: twice this week a pull request was merged with its CI red or still running, and the
// failure was found only when the next machine's install failed. The author cannot push; the user does.
// After the push the author runs this in the background: it waits for the checks and, on a red one,
// prints the failing log lines at once, so the fix goes through the loop before anyone installs.
//
// Usage: node pr-watch.mjs [--repo <path>] [--pr <number>] [--timeout-min <n, default 30>] [--interval-sec <n, default 30>]
//   --repo defaults to the current folder; --pr defaults to the pull request of its branch.
//   GitHub is asked through the GitHub CLI (`gh`), run in --repo. Tests name a script in SANAD_GH: it is
//   run with Node in place of gh, with the same arguments.
// The last line and the exit code:
//   0  PR CHECKS: PASS — <k> check(s) on <head commit, 10 characters> · <url>
//   1  PR CHECKS: FAIL — <failed check names> · <url>          (the failing log lines are above it)
//   2  PR CHECKS: could not ask GitHub — <gh's own first error line>; also a usage error
//   3  PR CHECKS: NO PR — push the branch and open the PR first
//      PR CHECKS: NONE — no check reported; a draft pull request may skip CI: mark it ready
//      PR CHECKS: NOT YOUR COMMIT — the PR head <x> is not your commit <y>: push first (no --pr: head vs git HEAD)
//      PR CHECKS: DRAFT — a draft with no CI run started (WIP only), or with skipped CI: mark it ready
//   4  PR CHECKS: PENDING after <n> min — <names>
// A merged or closed pull request is still watched (its checks still run), and the line then ends with
// "(the PR is already MERGED)": that is exactly the case that hurt.
//
// Three things GitHub does that "ask until nothing is pending" alone gets wrong:
//  - right after a push no check is listed for some seconds: "none" is believed on the third look only;
//  - a job that waits for another job is listed only when it starts: a green list is looked at once more
//    before PASS, so a check that appears late is not missed;
//  - one call that fails (the network) is not the end of a 30-minute watch: the third in a row is.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isMain } from './is-main.mjs';

export const EXIT = { pass: 0, fail: 1, error: 2, none: 3, pending: 4 };
export const MAX_PROBLEM_LINES = 40;
export const TAIL_LINES = 15;
const MAX_LINE = 300;       // one minified line must not fill the screen
const EMPTY_LOOKS = 3;      // looks with no check before "none" is believed
const FAILED_ASKS = 3;      // failed calls in a row before the watch gives up
const MAX_TIMEOUT_MIN = 24 * 60;
const MAX_INTERVAL_SEC = 60 * 60;
const USAGE = 'Usage: node pr-watch.mjs [--repo <path>] [--pr <number>] [--timeout-min <n, default 30>] [--interval-sec <n, default 30>]';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// Colour codes (and terminal titles) a CI log carries.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
export const stripAnsi = (text) => String(text).replace(ANSI, '');

// gh's own first error line (it often prints a hint under it).
export function firstLine(text) {
  return String(text || '').split(/\r?\n/).map((l) => stripAnsi(l).trim()).find(Boolean) || '';
}

// One gh call, run in the repository. Never throws: { ok, out, err }.
export function gh(repo, args, timeoutMs = 60000) {
  const fake = process.env.SANAD_GH;
  const [file, argv] = fake ? [process.execPath, [path.resolve(fake), ...args]] : ['gh', args];
  const r = spawnSync(file, argv, {
    cwd: repo, encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
    // No question on a terminal, no "new version" notice, no colours: only the answer.
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' },
  });
  if (r.error && r.error.code === 'ENOENT') return { ok: false, out: '', err: 'the GitHub CLI (gh) was not found on PATH: install it, then "gh auth login"' };
  if (r.error && r.error.code === 'ETIMEDOUT') return { ok: false, out: r.stdout || '', err: `gh ${args.slice(0, 2).join(' ')} did not answer in ${Math.round(timeoutMs / 1000)} s` };
  // A log over the buffer limit still gives its first part: the caller reads what came.
  return { ok: !r.error && r.status === 0, out: r.stdout || '', err: r.stderr || (r.error ? r.error.message : '') };
}

// gh's words for "this branch has no pull request" and "no pull request has this number".
const NO_PR = /no pull requests found|could not resolve to a pullrequest/i;

// { pr } | { missing: true } | { error }
export function readPr(repo, number) {
  const r = gh(repo, ['pr', 'view', ...(number ? [String(number)] : []), '--json', 'number,state,isDraft,headRefOid,url']);
  if (!r.ok) return NO_PR.test(r.err) ? { missing: true } : { error: firstLine(r.err) || 'gh pr view failed with no message' };
  try {
    const pr = JSON.parse(r.out);
    if (pr && Number.isInteger(pr.number)) return { pr };
  } catch { /* not JSON: said below */ }
  return { error: 'gh pr view did not answer with the pull request' };
}

// { checks } | { error }. gh ends with an error, not an empty list, when no check is reported:
// "no checks reported on the '<branch>' branch".
const NO_CHECKS = /no checks reported/i;
export function readChecks(repo, number) {
  const r = gh(repo, ['pr', 'checks', String(number), '--json', 'name,state,bucket,link']);
  // The list counts, not the exit code: plain `gh pr checks` ends with 1 on a red check and 8 on a pending one.
  try {
    const list = JSON.parse(r.out);
    if (Array.isArray(list)) return { checks: list };
  } catch { /* not JSON: an error, or no check yet */ }
  if (NO_CHECKS.test(r.err)) return { checks: [] };
  return { error: firstLine(r.err) || 'gh pr checks did not answer with a list' };
}

// gh sorts every check into a bucket (gh pr checks --help): pass, fail, pending, skipping, cancel.
// A cancelled check proved nothing, so it is red here. A bucket this script does not know stays pending:
// it can never turn into a pass.
export function bucketOf(check) {
  const bucket = String((check && check.bucket) || '').toLowerCase();
  if (bucket === 'pass') return 'pass';
  if (bucket === 'fail' || bucket === 'cancel') return 'fail';
  if (bucket === 'skipping') return 'skip';
  return 'pending';
}

export function tally(checks) {
  const t = { pass: [], fail: [], skip: [], pending: [] };
  for (const check of checks) t[bucketOf(check)].push(check);
  return t;
}

// "unit, e2e (cancelled)": a red check that is not a plain failure says what it is.
function label(check) {
  const state = String(check.state || '').toUpperCase();
  const plain = !state || state === 'FAILURE' || bucketOf(check) !== 'fail';
  return plain ? String(check.name) : `${check.name} (${state.toLowerCase().replace(/_/g, ' ')})`;
}
const names = (list) => [...new Set(list.map(label))].join(', ');

export function progress(t) {
  if (!t.pass.length && !t.fail.length && !t.skip.length && !t.pending.length) return '  waiting: no check reported yet';
  const parts = [`${t.pending.length} pending`, `${t.pass.length} passed`];
  if (t.fail.length) parts.push(`${t.fail.length} failed`);
  if (t.skip.length) parts.push(`${t.skip.length} skipped`);
  return '  waiting: ' + parts.join(', ');
}

// `gh run view --log-failed` starts every line with "job<TAB>step<TAB>timestamp ": noise for a reader.
const COLUMNS = /^(?:[^\t]*\t[^\t]*\t)?\uFEFF?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;
export function cleanLine(line) {
  const text = stripAnsi(line).replace(COLUMNS, '').trimEnd();
  return text.length > MAX_LINE ? text.slice(0, MAX_LINE) + ' …' : text;
}

// A line that names a problem: error, Error:, AssertionError, ##[error], FAIL, Failed, "not ok" (TAP) and
// ✖ (node:test). A line that reports a PASSING test is never one, whatever the name of the test says.
const PROBLEM = /error|\bfail|\bnot ok\b|✖/i;
// dotnet test prints "Passed <Name>" for every passing test at --verbosity normal.
const PASSING = /^\s*(?:[✓✔√]|ok\b|PASS\b|Passed\b)/;
// The lines that name the real failure. Over the limit these are picked before a plain error/fail match
// (a log may hold hundreds of "... failed, retrying" warnings).
const STRONG = /^\s*Failed\b|\[FAIL\]|##\[error\]|Error Message:|\berror [A-Z]{1,4}\d{2,5}\b|\bnot ok\b|✖/;

// The lines worth reading from one failed run's log: at most 40 that name a problem (strong ones first),
// plus its last 15, each once, in the log's order. `more` counts the problem lines left out.
export function failingLines(log) {
  const lines = String(log || '').split(/\r?\n/).map(cleanLine).filter((l) => l.trim());
  const tailStart = Math.max(0, lines.length - TAIL_LINES);
  const tail = new Set(lines.slice(tailStart));
  const candidates = [];
  const seen = new Set();
  for (let i = 0; i < tailStart; i++) {
    const line = lines[i];
    if (seen.has(line) || !PROBLEM.test(line) || PASSING.test(line)) continue;
    seen.add(line);
    candidates.push(line);
  }
  const strong = candidates.filter((l) => STRONG.test(l));
  const plain = candidates.filter((l) => !STRONG.test(l));
  const chosen = new Set([...strong, ...plain].slice(0, MAX_PROBLEM_LINES));
  const shown = new Set(), picked = [];
  lines.forEach((line, i) => {
    if (shown.has(line)) return;
    if (i >= tailStart || chosen.has(line)) { shown.add(line); picked.push(line); }
  });
  return { lines: picked, more: candidates.filter((l) => !chosen.has(l) && !tail.has(l)).length };
}

const RUN = /\/actions\/runs\/(\d+)/;

// Print the failing lines of every failed check. Two failed jobs of one run share one log: asked once.
function showFailures(repo, failed, out) {
  const runs = new Map();
  for (const check of failed) {
    const id = (String(check.link || '').match(RUN) || [])[1];
    if (id) runs.set(id, [...(runs.get(id) || []), label(check)]);
    else out(`--- ${label(check)}: not a GitHub Actions run, no log to read here — ${check.link || 'the check has no link'}`);
  }
  for (const [id, checks] of runs) {
    out(`--- ${[...new Set(checks)].join(', ')}: failing lines (gh run view ${id} --log-failed)`);
    const r = gh(repo, ['run', 'view', id, '--log-failed'], 180000);
    const { lines, more } = failingLines(r.out);
    if (!lines.length) { out(`  no log came back: ${firstLine(r.err) || 'the run has no failed step'}`); continue; }
    // Two spaces in front: a log line can never be read as this script's own "PR CHECKS:" line.
    for (const line of lines) out('  ' + line);
    if (more) out(`  … ${more} more problem line(s) not shown`);
  }
}

// The commit checked out in the folder, or '' when it is not a git folder (then nothing is compared).
function localHead(repo) {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  const sha = (r.stdout || '').trim();
  return !r.error && r.status === 0 && /^[0-9a-f]{40,64}$/i.test(sha) ? sha : '';
}

const already = (pr) => (pr.state && pr.state !== 'OPEN' ? ` (the PR is already ${pr.state})` : '');
const head = (pr) => String(pr.headRefOid || '').slice(0, 10) || 'an unknown commit';

// Log lines, check names and gh's errors are other people's text. Nothing in them may start a new line:
// a line of a CI log could otherwise show up as "PR CHECKS: PASS". Tabs stay, every other control
// character becomes a space.
export const oneLine = (text) => String(text).replace(/[\u0000-\u0008\u000a-\u001f\u007f\u2028\u2029]+/g, ' ');

// Watch one pull request to its result. Prints one line at a time through `print`; returns the exit code.
export async function watch({ repo, pr, timeoutMin, intervalSec }, print = (line) => process.stdout.write(line + '\n')) {
  const out = (line) => print(oneLine(line));
  const first = readPr(repo, pr);
  if (first.missing) { out('PR CHECKS: NO PR — push the branch and open the PR first'); return EXIT.none; }
  if (first.error) { out('PR CHECKS: could not ask GitHub — ' + first.error); return EXIT.error; }
  let info = first.pr;

  // Without --pr the pull request is the branch's own: if its head is not this folder's commit, the push
  // did not land, and GitHub's green checks belong to an older commit.
  if (!pr) {
    const mine = localHead(repo);
    const theirs = String(info.headRefOid || '');
    if (mine && theirs && mine !== theirs) {
      out(`PR CHECKS: NOT YOUR COMMIT — the PR head ${theirs.slice(0, 10)} is not your commit ${mine.slice(0, 10)}: push first · ${info.url}`);
      return EXIT.none;
    }
  }

  const intervalMs = intervalSec * 1000;
  const deadline = Date.now() + timeoutMin * 60000;
  // 2026-11-17 (audit finding 1): every verdict belongs to the commit that is the PR head at the end.
  // When the head moved while watching, what was seen belongs to the old commit: it is forgotten and the
  // new head is watched from the start while time remains.
  let moved = null;   // { was, now } once the head changed while watching
  for (;;) {
  let t = tally([]), result = '', said = '', greenList = null, emptyLooks = 0, failedAsks = 0, lastError = '';
  let early = false, stallList = '', stalls = 0, unwaited = [];
  while (!result) {
    const r = readChecks(repo, info.number);
    if (r.error) {
      lastError = r.error;
      if (++failedAsks >= FAILED_ASKS) { out('PR CHECKS: could not ask GitHub — ' + r.error); return EXIT.error; }
      out(`  GitHub did not answer (${r.error}): asking again`);
    } else {
      failedAsks = 0;
      t = tally(r.checks);
      const settled = !t.pending.length;
      const green = settled && !t.fail.length && t.pass.length > 0;
      const empty = settled && !t.fail.length && !t.pass.length;   // nothing listed, or skipped ones only
      const list = r.checks.map((c) => `${c.name}=${bucketOf(c)}`).sort().join('|');
      emptyLooks = empty ? emptyLooks + 1 : 0;
      // On a draft, a check with no Actions run (the WIP app) stays pending: it is not waited for.
      unwaited = info.isDraft ? t.pending.filter((c) => !RUN.test(String((c && c.link) || ''))) : [];
      const onlyUnwaited = unwaited.length > 0 && unwaited.length === t.pending.length;
      stalls = onlyUnwaited && !t.fail.length && list === stallList ? stalls + 1 : onlyUnwaited && !t.fail.length ? 1 : 0;
      stallList = onlyUnwaited ? list : '';
      if ((settled || onlyUnwaited) && t.fail.length) { result = 'fail'; early = !settled; }
      else if (stalls >= EMPTY_LOOKS) result = 'draft';
      else if (green && greenList === list) result = 'pass';
      else if (empty && emptyLooks >= EMPTY_LOOKS) result = 'none';
      greenList = green ? list : null;
      if (!result) {
        const line = green ? `  all ${t.pass.length} passed: one more look, a check may start late` : progress(t);
        if (line !== said) out(line);
        said = line;
      }
    }
    if (result) break;
    // A green list always gets its second look, even past the time limit: it costs one interval.
    const wait = greenList ? intervalMs : Math.min(intervalMs, deadline - Date.now());
    if (wait <= 0) break;
    await sleep(wait);
  }

  if (!result) {
    // Out of time. An answer that never came is not "none".
    if (failedAsks && !t.fail.length && !t.pending.length) { out('PR CHECKS: could not ask GitHub — ' + lastError); return EXIT.error; }
    result = t.fail.length ? 'fail' : t.pending.length ? 'pending' : 'none';
    // 2026-11-17: "none" after a head change is only two looks at the new commit: the time cut them short.
    if (result === 'none' && moved) {
      out(`PR CHECKS: PENDING — the PR head changed from ${moved.was} to ${moved.now} while watching, and the time is out: run the watch again${already(info)}`);
      return EXIT.pending;
    }
  }

  // The pull request may have been merged, or pushed to, while its checks ran: say what it is now.
  // A final read that fails is asked again (like every call); when all fail it is an error, never a PASS.
  let again = readPr(repo, info.number);
  for (let n = 1; !again.pr && n < FAILED_ASKS; n++) {
    await sleep(intervalMs);
    again = readPr(repo, info.number);
  }
  if (!again.pr) {
    out('PR CHECKS: could not ask GitHub — ' + (again.error || 'the pull request could not be read again'));
    return EXIT.error;
  }
  if (String(again.pr.headRefOid || '') !== String(info.headRefOid || '')) {
    const was = head(info), now = head(again.pr);
    info = again.pr;
    moved = { was, now };
    // Without --pr the new head must still be this folder's commit, as at the start.
    if (!pr) {
      const mine = localHead(repo);
      const theirs = String(info.headRefOid || '');
      if (mine && theirs && mine !== theirs) {
        out(`PR CHECKS: NOT YOUR COMMIT — the PR head ${theirs.slice(0, 10)} is not your commit ${mine.slice(0, 10)}: push first · ${info.url}`);
        return EXIT.none;
      }
    }
    if (deadline - Date.now() > 0) {
      out(`  the PR head changed from ${was} to ${now}: watching the new commit`);
      continue;
    }
    out(`PR CHECKS: PENDING — the PR head changed from ${was} to ${now} while watching, and the time is out: run the watch again${already(info)}`);
    return EXIT.pending;
  }
  info = again.pr;

  if (result === 'draft') {
    out(`PR CHECKS: DRAFT — ${names(unwaited)} ${unwaited.length === 1 ? 'is' : 'are'} pending and no CI run started; this pull request is a DRAFT: mark it ready${already(info)}`);
    return EXIT.none;
  }
  // A draft with skipped CI and an outside check that passed: nothing proved the code.
  if (result === 'pass' && info.isDraft && t.skip.length) {
    out(`PR CHECKS: DRAFT — ${t.skip.length} skipped, ${t.pass.length} passed: mark it ready${already(info)}`);
    return EXIT.none;
  }
  if (result === 'pass') {
    const skipped = t.skip.length ? ` (${t.skip.length} skipped)` : '';
    out(`PR CHECKS: PASS — ${t.pass.length} check(s) on ${head(info)} · ${info.url}${skipped}${already(info)}`);
    return EXIT.pass;
  }
  if (result === 'fail') {
    showFailures(repo, t.fail, out);
    const pending = !t.pending.length ? '' : early ? ` (not waited for: ${names(t.pending)})` : ` (still pending after ${timeoutMin} min: ${names(t.pending)})`;
    out(`PR CHECKS: FAIL — ${names(t.fail)}${pending} · ${info.url}${already(info)}`);
    return EXIT.fail;
  }
  if (result === 'pending') {
    out(`PR CHECKS: PENDING after ${timeoutMin} min — ${names(t.pending)}${already(info)}`);
    return EXIT.pending;
  }
  const what = t.skip.length ? `no check ran (${t.skip.length} skipped)` : 'no check reported';
  // "Mark it ready" is advice for an open pull request only.
  const hint = already(info) ? ''
    : info.isDraft ? '; this pull request is a DRAFT and a draft may skip CI: mark it ready'
      : '; a draft pull request may skip CI: mark it ready';
  out(`PR CHECKS: NONE — ${what}${hint}${already(info)}`);
  return EXIT.none;
  }
}

export function parseArgs(argv) {
  const o = { repo: '.', pr: null, timeoutMin: 30, intervalSec: 30 };
  const number = (key, value, max) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0 || n > max) throw new Error(`${key} needs a number above 0, at most ${max}`);
    return n;
  };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!['--repo', '--pr', '--timeout-min', '--interval-sec'].includes(key) || value === undefined || value === '') throw new Error('Unknown or empty option: ' + key);
    if (key === '--repo') o.repo = value;
    else if (key === '--pr') {
      if (!/^[1-9]\d*$/.test(value)) throw new Error('--pr needs the pull request number');
      o.pr = Number(value);
    } else if (key === '--timeout-min') o.timeoutMin = number(key, value, MAX_TIMEOUT_MIN);
    else o.intervalSec = number(key, value, MAX_INTERVAL_SEC);
  }
  o.repo = path.resolve(o.repo);
  if (!fs.existsSync(o.repo) || !fs.statSync(o.repo).isDirectory()) throw new Error('--repo is not a folder: ' + o.repo);
  return o;
}

if (isMain(import.meta.url)) {
  let options = null;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write('PR CHECKS: ' + error.message + '\n' + USAGE + '\n');
    process.exitCode = EXIT.error;
  }
  if (options) {
    // A crash must never look like a red check (exit 1): it is "could not ask".
    try { process.exitCode = await watch(options); }
    catch (error) {
      process.stdout.write(oneLine('PR CHECKS: could not ask GitHub — ' + (error && error.message ? error.message : String(error))) + '\n');
      process.exitCode = EXIT.error;
    }
  }
}
