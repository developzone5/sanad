import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { isMain } from './is-main.mjs';

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

// While a source-bound check runs, an edit inside its repository changes the tree
// and voids the whole run (2026-11-05: a full suite was lost twice that way). The
// run holds a lock file for that time; hooks/check-lock-guard.js reads the same
// folder and refuses such an edit. A lock is a guard rail, never a reason to
// refuse the check, so any lock error is ignored. `pidStartedAt` is when this process started (2026-11-13:
// on a CI runner a finished check's process id went to the next process at once, and its lock looked
// alive): the guard reads when the process now holding that id started, and a later start is another process.
export function checkLockDir() { return process.env.SANAD_CHECK_LOCK_DIR || path.join(os.homedir(), '.claude', 'state', 'check-locks'); }
function takeLock(receipt, timeoutMs) {
  try {
    const dir = checkLockDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, receipt.runId + '.json');
    fs.writeFileSync(file, JSON.stringify({ toplevel: receipt.source.toplevel, pid: process.pid, pidStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(), runId: receipt.runId, startedAt: receipt.startedAt,
      expiresAt: new Date(Date.now() + timeoutMs + 60000).toISOString(), command: [receipt.executable, ...receipt.args].join(' ').slice(0, 300) }), { flag: 'wx' });
    return file;
  } catch { return null; }
}

