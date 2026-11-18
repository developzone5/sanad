import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 2026-11-17: twice in one week a pull request was merged with its CI red or still running. pr-watch.mjs
// waits for the checks after the user's push and brings back the failing lines. No test here reaches
// GitHub: a small script stands in for gh (SANAD_GH) and answers from a scenario file.
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'pr-watch.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-watch-'));
process.env.SANAD_STATE_DIR = path.join(root, 'state');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

// The script's functions are loaded inside each test, so on a copy without pr-watch.mjs every test fails
// by itself (not the whole file at its first line).
const lib = () => import(pathToFileURL(script).href);

// The stand-in for gh. Each kind of call ("pr view", "pr checks") walks its own list of answers and the
// last answer repeats. Every call is written down next to the scenario, with a mark that says the call
// ran inside the repository. A command gh does not have gets gh's own "unknown command" error.
const emptyConfig = path.join(root, 'empty-gitconfig');
fs.writeFileSync(emptyConfig, '');
const fakeGh = path.join(root, 'fake-gh.cjs');
fs.writeFileSync(fakeGh, [
  "const fs = require('node:fs');",
  'const file = process.env.PR_WATCH_SCENARIO;',
  "const scenario = JSON.parse(fs.readFileSync(file, 'utf8'));",
  "const calls = fs.existsSync(file + '.calls') ? JSON.parse(fs.readFileSync(file + '.calls', 'utf8')) : [];",
  "const args = process.argv.slice(2), kind = args[0] === 'api' ? 'api ' + (/\\/rules\\/branches\\//.test(args.join(' ')) ? 'rules' : /\\/protection\\/required_status_checks$/.test(args.join(' ')) ? 'protection' : 'other') : (args[0] === 'pr' && args[1] === 'view' && args.includes('baseRefName') ? 'pr base' : args.slice(0, 2).join(' ') + (args.includes('--required') ? ' required' : ''));",
  'const nth = calls.filter((c) => c.kind === kind).length;',
  "calls.push({ kind, args, inRepo: fs.existsSync('this-is-the-repo.txt') });",
  "fs.writeFileSync(file + '.calls', JSON.stringify(calls));",
  "const fields = args.includes('--json') ? args[args.indexOf('--json') + 1] : '';",
  'const pick = (list) => list[Math.min(nth, list.length - 1)];',
  "let answer = { err: 'unknown command \"' + args.join(' ') + '\" for \"gh\"', code: 1 };",
  "if (kind === 'pr view' && fields === 'number,state,isDraft,headRefOid,url' && args.length <= 5) answer = pick(scenario.view);",
  "if (kind === 'pr checks' && fields === 'name,state,bucket,link' && args.length === 5) answer = pick(scenario.checks);",
  // 2026-11-18: GitHub's own list of required checks. No answer given = gh's "no required checks reported".
  "if (kind === 'pr checks required' && fields === 'name,bucket' && args.length === 6) answer = scenario.required ? pick(scenario.required) : { err: \"no required checks reported on the 'feat/x' branch\", code: 1 };",
  // 2026-11-18 (round 3): the base branch and the configured requirements. Default: base "main", no ruleset
  // rule (an empty list) and no classic protection (gh's 404 "Branch not protected"): both read, nothing required.
  "if (kind === 'pr base') answer = scenario.base ? pick(scenario.base) : { out: { baseRefName: 'main' } };",
  "if (kind === 'api rules') answer = scenario.rules ? pick(scenario.rules) : { out: [] };",
  "if (kind === 'api protection') answer = scenario.protection ? pick(scenario.protection) : { err: 'gh: Branch not protected (HTTP 404)', code: 1 };",
  // 2026-11-18: a run's log may be a list of answers (one per ask: gh refuses while a job still runs);
  // a job's own log (--job) is read from scenario.jobLogs.
  "if (kind === 'run view' && args[3] === '--log-failed' && args.length === 4) { const l = scenario.logs[args[2]]; const n = calls.filter((c) => c.kind === kind && c.args.length === 4 && c.args[2] === args[2]).length - 1; answer = (Array.isArray(l) ? l[Math.min(n, l.length - 1)] : l) || { err: 'HTTP 404: Not Found', code: 1 }; }",
  "if (kind === 'run view' && args[3] === '--job' && args[5] === '--log-failed' && args.length === 6) answer = (scenario.jobLogs || {})[args[4]] || { err: 'HTTP 404: Not Found', code: 1 };",
  "if (answer.err) process.stderr.write(answer.err + '\\n');",
  "if (answer.out !== undefined) process.stdout.write(typeof answer.out === 'string' ? answer.out : JSON.stringify(answer.out));",
  'process.exitCode = answer.code || 0;',
].join('\n'));

const URL = 'https://github.com/acme/app/pull/12';
const PR = { number: 12, state: 'OPEN', isDraft: false, headRefOid: '0123456789abcdef0123456789abcdef01234567', url: URL };
const STATE = { pass: 'SUCCESS', fail: 'FAILURE', pending: 'IN_PROGRESS', skipping: 'SKIPPED', cancel: 'CANCELLED' };
const check = (name, bucket, run) => ({ name, bucket, state: STATE[bucket], link: run ? `https://github.com/acme/app/actions/runs/${run}/job/${run}00` : '' });
// gh's own words when a pull request has no check yet (it ends with an error, not an empty list).
const NO_CHECKS = { err: "no checks reported on the 'feat/x' branch", code: 1 };

let cases = 0;
// view: the answers to `gh pr view` (a pull request, or { err, code }); checks: one answer per look
// (a list, or { err, code }); logs: run id → the text of `gh run view <id> --log-failed`.
// required (2026-11-18): the answers of `gh pr checks --required`: a list of names, or { err, code }.
const wrapLog = (l) => (typeof l === 'string' ? { out: l } : l);
// rules / protection / base (round 3): the answers of the two `gh api` calls and of the base-branch read:
// a value (the JSON answer) or { err, code }.
const wrapAnswer = (a) => (a && a.err ? a : { out: a });
function scenario({ view = [PR], checks = [[]], logs = {}, required = null, jobLogs = {}, rules = null, protection = null, base = null } = {}) {
  const dir = path.join(root, 'case-' + (++cases));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'this-is-the-repo.txt'), '');
  const file = path.join(dir, 'scenario.json');
  fs.writeFileSync(file, JSON.stringify({
    view: view.map((v) => (v.err ? v : { out: v })),
    checks: checks.map((c) => (Array.isArray(c) ? { out: c } : c)),
    logs: Object.fromEntries(Object.entries(logs).map(([id, text]) => [id, Array.isArray(text) ? text.map(wrapLog) : wrapLog(text)])),
    jobLogs: Object.fromEntries(Object.entries(jobLogs).map(([id, text]) => [id, wrapLog(text)])),
    ...(rules ? { rules: rules.map(wrapAnswer) } : {}),
    ...(protection ? { protection: protection.map(wrapAnswer) } : {}),
    ...(base ? { base: base.map(wrapAnswer) } : {}),
    ...(required ? { required: required.map((r) => (Array.isArray(r) ? { out: r.map((name) => ({ name, bucket: 'pass' })) } : r)) } : {}),
  }));
  const calls = () => (fs.existsSync(file + '.calls') ? JSON.parse(fs.readFileSync(file + '.calls', 'utf8')) : []);
  return { repo, file, calls, asked: (kind) => calls().filter((c) => c.kind === kind) };
}

