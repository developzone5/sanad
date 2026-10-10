import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runCommand, assertHttp, withCleanup, evidenceLog, redact } from '../scripts/evidence.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-evidence-tests-'));
const emptyIgnore = path.join(root, 'empty-ignore');
fs.writeFileSync(emptyIgnore, '');
function sourceFixture() {
  const repo = fs.mkdtempSync(path.join(root, 'repo-'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q'); git('config', 'user.name', 'Evidence fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'core.autocrlf', 'false'); git('config', 'core.excludesFile', emptyIgnore);
  fs.writeFileSync(path.join(repo, 'app.js'), 'export const value = 1;\n');
  git('add', 'app.js'); git('commit', '-qm', 'fixture');
  return { repo, git };
}
test('computed source ignores forged source, preserves the index and survives committing unchanged content', async () => {
  const { repo, git } = sourceFixture();
  fs.writeFileSync(path.join(repo, 'app.js'), 'export const value = 2;\n');
  git('add', 'app.js');
  fs.writeFileSync(path.join(repo, 'app.js'), 'export const value = 3;\n');
  fs.writeFileSync(path.join(repo, 'new.js'), 'export const added = true;\n');
  const index = fs.readFileSync(path.join(repo, '.git', 'index'));
  const result = await runCommand({ executable: process.execPath, args: ['-e', 'console.log("checked")'], cwd: repo, outputRoot: root, source: { toplevel: 'forged', treeBefore: 'fake', treeAfter: 'fake' } });
  assert.equal(result.status, 'passed');
  assert.deepEqual(fs.readFileSync(path.join(repo, '.git', 'index')), index);
  assert.equal(result.source.toplevel, fs.realpathSync.native(repo));
  assert.match(result.source.treeBefore, /^[0-9a-f]{40,64}$/);
  assert.equal(result.source.treeBefore, result.source.treeAfter);
  git('add', 'app.js', 'new.js'); git('commit', '-qm', 'checked content');
  assert.equal(result.source.treeAfter, git('rev-parse', 'HEAD^{tree}'));
});
test('a zero exit cannot pass when the command changes source', async () => {
  const { repo } = sourceFixture();
  const result = await runCommand({ executable: process.execPath, args: ['-e', 'require("node:fs").writeFileSync("app.js", "changed")'], cwd: repo, outputRoot: root });
  assert.equal(result.nativeExitCode, 0);
  assert.equal(result.status, 'failed');
  assert.notEqual(result.source.treeBefore, result.source.treeAfter);
  assert.match(result.reason, /source.*changed/i);
});
test('forced-added ignored source is refreshed from worktree and matches the unchanged commit', async () => {
  const { repo, git } = sourceFixture();
  fs.writeFileSync(path.join(repo, '.gitignore'), 'generated/\n');
  fs.mkdirSync(path.join(repo, 'generated'));
  fs.writeFileSync(path.join(repo, 'generated', 'forced [file].js'), 'first staged bytes\n');
  git('add', '.gitignore'); git('add', '-f', '--', 'generated/forced [file].js');
  fs.writeFileSync(path.join(repo, 'generated', 'forced [file].js'), 'verified worktree bytes\n');
  fs.writeFileSync(path.join(repo, 'generated', 'deleted.js'), 'removed before verification\n');
  git('add', '-f', '--', 'generated/deleted.js');
  fs.unlinkSync(path.join(repo, 'generated', 'deleted.js'));
  git('update-index', '--assume-unchanged', 'app.js');
  fs.writeFileSync(path.join(repo, 'app.js'), 'changed despite assume-unchanged\n');
  const index = fs.readFileSync(path.join(repo, '.git', 'index'));
  const result = await runCommand({ executable: process.execPath, args: ['-e', 'console.log("checked")'], cwd: repo, outputRoot: root });
  assert.equal(result.status, 'passed');
  assert.deepEqual(fs.readFileSync(path.join(repo, '.git', 'index')), index);
  git('update-index', '--no-assume-unchanged', 'app.js');
  git('add', '-u'); git('commit', '-qm', 'checked forced addition');
  assert.equal(result.source.treeAfter, git('rev-parse', 'HEAD^{tree}'));
});
test('inherited Git redirection cannot bind a different repository', async () => {
  const { repo, git } = sourceFixture();
  const other = sourceFixture();
  const previous = Object.fromEntries(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].map(key => [key, process.env[key]]));
  try {
    process.env.GIT_DIR = path.join(other.repo, '.git');
    process.env.GIT_WORK_TREE = other.repo;
    process.env.GIT_INDEX_FILE = path.join(other.repo, '.git', 'index');
    const result = await runCommand({ executable: process.execPath, args: ['-e', 'console.log("checked")'], cwd: repo, outputRoot: root });
    assert.equal(result.status, 'passed');
    assert.equal(result.source.toplevel, fs.realpathSync.native(repo));
    for (const key of Object.keys(previous)) delete process.env[key];
    assert.equal(result.source.treeAfter, git('rev-parse', 'HEAD^{tree}'));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
test('non-Git checks cannot produce passing publishing evidence', async () => {
  const result = await runCommand({ executable: process.execPath, args: ['-e', 'console.log("utility")'], cwd: root, outputRoot: root, source: { treeBefore: 'forged' } });
  assert.equal(result.nativeExitCode, 0); assert.equal(result.status, 'failed');
  assert.equal(result.source, null); assert.match(result.reason, /source|git/i);
});
test('evidence output inside the source repository is rejected before execution', async () => {
  const { repo } = sourceFixture();
  await assert.rejects(() => runCommand({ executable: process.execPath, args: ['-e', 'require("node:fs").writeFileSync("should-not-run", "bad")'], cwd: repo, outputRoot: path.join(repo, 'evidence') }), /outside.*repository/i);
  assert.equal(fs.existsSync(path.join(repo, 'should-not-run')), false);
});
test('native failure and full stdout/stderr survive summary and literal argv', async () => {
  const arg = 'literal ; & $(not-a-command) `text`';
  const result = await runCommand({ executable: process.execPath, args: ['-e', 'process.stdout.write(process.argv[1]); process.stderr.write("details\\n"); process.exitCode=7;', arg], cwd: root, outputRoot: root });
  assert.equal(result.nativeExitCode, 7); assert.equal(result.status, 'failed');
  assert.equal(fs.readFileSync(result.stdout, 'utf8'), arg);
  assert.equal(fs.readFileSync(result.stderr, 'utf8'), 'details\n');
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.runDir, 'metadata.json'), 'utf8')).nativeExitCode, 7);
});
test('logs redact a secret split across chunks before writing to disk', () => {
  const file = path.join(root, 'secret.log'); const log = evidenceLog(file, { secrets: ['standalone-secret-value'] });
  log.write('TOKEN=split'); log.write('-secret\nstandalone-'); log.write('secret-value\nAuthorization: Bearer abcdefghijk\n'); log.close();
  const saved = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(saved, /split-secret|standalone-secret-value|abcdefghijk/);
  assert.match(saved, /REDACTED/);
});
test('process timeout, spawn failure and output overflow cannot pass', async () => {
  const timed = await runCommand({ executable: process.execPath, args: ['-e', 'console.log("started");setInterval(()=>{},1000)'], cwd: root, outputRoot: root, timeoutMs: 300 });
  assert.equal(timed.status, 'failed'); assert.match(timed.reason, /Timed out/);
  assert.match(fs.readFileSync(timed.stdout, 'utf8'), /started/);
  const missing = await runCommand({ executable: path.join(root, 'missing.exe'), cwd: root, outputRoot: root });
  assert.equal(missing.status, 'failed'); assert.equal(missing.nativeExitCode, null);
  const huge = await runCommand({ executable: process.execPath, args: ['-e', 'console.log("x".repeat(5000))'], cwd: root, outputRoot: root, maxBytes: 100 });
  assert.equal(huge.status, 'failed'); assert.match(huge.reason, /bound/);
});
test('CLI returns the native exit instead of its summary exit', () => {
  const spec = path.join(root, 'spec.json');
  fs.writeFileSync(spec, JSON.stringify({ executable: process.execPath, args: ['-e', 'console.log("before failure");process.exitCode=9'], cwd: root, outputRoot: root }));
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/evidence.mjs', import.meta.url)), '--spec', spec], { encoding: 'utf8', windowsHide: true });
  assert.equal(run.status, 9); assert.match(run.stdout, /CHECK_COMPLETED/);
});
test('HTTP asserts expected rejection, code and persisted state and rejects false smoke success', async () => {
  let stored = 'hidden';
  const server = http.createServer((req, res) => {
    if (req.url === '/broken') { req.socket.destroy(); return; }
    if (req.url === '/redirect') { res.writeHead(302, { location: '/hidden' }); res.end(); return; }
    if (req.url === '/slow') return;
    res.setHeader('content-type', 'application/json');
    res.statusCode = req.url === '/wrong-media' ? 415 : 404;
    res.end(JSON.stringify({ code: 'NotFound', payload: req.url === '/huge' ? 'x'.repeat(4000) : undefined }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const result = await assertHttp({ url: base + '/hidden', expectedStatus: 404, expectedCode: 'NotFound', assertState: () => assert.equal(stored, 'hidden') });
    assert.equal(result.status, 404); assert.equal(result.stateChecked, true);
    await assert.rejects(() => assertHttp({ url: base + '/wrong-media', expectedStatus: 404 }), /415/);
    await assert.rejects(() => assertHttp({ url: base + '/broken', expectedStatus: 404 }));
    await assert.rejects(() => assertHttp({ url: base + '/redirect', expectedStatus: 404 }));
    await assert.rejects(() => assertHttp({ url: base + '/hidden', expectedStatus: 404, expectedCode: 'Forbidden' }), /error code/);
    stored = 'unexpectedly-mutated';
    await assert.rejects(() => assertHttp({ url: base + '/hidden', expectedStatus: 404, assertState: () => assert.equal(stored, 'hidden') }));
    await assert.rejects(() => assertHttp({ url: base + '/huge', expectedStatus: 404, maxBytes: 100 }), /bound/);
    await assert.rejects(() => assertHttp({ url: base + '/slow', expectedStatus: 404, timeoutMs: 30 }));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await assert.rejects(() => assertHttp({ url: base + '/closed', expectedStatus: 404 }));
});
test('cleanup never converts failed transport/state assertion into success', async () => {
  let cleaned = false;
  await assert.rejects(() => withCleanup(() => { throw new Error('HTTP 000'); }, () => { cleaned = true; }), /HTTP 000/);
  assert.ok(cleaned);
  await assert.rejects(() => withCleanup(() => { throw new Error('probe'); }, () => { throw new Error('cleanup'); }), error => error instanceof AggregateError && error.errors.length === 2);
  await assert.rejects(() => withCleanup(() => 'ok', () => { throw new Error('cleanup'); }), /cleanup/);
});
test('falsy rejections stay failed and cleanup still runs', async () => {
  for (const failure of [undefined, null, false, 0, '']) {
    let cleaned = false, rejected = false;
    try { await withCleanup(() => Promise.reject(failure), () => { cleaned = true; }); }
    catch (error) { rejected = true; assert.equal(error, failure); }
    assert.ok(rejected && cleaned);
  }
});
test('all cookie credentials and multiline explicit secrets are masked', () => {
  assert.doesNotMatch(redact('Cookie: session=sentinel-one; refresh=sentinel-two'), /sentinel/);
  const file = path.join(root, 'multiline.log'); const log = evidenceLog(file, { secrets: ['first-half\nsecond-half'] });
  log.write('first-half\n'); log.write('second-half\n'); log.close();
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /first-half|second-half/);
});
test('invalid caps fail before execution and an overflow seals the log', async () => {
  for (const maxBytes of ['unbounded', NaN, Infinity, -1, 0]) assert.throws(() => evidenceLog(path.join(root, 'invalid-' + String(maxBytes)), { maxBytes }), /Invalid/);
  const file = path.join(root, 'bounded.log'); const log = evidenceLog(file, { maxBytes: 1 });
  assert.throws(() => log.write('xx')); const size = fs.statSync(file).size;
  for (let i = 0; i < 100; i++) assert.throws(() => log.write('more'));
  log.close(); assert.equal(fs.statSync(file).size, size);
});
test('JSON event redaction preserves metrics, exit status and parseable structure', () => {
  const file = path.join(root, 'events.jsonl'); const log = evidenceLog(file);
  log.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 123, cached_input_tokens: 42, output_tokens: 4 } }) + '\n');
  log.write(JSON.stringify({ type: 'item.completed', item: { aggregated_output: 'Cookie: session=secret-one; refresh=secret-two\nfinished', exit_code: 17 }, password: 'secret-three' }) + '\n');
  log.close();
  const [usage, command] = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(usage.usage, { input_tokens: 123, cached_input_tokens: 42, output_tokens: 4 });
  assert.equal(command.item.exit_code, 17); assert.match(command.item.aggregated_output, /finished/);
  assert.doesNotMatch(JSON.stringify(command), /secret-one|secret-two|secret-three/);
});
test('camelCase, PascalCase and header-style credential keys are masked in every JSON shape', () => {
  const keys = ['accessToken', 'refreshToken', 'idToken', 'clientSecret', 'AccessToken', 'ClientSecret', 'x-api-key', 'private_key',
    'ConnectionStrings', 'secretKey', 'apiKey', 'APIKey', 'passphrase', 'tokens'];
  const value = Object.fromEntries(keys.map((k, i) => [k, 'fixture-value-' + i]));
  const shapes = [JSON.stringify(value), JSON.stringify({ outer: { list: [value] } }), JSON.stringify([value])];
  for (const shape of shapes) assert.doesNotMatch(redact(shape), /fixture-value/, shape);
  const file = path.join(root, 'pretty.jsonl'); const log = evidenceLog(file);
  const pretty = JSON.stringify({ response: value }, null, 2) + '\n';
  for (let i = 0; i < pretty.length; i += 7) log.write(pretty.slice(i, i + 7));   // chunk splits land mid-key and mid-value
  log.close();
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /fixture-value/);
});
test('token counts and other numbers stay readable; number-only env values are never secrets', () => {
  const usage = '{"type":"turn.completed","usage":{"input_tokens":5,"cached_input_tokens":1,"output_tokens":3,"reasoning_output_tokens":2}}';
  assert.equal(redact(usage), usage);
  assert.equal(redact('input_tokens: 12 output_tokens=4 max_tokens: 9'), 'input_tokens: 12 output_tokens=4 max_tokens: 9');
  assert.deepEqual(JSON.parse(redact('{"tokenCount":7,"secretsEnabled":true,"token":null}')), { tokenCount: 7, secretsEnabled: true, token: null });
  process.env.FIXTURE_MAX_OUTPUT_TOKENS = '4096'; process.env.FIXTURE_NUMERIC_TOKEN = '4097';
  try { assert.equal(redact('limit 4096 and 4097 retries'), 'limit 4096 and 4097 retries'); }
  finally { delete process.env.FIXTURE_MAX_OUTPUT_TOKENS; delete process.env.FIXTURE_NUMERIC_TOKEN; }
  // Any credential word masks the value (a hint next to a password is not worth the risk); a merely similar word does not.
  assert.equal(redact('passwordHint: none; accessToken=abc123def; tokenizer=wordpiece'), 'passwordHint: [REDACTED]; accessToken=[REDACTED]; tokenizer=wordpiece');
});
