import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Credential key names are matched as whole words after splitting camelCase,
// PascalCase, snake_case and kebab-case (accessToken, ClientSecret, x-api-key
// all read like access_token). The plural `tokens` is a usage counter
// (input_tokens) unless its value is non-numeric.
const CREDENTIAL_WORDS = new Set(['password', 'passwords', 'passwd', 'pwd', 'passphrase', 'secret', 'secrets', 'token', 'credential',
  'credentials', 'authorization', 'cookie', 'cookies', 'apikey', 'accesskey', 'privatekey', 'secretkey']);
const CREDENTIAL_PAIRS = new Set(['api_key', 'access_key', 'private_key', 'client_key', 'signing_key', 'connection_string', 'connection_strings']);

function keyWords(key) {
  return String(key).replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_').toLowerCase().split('_').filter(Boolean);
}

export function isSensitiveKey(key, value) {
  const words = keyWords(key);
  if (words.some(w => CREDENTIAL_WORDS.has(w))) return true;
  if (words.some((w, i) => i > 0 && CREDENTIAL_PAIRS.has(words[i - 1] + '_' + w))) return true;
  return words.includes('tokens') && value !== undefined && !/^-?\d+(?:\.\d+)?$/.test(String(value).replace(/^["']|["']$/g, ''));
}

function redactText(text, secrets = []) {
  let value = String(text);
  const fromEnv = Object.entries(process.env).filter(([key]) => /TOKEN|SECRET|PASSWORD|API_?KEY|CONNECTION_?STRING/i.test(key) && !/_TOKENS$/i.test(key)).map(([, v]) => v);
  const values = [...secrets, ...fromEnv.filter(v => typeof v === 'string' && !/^\d+$/.test(v.trim()))].filter(v => typeof v === 'string').flatMap(v => [v, ...v.split(/\r?\n/)]).filter(v => v.length >= 4).sort((a, b) => b.length - a.length);
  for (const secret of values) value = value.split(secret).join('[REDACTED]');
  return value
    .replace(/\b((?:cookie|set-cookie|authorization)\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+/gi, '$1 [REDACTED]')
    .replace(/(["']?)([A-Za-z_][\w.-]*)\1(\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;\r\n}\]]+)/g,
      (whole, quote, key, sep, found) => isSensitiveKey(key, found) && found !== '[REDACTED]' ? quote + key + quote + sep + (/^["']/.test(found) ? found[0] + '[REDACTED]' + found[0] : '[REDACTED]') : whole)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]');
}

export function redact(text, secrets = []) {
  const input = String(text);
  if (/^\s*[\[{]/.test(input)) {
    try {
      // Numbers, booleans and null are never credentials; masking them would
      // break usage counters (input_tokens) that review receipts rely on.
      const walk = value => {
        if (typeof value === 'string') return redactText(value, secrets);
        if (Array.isArray(value)) return value.map(walk);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, v]) =>
          [key, v !== null && typeof v !== 'number' && typeof v !== 'boolean' && isSensitiveKey(key, typeof v === 'string' ? v : 'object') ? '[REDACTED]' : walk(v)]));
        return value;
      };
      return JSON.stringify(walk(JSON.parse(input))) + (input.endsWith('\n') ? '\n' : '');
    } catch { /* Non-JSON process text uses the text masker. */ }
  }
  return redactText(input, secrets);
}

// Buffer incomplete lines so a secret split across process chunks is masked
// before reaching disk. Hitting the bound is a failure, never a clean truncation.
export function evidenceLog(file, { maxBytes = 8 * 1024 * 1024, secrets = [] } = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024 || !Array.isArray(secrets) || secrets.some(s => typeof s !== 'string')) throw new Error('Invalid evidence bounds or secret list.');
  fs.writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
  let pending = '', bytes = 0, closed = false;
  const append = text => { for (const line of text.match(/[^\n]*\n|[^\n]+$/g) || []) fs.appendFileSync(file, redact(line, secrets)); };
  return {
    write(chunk) {
      if (closed) throw new Error('Evidence log is closed.');
      const text = String(chunk); bytes += Buffer.byteLength(text);
      if (bytes > maxBytes) { pending = ''; append('\n[EVIDENCE LIMIT EXCEEDED; INCOMPLETE]\n'); closed = true; throw new Error('Evidence exceeded its byte bound.'); }
      pending += text;
      const end = pending.lastIndexOf('\n');
      if (end >= 0) { append(pending.slice(0, end + 1)); pending = pending.slice(end + 1); }
    },
    close() { if (!closed) { append(pending); pending = ''; closed = true; } },
    get bytes() { return bytes; },
  };
}

function stopTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore', timeout: 5000 });
    killer.once('error', () => child.kill());
    killer.once('close', code => { if (code) child.kill(); });
  } else child.kill('SIGTERM');
}

function sourceGit(cwd, args, extraEnv = {}, input) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  return execFileSync('git', args, { cwd, env: { ...env, GIT_OPTIONAL_LOCKS: '0', ...extraEnv }, input, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function sourceTree(toplevel) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-check-index-'));
  try {
    const env = { GIT_INDEX_FILE: path.join(scratch, 'index') };
    // Reconstruct tracked entries, including forced-added ignored paths, without
    // copying assume-unchanged/skip-worktree flags. Refresh only this temp index.
    const entries = sourceGit(toplevel, ['ls-files', '--stage', '-z']);
    sourceGit(toplevel, ['read-tree', '--empty'], env);
    if (entries) sourceGit(toplevel, ['update-index', '-z', '--index-info'], env, entries);
    sourceGit(toplevel, ['add', '-A', '--', '.'], env);
    if (/^160000 /m.test(sourceGit(toplevel, ['ls-files', '--stage'], env))) throw new Error('Submodule source cannot be bound by this check.');
    const tree = sourceGit(toplevel, ['write-tree'], env);
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(tree)) throw new Error('Invalid Git source tree.');
    return tree;
  } finally {
    // mkdtemp returns our newly-created child of the fixed OS temporary root.
    if (path.dirname(path.resolve(scratch)) !== path.resolve(os.tmpdir()) || !path.basename(scratch).startsWith('workflow-check-index-')) throw new Error('Invalid temporary index location.');
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export async function runCommand({ executable, args = [], cwd, outputRoot, timeoutMs = 300000, maxBytes, secrets = [] }) {
  if (typeof executable !== 'string' || !executable || !Array.isArray(args) || args.some(a => typeof a !== 'string') || !path.isAbsolute(cwd) || !path.isAbsolute(outputRoot)) throw new Error('Use an executable, argv array and absolute cwd/outputRoot.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) throw new Error('Timeout must be 1..3600000 ms.');
  fs.mkdirSync(outputRoot, { recursive: true });
  let source = null, sourceFailure = null, toplevel;
  try { toplevel = fs.realpathSync.native(sourceGit(cwd, ['rev-parse', '--show-toplevel'])); }
  catch { sourceFailure = 'Cannot bind source: cwd is not an accessible Git repository.'; }
  if (toplevel) {
    const relative = path.relative(toplevel, fs.realpathSync.native(outputRoot));
    if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('Evidence output must be outside the source repository.');
    try { source = { toplevel, treeBefore: sourceTree(toplevel), treeAfter: null }; }
    catch { sourceFailure = 'Cannot capture the Git source tree before verification.'; }
  }
  const runDir = fs.mkdtempSync(path.join(outputRoot, 'check-'));
  const stdout = evidenceLog(path.join(runDir, 'stdout.log'), { maxBytes, secrets });
  const stderr = evidenceLog(path.join(runDir, 'stderr.log'), { maxBytes, secrets });
  const receipt = { runId: crypto.randomUUID(), executable: redact(executable, secrets), args: args.map(a => redact(a, secrets)), cwd: fs.realpathSync.native(cwd), source, startedAt: new Date().toISOString(), status: 'running' };
  fs.writeFileSync(path.join(runDir, 'metadata.json'), JSON.stringify(receipt, null, 2));
  const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let failure = null, fallback;
  let finish;
  const abort = reason => {
    if (failure) return;
    failure = reason; stopTree(child);
    fallback = setTimeout(() => { child.kill('SIGKILL'); child.stdout.destroy(); child.stderr.destroy(); child.unref(); finish({ code: null, signal: 'TIMEOUT' }); }, 6000);
  };
  const cancel = () => abort('Cancelled');
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  for (const [stream, log] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on('data', data => { try { log.write(data); } catch (error) { abort(error.message); } });
  const timer = setTimeout(() => abort('Timed out'), timeoutMs);
  const terminal = await new Promise(resolve => {
    finish = resolve;
    child.once('error', error => { failure = 'Could not start process: ' + error.code; resolve({ code: null, signal: null }); });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer); clearTimeout(fallback);
  process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  stdout.close(); stderr.close();
  if (source) {
    try {
      if (fs.realpathSync.native(sourceGit(cwd, ['rev-parse', '--show-toplevel'])) !== source.toplevel) throw new Error('Repository changed.');
      source.treeAfter = sourceTree(source.toplevel);
      if (source.treeBefore !== source.treeAfter) sourceFailure = 'Verified source changed while the command was running.';
    } catch { sourceFailure = 'Cannot capture the Git source tree after verification.'; }
  }
  failure ||= sourceFailure;
  Object.assign(receipt, { completedAt: new Date().toISOString(), nativeExitCode: terminal.code, signal: terminal.signal, reason: failure,
    status: !failure && terminal.code === 0 ? 'passed' : 'failed', stdoutBytes: stdout.bytes, stderrBytes: stderr.bytes,
    stdout: path.join(runDir, 'stdout.log'), stderr: path.join(runDir, 'stderr.log') });
  fs.writeFileSync(path.join(runDir, 'metadata.json'), JSON.stringify(receipt, null, 2));
  return { ...receipt, runDir };
}

export async function assertHttp({ url, expectedStatus, options = {}, expectedCode, codePath = 'code', assertState, timeoutMs = 10000, maxBytes = 1024 * 1024 }) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Use an explicit HTTP(S) URL without credentials.');
  if (!Number.isInteger(expectedStatus) || expectedStatus < 100 || expectedStatus > 599) throw new Error('An expected HTTP status is required.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000 || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024) throw new Error('Invalid HTTP evidence bounds.');
  if (assertState !== undefined && typeof assertState !== 'function') throw new Error('State assertion must be an async function.');
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const response = await fetch(parsed, { ...options, redirect: 'error', signal });
  let bytes = 0; const chunks = [];
  try {
    for await (const chunk of response.body || []) { bytes += chunk.length; if (bytes > maxBytes) throw new Error('HTTP body exceeds evidence bound.'); chunks.push(chunk); }
  } catch (error) { throw new Error('HTTP transport/body failed: ' + error.message); }
  assert.equal(response.status, expectedStatus, `HTTP status: expected ${expectedStatus}, received ${response.status}`);
  const body = Buffer.concat(chunks).toString('utf8');
  let json;
  if (expectedCode !== undefined) {
    assert.match(response.headers.get('content-type') || '', /\bapplication\/(?:[\w.-]+\+)?json\b/i, 'Expected a JSON response for the API code assertion');
    json = JSON.parse(body);
    assert.equal(codePath.split('.').reduce((v, key) => v?.[key], json), expectedCode, 'Unexpected API error code');
  }
  if (assertState) assert.notEqual(await assertState({ status: response.status, body, json }), false, 'Persisted state assertion returned false');
  return { status: response.status, bytes, code: expectedCode, stateChecked: !!assertState };
}

export async function withCleanup(action, cleanup) {
  let value, failure, failed = false;
  try { value = await action(); } catch (error) { failure = error; failed = true; }
  try { await cleanup(); } catch (error) { if (failed) throw new AggregateError([failure, error], 'Probe and cleanup both failed'); throw error; }
  if (failed) throw failure;
  return value;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--spec') throw new Error('Use --spec ABSOLUTE_JSON_FILE.');
    const spec = path.resolve(process.argv[3]);
    if (fs.statSync(spec).size > 64000) throw new Error('Verification specification exceeds 64 KB.');
    const result = await runCommand(JSON.parse(fs.readFileSync(spec, 'utf8')));
    process.stdout.write('CHECK_COMPLETED ' + JSON.stringify(result) + '\n');
    process.exitCode = result.status === 'passed' ? 0 : result.nativeExitCode || 1;
  } catch (error) { process.stderr.write('CHECK_FAILED ' + redact(error.message) + '\n'); process.exitCode = 1; }
}