function run(sc, ...args) {
  const r = spawnSync(process.execPath, [script, '--repo', sc.repo, '--interval-sec', '0.2', ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 60000,
    // No git config of this machine may name required checks: the tests state their own.
    env: { ...process.env, SANAD_GH: fakeGh, PR_WATCH_SCENARIO: sc.file, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' },
  });
  const lines = (r.stdout || '').split(/\r?\n/).filter(Boolean);
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', lines, last: lines[lines.length - 1] || '', all: (r.stdout || '') + (r.stderr || '') };
}

// One line as `gh run view --log-failed` prints it: the job, the step and the time in front of the text.
const stamp = (i) => `2026-11-17T10:00:${String(i % 60).padStart(2, '0')}.${String(1000000 + i).slice(1)}0Z`;
const logLine = (text, i, job = 'unit', step = 'Run npm test') => `${job}\t${step}\t${stamp(i)} ${text}`;
// By code, not typed: the script's own marks are then checked against the real characters.
const ESC = '\x1b', CROSS = String.fromCharCode(0x2716), TICK = String.fromCharCode(0x2713), BOM = String.fromCharCode(0xFEFF);

test('a check that is pending on the first look and passed on the next ends as PASS; a skipped check does not count against it', () => {
  const running = [check('unit', 'pending', 901), check('lint', 'pass', 902), check('deploy', 'skipping')];
  const done = [check('unit', 'pass', 901), check('lint', 'pass', 902), check('deploy', 'skipping')];
  const sc = scenario({ checks: [running, running, done] });
  // 2026-11-18: a PASS needs a named required check (changed test: it names "unit").
  const r = run(sc, '--require', 'unit');
  assert.equal(r.status, 0, r.all);
  // One progress line per change of the counts: the second pending look prints nothing.
  assert.deepEqual(r.lines, [
    '  waiting: 1 pending, 1 passed, 1 skipped',
    '  all 2 passed: one more look, a check may start late',
    `PR CHECKS: PASS — required: unit passed on 0123456789 (1 other passed, 1 skipped) · ${URL}`,
  ]);
  // gh is asked inside the repository, for the branch's own pull request, with flags gh really has.
  const calls = sc.calls();
  assert.deepEqual(calls[0].args, ['pr', 'view', '--json', 'number,state,isDraft,headRefOid,url']);
  assert.deepEqual(calls[1].args, ['pr', 'checks', '12', '--json', 'name,state,bucket,link']);
  assert.ok(calls.every((c) => c.inRepo), 'every gh call runs in --repo');
  assert.equal(sc.asked('pr checks').length, 4, 'pending, pending, green, and the second look at the green list');
});

test('a red check ends as FAIL: its failing lines are shown without the job, step, time and colour noise', () => {
  const text = [
    '##[group]Run npm test',
    '> app@1.0.0 test',
    `${TICK} reports an error when the name is empty`,
    `${ESC}[31m${CROSS} adds two numbers${ESC}[39m`,
    'AssertionError [ERR_ASSERTION]: 3 !== 4',
    '    at Object.<anonymous> (calc.test.js:7:10)',
    'not ok 2 - adds two numbers',
    `${ESC}[31m${CROSS} adds two numbers${ESC}[39m`,
    ...Array.from({ length: 20 }, (_, i) => `step ${String(i + 1).padStart(2, '0')} done`),
    '# tests 2',
    '# fail 1',
    '##[error]Process completed with exit code 1.',
  ];
  // Windows line ends on purpose: the result must not depend on them.
  const log = text.map((line, i) => logLine(line, i)).join('\r\n') + '\r\n';
  const sc = scenario({ checks: [[check('unit', 'fail', 555), check('build', 'fail', 555), check('lint', 'pass', 556)]], logs: { 555: log } });
  const r = run(sc);
  assert.equal(r.status, 1, r.all);
  assert.deepEqual(r.lines, [
    '--- unit, build: failing lines (gh run view 555 --log-failed)',
    `  ${CROSS} adds two numbers`,
    '  AssertionError [ERR_ASSERTION]: 3 !== 4',
    '  not ok 2 - adds two numbers',
    ...Array.from({ length: 12 }, (_, i) => `  step ${String(i + 9).padStart(2, '0')} done`),
    '  # tests 2',
    '  # fail 1',
    '  ##[error]Process completed with exit code 1.',
    `PR CHECKS: FAIL — unit, build · ${URL}`,
  ]);
  assert.doesNotMatch(r.stdout, /\t|\x1b|\d{4}-\d\d-\d\dT/, 'no tab column, colour code or timestamp is left');
  // Two failed jobs of one run share its log: it is asked for once, with the flag gh really has.
  assert.deepEqual(sc.asked('run view').map((c) => c.args), [['run', 'view', '555', '--log-failed']]);
});

test('at most 40 problem lines and the last 15 lines are shown, each once, in the order of the log', async () => {
  const { failingLines } = await lib();
  const problems = Array.from({ length: 60 }, (_, i) => `Error: broken thing ${i}`);
  const plain = Array.from({ length: 30 }, (_, i) => `plain line ${i}`);
  const end = Array.from({ length: 15 }, (_, i) => (i === 3 ? 'Error: broken thing 2' : i === 7 ? 'FAIL at the very end' : `closing line ${i}`));
  const { lines, more } = failingLines([...problems, 'Error: broken thing 0', ...plain, ...end].join('\n'));
  assert.deepEqual(lines, [...problems.slice(0, 40), ...end.filter((l) => l !== 'Error: broken thing 2')]);
  assert.equal(more, 20, 'the problem lines over the limit are counted, a repeated one is not');
  assert.deepEqual(failingLines(''), { lines: [], more: 0 });
});

test('every kind of problem line is found; a passing test whose name says "error" is not one', async () => {
  const { failingLines, cleanLine } = await lib();
  const found = ['  FAIL  src/a.test.ts > saves the form', 'not ok 3 - saves the form', `${CROSS} saves the form (4.2ms)`,
    'AssertionError: expected 1 to be 2', 'Error: connect ECONNREFUSED 127.0.0.1:3306', '  Failed EduQuest.Tests.Users.RoleSync [12 ms]',
    'src/app.ts(3,1): error TS2304: Cannot find name x.'];
  const quiet = [`${TICK} shows an error when the name is empty`, 'ok 1 - returns an error for a bad id', 'PASS src/error-page.test.ts', 'installing packages'];
  const tail = Array.from({ length: 15 }, (_, i) => `closing line ${i}`);
  assert.deepEqual(failingLines([...quiet, ...found, ...tail].join('\n')).lines, [...found, ...tail]);
  // The noise columns go only when gh's own time stamp follows them: a line of the log that holds tabs stays whole.
  assert.equal(cleanLine('unit\tRun npm test\t' + BOM + '2026-11-17T10:00:00.1234567Z hello'), 'hello');
  assert.equal(cleanLine('2026-11-17T10:00:00Z hello'), 'hello');
  assert.equal(cleanLine('name\tvalue\tunit'), 'name\tvalue\tunit');
  assert.equal(cleanLine('x'.repeat(5000)).length, 302, 'one endless line is cut');
});

test('a failed check with no Actions run, or whose log does not come back, is still named', () => {
  const outside = { name: 'deploy-preview', bucket: 'fail', state: 'FAILURE', link: 'https://deploy.example/builds/7' };
  const sc = scenario({ checks: [[outside, check('e2e', 'fail', 808)]] });
  const r = run(sc);
  assert.equal(r.status, 1, r.all);
  assert.deepEqual(r.lines, [
    '--- deploy-preview: not a GitHub Actions run, no log to read here — https://deploy.example/builds/7',
    '--- e2e: failing lines (gh run view 808 --log-failed)',
    '  no log came back: HTTP 404: Not Found',
    `PR CHECKS: FAIL — deploy-preview, e2e · ${URL}`,
  ]);
});

test('no check reported ends as NONE, on the third look only', () => {
  const sc = scenario({ checks: [NO_CHECKS] });
  const r = run(sc);
  assert.equal(r.status, 3, r.all);
  assert.deepEqual(r.lines, [
    '  waiting: no check reported yet',
    'PR CHECKS: NONE — no check reported; a draft pull request may skip CI: mark it ready',
  ]);
  assert.equal(sc.asked('pr checks').length, 3, 'right after a push GitHub lists nothing for some seconds');
});

test('no check reported on a draft pull request says it is a draft', () => {
  const r = run(scenario({ view: [{ ...PR, isDraft: true }], checks: [NO_CHECKS] }));
  assert.equal(r.status, 3, r.all);
  assert.equal(r.last, 'PR CHECKS: NONE — no check reported; this pull request is a DRAFT and a draft may skip CI: mark it ready');
});

test('checks that were all skipped are not a pass: NONE', () => {
  const r = run(scenario({ view: [{ ...PR, isDraft: true }], checks: [[check('unit', 'skipping'), check('lint', 'skipping')]] }));
  assert.equal(r.status, 3, r.all);
  assert.equal(r.last, 'PR CHECKS: NONE — no check ran (2 skipped); this pull request is a DRAFT and a draft may skip CI: mark it ready');
  assert.doesNotMatch(r.stdout, /PASS/);
});

test('checks that are listed some seconds after the push are waited for', () => {
  const sc = scenario({ checks: [NO_CHECKS, NO_CHECKS, [check('unit', 'pending', 1)], [check('unit', 'pass', 1)]] });
  const r = run(sc, '--require', 'unit');   // 2026-11-18: names its required check
  assert.equal(r.status, 0, r.all);
  assert.deepEqual(r.lines, [
    '  waiting: no check reported yet',
    '  waiting: 1 pending, 0 passed',
    '  all 1 passed: one more look, a check may start late',
    `PR CHECKS: PASS — required: unit passed on 0123456789 (0 other passed, 0 skipped) · ${URL}`,
  ]);
});

test('checks still pending at the time limit end as PENDING with their names', () => {
  const sc = scenario({ checks: [[check('unit', 'pending', 1), check('e2e', 'pending', 2), check('lint', 'pass', 3)]] });
  const r = run(sc, '--timeout-min', '0.01');
  assert.equal(r.status, 4, r.all);
  assert.deepEqual(r.lines, ['  waiting: 2 pending, 1 passed', 'PR CHECKS: PENDING after 0.01 min — unit, e2e']);
});

test('a red check with another one still pending at the time limit ends as FAIL and names the pending one', () => {
  const sc = scenario({ checks: [[check('unit', 'fail', 5), check('e2e', 'pending', 6)]], logs: { 5: logLine('FAIL src/a.test.ts', 1) } });
  const r = run(sc, '--timeout-min', '0.1');
  assert.equal(r.status, 1, r.all);
  assert.deepEqual(r.lines, [
    '  waiting: 1 pending, 0 passed, 1 failed',
    '--- unit: failing lines (gh run view 5 --log-failed)',
    '  FAIL src/a.test.ts',
    `PR CHECKS: FAIL — unit (still pending after 0.1 min: e2e) · ${URL}`,
  ]);
  // 2026-11-18 (audit finding 8): the failing lines come at the first look that shows the red check,
  // not at the end: the log is asked once, right after the first list, before the later looks.
  const kinds = sc.calls().map((c) => c.kind);
  assert.equal(kinds[2], 'run view', kinds.join(', '));
  assert.equal(sc.asked('run view').length, 1);
  assert.ok(sc.asked('pr checks').length >= 2, 'the watch went on with the other check');
});

test('a branch with no pull request ends as NO PR, and no check is asked for', () => {
  const sc = scenario({ view: [{ err: 'no pull requests found for branch "feat/x"', code: 1 }] });
  const r = run(sc);
  assert.equal(r.status, 3, r.all);
  assert.deepEqual(r.lines, ['PR CHECKS: NO PR — push the branch and open the PR first']);
  assert.equal(sc.asked('pr checks').length, 0);

  // --pr goes to gh as the number; GitHub's own words for a number with no pull request.
  const byNumber = scenario({ view: [{ err: 'GraphQL: Could not resolve to a PullRequest with the number of 99. (repository.pullRequest)', code: 1 }] });
  const n = run(byNumber, '--pr', '99');
  assert.equal(n.status, 3, n.all);
  assert.deepEqual(n.lines, ['PR CHECKS: NO PR — push the branch and open the PR first']);
  assert.deepEqual(byNumber.calls()[0].args, ['pr', 'view', '99', '--json', 'number,state,isDraft,headRefOid,url']);
});

test('gh not signed in: its own first error line, exit 2', () => {
  const hint = 'Alternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.';
  const sc = scenario({ view: [{ err: 'To get started with GitHub CLI, please run:  gh auth login\n' + hint, code: 4 }] });
  const r = run(sc);
  assert.equal(r.status, 2, r.all);
  assert.deepEqual(r.lines, ['PR CHECKS: could not ask GitHub — To get started with GitHub CLI, please run:  gh auth login']);
});

test('gh not installed is said in plain words, exit 2', () => {
  const sc = scenario();
  const noTools = path.join(root, 'no-tools');
  fs.mkdirSync(noTools, { recursive: true });
  // No SANAD_GH and a PATH with nothing in it (Windows spells it Path): the real `gh` cannot be found.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:path|sanad_gh)$/i.test(key)));
  env.PATH = noTools;
  const r = spawnSync(process.execPath, [script, '--repo', sc.repo], { encoding: 'utf8', windowsHide: true, timeout: 60000, env });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /^PR CHECKS: could not ask GitHub — the GitHub CLI \(gh\) was not found on PATH/);
});

