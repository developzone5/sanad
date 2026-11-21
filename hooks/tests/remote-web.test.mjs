import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'remote', 'remote-web.sh');

// Git's own bash and its tools (see remote-preflight.test.mjs: `bash` on PATH can be the WSL launcher).
function gitBash() {
  if (process.platform !== 'win32') return { exe: 'bash', tools: '' };
  try {
    const exec = execFileSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true }).trim();
    const tools = path.resolve(exec, '..', '..', '..', 'usr', 'bin');
    if (fs.existsSync(path.join(tools, 'bash.exe'))) return { exe: path.join(tools, 'bash.exe'), tools };
  } catch { /* no git on PATH: fall back to PATH */ }
  return { exe: 'bash', tools: '' };
}
const BASH = gitBash();
const WEB = 39411, API = 39412;   // ports nothing else uses on a developer machine

// A fake test machine: `netstat` is a file, the web server is a line in it, a stop removes the line.
// The command that starts the web server stays in the foreground, as the real one does.
const FAKE_SSH = `#!/usr/bin/env bash
d="$(dirname "$0")"
cmd="\${@: -1}"
echo "$cmd" >> "$d/calls.log"
case "$cmd" in
  "echo ok") echo ok ;;
  "netstat -ano") cat "$d/netstat" 2>/dev/null ;;
  tasklist*) echo '"node.exe","1","Services","0","52,772 K"' ;;
  "taskkill /PID "*) n=$(echo "$cmd" | awk '{print $3}'); grep -v " $n\\$" "$d/netstat" > "$d/netstat.new"; mv "$d/netstat.new" "$d/netstat"; rm -f "$d/web-up" ;;
  START-WEB*)
    if [ -f "$d/web-fails" ]; then echo "error when starting dev server: Port ${WEB} is already in use"; exit 1; fi
    n=$(cat "$d/next-pid" 2>/dev/null || echo 7001); echo $((n + 1)) > "$d/next-pid"
    echo "  TCP    127.0.0.1:${WEB}        0.0.0.0:0              LISTENING       $n" >> "$d/netstat"
    touch "$d/web-up"; echo "VITE ready"
    while :; do sleep 1; done ;;
  RESTART-APP*) : ;;
  *) exit 1 ;;
esac
`;
const FAKE_CURL = `#!/usr/bin/env bash
d="$(dirname "$0")"
[ -f "$d/web-up" ] || { printf 000; exit 7; }
code=200
if [ -s "$d/codes" ]; then
  code=$(head -1 "$d/codes")
  if [ "$(wc -l < "$d/codes")" -gt 1 ]; then
    tail -n +2 "$d/codes" > "$d/codes.next"; mv "$d/codes.next" "$d/codes"
  fi
fi
echo "$code \${@: -1}" >> "$d/curl-calls.log"
printf '%s' "$code"
`;