// 2026-11-12: a check that runs over ssh inside the test machine's clone (git config sanad.remoteHost +
// sanad.remoteRepo) proved nothing about THIS folder's code when another task had put its own code
// there: every worktree of a repository shares that one clone, and the receipt was bound to the local
// tree only. Such a run is now bound to the clone as well: the clone must hold exactly the local tree
// before the command starts (otherwise the command does not start: a run on other code is a wasted
// run) and still hold it when the command ends. The test machine runs Windows, as for remote-sync.sh.
function configValue(cwd, key) { try { return sourceGit(cwd, ['config', '--get', key]); } catch { return ''; } }
export function remoteTarget(executable, args, toplevel) {
  if (!/^ssh(?:\.exe)?$/i.test(path.basename(String(executable)))) return null;
  const host = configValue(toplevel, 'sanad.remoteHost'), repo = configValue(toplevel, 'sanad.remoteRepo');
  if (!host || !repo) return null;
  const at = args.indexOf(host);
  if (at < 0 || at === args.length - 1) return null;
  const flat = text => String(text).replace(/\\/g, '/').toLowerCase();
  if (!flat(args.slice(at + 1).join(' ')).includes(flat(repo).replace(/\/+$/, ''))) return null;
  return { host, repo, sshArgs: args.slice(0, at + 1) };
}
function probeRemote(remote, executable) {
  if (/["&|<>^%\r\n]/.test(remote.repo)) throw new Error('Unsafe sanad.remoteRepo.');
  const out = execFileSync(executable, [...remote.sshArgs, `cd /d "${remote.repo}" && git rev-parse HEAD^^{tree} && git status --porcelain --untracked-files=no`],
    { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  const lines = out.split(/\r?\n/).map(line => line.trimEnd()).filter(Boolean);
  const at = lines.findIndex(line => /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(line.trim()));
  if (at < 0) throw new Error('The test machine did not name its tree.');
  return { tree: lines[at].trim(), dirty: lines.slice(at + 1).join('\n') };
}

// `remoteProbe` (a function, so never from a JSON spec) stands in for the test machine in tests.
export async function runCommand({ executable, args = [], cwd, outputRoot, timeoutMs = 300000, maxBytes, secrets = [], remoteProbe }) {
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
  const lock = source ? takeLock(receipt, timeoutMs) : null;
  try {
    const remote = source && !sourceFailure ? remoteTarget(executable, args, source.toplevel) : null;
    const askRemote = async () => (typeof remoteProbe === 'function' ? remoteProbe : probeRemote)(remote, executable);
    if (remote) {
      receipt.remote = { host: remote.host, repo: remote.repo, treeBefore: null, treeAfter: null };
      let refused = null;
      try {
        const there = await askRemote();
        receipt.remote.treeBefore = there.tree;
        if (there.dirty) refused = `The folder on the test machine (${remote.host}) has changed files that are not part of this code. Clean it there, then run remote-sync.sh and the check again.`;
        else if (there.tree !== source.treeBefore) refused = `The test machine holds other code (tree ${String(there.tree).slice(0, 12)}; this folder is ${source.treeBefore.slice(0, 12)}). Run remote-sync.sh, then the check again.`;
      } catch { refused = `Cannot read the code on the test machine (${remote.host}) before the check.`; }
      if (refused) {
        stdout.close(); stderr.close();
        Object.assign(receipt, { completedAt: new Date().toISOString(), nativeExitCode: null, signal: null, reason: refused, status: 'failed',
          stdoutBytes: 0, stderrBytes: 0, stdout: path.join(runDir, 'stdout.log'), stderr: path.join(runDir, 'stderr.log') });
        fs.writeFileSync(path.join(runDir, 'metadata.json'), JSON.stringify(receipt, null, 2));
        return { ...receipt, runDir };
      }
    }
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
    // Another task's sync during this run changed the code under it: the result is not for this code.
    if (remote) {
      try {
        const there = await askRemote();
        receipt.remote.treeAfter = there.tree;
        if (there.tree !== source.treeBefore) sourceFailure ||= 'The code on the test machine changed while the command was running (another task put its code there). Run remote-sync.sh and the check again.';
      } catch { sourceFailure ||= `Cannot read the code on the test machine (${remote.host}) after the check.`; }
    }
    failure ||= sourceFailure;
    Object.assign(receipt, { completedAt: new Date().toISOString(), nativeExitCode: terminal.code, signal: terminal.signal, reason: failure,
      status: !failure && terminal.code === 0 ? 'passed' : 'failed', stdoutBytes: stdout.bytes, stderrBytes: stderr.bytes,
      stdout: path.join(runDir, 'stdout.log'), stderr: path.join(runDir, 'stderr.log') });
    fs.writeFileSync(path.join(runDir, 'metadata.json'), JSON.stringify(receipt, null, 2));
    return { ...receipt, runDir };
  } finally { if (lock) { try { fs.rmSync(lock, { force: true }); } catch { /* a stale lock expires on its own */ } } }
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

// 2026-11-14: the only failure of a 1759-test Vitest suite was "Test timed out in 5000ms." in a slow test file
// the task never touched; writing its rerun spec and the CHECK RETIRED line by hand cost minutes. When the
// check failed, every failing test failed by its test timeout (run-summary.mjs timeoutFailures), and no
// failing test file nor the source file it is named after is changed by this task, the CLI writes
// `<spec>-rerun-timeouts.json` (only those files, a 60 s test timeout) and prints the ready CHECK RETIRED
// line. Anything unsure offers nothing: a missed offer costs a hand-written rerun, a wrong one hides a failure.
const RERUN_SUFFIX = '-rerun-timeouts';
const RERUN_TIMEOUT = '--testTimeout=60000';
// Words that change which tests run, stop the run at a failure, let an empty run pass, or set a timeout
// already: offer nothing.
const RERUN_UNSAFE = /^(?:--(?:passWithNoTests|changed|related|findRelatedTests|onlyChanged|changedSince|lastCommit|listTests|shard|testTimeout|bail)\b.*|-o|-b|related|bench|list)$/;

// This task's files: those that differ between the merge base of HEAD with origin/<git config
// sanad.integration, default staging> and the working tree, untracked ones included; and every tracked
// file. null when git or that base is missing.
function taskFiles(toplevel) {
  try {
    const base = sourceGit(toplevel, ['merge-base', 'HEAD', 'origin/' + (configValue(toplevel, 'sanad.integration') || 'staging')]);
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(base)) return null;
    const list = args => sourceGit(toplevel, args).split('\0').filter(Boolean);
    return { changed: [...list(['diff', '--name-only', '--no-renames', '-z', base, '--']), ...list(['ls-files', '--others', '--exclude-standard', '-z'])],
      tracked: list(['ls-files', '-z']) };
  } catch { return null; }
}
// A runner names files from its own root (a sub-folder of the repository): the same file when one name ends the other.
const lowerPath = p => String(p).replace(/\\/g, '/').toLowerCase();
function sameFile(a, b) { a = lowerPath(a); b = lowerPath(b); return a === b || a.endsWith('/' + b) || b.endsWith('/' + a); }
// Touched: the test file changed, or the file it is named after (a.test.ts → a.ts, a.tsx): code made slower
// by this task would otherwise pass under the longer timeout.
function touched(file, changed) {
  const own = file.replace(/\.(?:test|spec)\.[^./]+$/i, '');
  return changed.some(c => sameFile(c, file) || (own !== file && sameFile(c.replace(/\.[^./]+$/, ''), own)));
}

const executableWord = w => String(w || '').split(/[\\/]/).pop().replace(/\.(?:exe|cmd|bat)$/i, '').toLowerCase();
// How a check's last command takes more words: a direct Vitest/Jest run as they are, an npm script after `--`.
// null for any other command, or when the command names another runner than the one whose output was read.
function runnerTail(words, runner) {
  const direct = found => (found === runner ? { dashDash: false } : null);
  const npm = rest => (/^(?:test|t|tst)$/.test(rest[0] || '') || (/^(?:run|run-script)$/.test(rest[0] || '') && /^[^-]/.test(rest[1] || ''))
    ? { dashDash: !rest.includes('--') } : null);
  const program = executableWord(words[0]);
  if (program === 'node') {
    const script = String(words[1] || '').replace(/\\/g, '/');
    if (/(?:^|\/)node_modules\/vitest\/vitest\.mjs$/i.test(script)) return direct('vitest');
    if (/(?:^|\/)node_modules\/(?:jest|jest-cli)\/bin\/jest(?:\.js)?$/i.test(script)) return direct('jest');
    if (/(?:^|\/)node_modules\/npm\/bin\/npm-cli\.js$/i.test(script)) return npm(words.slice(2));
    return null;
  }
  if (program === 'vitest' || program === 'jest') return direct(program);
  if (program === 'npx') return direct(executableWord(words.slice(1).find(w => !w.startsWith('-'))));
  if (program === 'npm') return npm(words.slice(1));
  return null;
}
// The last command of an ssh spec's remote line (`cd /d X && node …vitest.mjs run`): its words, and where added
// words go (before a trailing `2>&1`). null after a pipe, or with a redirection, a group or a variable in it:
// added words might reach another program there.
function lastCommand(line) {
  let start = 0, quoted = false, piped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { quoted = !quoted; continue; }
    if (quoted || !(ch === ';' || ch === '\n' || ch === '|' || (ch === '&' && line[i - 1] !== '>' && line[i - 1] !== '<'))) continue;
    const pair = (ch === '&' || ch === '|') && line[i + 1] === ch;
    piped = ch === '|' && !pair;
    start = i + (pair ? 2 : 1);
    if (pair) i++;
  }
  if (quoted || piped) return null;
  const end = start + /(?:\s+\d?>&\d)*\s*$/.exec(line.slice(start)).index;
  const command = line.slice(start, end);
  if (/[<>()`$%^!]/.test(command)) return null;
  return { words: (command.match(/"[^"]*"|\S+/g) || []).map(w => w.replace(/"/g, '')), end };
}
// A file name added to a remote shell line: quoted when it holds more than plain path signs.
function shellWord(file) {
  if (/["%$`!^&|<>\r\n\\]/.test(file)) return null;
  return /^[\w./@+-]+$/.test(file) ? file : '"' + file + '"';
}
// The spec's args with the failing files and the longer timeout added; for ssh, at the end of its remote line.
function rerunArgs(executable, args, files, runner) {
  if (typeof executable !== 'string' || !Array.isArray(args) || args.some(a => typeof a !== 'string') || !files.length) return null;
  // Jest reads each file as a pattern: a pattern sign in a name could match no file, and an empty run proves nothing.
  if (runner === 'jest' && files.some(f => /[[\](){}+*?^$|]/.test(f))) return null;
  if (executableWord(executable) === 'ssh') {
    const line = args[args.length - 1] || '';
    const last = lastCommand(line);
    const tail = last && !last.words.some(w => RERUN_UNSAFE.test(w)) ? runnerTail(last.words, runner) : null;
    const words = files.map(shellWord);
    if (!tail || words.includes(null)) return null;
    const added = [...(tail.dashDash ? ['--'] : []), ...words, RERUN_TIMEOUT].join(' ');
    return [...args.slice(0, -1), line.slice(0, last.end).replace(/\s+$/, '') + ' ' + added + line.slice(last.end)];
  }
  if (args.some(a => RERUN_UNSAFE.test(a))) return null;
  const tail = runnerTail([executable, ...args], runner);
  return tail ? [...args, ...(tail.dashDash ? ['--'] : []), ...files, RERUN_TIMEOUT] : null;
}

// The rerun offer for a finished check: { file, spec, lines } (the CLI writes the spec and prints the lines), or
// null. `specArg` is the spec path as given on the command line and `script` this helper's path: the stop hook
// matches CHECK RETIRED's `failed` against the command as typed (quotes dropped), so it is built the same way.
export async function rerunSuggestion({ receipt, spec, specArg, script }) {
  try {
    if (!receipt || receipt.status !== 'failed' || receipt.reason || receipt.signal || !Number.isInteger(receipt.nativeExitCode) || receipt.nativeExitCode === 0) return null;
    if (!receipt.source || typeof receipt.source.toplevel !== 'string' || !spec || typeof specArg !== 'string' || typeof script !== 'string' || /["\r\n]/.test(specArg + script)) return null;
    const cut = Math.max(specArg.lastIndexOf('/'), specArg.lastIndexOf('\\'));
    const name = specArg.slice(cut + 1).replace(/\.json$/i, '');
    if (!name || name.toLowerCase().endsWith(RERUN_SUFFIX)) return null;   // timed out again at 60 s: no load noise
    const { timeoutFailures } = await import('./run-summary.mjs');
    const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
    const failures = timeoutFailures(read(receipt.stdout) + '\n' + read(receipt.stderr));
    if (!failures) return null;
    // Each failing file must be a file of this repository (its name was read right) that this task does not touch.
    const git = taskFiles(receipt.source.toplevel);
    if (!git || failures.files.some(f => !git.tracked.some(t => sameFile(t, f)) || touched(f, git.changed))) return null;
    const args = rerunArgs(spec.executable, spec.args || [], failures.files, failures.runner);
    if (!args) return null;
    const quote = p => (/\s/.test(p) ? `"${p}"` : p);
    const command = file => `node ${quote(script)} --spec ${quote(file)}`;
    const shown = failures.files.join(', ');
    const lines = [`CHECK_RERUN: only timeouts, in test files this change does not touch: ${shown}`,
      'CHECK RETIRED: ' + JSON.stringify({ failed: command(specArg), replacement: command(specArg.slice(0, cut + 1) + name + RERUN_SUFFIX + '.json'),
        reason: `every failure is a test timeout, in test files this change does not touch (${shown}); the replacement reruns only them with ${RERUN_TIMEOUT}` })];
    if (lines.some(l => redact(l) !== l)) return null;   // a masked word would make a wrong command
    // The CLI refuses a spec over 64 KB (see below): such a rerun spec would only fail.
    if (Buffer.byteLength(JSON.stringify({ ...spec, args }, null, 2) + '\n') > 64000) return null;
    return { file: path.join(path.dirname(path.resolve(specArg)), name + RERUN_SUFFIX + '.json'), spec: { ...spec, args }, lines };
  } catch { return null; }
}

if (isMain(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--spec') throw new Error('Use --spec ABSOLUTE_JSON_FILE.');
    const spec = path.resolve(process.argv[3]);
    if (fs.statSync(spec).size > 64000) throw new Error('Verification specification exceeds 64 KB.');
    const input = JSON.parse(fs.readFileSync(spec, 'utf8'));
    const result = await runCommand(input);
    // A failed check names its totals and failing tests here, read from its saved logs (run-summary.mjs,
    // 2026-11-13); the receipt line stays last and unchanged.
    const { summaryLines } = await import('./run-summary.mjs');
    for (const line of summaryLines(result)) process.stdout.write(redact(line) + '\n');
    // Only test timeouts, in test files this task does not touch: a ready rerun spec and CHECK RETIRED line (2026-11-14).
    // The lines print only once the spec is written; any error offers nothing and changes neither the receipt nor the exit.
    try {
      const offer = await rerunSuggestion({ receipt: result, spec: input, specArg: process.argv[3], script: path.resolve(process.argv[1]).replace(/\\/g, '/') });
      if (offer) {
        fs.writeFileSync(offer.file, JSON.stringify(offer.spec, null, 2) + '\n');
        for (const line of offer.lines) process.stdout.write(line + '\n');
      }
    } catch { /* no offer */ }
    process.stdout.write('CHECK_COMPLETED ' + JSON.stringify(result) + '\n');
    process.exitCode = result.status === 'passed' ? 0 : result.nativeExitCode || 1;
  } catch (error) { process.stderr.write('CHECK_FAILED ' + redact(error.message) + '\n'); process.exitCode = 1; }
}