test('a wrong option is a usage error: exit 2, and GitHub is not asked', () => {
  const sc = scenario();
  const wrong = [['--watch', 'yes'], ['--pr', 'abc'], ['--pr', '0'], ['--timeout-min', '0'], ['--interval-sec', 'soon'], ['--timeout-min'],
    ['--repo', path.join(sc.repo, 'not-there')]];
  for (const args of wrong) {
    const r = run(sc, ...args);
    assert.equal(r.status, 2, args.join(' ') + ' → ' + r.all);
    assert.match(r.stderr, /^PR CHECKS: .+\r?\nUsage: node pr-watch\.mjs /, args.join(' '));
    assert.equal(r.stdout, '', args.join(' '));
  }
  assert.equal(sc.calls().length, 0);
});

test('an already merged pull request is still watched: its red check is shown and the line says MERGED', () => {
  const log = [logLine('npm error code E404', 1, 'install', 'Run npm ci'), logLine('##[error]Process completed with exit code 1.', 2, 'install', 'Run npm ci')].join('\n');
  const sc = scenario({ view: [{ ...PR, state: 'MERGED' }], checks: [[check('install', 'fail', 777), check('lint', 'pass', 778)]], logs: { 777: log } });
  const r = run(sc);
  assert.equal(r.status, 1, r.all);
  assert.deepEqual(r.lines, [
    '--- install: failing lines (gh run view 777 --log-failed)',
    '  npm error code E404',
    '  ##[error]Process completed with exit code 1.',
    `PR CHECKS: FAIL — install · ${URL} (the PR is already MERGED)`,
  ]);
});

test('no check reported on a merged pull request: the line says MERGED and gives no "mark it ready" advice', () => {
  const r = run(scenario({ view: [{ ...PR, state: 'MERGED' }], checks: [NO_CHECKS] }));
  assert.equal(r.status, 3, r.all);
  assert.equal(r.last, 'PR CHECKS: NONE — no check reported (the PR is already MERGED)');
});

// A CI log and a check name are other people's text, and the author reads this output to decide.
test('text from a log or a check name never starts a line of its own: no forged result line', () => {
  const forged = 'PR CHECKS: PASS — 9 check(s) on 0123456789';
  const named = { ...check('unit', 'fail', 31), name: 'unit\n' + forged };
  // The Unicode line separator also starts a "line" for a reader that matches line by line.
  const separator = String.fromCharCode(0x2028);
  const log = [logLine('Error: boom\r' + forged, 1), logLine(forged, 2), logLine('Error: again' + separator + forged + ' again', 3)].join('\n');
  const sc = scenario({ checks: [[named]], logs: { 31: log } });
  const r = run(sc);
  assert.equal(r.status, 1, r.all);
  const results = r.stdout.split(/\r\n|\r|\n/).filter((line) => line.startsWith('PR CHECKS:'));
  assert.deepEqual(results, [`PR CHECKS: FAIL — unit ${forged} · ${URL}`]);
  assert.ok(r.stdout.includes('  Error: boom ' + forged), 'the log line is still shown, as one line');
  assert.ok(r.stdout.includes('  Error: again ' + forged + ' again') && !r.stdout.includes(separator), 'a line separator inside a log line is a space');
});

test('a pull request merged while its checks ran says so on the result line', () => {
  const sc = scenario({ view: [PR, { ...PR, state: 'MERGED' }], checks: [[check('unit', 'pending', 1)], [check('unit', 'pass', 1)]] });
  const r = run(sc, '--require', 'unit');   // 2026-11-18: names its required check
  assert.equal(r.status, 0, r.all);
  assert.equal(r.last, `PR CHECKS: PASS — required: unit passed on 0123456789 (0 other passed, 0 skipped) · ${URL} (the PR is already MERGED)`);
});

test('a check that starts after the others passed is not missed: one green look is never a PASS', () => {
  const build = check('build', 'pass', 1);
  const sc = scenario({
    checks: [[build], [build, check('deploy', 'pending', 1)], [build, check('deploy', 'fail', 1)]],
    logs: { 1: logLine('Error: the deploy step failed', 1, 'deploy', 'Deploy') },
  });
  const r = run(sc);
  assert.equal(r.status, 1, r.all);
  assert.doesNotMatch(r.stdout, /PR CHECKS: PASS/);
  assert.equal(r.last, `PR CHECKS: FAIL — deploy · ${URL}`);
  assert.ok(r.lines.includes('  Error: the deploy step failed'), r.stdout);
});

test('a cancelled check is red, and a bucket gh may add later never counts as passed', async () => {
  const r = run(scenario({ checks: [[check('unit', 'pass', 1), check('e2e', 'cancel', 2)]] }));
  assert.equal(r.status, 1, r.all);
  assert.equal(r.last, `PR CHECKS: FAIL — e2e (cancelled) · ${URL}`);

  const { bucketOf, tally } = await lib();
  assert.equal(bucketOf({ name: 'new', bucket: 'something-new' }), 'pending');
  assert.equal(bucketOf({ name: 'none' }), 'pending');
  const t = tally([check('a', 'pass'), check('b', 'skipping'), check('c', 'fail'), check('d', 'cancel'), check('e', 'pending')]);
  assert.deepEqual([t.pass.length, t.skip.length, t.fail.length, t.pending.length], [1, 1, 2, 1]);
});

test('one call that fails is asked again; three in a row end the watch with gh\'s own error', () => {
  const blip = { err: 'HTTP 502: Bad Gateway (https://api.github.com/graphql)', code: 1 };
  const once = run(scenario({ checks: [blip, [check('unit', 'pass', 1)]] }), '--require', 'unit');   // 2026-11-18: names its required check
  assert.equal(once.status, 0, once.all);
  assert.deepEqual(once.lines, [
    '  GitHub did not answer (HTTP 502: Bad Gateway (https://api.github.com/graphql)): asking again',
    '  all 1 passed: one more look, a check may start late',
    `PR CHECKS: PASS — required: unit passed on 0123456789 (0 other passed, 0 skipped) · ${URL}`,
  ]);

  const down = scenario({ checks: [blip] });
  const r = run(down);
  assert.equal(r.status, 2, r.all);
  assert.equal(r.last, 'PR CHECKS: could not ask GitHub — HTTP 502: Bad Gateway (https://api.github.com/graphql)');
  assert.equal(down.asked('pr checks').length, 3);
});

