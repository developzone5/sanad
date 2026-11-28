// 2026-11-28 (owner, batch b task 4): the install runs only what the change needs. The proof on the test machine runs
// only when a changed file is one the proof or the test machine uses; the replay only for a file under hooks/ or one it
// reads; a file on no list, the installer or the lists file runs every step. Each step left out prints one line. Both
// suites run at the same time, and a suite that failed only in a named wall-clock test file runs those files again,
// alone. No suite is ever left out; the lock, the rollback and the drift guard do not change.
import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const installer = path.resolve(here, '../../scripts/workflow-install.sh');
const listsFile = path.resolve(here, '../../scripts/install-lists.mjs');
const gateScripts = path.resolve(here, '../../skills/gate/scripts');
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const slash = (v) => v.replaceAll('\\', '/');
const lists = await import(new URL('file:///' + slash(listsFile)).href);

// Review (batch b): the proof's scripts and the test machine's scripts also load hook files with require; those are proof
// files too. Followed here from red-proof.mjs and from every file in scripts/remote: import, import(), require('./…'),
// createRequire(...)('…'), require(path.join(__dirname, '…')), and note-check.mjs's PARSER (the scanner).
test('the proof list is every file the proof and the test machine load: red-proof.mjs, its imports, the hook files they require', async () => {
  const top = path.resolve(here, '../..');
  const remote = fs.readdirSync(path.join(top, 'scripts/remote')).map((n) => 'scripts/remote/' + n);
  const seen = new Set(['skills/gate/scripts/red-proof.mjs', ...remote]);
  const queue = [...seen];
  const add = (from, rel) => { const p = path.posix.normalize(path.posix.dirname(from) + '/' + rel); if (!seen.has(p)) { seen.add(p); queue.push(p); } };
  while (queue.length) {
    const f = queue.shift();
    let text = '';
    try { text = fs.readFileSync(path.join(top, f), 'utf8'); } catch { continue; }
    for (const m of text.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\(\s*)['"](\.{1,2}\/[\w./-]+\.(?:mjs|cjs|js))['"]/g)) add(f, m[1]);
    for (const m of text.matchAll(/createRequire\([^)]*\)\(\s*['"](\.{1,2}\/[\w./-]+)['"]/g)) add(f, m[1]);
    for (const m of text.matchAll(/require\(path\.join\(__dirname,\s*['"]([\w.-]+\.c?js)['"]\)\)/g)) add(f, m[1]);
    for (const m of text.matchAll(/export const PARSER = ['"](\.{1,2}\/[\w./-]+)['"]/g)) add(f, m[1]);
  }
  const loaded = [...seen].filter((f) => !f.startsWith('scripts/remote/')).map((f) => 'claude/' + f).sort();
  assert.deepEqual([...lists.PROOF_FILES].sort(), loaded);
  assert.ok(remote.every((f) => lists.PROOF_PREFIXES.some((p) => ('claude/' + f).startsWith(p))), 'every test machine script is on the list');
  const { proofScripts } = await import(new URL('file:///' + slash(path.join(gateScripts, 'red-proof.mjs'))).href);
  for (const n of proofScripts(gateScripts)) assert.ok(lists.PROOF_FILES.includes('claude/skills/gate/scripts/' + n), n + ' is copied by the proof');
  for (const hook of ['claude/hooks/lib/code-paths.cjs', 'claude/hooks/lib/process-start.cjs']) assert.equal(lists.decide([hook]).e2e.run, true, hook);
});

test('decide: each list, a file on no list, the installer and the lists file', () => {
  const d = (...files) => lists.decide(files);
  const docs = d('claude/skills/gate/reference/a.md', 'claude/skills/gate/tests/x.test.mjs', 'claude/agents/a.md', 'agents/skills/s/SKILL.md', 'codex/agents/r.toml', 'claude/skills/gate/scripts/sanad.mjs');
  assert.deepEqual([docs.e2e.run, docs.replay.run], [false, false], JSON.stringify(docs));
  assert.equal(docs.e2e.why, 'no changed file is used by the proof or the test machine');
  assert.equal(docs.replay.why, 'no changed file is under hooks/ or read by the replay');
  assert.deepEqual([d('claude/skills/gate/scripts/kept.mjs').e2e.run, d('claude/skills/gate/scripts/kept.mjs').replay.run], [true, false], 'a proof file');
  assert.equal(d('claude/scripts/remote/remote-sync.sh').e2e.run, true, 'a test machine script');
  assert.deepEqual([d('claude/hooks/lib/x.cjs').e2e.run, d('claude/hooks/lib/x.cjs').replay.run], [false, true], 'a hooks file');
  assert.equal(d('claude/scripts/replay/replay.mjs').replay.run, true);
  for (const f of ['claude/settings.json', 'claude/skills/explain-pr/scripts/x.mjs', 'claude/skills/gate/scripts/x.cjs']) {
    const r = d('claude/skills/gate/reference/a.md', f);
    assert.deepEqual([r.e2e.run, r.replay.run], [true, true], f);
    assert.match(r.e2e.why, new RegExp(`^${f.replace(/[.]/g, '\\.')} is on no list`));
  }
  for (const f of lists.ALWAYS_ALL) { const r = d('claude/agents/a.md', f); assert.deepEqual([r.e2e.run, r.replay.run], [true, true], f); assert.match(r.e2e.why, /changed, so every step runs$/); }
  assert.deepEqual([d().e2e.run, d().replay.run], [true, true], 'no file named: every step runs');
});

// A failing-tests part as node's spec reporter prints it. Each failure: [file, title, the assertion line].
const SANAD = ['sanad.test.mjs', 'next answers in under 1 second on a repository with 1,500 untracked files, and reads no proof for it', 'AssertionError [ERR_ASSERTION]: next took 1396 ms'];
const CHANGE = ['tests\\change-set.test.mjs', 'a folder with 1,500 untracked files: a FOREIGN? answer in under 2 seconds that names the folder once', 'AssertionError [ERR_ASSERTION]: took 2310 ms'];
const SCAN = ['scan-incremental.test.mjs', 'a large transcript is read in pieces and a later call reads only the new part fast', 'AssertionError [ERR_ASSERTION]: a later call took 455 ms'];
const failingLog = (...fails) => ['ℹ tests 9', `ℹ pass ${9 - fails.length}`, `ℹ fail ${fails.length}`, '', '✖ failing tests:', '',
  ...fails.flatMap(([file, title, line], i) => [`test at ${file}:1${i}:1`, `✖ ${title} (1396.25ms)`, `  ${line}`, '']), ''].join('\n');
test('retry: only a named wall-clock test failing on its time assertion runs again alone; any other failure is real', () => {
  assert.equal(lists.TIME_LIMIT_TESTS.length <= 8, true, 'the list is short');
  assert.deepEqual(lists.retryFiles(failingLog(SANAD), 'gate'), ['sanad.test.mjs']);
  assert.deepEqual(lists.retryFiles(failingLog(CHANGE, SANAD), 'gate'), ['change-set.test.mjs', 'sanad.test.mjs']);
  assert.equal(lists.retryFiles(failingLog(SANAD, ['pre-review.test.mjs', 'a check', 'AssertionError [ERR_ASSERTION]: took 9 ms']), 'gate'), null, 'one real failure: no retry');
  assert.equal(lists.retryFiles(failingLog(SANAD), 'hooks'), null, 'the file of another suite');
  assert.deepEqual(lists.retryFiles(failingLog(SCAN), 'hooks'), ['scan-incremental.test.mjs']);
  // Review (batch b): another test of a named file, or the named test failing on another assertion, is real.
  assert.equal(lists.retryFiles(failingLog(['sanad.test.mjs', 'ready: every item is done', 'AssertionError [ERR_ASSERTION]: next took 1396 ms']), 'gate'), null, 'another test of the file');
  assert.equal(lists.retryFiles(failingLog([SANAD[0], SANAD[1], 'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: true !== false']), 'gate'), null, 'the named test, another assertion');
  // Review (batch b): a log cut short — the summary says 2 failures, one is printed — is never retried.
  assert.equal(lists.retryFiles(failingLog(SANAD).replace('ℹ fail 1', 'ℹ fail 2'), 'gate'), null, 'the count differs from the summary');
  assert.equal(lists.retryFiles('ℹ fail 1\nno summary of the failures\n', 'gate'), null, 'no failing-tests part');
  assert.equal(lists.retryFiles(failingLog(SANAD) + '\n✖ another failure\n', 'gate'), null, 'a failure with no test-at line');
  assert.deepEqual([lists.concurrency('hooks', 16), lists.concurrency('gate', 16), lists.concurrency('gate', 2)], [2, 14, 1]);
});

// A small live tree, a base and a candidate, with the installer pointed at the live tree (as the rollback tests do).
function fixture(t, { proofMarker = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanad-install-needs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const base = path.join(root, 'base'), cand = path.join(root, 'candidate'), live = path.join(root, 'live');
  const put = (folder, rel, content) => { const target = path.join(folder, rel); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); };
  const marker = (name) => slash(path.join(root, name + '.ran'));
  const fakeProof = `require('node:fs').writeFileSync(${JSON.stringify(marker('proof'))}, 'ran\\n');\n`;
  const fakeReplay = `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker('replay'))}, 'ran\\n');\n`;
  for (const folder of [base, cand, live]) {
    put(folder, 'claude/hooks/tests/fixture.test.cjs', 'require("node:test")("fixture", () => {});\n');
    put(folder, 'claude/skills/gate/tests/fixture.test.cjs', 'require("node:test")("fixture", () => {});\n');
    put(folder, 'claude/skills/gate/scripts/red-proof.mjs', proofMarker ? fakeProof.replace("require('node:fs')", "(await import('node:fs')).default") : '');
    put(folder, 'claude/scripts/replay/replay.mjs', fakeReplay);
    put(folder, 'claude/scripts/install-lists.mjs', fs.readFileSync(listsFile));
    put(folder, 'claude/skills/gate/reference/a.md', 'old text\n');
  }
  const source = fs.readFileSync(installer, 'utf8').replaceAll('\r\n', '\n');
  const rootLine = 'C="$HOME/.claude"; A="$HOME/.agents/skills"; X="$HOME/.codex"';
  assert.equal(source.split(rootLine).length, 2);
  const quote = (v) => "'" + slash(v).replaceAll("'", "'\\''") + "'";
  const script = path.join(root, 'install.sh');
  fs.writeFileSync(script, source.replace(rootLine, `C=${quote(path.join(live, 'claude'))}; A=${quote(path.join(live, 'agents/skills'))}; X=${quote(path.join(live, 'codex'))}`));
  fs.writeFileSync(path.join(root, 'empty.gitconfig'), '');
  const env = { ...process.env, SANAD_E2E_RUN: `${slash(root)}|.|node -v`, SANAD_REPLAY: '', GIT_CONFIG_GLOBAL: path.join(root, 'empty.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    SANAD_STATE_DIR: path.join(root, 'state'), WORKFLOW_TYPESCRIPT_RUNNER: 'fixture', HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home') };
  delete env.NODE_TEST_CONTEXT;
  const run = (name, extra = {}) => new Promise((resolve) => {
    const child = spawn(bash, [script, cand, base, name], { env: { ...env, ...extra }, timeout: 150000 });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c) => { stdout += c; });
    child.stderr.setEncoding('utf8').on('data', (c) => { stderr += c; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  const ran = (name) => fs.existsSync(path.join(root, name + '.ran'));
  return { root, base, cand, live, put, run, ran, releases: () => { try { return fs.readFileSync(path.join(live, 'claude/backups/RELEASES.md'), 'utf8'); } catch { return ''; } } };
}

// A fake `node` first on PATH for `node --test …` (any other call is the real node). mode:
//   together — each suite writes its mark and waits for the other's (20 s at most): run one after the other, it fails.
//   slow-gate — the gate suite's full run fails only with <failure> ([file, title, assertion line]); a run that names files passes.
function fakeRunner(f, mode, failure = SANAD) {
  const bin = path.join(f.root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const clean = 'ℹ tests 1\nℹ pass 1\nℹ fail 0\n';
  fs.writeFileSync(path.join(f.root, 'clean.txt'), clean);
  fs.writeFileSync(path.join(f.root, 'failing.txt'), failingLog(failure));
  fs.writeFileSync(path.join(bin, 'node'), [
    '#!/usr/bin/env bash',
    'if [ "${1:-}" != "--test" ]; then exec "$SANAD_TEST_REAL_NODE" "$@"; fi',
    'suite=gate; case "$PWD" in */hooks/tests) suite=hooks;; esac',
    'named=0; for a in "$@"; do case "$a" in *.test.*) named=1;; esac; done',
    'if [ "$SANAD_FAKE_MODE" = together ]; then',
    '  : > "$SANAD_FAKE_DIR/$suite.started"',
    '  for i in $(seq 1 200); do [ -f "$SANAD_FAKE_DIR/hooks.started" ] && [ -f "$SANAD_FAKE_DIR/gate.started" ] && { cat "$SANAD_FAKE_DIR/clean.txt"; exit 0; }; sleep 0.1; done',
    '  echo "the other suite never started while this one ran"; exit 1',
    'fi',
    'if [ "$suite" = gate ] && [ "$named" = 0 ]; then cat "$SANAD_FAKE_DIR/failing.txt"; exit 1; fi',
    'if [ "$named" = 1 ]; then echo "ran: $*" >> "$SANAD_FAKE_DIR/again.txt"; fi',
    'cat "$SANAD_FAKE_DIR/clean.txt"; exit 0',
    '',
  ].join('\n'), { mode: 0o755 });
  const key = Object.keys(process.env).find((n) => n.toLowerCase() === 'path') ?? 'PATH';
  return { [key]: bin + path.delimiter + process.env[key], SANAD_FAKE_MODE: mode, SANAD_FAKE_DIR: slash(f.root), SANAD_TEST_REAL_NODE: slash(process.execPath) };
}

describe('the install runs only what the change needs', { concurrency: 4 }, () => {
  it('a text-only change leaves out the proof and the replay, one line each, and still runs both suites', async (t) => {
    const f = fixture(t);
    f.put(f.cand, 'claude/skills/gate/reference/a.md', 'new text\n');
    const r = await f.run('text-only');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^E2E: left out — no changed file is used by the proof or the test machine$/m);
    assert.match(r.stdout, /^REPLAY: left out — no changed file is under hooks\/ or read by the replay$/m);
    assert.equal(f.ran('proof'), false, 'the proof did not run');
    assert.equal(f.ran('replay'), false, 'the replay did not run');
    assert.match(r.stdout, /^hooks: ℹ pass 1 ℹ fail 0 $/m);
    assert.match(r.stdout, /^gate: ℹ pass 1 ℹ fail 0 $/m);
  });

  it('a file on no list runs every step, and says why', async (t) => {
    const f = fixture(t);
    f.put(f.cand, 'claude/skills/gate/reference/a.md', 'new text\n');
    f.put(f.cand, 'claude/settings.json', '{}\n');
    const r = await f.run('no-list');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^E2E: runs — claude\/settings\.json is on no list \(1 such file\(s\)\), so every step runs$/m);
    assert.match(r.stdout, /^REPLAY: runs — claude\/settings\.json is on no list/m);
    assert.equal(f.ran('proof'), true);
    assert.equal(f.ran('replay'), true);
  });

  it('a hooks file runs the replay and leaves out the proof; a proof file runs the proof and leaves out the replay', async (t) => {
    const f = fixture(t);
    f.put(f.cand, 'claude/hooks/lib/new.cjs', 'module.exports = 1;\n');
    const r = await f.run('hooks-file');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^E2E: left out — /m);
    assert.match(r.stdout, /^REPLAY: runs — claude\/hooks\/lib\/new\.cjs is under hooks\/ or read by the replay$/m);
    assert.deepEqual([f.ran('proof'), f.ran('replay')], [false, true]);
    const g = fixture(t);
    g.put(g.cand, 'claude/skills/gate/scripts/kept.mjs', 'export const k = 1;\n');
    const s = await g.run('proof-file');
    assert.equal(s.status, 0, s.stdout + s.stderr);
    assert.match(s.stdout, /^E2E: runs — claude\/skills\/gate\/scripts\/kept\.mjs is used by the proof or the test machine$/m);
    assert.match(s.stdout, /^REPLAY: left out — /m);
    assert.deepEqual([g.ran('proof'), g.ran('replay')], [true, false]);
  });

  it('a change to the installer or the lists file runs every step', async (t) => {
    const f = fixture(t);
    f.put(f.cand, 'claude/scripts/install-lists.mjs', fs.readFileSync(listsFile, 'utf8') + '\n// changed\n');
    const r = await f.run('lists-changed');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^E2E: runs — claude\/scripts\/install-lists\.mjs changed, so every step runs$/m);
    assert.deepEqual([f.ran('proof'), f.ran('replay')], [true, true]);
  });

  it('a candidate with no lists file runs every step, as before', async (t) => {
    const f = fixture(t);
    for (const folder of [f.base, f.cand, f.live]) fs.rmSync(path.join(folder, 'claude/scripts/install-lists.mjs'));
    f.put(f.cand, 'claude/skills/gate/reference/a.md', 'new text\n');
    const r = await f.run('no-lists');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^E2E: runs — every step runs \(no lists file in the candidate\)$/m);
    assert.deepEqual([f.ran('proof'), f.ran('replay')], [true, true]);
  });

  it('the hook suite and the gate suite run at the same time', async (t) => {
    const f = fixture(t);
    f.put(f.cand, 'claude/skills/gate/reference/a.md', 'new text\n');
    const r = await f.run('together', fakeRunner(f, 'together'));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^hooks: ℹ pass 1 ℹ fail 0 $/m);
    assert.match(r.stdout, /^gate: ℹ pass 1 ℹ fail 0 $/m);
  });

  it('a suite that failed only in a named wall-clock test file runs it again alone; it passes there and the install stays', async (t) => {
    const f = fixture(t);
    f.put(f.cand, 'claude/skills/gate/reference/a.md', 'new text\n');
    const r = await f.run('slow-gate', fakeRunner(f, 'slow-gate', SANAD));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^SUITE gate: only test files with a wall-clock limit failed under the load of both suites, and they passed alone: sanad\.test\.mjs /m);
    assert.match(fs.readFileSync(path.join(f.root, 'again.txt'), 'utf8'), /^ran: --test --test-reporter=spec sanad\.test\.mjs$/m);
    assert.match(f.releases(), /slow-gate/);
  });

  it('a failure in any other test file is real: no run alone, and the install rolls back', async (t) => {
    const f = fixture(t);
    f.put(f.cand, 'claude/skills/gate/reference/a.md', 'new text\n');
    const r = await f.run('real-failure', fakeRunner(f, 'slow-gate', [SANAD[0], SANAD[1], 'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: true !== false']));
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^ {2}suite failed \(tests-gate\): exit 1/m);
    assert.match(r.stdout, /^ROLLED BACK: the previous files are live again$/m);
    assert.equal(fs.existsSync(path.join(f.root, 'again.txt')), false, 'nothing ran again');
    assert.equal(fs.readFileSync(path.join(f.live, 'claude/skills/gate/reference/a.md'), 'utf8'), 'old text\n');
  });
});