function setup({ config = {}, sync = 'echo "SYNCED pc2:C:/repos/App 1111111111111111111111111111111111111111 tree 2222222222222222222222222222222222222222"', wait = '15', useRealCurl = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-web-'));
  const bin = path.join(root, 'bin'), repo = path.join(root, 'repo'), state = path.join(root, 'state');
  for (const d of [bin, repo, state]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(bin, 'ssh'), FAKE_SSH, { mode: 0o755 });
  if (!useRealCurl) fs.writeFileSync(path.join(bin, 'curl'), FAKE_CURL, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'netstat'), '');
  fs.writeFileSync(path.join(bin, 'sync.sh'), `#!/usr/bin/env bash\n${sync}\n`);
  fs.writeFileSync(path.join(bin, 'preflight.sh'), '#!/usr/bin/env bash\necho "$*" > "$(dirname "$0")/preflight-args"\necho "READY pc2 docker 29.9.2 app web-api healthy (held until 2026-11-11T12:00:00Z)"\n');
  // Only this test's settings: the real global ones (this machine has a remote) must not leak in.
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', SANAD_STATE_DIR: state.replaceAll('\\', '/'),
    REMOTE_WEB_SYNC: path.join(bin, 'sync.sh'), REMOTE_WEB_PREFLIGHT: path.join(bin, 'preflight.sh'), REMOTE_WEB_WAIT_SECONDS: wait };
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '');
  const all = { 'sanad.remoteHost': 'pc2', 'sanad.remoteWebUp': 'START-WEB vite --port ' + WEB, 'sanad.remoteWebPorts': `${WEB} ${API}`,
    'sanad.remoteAppRestart': 'RESTART-APP', 'sanad.remoteAppUp': 'start the app', ...config };
  const gitDir = path.join(repo, '.git');
  fs.mkdirSync(path.join(gitDir, 'refs'), { recursive: true });
  fs.mkdirSync(path.join(gitDir, 'objects'));
  fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
  const entries = Object.entries(all).filter(([, value]) => value !== null)
    .map(([key, value]) => `\t${key.slice('sanad.'.length)} = ${JSON.stringify(value)}\n`);
  fs.writeFileSync(path.join(gitDir, 'config'), '[sanad]\n' + entries.join(''));
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  env.PATH = [bin, BASH.tools, process.env.PATH].filter(Boolean).join(path.delimiter);
  const options = { cwd: repo, encoding: 'utf8', env, windowsHide: true, timeout: 60000 };
  const run = (...args) => {
    const r = spawnSync(BASH.exe, [script, ...args], options);
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
  };
  const runAsync = (...args) => new Promise(resolve => {
    execFile(BASH.exe, [script, ...args], options, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, out: stdout + stderr });
    });
  });
  const calls = () => { try { return fs.readFileSync(path.join(bin, 'calls.log'), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  const read = (name) => { try { return fs.readFileSync(path.join(state, name), 'utf8').trim(); } catch { return null; } };
  // Whatever a test leaves: the fake link is stopped, then the folder goes.
  const done = () => { run('stop'); fs.rmSync(root, { recursive: true, force: true }); };
  return { root, bin, repo, run, runAsync, calls, read, done };
}

// Give the fixture a synthetic HEAD. The tests only run read-only Git commands.
function seedHead(repo) {
  const gitDir = path.join(repo, '.git');
  const object = (type, content) => {
    const data = Buffer.from(`${type} ${Buffer.byteLength(content)}\0${content}`);
    const id = createHash('sha1').update(data).digest('hex');
    const dir = path.join(gitDir, 'objects', id.slice(0, 2));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, id.slice(2)), deflateSync(data));
    return id;
  };
  const identity = 'Test <test@example.invalid> 1 +0000';
  const tip = object('commit', `tree ${object('tree', '')}\nauthor ${identity}\ncommitter ${identity}\n\nFixture\n`);
  fs.mkdirSync(path.join(gitDir, 'refs', 'heads'));
  fs.writeFileSync(path.join(gitDir, 'refs', 'heads', 'main'), `${tip}\n`);
}

// 2026-11-11 (TUW-242, TUW-243): a link to an old web server held the ports here, the new server came up on
// another port behind it, and three web servers stayed on the test machine.
test('start brings the app up in one step; a second start and a stop end only what this script started', () => {
  const t = setup();
  try {
    const first = t.run('start', '--hold', '45');
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, new RegExp(`^READY http://localhost:${WEB} · ports ${WEB} ${API} linked from pc2 · web server pid 7001 there · code pc2:C:/repos/App 1{40} tree 2{40}$`, 'm'));
    assert.match(first.out, /^READY pc2 docker 29\.9\.2 app web-api healthy/m, 'the app is ready too');
    assert.equal(fs.readFileSync(path.join(t.bin, 'preflight-args'), 'utf8').trim(), '--app --hold 45');
    assert.equal(t.read('remote-web-pc2.server'), `${WEB} 7001`);
    const link1 = t.read('remote-web-pc2.link');
    assert.match(link1, new RegExp(`^\\d+ \\S+ ${WEB} ${API}$`));
    assert.deepEqual(t.calls().filter(c => /^(RESTART|START|taskkill)/.test(c)), ['RESTART-APP', 'START-WEB vite --port ' + WEB], 'nothing was stopped');
    const status = t.run('status');
    assert.match(status.out, /^LINK up/m); assert.match(status.out, /^WEB up on pc2 \(pid 7001, port 39411\)$/m);

    const second = t.run('start');
    assert.equal(second.code, 0, second.out);
    assert.match(second.out, /^STOPPED: the link here and the web server on pc2 \(pid 7001, port 39411\)$/m, 'the earlier start is ended first');
    assert.match(second.out, /web server pid 7002 there/);
    assert.ok(t.calls().includes('taskkill /PID 7001 /T /F'));
    assert.equal(t.read('remote-web-pc2.server'), `${WEB} 7002`);
    assert.notEqual(t.read('remote-web-pc2.link'), link1);

    const stop = t.run('stop');
    assert.equal(stop.code, 0, stop.out);
    assert.match(stop.out, /^STOPPED: the link here and the web server on pc2 \(pid 7002, port 39411\)$/m);
    assert.equal(t.read('remote-web-pc2.server'), null); assert.equal(t.read('remote-web-pc2.link'), null);
    assert.match(t.run('stop').out, /^NOTHING: /m, 'a second stop has nothing to stop');
    assert.match(t.run('status').out, /^NOTHING: /m);
  } finally { t.done(); }
});