// ---- repairs, 2026-11-17 (review findings 1-5) ----
const gitIn = (repo, ...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8', windowsHide: true });
function gitRepo(sc) {
  gitIn(sc.repo, 'init', '-q');
  gitIn(sc.repo, 'add', 'this-is-the-repo.txt');
  gitIn(sc.repo, 'commit', '-q', '-m', 'one');
  return gitIn(sc.repo, 'rev-parse', 'HEAD').stdout.trim();
}
const YELLOW = 'https://github.com/marketplace/wip';
const wip = { name: 'WIP', bucket: 'pending', state: 'IN_PROGRESS', link: YELLOW };

test('a dotnet log: 45 "Passed" lines do not hide the real Failed line and its Error Message', async () => {
  const { failingLines } = await lib();
  const passed = Array.from({ length: 45 }, (_, i) => `  Passed Ns.Tests.Validate_Case${i}_ShouldReturnError [1 ms]`);
  const plain = Array.from({ length: 20 }, (_, i) => `plain line ${i}`);
  const { lines } = failingLines([...passed, '  Failed Ns.Tests.Real_Test [152 ms]', '  Error Message:', ...plain].join('\n'));
  assert.ok(lines.includes('  Failed Ns.Tests.Real_Test [152 ms]'), lines.join('\n'));
  assert.ok(lines.includes('  Error Message:'));
  assert.equal(lines.filter((l) => /^Passed/.test(l)).length, 0);
});

test('over the limit, strong lines (Failed, Error Message, ##[error]) come before plain "failed" warnings', async () => {
  const { failingLines } = await lib();
  const warns = Array.from({ length: 50 }, (_, i) => `[10:00:${i} WRN] request ${i} failed, retrying`);
  const plain = Array.from({ length: 20 }, (_, i) => `plain line ${i}`);
  const { lines, more } = failingLines([...warns, '  Failed Ns.Tests.Real_Test [152 ms]', '  Error Message:', ...plain].join('\n'));
  assert.ok(lines.includes('  Failed Ns.Tests.Real_Test [152 ms]'), lines.join('\n'));
  assert.ok(lines.includes('  Error Message:'));
  assert.equal(lines.length - 15, 40, 'still at most 40 problem lines plus the tail');
  assert.equal(more, 12);
  assert.ok(lines.indexOf('[10:00:0 WRN] request 0 failed, retrying') < lines.indexOf('  Failed Ns.Tests.Real_Test [152 ms]'), 'log order kept');
});

test('a pull request head that is not your commit is not a PASS: exit 3, push first', () => {
  const sc = scenario({ view: [{ ...PR, headRefOid: 'a'.repeat(40) }], checks: [[check('unit', 'pass', 1)]] });
  const mine = gitRepo(sc);
  const r = run(sc);
  assert.equal(r.status, 3, r.all);
  assert.equal(r.last, `PR CHECKS: NOT YOUR COMMIT — the PR head aaaaaaaaaa is not your commit ${mine.slice(0, 10)}: push first · ${URL}`);
  assert.doesNotMatch(r.stdout, /PASS/);
  assert.equal(sc.asked('pr checks').length, 0);

  const same = scenario({ view: [{ ...PR, headRefOid: '' }], checks: [[check('unit', 'pass', 1)]] });
  const head = gitRepo(same);
  fs.writeFileSync(same.file, JSON.stringify({ view: [{ out: { ...PR, headRefOid: head } }], checks: [{ out: [check('unit', 'pass', 1)] }], logs: {} }));
  const ok = run(same, '--require', 'unit');   // 2026-11-18: names its required check
  assert.equal(ok.status, 0, ok.all);
  // --pr named: the user chose that pull request, so no comparison with this folder's commit.
  const named = run(sc, '--pr', '12', '--require', 'unit');
  assert.equal(named.status, 0, named.all);
});

test('a draft whose only pending check is not an Actions run ends as DRAFT after three looks, exit 3', () => {
  const sc = scenario({ view: [{ ...PR, isDraft: true }], checks: [[wip]] });
  const r = run(sc, '--timeout-min', '0.2');
  assert.equal(r.status, 3, r.all);
  assert.equal(r.last, 'PR CHECKS: DRAFT — WIP is pending and no CI run started; this pull request is a DRAFT: mark it ready');
  assert.equal(sc.asked('pr checks').length, 3);
});

test('on a draft, a red Actions check is reported without waiting for a check that has no run', () => {
  const sc = scenario({ view: [{ ...PR, isDraft: true }], checks: [[check('unit', 'fail', 5), wip]], logs: { 5: logLine('FAIL src/a.test.ts', 1) } });
  const r = run(sc, '--timeout-min', '0.2');
  assert.equal(r.status, 1, r.all);
  assert.ok(sc.asked('pr checks').length <= 2, 'asked ' + sc.asked('pr checks').length + ' times');
  assert.match(r.last, /^PR CHECKS: FAIL — unit \(not waited for: WIP\)/);
});

test('a draft with skipped CI and one outside check passing is not a PASS: DRAFT, exit 3', () => {
  const header = { name: 'Header rules - site', bucket: 'pass', state: 'SUCCESS', link: 'https://app.netlify.com/x' };
  const sc = scenario({ view: [{ ...PR, isDraft: true }], checks: [[header, check('Build & test', 'skipping'), check('sast', 'skipping')]] });
  const r = run(sc);
  assert.equal(r.status, 3, r.all);
  assert.equal(r.last, 'PR CHECKS: DRAFT — 2 skipped, 1 passed: mark it ready');
  assert.doesNotMatch(r.stdout, /PASS/);
});

test('guard: a green list first seen at the time limit still gets its second look and ends PASS', () => {
  const sc = scenario({ checks: [[check('unit', 'pending', 1)], [check('unit', 'pass', 1)]] });
  const r = run(sc, '--interval-sec', '1', '--timeout-min', '0.012', '--require', 'unit');   // 2026-11-18: names its required check
  assert.equal(r.status, 0, r.all);
});

test('guard: a call that failed before the time limit is "could not ask", never NONE', () => {
  const r = run(scenario({ checks: [{ err: 'HTTP 502: Bad Gateway', code: 1 }] }), '--timeout-min', '0.001');
  assert.equal(r.status, 2, r.all);
  assert.equal(r.last, 'PR CHECKS: could not ask GitHub — HTTP 502: Bad Gateway');
});

test('guard: a crash while reading the list is exit 2 "could not ask", never a red check', () => {
  const r = run(scenario({ checks: [[null]] }));
  assert.equal(r.status, 2, r.all);
  assert.match(r.last, /^PR CHECKS: could not ask GitHub — /);
});

// ---- audit finding 1, 2026-11-17: a verdict belongs to the commit that is the PR head at the end ----
const HEAD_A = 'a'.repeat(40), HEAD_B = 'b'.repeat(40);

test('head changed while watching, time is out: not a PASS, exit 4 and it says the head changed', () => {
  // Checks stay pending to the time limit; the final read shows another commit.
  const sc = scenario({ view: [{ ...PR, headRefOid: HEAD_A }, { ...PR, headRefOid: HEAD_B }], checks: [[check('unit', 'pending', 1)]] });
  const r = run(sc, '--pr', '12', '--timeout-min', '0.01');
  assert.equal(r.status, 4, r.all);
  assert.match(r.last, /^PR CHECKS: PENDING — the PR head changed from aaaaaaaaaa to bbbbbbbbbb while watching/);
  assert.doesNotMatch(r.stdout, /PASS|FAIL/);
});

test('head changed while watching, checks were green on the old commit: never PASS on the new head', () => {
  // The reproduced case: green on aaaa, final read bbbb, time is out at once.
  const sc = scenario({ view: [{ ...PR, headRefOid: HEAD_A }, { ...PR, headRefOid: HEAD_B }], checks: [[check('unit', 'pass', 1)]] });
  const r = run(sc, '--pr', '12', '--interval-sec', '0.2', '--timeout-min', '0.001');
  assert.equal(r.status, 4, r.all);
  assert.doesNotMatch(r.stdout, /PASS/);
  assert.match(r.last, /head changed from aaaaaaaaaa to bbbbbbbbbb/);
});

test('head changed while watching, a red check on the old commit: not a FAIL for the new head either', () => {
  const sc = scenario({ view: [{ ...PR, headRefOid: HEAD_A }, { ...PR, headRefOid: HEAD_B }], checks: [[check('unit', 'fail', 5)]], logs: { 5: logLine('FAIL src/a.test.ts', 1) } });
  const r = run(sc, '--pr', '12', '--timeout-min', '0.001');
  assert.equal(r.status, 4, r.all);
  assert.doesNotMatch(r.stdout, /PR CHECKS: FAIL/);
  assert.match(r.last, /head changed from aaaaaaaaaa to bbbbbbbbbb/);
});

test('head changed while watching, time remains: the old result is forgotten and the new commit is watched to PASS', () => {
  const green = [check('unit', 'pass', 1)];
  const sc = scenario({ view: [{ ...PR, headRefOid: HEAD_A }, { ...PR, headRefOid: HEAD_B }], checks: [green, green, [check('unit', 'pending', 2)], green] });
  const r = run(sc, '--pr', '12', '--require', 'unit');   // 2026-11-18: names its required check
  assert.equal(r.status, 0, r.all);
  assert.equal(r.last, `PR CHECKS: PASS — required: unit passed on bbbbbbbbbb (0 other passed, 0 skipped) · ${URL}`);
  assert.ok(r.lines.some((l) => /head changed from aaaaaaaaaa to bbbbbbbbbb/.test(l)), r.stdout);
  // The new commit got its own looks: pending first, then green twice (the old green was not reused).
  assert.ok(sc.asked('pr checks').length >= 5, 'asked ' + sc.asked('pr checks').length);
});

test('the final read of the pull request fails: exit 2 "could not ask GitHub", never PASS', () => {
  const sc = scenario({ view: [{ ...PR, headRefOid: HEAD_A }, { err: 'HTTP 502: Bad Gateway', code: 1 }], checks: [[check('unit', 'pass', 1)]] });
  const r = run(sc, '--pr', '12');
  assert.equal(r.status, 2, r.all);
  assert.equal(r.last, 'PR CHECKS: could not ask GitHub — HTTP 502: Bad Gateway');
  assert.doesNotMatch(r.stdout, /PASS/);
});

// 2026-11-17 (round 2): four repairs, each with its own test.
function gitFolder(sc) {
  const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: sc.repo, encoding: 'utf8', windowsHide: true });
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'one');
  return git('rev-parse', 'HEAD').stdout.trim();
}

