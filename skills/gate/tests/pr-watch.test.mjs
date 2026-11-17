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
const fakeGh = path.join(root, 'fake-gh.cjs');
fs.writeFileSync(fakeGh, [
  "const fs = require('node:fs');",
  'const file = process.env.PR_WATCH_SCENARIO;',
  "const scenario = JSON.parse(fs.readFileSync(file, 'utf8'));",
  "const calls = fs.existsSync(file + '.calls') ? JSON.parse(fs.readFileSync(file + '.calls', 'utf8')) : [];",
  "const args = process.argv.slice(2), kind = args.slice(0, 2).join(' ');",
  'const nth = calls.filter((c) => c.kind === kind).length;',
  "calls.push({ kind, args, inRepo: fs.existsSync('this-is-the-repo.txt') });",
  "fs.writeFileSync(file + '.calls', JSON.stringify(calls));",
  "const fields = args.includes('--json') ? args[args.indexOf('--json') + 1] : '';",
  'const pick = (list) => list[Math.min(nth, list.length - 1)];',
  "let answer = { err: 'unknown command \"' + args.join(' ') + '\" for \"gh\"', code: 1 };",
  "if (kind === 'pr view' && fields === 'number,state,isDraft,headRefOid,url' && args.length <= 5) answer = pick(scenario.view);",
  "if (kind === 'pr checks' && fields === 'name,state,bucket,link' && args.length === 5) answer = pick(scenario.checks);",
  "if (kind === 'run view' && args[3] === '--log-failed' && args.length === 4) answer = scenario.logs[args[2]] || { err: 'HTTP 404: Not Found', code: 1 };",
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
function scenario({ view = [PR], checks = [[]], logs = {} } = {}) {
  const dir = path.join(root, 'case-' + (++cases));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'this-is-the-repo.txt'), '');
  const file = path.join(dir, 'scenario.json');
  fs.writeFileSync(file, JSON.stringify({
    view: view.map((v) => (v.err ? v : { out: v })),
    checks: checks.map((c) => (Array.isArray(c) ? { out: c } : c)),
    logs: Object.fromEntries(Object.entries(logs).map(([id, text]) => [id, { out: text }])),
  }));
  const calls = () => (fs.existsSync(file + '.calls') ? JSON.parse(fs.readFileSync(file + '.calls', 'utf8')) : []);
  return { repo, file, calls, asked: (kind) => calls().filter((c) => c.kind === kind) };
}

function run(sc, ...args) {
  const r = spawnSync(process.execPath, [script, '--repo', sc.repo, '--interval-sec', '0.2', ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 60000,
    env: { ...process.env, SANAD_GH: fakeGh, PR_WATCH_SCENARIO: sc.file },
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
  const r = run(sc);
  assert.equal(r.status, 0, r.all);
  // One progress line per change of the counts: the second pending look prints nothing.
  assert.deepEqual(r.lines, [
    '  waiting: 1 pending, 1 passed, 1 skipped',
    '  all 2 passed: one more look, a check may start late',
    `PR CHECKS: PASS — 2 check(s) on 0123456789 · ${URL} (1 skipped)`,
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
  const r = run(sc);
  assert.equal(r.status, 0, r.all);
  assert.deepEqual(r.lines, [
    '  waiting: no check reported yet',
    '  waiting: 1 pending, 0 passed',
    '  all 1 passed: one more look, a check may start late',
    `PR CHECKS: PASS — 1 check(s) on 0123456789 · ${URL}`,
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
  const r = run(sc, '--timeout-min', '0.01');
  assert.equal(r.status, 1, r.all);
  assert.deepEqual(r.lines, [
    '  waiting: 1 pending, 0 passed, 1 failed',
    '--- unit: failing lines (gh run view 5 --log-failed)',
    '  FAIL src/a.test.ts',
    `PR CHECKS: FAIL — unit (still pending after 0.01 min: e2e) · ${URL}`,
  ]);
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
  const r = run(sc);
  assert.equal(r.status, 0, r.all);
  assert.equal(r.last, `PR CHECKS: PASS — 1 check(s) on 0123456789 · ${URL} (the PR is already MERGED)`);
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
  const once = run(scenario({ checks: [blip, [check('unit', 'pass', 1)]] }));
  assert.equal(once.status, 0, once.all);
  assert.deepEqual(once.lines, [
    '  GitHub did not answer (HTTP 502: Bad Gateway (https://api.github.com/graphql)): asking again',
    '  all 1 passed: one more look, a check may start late',
    `PR CHECKS: PASS — 1 check(s) on 0123456789 · ${URL}`,
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
  const ok = run(same);
  assert.equal(ok.status, 0, ok.all);
  // --pr named: the user chose that pull request, so no comparison with this folder's commit.
  const named = run(sc, '--pr', '12');
  assert.equal(named.status, 0, named.all);
});

test('a draft whose only pending check is not an Actions run ends as DRAFT after three looks, exit 3', () => {
  const sc = scenario({ view: [{ ...PR, isDraft: true }], checks: [[wip]] });
  const r = run(sc, '--timeout-min', '0.05');
  assert.equal(r.status, 3, r.all);
  assert.equal(r.last, 'PR CHECKS: DRAFT — WIP is pending and no CI run started; this pull request is a DRAFT: mark it ready');
  assert.equal(sc.asked('pr checks').length, 3);
});

test('on a draft, a red Actions check is reported without waiting for a check that has no run', () => {
  const sc = scenario({ view: [{ ...PR, isDraft: true }], checks: [[check('unit', 'fail', 5), wip]], logs: { 5: logLine('FAIL src/a.test.ts', 1) } });
  const r = run(sc, '--timeout-min', '0.05');
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
  const r = run(sc, '--interval-sec', '1', '--timeout-min', '0.012');
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
  const r = run(sc, '--pr', '12');
  assert.equal(r.status, 0, r.all);
  assert.equal(r.last, `PR CHECKS: PASS — 1 check(s) on bbbbbbbbbb · ${URL}`);
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
  const r = run(sc, '--pr', '12');
  assert.equal(r.status, 0, r.all);
  assert.equal(r.last, `PR CHECKS: PASS — 1 check(s) on aaaaaaaaaa · ${URL}`);
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
  const r = run(sc, '--pr', '12');
  assert.equal(r.status, 0, r.all);
  assert.equal(r.last, `PR CHECKS: PASS — 1 check(s) on bbbbbbbbbb · ${URL}`);
  assert.equal(sc.asked('pr checks').length, 4, 'two looks on aaaa, two on bbbb');
});

test('must not change: the same head at the end is a PASS on that commit', () => {
  const sc = scenario({ view: [{ ...PR, headRefOid: HEAD_A }, { ...PR, headRefOid: HEAD_A }], checks: [[check('unit', 'pass', 1)]] });
  const r = run(sc, '--pr', '12');
  assert.equal(r.status, 0, r.all);
  assert.equal(r.last, `PR CHECKS: PASS — 1 check(s) on aaaaaaaaaa · ${URL}`);
});
