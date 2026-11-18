#!/usr/bin/env node
// pr-watch.mjs — after the user pushes, watch the pull request's checks and bring back the failure.
//
// 2026-11-17: twice this week a pull request was merged with its CI red or still running, and the
// failure was found only when the next machine's install failed. The author cannot push; the user does.
// After the push the author runs this in the background: it waits for the checks and, on a red one,
// prints the failing log lines at once, so the fix goes through the loop before anyone installs.
//
// Usage: node pr-watch.mjs [--repo <path>] [--pr <number>] [--require "<name>[,<name>...]"] [--timeout-min <n, default 30>] [--interval-sec <n, default 30>]
//   --repo defaults to the current folder; --pr defaults to the pull request of its branch.
//   GitHub is asked through the GitHub CLI (`gh`), run in --repo. Tests name a script in SANAD_GH: it is
//   run with Node in place of gh, with the same arguments.
// 2026-11-18 (audit finding 1): PASS means every REQUIRED check ran and passed on the pull request head at
// the end. The required names are the UNION of: --require (may repeat, names split by commas), `git config
// --get-all sanad.requiredChecks` in --repo (each value may hold names split by commas) and GitHub's own
// list (`gh pr checks <n> --required`, asked again at every settled, not red look; "no required checks
// reported" means none). A typed name never drops one the others list. A typed value that is a listed
// check name stays one name (matrix jobs hold commas); GitHub's names are never split.
// Names match exactly after trim, without case. With no required name from any source the watcher never
// exits 0. An honest skip of a check that is not required does not block.
// The last line and the exit code:
//   0  PR CHECKS: PASS — required: <names> passed on <head commit, 10 characters> (<n> other passed, <m> skipped) · <url>
//   3  PR CHECKS: NOT PROVEN — required check "<name>" was skipped
//      PR CHECKS: NOT PROVEN — <n> passed, <m> skipped, but no required check is named: run again with --require ...
//   4  PR CHECKS: PENDING — required check "<name>" never reported (seen: <listed names>)
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
const USAGE = 'Usage: node pr-watch.mjs [--repo <path>] [--pr <number>] [--require "<name>[,<name>...]"] [--timeout-min <n, default 30>] [--interval-sec <n, default 30>]';

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

// ---- required checks (2026-11-18, audit finding 1) ----
// A check name as compared: exact after trim, without case.
const keyOf = (name) => String(name == null ? '' : name).trim().toLowerCase();
// "a, b" and ["a,b", " c"] → [{ name, key }] without empties and repeats; the name stays as typed (trimmed).
// 2026-11-18 (audit finding 3): a name may hold a comma ("test (ubuntu-latest, 20)"). A typed value is one
// name when it is itself a listed check; else it is split only at commas outside (), [] and {}.
function splitTop(value) {
  const parts = [];
  let depth = 0, from = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) { parts.push(value.slice(from, i)); from = i + 1; }
  }
  parts.push(value.slice(from));
  return parts;
}
export function requiredFrom(values, listedKeys = new Set()) {
  const seen = new Set(), list = [];
  for (const value of values) {
    const whole = String(value).trim();
    const parts = listedKeys.has(keyOf(whole)) ? [whole] : splitTop(String(value));
    for (const part of parts) {
      const name = part.trim(), key = keyOf(name);
      if (name && !seen.has(key)) { seen.add(key); list.push({ name, key }); }
    }
  }
  return list;
}
// Several lists in one, each name once (the first spelling stays).
const unionOf = (...lists) => {
  const seen = new Set(), list = [];
  for (const x of lists.flat()) if (!seen.has(x.key)) { seen.add(x.key); list.push(x); }
  return list;
};