test('no --pr: a head that moves to a commit that is not the folder commit is NOT YOUR COMMIT, never PASS', () => {
  const sc = scenario({ checks: [[check('unit', 'pass', 1)]] });
  const mine = gitFolder(sc);
  fs.writeFileSync(sc.file, JSON.stringify({
    view: [{ out: { ...PR, headRefOid: mine } }, { out: { ...PR, headRefOid: HEAD_B } }],
    checks: [{ out: [check('unit', 'pass', 1)] }], logs: {},
  }));
  const r = run(sc);
  assert.equal(r.status, 3, r.all);
  assert.match(r.last, /^PR CHECKS: NOT YOUR COMMIT — the PR head bbbbbbbbbb is not your commit /);
  assert.doesNotMatch(r.stdout, /PASS/);
});

test('one failed final read is asked again: a red check still shows its failing lines and FAIL', () => {
  const sc = scenario({
    view: [{ ...PR, headRefOid: HEAD_A }, { err: 'HTTP 502: Bad Gateway', code: 1 }, { ...PR, headRefOid: HEAD_A }],
    checks: [[check('unit', 'fail', 5)]], logs: { 5: logLine('FAIL src/a.test.ts', 1) },
  });
  const r = run(sc, '--pr', '12');
  assert.equal(r.status, 1, r.all);
  assert.ok(r.lines.some((l) => /FAIL src\/a\.test\.ts/.test(l)), r.stdout);
  assert.match(r.last, /^PR CHECKS: FAIL — unit/);
});

test('one failed final read is asked again: green checks still end as PASS', () => {
  const sc = scenario({
    view: [{ ...PR, headRefOid: HEAD_A }, { err: 'HTTP 502: Bad Gateway', code: 1 }, { ...PR, headRefOid: HEAD_A }],
    checks: [[check('unit', 'pass', 1)]],
  });
  const r = run(sc, '--pr', '12', '--require', 'unit');   // 2026-11-18: names its required check
  assert.equal(r.status, 0, r.all);
  assert.equal(r.last, `PR CHECKS: PASS — required: unit passed on aaaaaaaaaa (0 other passed, 0 skipped) · ${URL}`);
});

test('a head change found just before the time limit ends as PENDING "head changed" (exit 4), not NONE', () => {
  const sc = scenario({
    view: [{ ...PR, headRefOid: HEAD_A }, { ...PR, headRefOid: HEAD_B }],
    checks: [[check('unit', 'pass', 1)], [check('unit', 'pass', 1)], NO_CHECKS],
  });
  const r = run(sc, '--pr', '12', '--interval-sec', '2', '--timeout-min', '0.05');
  assert.equal(r.status, 4, r.all);
  assert.match(r.last, /^PR CHECKS: PENDING — the PR head changed from aaaaaaaaaa to bbbbbbbbbb/);
  assert.doesNotMatch(r.stdout, /NONE/);
});

test('a head change forgets the old green look: the new commit gets two looks of its own', () => {
  const sc = scenario({ view: [{ ...PR, headRefOid: HEAD_A }, { ...PR, headRefOid: HEAD_B }], checks: [[check('unit', 'pass', 1)]] });
  const r = run(sc, '--pr', '12', '--require', 'unit');   // 2026-11-18: names its required check
  assert.equal(r.status, 0, r.all);
  assert.equal(r.last, `PR CHECKS: PASS — required: unit passed on bbbbbbbbbb (0 other passed, 0 skipped) · ${URL}`);
  assert.equal(sc.asked('pr checks').length, 4, 'two looks on aaaa, two on bbbb');
});

// ---- audit findings 1 and 8, 2026-11-18 ----
// 1: PASS only when every REQUIRED check ran and passed on the final head. The required names come from
// --require, else git config sanad.requiredChecks, else GitHub's own list (gh pr checks --required).
// 8: a failed job's failing lines are shown at once, while the other checks are still watched.
const IN_PROGRESS = { err: 'run 555 is still in progress; logs will be available when it is complete', code: 1 };
const NOT_PROVEN = (passed, skipped, seen) => `PR CHECKS: NOT PROVEN — ${passed} passed, ${skipped} skipped, but no required check is named: run again with --require "<job name>" or set git config sanad.requiredChecks (seen: ${seen})`;

test('1: only a passing lint, with no required check named anywhere, is NOT PROVEN (exit 3), never PASS', () => {
  const sc = scenario({ checks: [[check('lint', 'pass', 1)]] });
  const r = run(sc, '--pr', '12');
  assert.equal(r.status, 3, r.all);
  assert.equal(r.last, NOT_PROVEN(1, 0, 'lint'));
  assert.doesNotMatch(r.stdout, /PR CHECKS: PASS/);
  // GitHub's own list was asked, with the flag gh really has.
  // 2026-11-18: asked again at every settled look (two looks before a PASS), never kept.
  const asked = sc.asked('pr checks required').map((c) => c.args);
  assert.equal(asked.length, 2);
  assert.ok(asked.every((a) => a.join(' ') === 'pr checks 12 --required --json name,bucket'));
});

test('1: a passing lint plus a SKIPPED full suite, nothing required named, is NOT PROVEN (exit 3)', () => {
  const r = run(scenario({ checks: [[check('lint', 'pass', 1), check('Full suite', 'skipping')]] }));
  assert.equal(r.status, 3, r.all);
  assert.equal(r.last, NOT_PROVEN(1, 1, 'lint, Full suite'));
});

test('1: a required check that was skipped is never PASS: NOT PROVEN, exit 3', () => {
  const r = run(scenario({ checks: [[check('lint', 'pass', 1), check('Full suite', 'skipping')]] }), '--require', 'Full suite');
  assert.equal(r.status, 3, r.all);
  assert.equal(r.last, 'PR CHECKS: NOT PROVEN — required check "Full suite" was skipped');
  assert.doesNotMatch(r.stdout, /PR CHECKS: PASS/);
});

test('1: a required check whose name is also listed as skipped by a twin job is not proven', () => {
  const r = run(scenario({ checks: [[check('build', 'pass', 1), check('build', 'skipping')]] }), '--require', 'build');
  assert.equal(r.status, 3, r.all);
  assert.equal(r.last, 'PR CHECKS: NOT PROVEN — required check "build" was skipped');
});

test('1: an honest skip of a check that is not required does not block: PASS names the required check and the counts', () => {
  const sc = scenario({ checks: [[check('Build & test', 'pass', 1), check('frontend image', 'skipping'), check('lint', 'pass', 2)]] });
  const r = run(sc, '--require', 'Build & test');
  assert.equal(r.status, 0, r.all);
  assert.equal(r.last, `PR CHECKS: PASS — required: Build & test passed on 0123456789 (1 other passed, 1 skipped) · ${URL}`);
});

test('1: a required check that is never listed stays pending until the time is out: exit 4', () => {
  const sc = scenario({ checks: [[check('lint', 'pass', 1)]] });
  const r = run(sc, '--require', 'Full suite', '--timeout-min', '0.01');
  assert.equal(r.status, 4, r.all);
  // 2026-11-18 (finding 6): the line shows the names that were listed.
  assert.equal(r.last, 'PR CHECKS: PENDING — required check "Full suite" never reported (seen: lint)');
  assert.doesNotMatch(r.stdout, /PASS/);
});

test('1: a required check that is listed late is not missed', () => {
  const lint = check('lint', 'pass', 1);
  const sc = scenario({ checks: [[lint], [lint], [lint, check('Full suite', 'pending', 2)], [lint, check('Full suite', 'pass', 2)]] });
  const r = run(sc, '--require', 'Full suite');
  assert.equal(r.status, 0, r.all);
  assert.equal(r.last, `PR CHECKS: PASS — required: Full suite passed on 0123456789 (1 other passed, 0 skipped) · ${URL}`);
});