test('a port another process holds is never taken: PORT-BUSY, and nothing is stopped or started', async () => {
  const there = setup();
  try {
    fs.writeFileSync(path.join(there.bin, 'netstat'), `  TCP    [::1]:${WEB}             [::]:0                 LISTENING       4216\n  TCP    0.0.0.0:1${WEB}        0.0.0.0:0              LISTENING       9\n`);
    const r = there.run('start');
    assert.equal(r.code, 9, r.out);
    assert.match(r.out, new RegExp(`^PORT-BUSY: port ${WEB} on pc2 is held by pid 4216 \\(node\\.exe\\), which this script did not start\\. Ask the user`, 'm'));
    assert.deepEqual(there.calls().filter(c => /^(START|taskkill|RESTART)/.test(c)), []);
  } finally { there.done(); }

  const here = setup();
  const server = net.createServer().listen(API, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const r = here.run('start');
    assert.equal(r.code, 9, r.out);
    assert.match(r.out, new RegExp(`^PORT-BUSY: port ${API} on this machine is in use`, 'm'));
    assert.deepEqual(here.calls().filter(c => /^(START|taskkill|RESTART)/.test(c)), []);
  } finally { server.close(); here.done(); }
});

test('a web server that does not come up is WEB-DOWN with its last lines, and leaves nothing behind', () => {
  const t = setup();
  try {
    fs.writeFileSync(path.join(t.bin, 'web-fails'), '');
    const r = t.run('start');
    assert.equal(r.code, 10, r.out);
    assert.match(r.out, /^WEB-DOWN: the web server on pc2 stopped before it answered/m);
    assert.match(r.out, /Port 39411 is already in use/);
    assert.equal(t.read('remote-web-pc2.link'), null);
  } finally { t.done(); }
});

test('missing settings, no test machine and a failed sync each stop with their own word', () => {
  const none = setup({ config: { 'sanad.remoteWebUp': null } });
  try {
    const r = none.run('start');
    assert.equal(r.code, 1); assert.match(r.out, /^FAILED: start needs git config sanad\.remoteWebUp/m);
    assert.equal(none.run('restart').code, 1, 'an unknown action');
  } finally { none.done(); }
  const local = setup({ config: { 'sanad.remoteHost': null } });
  try { const r = local.run('start'); assert.equal(r.code, 3); assert.match(r.out, /^NO-REMOTE: /m); } finally { fs.rmSync(local.root, { recursive: true, force: true }); }
  const dirty = setup({ sync: 'echo "REMOTE-DIRTY: pc2:C:/repos/App has uncommitted changes:"; exit 5' });
  try {
    const r = dirty.run('start');
    assert.equal(r.code, 5, r.out); assert.match(r.out, /^REMOTE-DIRTY: /m);
    assert.deepEqual(dirty.calls().filter(c => /^(START|RESTART)/.test(c)), [], 'no app or web server on code that was not synced');
  } finally { dirty.done(); }
});