// The values set in the repository, as typed: `git config --get-all sanad.requiredChecks`. Any failure is "none set".
function gitConfigValues(repo) {
  const r = spawnSync('git', ['config', '--get-all', 'sanad.requiredChecks'], { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  if (r.error || r.status !== 0) return [];
  return String(r.stdout || '').split(/\r?\n/).filter((l) => l.trim());
}

// GitHub's own list: { required: [...] } | { error }. "no required checks reported" means none.
// Its names are never split: GitHub says each one as one name.
const NO_REQUIRED = /no required checks reported|no checks reported/i;
function githubRequired(repo, number) {
  const r = gh(repo, ['pr', 'checks', String(number), '--required', '--json', 'name,bucket']);
  try {
    const list = JSON.parse(r.out);
    if (Array.isArray(list)) return { required: unionOf(list.map((c) => String((c && c.name) || '').trim()).filter(Boolean).map((name) => ({ name, key: keyOf(name) }))) };
  } catch { /* not JSON: an error, or none required */ }
  if (NO_REQUIRED.test(r.err)) return { required: [] };
  return { error: firstLine(r.err) || 'gh pr checks --required did not answer with a list' };
}

// 2026-11-18 (audit round 3, finding 1): "gh pr checks --required" lists only checks that REPORTED. A suite the
// branch rules require but that never started is not in it. So the configured requirements of the base
// branch are read too: rulesets (rules of type required_status_checks, each context is a name) and classic
// branch protection (contexts and checks[].context). Both are best effort: a failed call means that source
// could not be read; a repository without classic protection answers "Branch not protected" (404): that is
// "none", read fine. The names are ADDED to the required set. `readable` is false only when neither source
// could be read: the watch then does not block, and its PASS line says so.
const NOT_PROTECTED = /branch not protected/i;
const baseBranch = (repo, number) => {
  const r = gh(repo, ['pr', 'view', String(number), '--json', 'baseRefName']);
  try {
    const name = JSON.parse(r.out).baseRefName;
    if (typeof name === 'string' && name.trim()) return name.trim();
  } catch { /* not JSON: base unknown */ }
  return '';
};
const contextName = (x) => String(typeof x === 'string' ? x : (x && x.context) || '').trim();
// 2026-11-18 (audit round 4): the two sources are tracked apart. `unread` names each source that could not be
// read at this look (a plain "Not Found" from the classic call is "unread", never "none": a normal account
// gets it whether or not the branch is protected). `memo` ({ rules, prot }, one per head) keeps each source's
// last good names: a failed read never counts as "nothing required". The rules call asks for 100 per page and
// follows every page (--paginate --slurp gives an array of pages, joined here).
export const UNREAD_RULES = 'rulesets', UNREAD_CLASSIC = 'classic branch protection';
function configuredRequired(repo, number, memo = { rules: null, prot: null }) {
  const base = baseBranch(repo, number);
  if (!base) return { names: [], unread: [UNREAD_RULES, UNREAD_CLASSIC], readable: false };
  const enc = encodeURIComponent(base);
  const unread = [];
  const rules = gh(repo, ['api', '--paginate', '--slurp', `repos/{owner}/{repo}/rules/branches/${enc}?per_page=100`]);
  let rulesNames = null;
  if (rules.ok) {
    try {
      const pages = JSON.parse(rules.out);
      if (Array.isArray(pages)) {
        const list = pages.flatMap((p) => (Array.isArray(p) ? p : [p]));
        rulesNames = [];
        for (const rule of list) {
          if (!rule || rule.type !== 'required_status_checks') continue;
          const items = (rule.parameters && rule.parameters.required_status_checks) || [];
          for (const item of Array.isArray(items) ? items : []) rulesNames.push(contextName(item));
        }
      }
    } catch { /* not a list: this source could not be read */ }
  }
  if (rulesNames) memo.rules = rulesNames;
  else unread.push(UNREAD_RULES);
  const prot = gh(repo, ['api', `repos/{owner}/{repo}/branches/${enc}/protection/required_status_checks`]);
  let protNames = null;
  if (prot.ok) {
    try {
      const body = JSON.parse(prot.out);
      if (body && typeof body === 'object') {
        protNames = [];
        for (const c of Array.isArray(body.contexts) ? body.contexts : []) protNames.push(contextName(c));
        for (const c of Array.isArray(body.checks) ? body.checks : []) protNames.push(contextName(c));
      }
    } catch { /* not an object: this source could not be read */ }
  } else if (NOT_PROTECTED.test(prot.err + ' ' + prot.out)) protNames = [];   // no classic protection: "none"
  if (protNames) memo.prot = protNames;
  else unread.push(UNREAD_CLASSIC);
  const names = [...(memo.rules || []), ...(memo.prot || [])];
  return { names: unionOf(names.filter(Boolean).map((name) => ({ name, key: keyOf(name) }))), unread, readable: unread.length < 2 };
}

const quoted = (list) => list.map((n) => `"${n}"`).join(', ');

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

// 2026-11-18 (audit finding 8): a failed job is shown when a look first finds it red, while the other
// checks are still watched. `shown` remembers, for one head, the jobs already shown and the log lines
// already printed per run: the same log is never printed twice.
const newShown = () => ({ jobs: new Set(), runs: new Map() });
const jobKey = (check) => `${check.name}\u0000${check.link || ''}`;

// Print the failing lines of every failed check not shown yet. Two failed jobs of one run that fail at
// the same look share one log: asked once.
// 2026-11-18 (audit finding 2): a job counts as shown only after its lines were printed. gh gives no log of
// a run that still has a job running ("logs will be available when it is complete"): such a job is asked
// again at every later look, and the log of that job alone (by the job id in its link) is tried too.
// Only the last call (`final`) says "no log came back".
const JOB = /\/job\/(\d+)/;
function showFailures(repo, failed, out, shown = newShown(), final = false) {
  const fresh = failed.filter((check) => !shown.jobs.has(jobKey(check)));
  const runs = new Map();
  for (const check of fresh) {
    const id = (String(check.link || '').match(RUN) || [])[1];
    if (id) runs.set(id, [...(runs.get(id) || []), check]);
    else {
      shown.jobs.add(jobKey(check));
      out(`--- ${label(check)}: not a GitHub Actions run, no log to read here — ${check.link || 'the check has no link'}`);
    }
  }
  // Print the new lines of one log; true when something was printed or the log was already shown.
  const print = (id, who, command, text, jobs) => {
    const { lines, more } = failingLines(text);
    if (!lines.length) return false;
    const printed = shown.runs.get(id) || new Set();
    const first = !shown.runs.has(id);
    shown.runs.set(id, printed);
    const news = lines.filter((line) => !printed.has(line));
    for (const check of jobs) shown.jobs.add(jobKey(check));
    if (!news.length) { out(`--- ${who}: same log as shown above (${command})`); return true; }
    out(`--- ${who}: failing lines (${command})`);
    // Two spaces in front: a log line can never be read as this script's own "PR CHECKS:" line.
    for (const line of news) { printed.add(line); out('  ' + line); }
    if (more && first) out(`  … ${more} more problem line(s) not shown`);
    return true;
  };
  for (const [id, checks] of runs) {
    const who = [...new Set(checks.map(label))].join(', ');
    const r = gh(repo, ['run', 'view', id, '--log-failed'], 180000);
    if (print(id, who, `gh run view ${id} --log-failed`, r.out, checks)) continue;
    // The run gave nothing: read each job's own log.
    let pending = [];
    for (const check of checks) {
      const jobId = (String(check.link || '').match(JOB) || [])[1];
      const j = jobId ? gh(repo, ['run', 'view', id, '--job', jobId, '--log-failed'], 180000) : { out: '' };
      if (!print(id, label(check), `gh run view ${id} --job ${jobId} --log-failed`, j.out, [check])) pending.push(check);
    }
    if (final && pending.length) {
      out(`--- ${[...new Set(pending.map(label))].join(', ')}: failing lines (gh run view ${id} --log-failed)`);
      out(`  no log came back: ${firstLine(r.err) || 'the run has no failed step'}`);
      for (const check of pending) shown.jobs.add(jobKey(check));
    }
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
export async function watch({ repo, pr, timeoutMin, intervalSec, require = [] }, print = (line) => process.stdout.write(line + '\n')) {
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
  // 2026-11-18 (audit finding 1): the required names. --require, else the repository's git config, else
  // GitHub's own list (asked when the first settled, not red list is seen; null = not known yet).
  // 2026-11-18 (audit findings 1, 3, 4): the names typed (--require, git config) ADD to each other and to
  // GitHub's own list; none of them drops another. GitHub's list is asked again at every settled, not red
  // look that lists a check (never kept from an earlier look or an old head), so a name that is listed late
  // is seen. A typed value that is itself a listed check name is one name, a comma inside it included.
  const typed = [...require, ...gitConfigValues(repo)];
  for (;;) {
  let t = tally([]), result = '', said = '', greenList = null, emptyLooks = 0, failedAsks = 0, lastError = '';
  let early = false, stallList = '', stalls = 0, unwaited = [], missing = [], reqSkipped = [], requiredAsks = 0, seenList = [];
  let req = [], reqFailed = false, hinted = false, skipSaid = new Set(), seenAll = [], configUnread = [];
  const memo = { rules: null, prot: null };   // each source's last good names, for this head only
  const shown = newShown();   // the failed jobs already shown for this head
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
      let askAgain = false, fromGitHub = [];
      if (settled && !t.fail.length && r.checks.length) {
        const q = githubRequired(repo, info.number);
        if (q.error) {
          lastError = q.error;
          reqFailed = true;
          if (++requiredAsks >= FAILED_ASKS) { out('PR CHECKS: could not ask GitHub — ' + q.error); return EXIT.error; }
          out(`  GitHub did not answer (${q.error}): asking again`);
          askAgain = true;
        } else {
          reqFailed = false; requiredAsks = 0;
          // 2026-11-18 (audit round 3, finding 1): the base branch's configured requirements add to the list.
          const cfg = configuredRequired(repo, info.number, memo);
          configUnread = cfg.unread;
          fromGitHub = unionOf(q.required, cfg.names);
        }
      }
      if (!askAgain) {
      const listedKeys = new Set(r.checks.map((c) => keyOf(c.name)));
      req = unionOf(requiredFrom(typed, listedKeys), fromGitHub);
      const listed = (x) => r.checks.filter((c) => keyOf(c.name) === x.key);
      missing = req.filter((x) => !listed(x).length).map((x) => x.name);
      reqSkipped = req.filter((x) => listed(x).some((c) => bucketOf(c) === 'skip')).map((x) => x.name);
      seenList = [...t.pass, ...t.skip];
      seenAll = r.checks;
      // Green: nothing red or pending, and every required check listed. With no required name only a
      // passed check makes it green (the end then says NOT PROVEN); with names the skip rules decide at the end.
      const complete = settled && !t.fail.length && !missing.length;
      const green = complete && (req.length ? true : t.pass.length > 0);
      // Nothing listed, or skipped ones only, and no required name: "none". A required name never gives "none"
      // (audit finding 7: except on a draft, where nothing passed and a required name is not listed: a draft may skip CI).
      const empty = settled && !t.fail.length && !t.pass.length && (!req.length || (info.isDraft && missing.length > 0));
      // The required names are part of what was seen: a changed list is a new look.
      const list = r.checks.map((c) => `${c.name}=${bucketOf(c)}`).sort().join('|') + '#' + req.map((x) => x.key).sort().join('|');
      emptyLooks = empty ? emptyLooks + 1 : 0;
      // On a draft, a check with no Actions run (the WIP app) stays pending: it is not waited for.
      unwaited = info.isDraft ? t.pending.filter((c) => !RUN.test(String((c && c.link) || ''))) : [];
      const onlyUnwaited = unwaited.length > 0 && unwaited.length === t.pending.length;
      stalls = onlyUnwaited && !t.fail.length && list === stallList ? stalls + 1 : onlyUnwaited && !t.fail.length ? 1 : 0;
      stallList = onlyUnwaited ? list : '';
      if ((settled || onlyUnwaited) && t.fail.length) { result = 'fail'; early = !settled; }
      else if (stalls >= EMPTY_LOOKS) result = 'draft';
      else if (green && greenList === list) result = 'done';
      else if (empty && emptyLooks >= EMPTY_LOOKS) result = 'none';
      greenList = green ? list : null;
      if (!result) {
        const line = green ? `  all ${t.pass.length} passed: one more look, a check may start late` : progress(t);
        if (line !== said) out(line);
        said = line;
        // 2026-11-18 (audit finding 5): a required check that is skipped can never be a PASS: said once, at once.
        for (const name of reqSkipped) {
          if (!skipSaid.has(keyOf(name))) { skipSaid.add(keyOf(name)); out(`  required check "${name}" was skipped: this can never be a PASS`); }
        }
        // 2026-11-18 (audit finding 6): a required name that no listed check has, at the first settled look.
        if (settled && !hinted && missing.length && r.checks.length) {
          hinted = true;
          out(`  required check${missing.length === 1 ? '' : 's'} ${quoted(missing)} not listed yet (seen: ${names(seenAll)}): waiting`);
        }
        // 2026-11-18 (audit finding 8): a job that is red now is shown now, once, while the rest is watched.
        if (t.fail.length) showFailures(repo, t.fail, out, shown);
      }
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
    // 2026-11-18: the list of required checks could not be read before the time ran out: not "none".
    if (reqFailed && !t.fail.length && !t.pending.length) { out('PR CHECKS: could not ask GitHub — ' + lastError); return EXIT.error; }
    result = t.fail.length ? 'fail' : t.pending.length || missing.length ? 'pending' : 'none';
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
  if (result === 'done') {
    // A draft with skipped CI and an outside check that passed: nothing proved the code.
    // 2026-11-18 (audit round 3, finding 2): on a draft the DRAFT line is for a REQUIRED check that is skipped,
    // or for no required name at all; a skipped check that is not required never blocks.
    if (info.isDraft && t.skip.length && (!req.length || reqSkipped.length)) {
      out(`PR CHECKS: DRAFT — ${t.skip.length} skipped, ${t.pass.length} passed: mark it ready${already(info)}`);
      return EXIT.none;
    }
    // 2026-11-18 (audit finding 1): never exit 0 without a named required check that passed.
    if (!req.length) {
      out(`PR CHECKS: NOT PROVEN — ${t.pass.length} passed, ${t.skip.length} skipped, but no required check is named: run again with --require "<job name>" or set git config sanad.requiredChecks (seen: ${names(seenList)})${already(info)}`);
      return EXIT.none;
    }
    if (reqSkipped.length) {
      out(`PR CHECKS: NOT PROVEN — required check${reqSkipped.length === 1 ? '' : 's'} ${quoted(reqSkipped)} ${reqSkipped.length === 1 ? 'was' : 'were'} skipped${already(info)}`);
      return EXIT.none;
    }
    const keys = new Set(req.map((x) => x.key));
    const otherPassed = t.pass.filter((c) => !keys.has(keyOf(c.name))).length;
    out(`PR CHECKS: PASS — required: ${req.map((x) => x.name).join(', ')} passed on ${head(info)} (${otherPassed} other passed, ${t.skip.length} skipped) · ${info.url}${already(info)}${configUnread.length === 2 ? " (GitHub's configured required list could not be read)" : configUnread.length ? ` (GitHub's configured required list could not be read from: ${configUnread.join(', ')})` : ''}`);
    return EXIT.pass;
  }
  if (result === 'fail') {
    showFailures(repo, t.fail, out, shown, true);
    const pending = !t.pending.length ? '' : early ? ` (not waited for: ${names(t.pending)})` : ` (still pending after ${timeoutMin} min: ${names(t.pending)})`;
    out(`PR CHECKS: FAIL — ${names(t.fail)}${pending} · ${info.url}${already(info)}`);
    return EXIT.fail;
  }
  if (result === 'pending') {
    // 2026-11-18 (audit findings 5, 6): the line names a skipped required check and shows the names that were listed.
    const never = [
      missing.length ? `required check${missing.length === 1 ? '' : 's'} ${quoted(missing)} never reported (seen: ${names(seenAll) || 'none'})` : '',
      reqSkipped.length ? `required check${reqSkipped.length === 1 ? '' : 's'} ${quoted(reqSkipped)} ${reqSkipped.length === 1 ? 'was' : 'were'} skipped` : '',
    ].filter(Boolean).join('; ');
    out(t.pending.length
      ? `PR CHECKS: PENDING after ${timeoutMin} min — ${names(t.pending)}${never ? '; ' + never : ''}${already(info)}`
      : `PR CHECKS: PENDING — ${never}${already(info)}`);
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
  const o = { repo: '.', pr: null, timeoutMin: 30, intervalSec: 30, require: [] };
  const number = (key, value, max) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0 || n > max) throw new Error(`${key} needs a number above 0, at most ${max}`);
    return n;
  };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!['--repo', '--pr', '--require', '--timeout-min', '--interval-sec'].includes(key) || value === undefined || value === '') throw new Error('Unknown or empty option: ' + key);
    if (key === '--repo') o.repo = value;
    else if (key === '--require') {
      const names = requiredFrom([value]);
      if (!names.length) throw new Error('--require needs at least one check name');
      o.require.push(value);
    }
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