test('1: names match exactly after trim, without case; --require may repeat and holds commas', () => {
  const sc = scenario({ checks: [[check('unit', 'pass', 1), check('e2e', 'pass', 2), check('lint', 'pass', 3), check('docs', 'pass', 4)]] });
  const r = run(sc, '--require', '  UNIT , e2e', '--require', 'Lint');
  assert.equal(r.status, 0, r.all);
  assert.equal(r.last, `PR CHECKS: PASS — required: UNIT, e2e, Lint passed on 0123456789 (1 other passed, 0 skipped) · ${URL}`);
  // Exactly: "unit" does not name "unit-tests".
  const part = run(scenario({ checks: [[check('unit-tests', 'pass', 1)]] }), '--require', 'unit', '--timeout-min', '0.01');
  assert.equal(part.status, 4, part.all);
  assert.equal(part.last, 'PR CHECKS: PENDING — required check "unit" never reported (seen: unit-tests)');
});

test('1: git config sanad.requiredChecks names the required checks (several values, commas inside); --require adds to it', () => {
  const lone = scenario({ checks: [[check('unit', 'pass', 1), check('lint', 'pass', 2)]] });
  gitRepo(lone);
  gitIn(lone.repo, 'config', '--add', 'sanad.requiredChecks', 'unit, e2e');
  gitIn(lone.repo, 'config', '--add', 'sanad.requiredChecks', 'lint');
  const missing = run(lone, '--pr', '12', '--timeout-min', '0.01');
  assert.equal(missing.status, 4, missing.all);
  assert.equal(missing.last, 'PR CHECKS: PENDING — required check "e2e" never reported (seen: unit, lint)');
  // 2026-11-18 (finding 4): the config adds to GitHub's list, so GitHub is asked too.
  assert.ok(lone.asked('pr checks required').length > 0, 'GitHub\'s list is asked as well');

  const full = scenario({ checks: [[check('unit', 'pass', 1), check('lint', 'pass', 2), check('e2e', 'pass', 3)]] });
  gitRepo(full);
  gitIn(full.repo, 'config', '--add', 'sanad.requiredChecks', 'unit, e2e');
  gitIn(full.repo, 'config', '--add', 'sanad.requiredChecks', 'lint');
  const ok = run(full, '--pr', '12');
  assert.equal(ok.status, 0, ok.all);
  assert.equal(ok.last, `PR CHECKS: PASS — required: unit, e2e, lint passed on 0123456789 (0 other passed, 0 skipped) · ${URL}`);

  // 2026-11-18 (finding 4): --require adds to the config, it never replaces it: "e2e" is still required.
  const over = run(lone, '--pr', '12', '--require', 'unit', '--timeout-min', '0.01');
  assert.equal(over.status, 4, over.all);
  assert.equal(over.last, 'PR CHECKS: PENDING — required check "e2e" never reported (seen: unit, lint)');
});

test('1: with no option and no config, the list of required checks from GitHub is used', () => {
  const sc = scenario({ checks: [[check('Build', 'pass', 1), check('lint', 'pass', 2)]], required: [['Build']] });
  const r = run(sc, '--pr', '12');
  assert.equal(r.status, 0, r.all);
  assert.equal(r.last, `PR CHECKS: PASS — required: Build passed on 0123456789 (1 other passed, 0 skipped) · ${URL}`);
});

test('1: a required check from GitHub that was skipped is NOT PROVEN, and a draft keeps its DRAFT line', () => {
  const list = [check('Build', 'skipping'), check('lint', 'pass', 2)];
  const ready = run(scenario({ checks: [list], required: [['Build']] }), '--pr', '12');
  assert.equal(ready.status, 3, ready.all);
  assert.equal(ready.last, 'PR CHECKS: NOT PROVEN — required check "Build" was skipped');
  const draft = run(scenario({ view: [{ ...PR, isDraft: true }], checks: [list], required: [['Build']] }), '--pr', '12');
  assert.equal(draft.status, 3, draft.all);
  assert.equal(draft.last, 'PR CHECKS: DRAFT — 1 skipped, 1 passed: mark it ready');
});

test('1: the list of required checks cannot be read three times: could not ask GitHub, exit 2, never PASS', () => {
  const sc = scenario({ checks: [[check('lint', 'pass', 1)]], required: [{ err: 'HTTP 502: Bad Gateway', code: 1 }] });
  const r = run(sc, '--pr', '12');
  assert.equal(r.status, 2, r.all);
  assert.equal(r.last, 'PR CHECKS: could not ask GitHub — HTTP 502: Bad Gateway');
  assert.doesNotMatch(r.stdout, /PASS/);
  assert.equal(sc.asked('pr checks required').length, 3);
});

test('must not change: a failed check is FAIL whether it is required or not, even when the required one passed', () => {
  const sc = scenario({ checks: [[check('unit', 'pass', 1), check('lint', 'fail', 2)]], logs: { 2: logLine('Error: lint broke', 1) } });
  const r = run(sc, '--require', 'unit');
  assert.equal(r.status, 1, r.all);
  assert.equal(r.last, `PR CHECKS: FAIL — lint · ${URL}`);
  const req = run(scenario({ checks: [[check('unit', 'fail', 1)]], logs: { 1: logLine('Error: unit broke', 1) } }), '--require', 'unit');
  assert.equal(req.status, 1, req.all);
});

test('1: --require with no name in it is a usage error: exit 2, GitHub is not asked', () => {
  const sc = scenario();
  for (const value of [',', ' , ,']) {
    const r = run(sc, '--require', value);
    assert.equal(r.status, 2, value + ' → ' + r.all);
    assert.match(r.stderr, /^PR CHECKS: .+\r?\nUsage: node pr-watch\.mjs .*--require/, value);
  }
  assert.equal(sc.calls().length, 0);
});

test('8: a red job is shown at the look that finds it, while another check is still pending', () => {
  const log = (id, text) => ({ [id]: logLine(text, 1) });
  const sc = scenario({
    checks: [[check('unit', 'fail', 5), check('e2e', 'pending', 6), check('lint', 'pending', 7)],
      [check('unit', 'fail', 5), check('e2e', 'pending', 6), check('lint', 'pending', 7)],
      [check('unit', 'fail', 5), check('e2e', 'fail', 6), check('lint', 'pass', 7)]],
    logs: { ...log(5, 'FAIL unit.test.ts'), ...log(6, 'FAIL e2e.test.ts') },
  });
  const r = run(sc);
  assert.equal(r.status, 1, r.all);
  const kinds = sc.calls().map((c) => c.kind);
  assert.equal(kinds[2], 'run view', 'the first red job is read at once: ' + kinds.join(', '));
  assert.deepEqual(sc.asked('run view').map((c) => c.args[2]), ['5', '6'], 'each failed job once');
  assert.deepEqual(r.lines, [
    '  waiting: 2 pending, 0 passed, 1 failed',
    '--- unit: failing lines (gh run view 5 --log-failed)',
    '  FAIL unit.test.ts',
    '--- e2e: failing lines (gh run view 6 --log-failed)',
    '  FAIL e2e.test.ts',
    `PR CHECKS: FAIL — unit, e2e · ${URL}`,
  ]);
});

test('8: two failed jobs of one run: the same log lines are never printed twice', () => {
  const log = [logLine('FAIL src/a.test.ts', 1), logLine('Error: boom', 2)].join('\n');
  // Real gh gives no log of a run that still has a job running (2026-11-18, finding 2).
  const sc = scenario({
    checks: [[check('unit', 'fail', 5), check('e2e', 'pending', 5)], [check('unit', 'fail', 5), check('e2e', 'fail', 5)]],
    logs: { 5: [IN_PROGRESS, log] },
  });
  const r = run(sc);
  assert.equal(r.status, 1, r.all);
  assert.equal(r.lines.filter((l) => l === '  FAIL src/a.test.ts').length, 1, r.stdout);
  assert.equal(r.lines.filter((l) => l === '  Error: boom').length, 1, r.stdout);
  assert.equal(r.last, `PR CHECKS: FAIL — unit, e2e · ${URL}`);
});

// ---- audit repairs, 2026-11-18 (second round: findings 1-8 of the audit of the first repair) ----
test('r1a: GitHub\'s required list is asked again at every settled look: a required check that appears late and is skipped is NOT PROVEN', () => {
  const lint = check('lint', 'pass', 1);
  const sc = scenario({
    checks: [[lint], [lint, check('unit', 'pending', 2)], [lint, check('unit', 'skipping')]],
    required: [['lint'], ['lint', 'unit']],
  });
  const r = run(sc, '--pr', '12');
  assert.equal(r.status, 3, r.all);
  assert.equal(r.last, 'PR CHECKS: NOT PROVEN — required check "unit" was skipped');
  assert.doesNotMatch(r.stdout, /PR CHECKS: PASS/);
});

test('r1b: a new head gets GitHub\'s list again, not the answer given for the old head', () => {
  const lint = check('lint', 'pass', 1);
  const sc = scenario({
    view: [{ ...PR, headRefOid: HEAD_A }, { ...PR, headRefOid: HEAD_B }],
    checks: [[lint], [lint], [lint, check('unit', 'skipping')]],
    required: [['lint'], ['lint'], ['lint', 'unit']],
  });
  const r = run(sc, '--pr', '12');
  assert.equal(r.status, 3, r.all);
  assert.equal(r.last, 'PR CHECKS: NOT PROVEN — required check "unit" was skipped');
});