test('only the empty 200 response makes the configured check path ready after 500 and 404', async () => {
  const checkPath = '/ready?side=app';
  const t = setup({ config: { 'sanad.remoteWebCheckPath': checkPath }, useRealCurl: true });
  const requests = [];
  const codes = [500, 404, 200];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(codes.shift() ?? 500);
    res.end();
  });
  // Bind only after the fake SSH starts. The port must be free before that.
  let started = false;
  const watcher = fs.watch(t.bin, () => {
    if (started || !fs.existsSync(path.join(t.bin, 'web-up'))) return;
    started = true;
    server.listen(WEB, '127.0.0.1');
  });
  try {
    const r = await t.runAsync('start');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^READY http:\/\/localhost:/m);
    assert.doesNotMatch(r.out, /WEB-ERROR/);
    assert.deepEqual(requests, [checkPath, checkPath, checkPath]);
  } finally {
    watcher.close();
    await new Promise(resolve => server.close(resolve));
    t.done();
  }
});

test('a redirect on the default path is ready', () => {
  const t = setup();
  try {
    fs.writeFileSync(path.join(t.bin, 'codes'), '302\n');
    const r = t.run('start');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^READY http:\/\/localhost:/m);
    assert.equal(fs.readFileSync(path.join(t.bin, 'curl-calls.log'), 'utf8').trim(), `302 http://localhost:${WEB}/`);
  } finally { t.done(); }
});

test('a persistent HTTP error prints the last code and logs, and stops the link and server', () => {
  const t = setup({ wait: '5' });
  try {
    fs.writeFileSync(path.join(t.bin, 'codes'), '500\n404\n');
    const r = t.run('start');
    assert.equal(r.code, 10, r.out);
    assert.match(r.out, /^WEB-ERROR: HTTP 404 from localhost:39411\. Its last lines:$/m);
    assert.match(r.out, /VITE ready/);
    assert.doesNotMatch(r.out, /^READY /m);
    for (const suffix of ['link', 'server', 'owner']) assert.equal(t.read(`remote-web-pc2.${suffix}`), null);
    assert.ok(t.calls().includes('taskkill /PID 7001 /T /F'));
  } finally { t.done(); }
});

test('a check target must be a path on localhost', () => {
  const t = setup({ config: { 'sanad.remoteWebCheckPath': 'https://other.example/ready' } });
  try {
    const r = t.run('start');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /^FAILED: sanad\.remoteWebCheckPath must start with \/ and contain no control characters$/m);
    assert.deepEqual(t.calls().filter(c => /^(RESTART|START|taskkill)/.test(c)), []);
  } finally { t.done(); }
});

test('a failed preflight keeps its exit code and Docker logs', () => {
  const t = setup();
  try {
    fs.writeFileSync(path.join(t.bin, 'preflight.sh'), `echo 'NOTE: running sanad.remoteAppHeal once'
echo 'APP-DOWN: web-api could not start. Its last lines:'
echo '  app boot failed'
exit 8
`);
    const r = t.run('start');
    assert.equal(r.code, 8, r.out);
    assert.match(r.out, /^NOTE: running sanad\.remoteAppHeal once/m);
    assert.match(r.out, /^APP-DOWN: .*\n  app boot failed$/m);
    assert.ok(t.calls().every(c => !c.startsWith('START-WEB')));
  } finally { t.done(); }
});

test('the shared file guard refuses a foreign folder before sync', () => {
  const t = setup({ sync: 'echo "sync must not run"; exit 5' });
  try {
    seedHead(t.repo);
    const folder = path.join(t.repo, 'foreign');
    fs.mkdirSync(folder);
    for (let i = 0; i < 201; i++) fs.writeFileSync(path.join(folder, `${i}.js`), '');
    const r = t.run('start');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /^FOREIGN\? foreign\/ holds 201 untracked files:/m);
    assert.deepEqual(t.calls().filter(c => /^(RESTART|START|taskkill)/.test(c)), []);
  } finally { t.done(); }
});