test('r1c: right after a push GitHub says "no required checks" while nothing is listed: the later list still counts', () => {
  const sc = scenario({ checks: [NO_CHECKS, [check('unit', 'pending', 1)], [check('unit', 'pass', 1)]], required: [['unit']] });
  const r = run(sc, '--pr', '12');
  assert.equal(r.status, 0, r.all);
  assert.equal(r.last, `PR CHECKS: PASS — required: unit passed on 0123456789 (0 other passed, 0 skipped) · ${URL}`);
});

test('r3: a check name with a comma (a matrix job) can be required: from GitHub, from --require, from git config', () => {
  const name = 'test (ubuntu-latest, 20)';
  const list = [check(name, 'pass', 1), check('lint', 'pass', 2)];
  const viaGitHub = run(scenario({ checks: [list], required: [[name]] }), '--pr', '12');
  assert.equal(viaGitHub.status, 0, viaGitHub.all);
  assert.equal(viaGitHub.last, `PR CHECKS: PASS — required: ${name} passed on 0123456789 (1 other passed, 0 skipped) · ${URL}`);
  const typed = run(scenario({ checks: [list] }), '--require', name + ', lint');
  assert.equal(typed.status, 0, typed.all);
  assert.equal(typed.last, `PR CHECKS: PASS — required: ${name}, lint passed on 0123456789 (0 other passed, 0 skipped) · ${URL}`);
  const cfg = scenario({ checks: [list] });
  gitRepo(cfg);
  gitIn(cfg.repo, 'config', '--add', 'sanad.requiredChecks', name);
  const viaConfig = run(cfg, '--pr', '12');
  assert.equal(viaConfig.status, 0, viaConfig.all);
  // Not yet listed: a comma inside brackets still does not split the name.
  const late = run(scenario({ checks: [[check('lint', 'pass', 2)]] }), '--require', name, '--timeout-min', '0.01');
  assert.equal(late.last, `PR CHECKS: PENDING — required check "${name}" never reported (seen: lint)`);
});

test('r4: --require adds to the git config and to GitHub\'s list, it never drops a name', () => {
  const list = [check('lint', 'pass', 1), check('unit', 'skipping')];
  const cfg = scenario({ checks: [list] });
  gitRepo(cfg);
  gitIn(cfg.repo, 'config', '--add', 'sanad.requiredChecks', 'unit,lint');
  const a = run(cfg, '--pr', '12', '--require', 'lint');
  assert.equal(a.status, 3, a.all);
  assert.equal(a.last, 'PR CHECKS: NOT PROVEN — required check "unit" was skipped');
  const b = run(scenario({ checks: [list], required: [['unit']] }), '--pr', '12', '--require', 'lint');
  assert.equal(b.status, 3, b.all);
  assert.equal(b.last, 'PR CHECKS: NOT PROVEN — required check "unit" was skipped');
});

test('r5: a required check that is already skipped is said once, and is in the PENDING line', () => {
  const sc = scenario({ checks: [[check('unit', 'skipping'), check('deploy', 'pending', 3)]] });
  const r = run(sc, '--require', 'unit', '--timeout-min', '0.01');
  assert.equal(r.status, 4, r.all);
  assert.equal(r.lines.filter((l) => l === '  required check "unit" was skipped: this can never be a PASS').length, 1, r.stdout);
  assert.equal(r.last, 'PR CHECKS: PENDING after 0.01 min — deploy; required check "unit" was skipped');
});

test('r6: a required name that matches no listed check shows the real names, once at the first settled look and at the end', () => {
  const sc = scenario({ checks: [[check('unit', 'pass', 1), check('lint', 'pass', 2)]] });
  const r = run(sc, '--require', 'CI / unit', '--timeout-min', '0.01');
  assert.equal(r.status, 4, r.all);
  assert.equal(r.lines.filter((l) => l === '  required check "CI / unit" not listed yet (seen: unit, lint): waiting').length, 1, r.stdout);
  assert.equal(r.last, 'PR CHECKS: PENDING — required check "CI / unit" never reported (seen: unit, lint)');
});

test('r7: a draft with nothing passed and a required name not listed ends on the third look with the DRAFT line', () => {
  const draft = { ...PR, isDraft: true };
  const none = scenario({ view: [draft], checks: [NO_CHECKS] });
  const a = run(none, '--require', 'unit');
  assert.equal(a.status, 3, a.all);
  assert.equal(a.last, 'PR CHECKS: NONE — no check reported; this pull request is a DRAFT and a draft may skip CI: mark it ready');
  assert.equal(none.asked('pr checks').length, 3);
  const cfg = scenario({ view: [draft], checks: [[check('changes', 'skipping')]] });
  gitRepo(cfg);
  gitIn(cfg.repo, 'config', '--add', 'sanad.requiredChecks', 'unit');
  const b = run(cfg, '--pr', '12');
  assert.equal(b.status, 3, b.all);
  assert.equal(b.last, 'PR CHECKS: NONE — no check ran (1 skipped); this pull request is a DRAFT and a draft may skip CI: mark it ready');
  // A ready pull request with a missing required name still waits.
  const ready = run(scenario({ checks: [NO_CHECKS] }), '--require', 'unit', '--timeout-min', '0.01');
  assert.equal(ready.status, 4, ready.all);
});

test('r8: a red job whose run still has a job running is shown at once from its own job log, never twice', () => {
  const log = [logLine('FAIL src/a.test.ts', 1), logLine('Error: boom', 2)].join('\n');
  const sc = scenario({
    checks: [[check('unit', 'fail', 555), check('e2e', 'pending', 555)], [check('unit', 'fail', 555), check('e2e', 'pending', 555)], [check('unit', 'fail', 555), check('e2e', 'pass', 555)]],
    logs: { 555: [IN_PROGRESS, IN_PROGRESS, IN_PROGRESS] },
    jobLogs: { 55500: log },
  });
  const r = run(sc);
  assert.equal(r.status, 1, r.all);
  assert.deepEqual(r.lines, [
    '  waiting: 1 pending, 0 passed, 1 failed',
    '--- unit: failing lines (gh run view 555 --job 55500 --log-failed)',
    '  FAIL src/a.test.ts',
    '  Error: boom',
    `PR CHECKS: FAIL — unit · ${URL}`,
  ]);
});

test('r8: a run log that gh gives only when the run is complete is asked again, and "no log came back" is not said', () => {
  const log = [logLine('FAIL src/a.test.ts', 1), logLine('Error: boom', 2)].join('\n');
  const sc = scenario({
    checks: [[check('unit', 'fail', 555), check('e2e', 'pending', 555)], [check('unit', 'fail', 555), check('e2e', 'pending', 555)], [check('unit', 'fail', 555), check('e2e', 'pass', 555)]],
    logs: { 555: [IN_PROGRESS, IN_PROGRESS, log] },
  });
  const r = run(sc);
  assert.equal(r.status, 1, r.all);
  assert.doesNotMatch(r.stdout, /no log came back/);
  assert.equal(r.lines.filter((l) => l === '  FAIL src/a.test.ts').length, 1, r.stdout);
  assert.equal(r.last, `PR CHECKS: FAIL — unit · ${URL}`);
  // Later looks ask again only while nothing was printed.
  assert.equal(sc.asked('run view').filter((c) => c.args.length === 4).length, 3, sc.calls().map((c) => c.args.join(' ')).join('\n'));
});

test('r8: a log that never comes is said once, at the end', () => {
  const sc = scenario({
    checks: [[check('unit', 'fail', 555), check('e2e', 'pending', 555)], [check('unit', 'fail', 555), check('e2e', 'pass', 555)]],
    logs: { 555: [IN_PROGRESS] },
  });
  const r = run(sc);
  assert.equal(r.status, 1, r.all);
  assert.equal(r.lines.filter((l) => /no log came back/.test(l)).length, 1, r.stdout);
});

test('must not change: the same head at the end is a PASS on that commit', () => {
  const sc = scenario({ view: [{ ...PR, headRefOid: HEAD_A }, { ...PR, headRefOid: HEAD_A }], checks: [[check('unit', 'pass', 1)]] });
  const r = run(sc, '--pr', '12', '--require', 'unit');   // 2026-11-18: names its required check
  assert.equal(r.status, 0, r.all);
  assert.equal(r.last, `PR CHECKS: PASS — required: unit passed on aaaaaaaaaa (0 other passed, 0 skipped) · ${URL}`);
});

// ---- audit round 3, 2026-11-18: findings 1 (configured requirements of the base branch) and 2 (draft) ----
const ruleset = (...names) => [{ type: 'deletion' }, { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, required_status_checks: names.map((context) => ({ context, integration_id: 15368 })) } }];
const FORBIDDEN = { err: 'gh: Resource not accessible by integration (HTTP 403)', code: 1 };
const UNREAD = " (GitHub's configured required list could not be read)";

test('r3-1: a suite required by a ruleset that never started is never a PASS: PENDING, exit 4', () => {
  const sc = scenario({ checks: [[check('lint', 'pass', 1)]], rules: [ruleset('Full suite')] });
  const r = run(sc, '--pr', '12', '--require', 'lint', '--timeout-min', '0.01');
  assert.equal(r.status, 4, r.all);
  assert.equal(r.last, 'PR CHECKS: PENDING — required check "Full suite" never reported (seen: lint)');
  assert.doesNotMatch(r.stdout, /PR CHECKS: PASS/);
  // The base branch is read by gh, the rules by the repository's own placeholders.
  assert.deepEqual(sc.asked('api rules')[0].args, ['api', '--paginate', '--slurp', 'repos/{owner}/{repo}/rules/branches/main?per_page=100']);
  assert.deepEqual(sc.asked('api protection')[0].args, ['api', 'repos/{owner}/{repo}/branches/main/protection/required_status_checks']);
});

test('r3-1: a suite required by classic branch protection (contexts and checks) that never started is not a PASS', () => {
  const viaContexts = scenario({ checks: [[check('lint', 'pass', 1)]], protection: [{ strict: false, contexts: ['Full suite'], checks: [] }] });
  const a = run(viaContexts, '--pr', '12', '--require', 'lint', '--timeout-min', '0.01');
  assert.equal(a.status, 4, a.all);
  assert.equal(a.last, 'PR CHECKS: PENDING — required check "Full suite" never reported (seen: lint)');
  const viaChecks = scenario({ checks: [[check('lint', 'pass', 1)]], protection: [{ strict: false, contexts: [], checks: [{ context: 'e2e', app_id: 15368 }] }] });
  const b = run(viaChecks, '--pr', '12', '--require', 'lint', '--timeout-min', '0.01');
  assert.equal(b.status, 4, b.all);
  assert.equal(b.last, 'PR CHECKS: PENDING — required check "e2e" never reported (seen: lint)');
});

test('r3-1: names from the rules are ADDED to the typed ones; all must pass; PASS names them', () => {
  const list = [check('lint', 'pass', 1), check('Full suite', 'pass', 2), check('e2e', 'pass', 3), check('docs', 'pass', 4)];
  const sc = scenario({ checks: [list], rules: [ruleset('Full suite')], protection: [{ contexts: ['e2e'], checks: [{ context: 'FULL SUITE' }] }] });
  const r = run(sc, '--pr', '12', '--require', 'lint');
  assert.equal(r.status, 0, r.all);
  assert.equal(r.last, `PR CHECKS: PASS — required: lint, Full suite, e2e passed on 0123456789 (1 other passed, 0 skipped) · ${URL}`);
});

test('r3-1: a required suite from the rules that was skipped is NOT PROVEN', () => {
  const sc = scenario({ checks: [[check('lint', 'pass', 1), check('Full suite', 'skipping')]], rules: [ruleset('Full suite')] });
  const r = run(sc, '--pr', '12', '--require', 'lint');
  assert.equal(r.status, 3, r.all);
  assert.equal(r.last, 'PR CHECKS: NOT PROVEN — required check "Full suite" was skipped');
});

test('r3-1: neither source can be read: no block, and the PASS line says so', () => {
  const sc = scenario({ checks: [[check('lint', 'pass', 1)]], rules: [FORBIDDEN], protection: [FORBIDDEN] });
  const r = run(sc, '--pr', '12', '--require', 'lint');
  assert.equal(r.status, 0, r.all);
  assert.equal(r.last, `PR CHECKS: PASS — required: lint passed on 0123456789 (0 other passed, 0 skipped) · ${URL}${UNREAD}`);
  // A source that answers garbage is "could not be read" too; a failed base read as well.
  const junk = run(scenario({ checks: [[check('lint', 'pass', 1)]], rules: ['nope'], protection: ['nope'] }), '--pr', '12', '--require', 'lint');
  assert.equal(junk.status, 0, junk.all);
  assert.ok(junk.last.endsWith(UNREAD), junk.last);
  const nobase = run(scenario({ checks: [[check('lint', 'pass', 1)]], base: [{ err: 'HTTP 502', code: 1 }] }), '--pr', '12', '--require', 'lint');
  assert.equal(nobase.status, 0, nobase.all);
  assert.ok(nobase.last.endsWith(UNREAD), nobase.last);
});

test('must not change: a repository with no rules and no protection ("Branch not protected") is read fine: a plain PASS, no note', () => {
  const sc = scenario({ checks: [[check('lint', 'pass', 1)]] });
  const r = run(sc, '--pr', '12', '--require', 'lint');
  assert.equal(r.status, 0, r.all);
  assert.equal(r.last, `PR CHECKS: PASS — required: lint passed on 0123456789 (0 other passed, 0 skipped) · ${URL}`);
  // Both read, rules name the typed check: plain PASS.
  const both = run(scenario({ checks: [[check('lint', 'pass', 1)]], rules: [ruleset('lint')] }), '--pr', '12');
  assert.equal(both.status, 0, both.all);
  assert.equal(both.last, `PR CHECKS: PASS — required: lint passed on 0123456789 (0 other passed, 0 skipped) · ${URL}`);
});

// ---- audit round 4, 2026-11-18: problems 1 (one source unread), 2 (a read name is kept), 3 (paging) ----
const NOTFOUND = { err: 'gh: Not Found (HTTP 404)', code: 1 };
test('r4-1: one source read, the other unreadable (plain Not Found / 403): PASS ends with a note naming the unread source', () => {
  const classic = run(scenario({ checks: [[check('lint', 'pass', 1)]], protection: [NOTFOUND] }), '--pr', '12', '--require', 'lint');
  assert.equal(classic.status, 0, classic.all);
  assert.equal(classic.last, `PR CHECKS: PASS — required: lint passed on 0123456789 (0 other passed, 0 skipped) · ${URL} (GitHub's configured required list could not be read from: classic branch protection)`);
  const rulesOnly = run(scenario({ checks: [[check('lint', 'pass', 1)]], rules: [FORBIDDEN] }), '--pr', '12', '--require', 'lint');
  assert.equal(rulesOnly.status, 0, rulesOnly.all);
  assert.ok(rulesOnly.last.endsWith(' (GitHub\'s configured required list could not be read from: rulesets)'), rulesOnly.last);
});

test('r4-2: a requirement read at look 1 is kept when that source fails at later looks', () => {
  const sc = scenario({ checks: [[check('lint', 'pass', 1)]], rules: [ruleset('Full suite'), FORBIDDEN] });
  const r = run(sc, '--pr', '12', '--require', 'lint', '--timeout-min', '0.01');
  assert.equal(r.status, 4, r.all);
  assert.equal(r.last, 'PR CHECKS: PENDING — required check "Full suite" never reported (seen: lint)');
  assert.doesNotMatch(r.stdout, /PR CHECKS: PASS/);
});

test('r4-3: the rules are asked with a page size of 100 and every page; names on a later page count', () => {
  const page1 = [{ type: 'deletion' }], page2 = [ruleset('Full suite')[1]];
  // gh --slurp hands back an array of pages: the stand-in answers that shape.
  const paged = scenario({ checks: [[check('lint', 'pass', 1)]], rules: [[page1, page2]] });
  const r = run(paged, '--pr', '12', '--require', 'lint', '--timeout-min', '0.01');
  assert.equal(r.status, 4, r.all);
  assert.equal(r.last, 'PR CHECKS: PENDING — required check "Full suite" never reported (seen: lint)');
  assert.ok(paged.asked('api rules')[0].args.includes('--paginate'));
  assert.ok(paged.asked('api rules')[0].args.some((a) => /\?per_page=100$/.test(a)));
  // must not change: the pages shape with no required rule is a plain PASS.
  const plain = run(scenario({ checks: [[check('lint', 'pass', 1)]], rules: [[page1, []]] }), '--pr', '12', '--require', 'lint');
  assert.equal(plain.status, 0, plain.all);
  assert.equal(plain.last, `PR CHECKS: PASS — required: lint passed on 0123456789 (0 other passed, 0 skipped) · ${URL}`);
});

test('r3-2: a draft whose required check passed and whose optional deploy was skipped is a PASS, like a ready one', () => {
  const draft = { ...PR, isDraft: true };
  const list = [check('Build & test', 'pass', 1), check('deploy', 'skipping')];
  const r = run(scenario({ view: [draft], checks: [list] }), '--pr', '12', '--require', 'Build & test');
  assert.equal(r.status, 0, r.all);
  assert.equal(r.last, `PR CHECKS: PASS — required: Build & test passed on 0123456789 (0 other passed, 1 skipped) · ${URL}`);
  // The same through GitHub's own list.
  const viaGitHub = run(scenario({ view: [draft], checks: [list], required: [['Build & test']] }), '--pr', '12');
  assert.equal(viaGitHub.status, 0, viaGitHub.all);
});

test('must not change: a draft whose REQUIRED check is skipped, or with no required name, keeps its DRAFT line', () => {
  const draft = { ...PR, isDraft: true };
  const skippedReq = run(scenario({ view: [draft], checks: [[check('lint', 'pass', 1), check('Build', 'skipping')]] }), '--pr', '12', '--require', 'Build');
  assert.equal(skippedReq.status, 3, skippedReq.all);
  assert.equal(skippedReq.last, 'PR CHECKS: DRAFT — 1 skipped, 1 passed: mark it ready');
  const noName = run(scenario({ view: [draft], checks: [[check('lint', 'pass', 1), check('Build', 'skipping')]] }), '--pr', '12');
  assert.equal(noName.status, 3, noName.all);
  assert.equal(noName.last, 'PR CHECKS: DRAFT — 1 skipped, 1 passed: mark it ready');
});
