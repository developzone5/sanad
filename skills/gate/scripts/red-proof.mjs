#!/usr/bin/env node
// red-proof.mjs — prove new tests can fail, without leaving a failed check behind. Each run swaps
// files, runs the test command once, and always puts the files back byte for byte.
//
//   old code   (--old <ref> --files <fix files>): the tests fail on the code before the fix.
//   breaks     (--breaks <json>): for each break of the rule under test (one exact text replaced in
//              one product file), the named tests must fail. 2026-11-07: three rounds in a row a
//              "nothing happens" check passed review that no run had ever seen fail; the old code
//              proves only the first failing line of each test. A break proves the rest.
//   green      (--then-green): the same command on the fixed tree passes, before any reviewer reads.
//   one break  (--break <file> --find <text> --put <text>): a test of code that already works.
//
// Why a script: a red run typed as a plain test command is kept as a failed check by the push
// guard forever, and a hand-written "swap; test; restore" compound can never be re-run green.
// Exit 0 = every requested proof held (each failing test named, with its reason), 1 = NOT RED,
// a break the tests did not catch, or a red green run; 2 = usage or restore problem; 3 = SETUP (a
// test failed for a setup reason: element not found, type or build error, timeout).
//
// Usage:
//   node ~/.claude/skills/gate/scripts/red-proof.mjs --repo <path> [--old <git-ref> --files <a,b>]
//        [--breaks <json>] [--then-green] [--base <ref>] [--cwd <dir>] [--log <file>] -- <executable> [args...]
//   node ~/.claude/skills/gate/scripts/red-proof.mjs --repo <path> --break <file> --find <text> --put <text>
//        [--cwd <dir>] [--log <file>] -- <executable> [args...]
//   node ~/.claude/skills/gate/scripts/red-proof.mjs --restore <backup-dir>
// --breaks file: [{ "name": "...", "file": "<repo-relative>", "find": "<exact text, once>",
//   "put": "<replacement>", "mustFail": ["<part of a test name>", ...] }, ...]
// A passing run records the test files it proved (see proof-record.mjs); pre-review's test check
// reads that record. The test command runs without a shell; pass the real executable (node
// <entrypoint>, dotnet, ...), not a .cmd shim.
//
// --parallel <n> (2026-11-07: eleven runs one after another took 2 minutes): each run gets its own
// temporary copy of the repository (a git worktree with the uncommitted files copied in and every
// node_modules folder linked), n at a time; the working folder is never touched. --plan <json> is
// how remote-proof.mjs hands a run to the test machine: { old: [{ file, content64|null }],
// oldLabel, breaks, green }.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { changedTestFiles, defaultBase, testFileHashes, writeRecord } from './proof-record.mjs';

// Why each test failed (2026-11-06). An assertion about behavior proves the code is wrong. A
// missing element, a type, reference or build error, or a timeout means the test itself (or the
// machine) is wrong, so the run proves nothing yet: exit 3, SETUP.
const SETUP_ERR = /TestingLibraryElementError|Unable to find (?:an? )?(?:accessible )?element|Found multiple elements|\bTypeError\b|\bReferenceError\b|\bSyntaxError\b|Cannot read propert|is not a function|is not defined|Test timed out|Hook timed out|Cannot find module|Failed to resolve import|NullReferenceException|\berror (?:CS|TS)\d{3,5}\b/;
const ASSERT_ERR = /AssertionError|\bexpected\b.*\bto\b|Assert\.\w+\(\) Failure|Xunit\.Sdk\.\w+Exception|AssertFailedException|Shouldly|^Expected:/i;
const SETUP_OUTPUT = /\berror (?:CS|TS)\d{3,5}\b|Build FAILED|Failed to resolve import|Cannot find module|SyntaxError/;
export function failureReasons(text) {
  const lines = String(text).replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/);
  const found = new Map();
  for (let i = 0; i < lines.length; i++) {
    const vitest = /^\s*FAIL\s+(.+?)\s*$/.exec(lines[i]);
    const dotnet = /^\s*Failed\s+(\S.*?)\s*\[[^\]]*\]\s*$/.exec(lines[i]);
    const name = vitest ? vitest[1] : dotnet ? dotnet[1] : null;
    if (!name || /\(\d+ tests?\b/.test(name) || found.has(name)) continue; // a file's summary line, or seen
    let kind = 'other', why = '';
    // Tests that fail the same way are listed together, one FAIL line each, above one shared error
    // (vitest groups them): skip the FAIL lines right below this one and read that error.
    let grouped = true;
    for (let j = i + 1; j < Math.min(lines.length, i + 60); j++) {
      const l = lines[j].trim();
      if (!l || /^(?:[⎯─-]{3,}|Error Message:|Stack Trace:)/.test(l)) continue;
      if (/^\s*(?:FAIL|Failed)\s/.test(lines[j])) { if (grouped) continue; break; }
      grouped = false;
      if (SETUP_ERR.test(l)) { kind = 'setup'; why = l; break; }
      if (ASSERT_ERR.test(l)) { kind = 'assert'; why = l; break; }
    }
    found.set(name, { name, kind, why: why.slice(0, 140) });
  }
  return [...found.values()];
}

// The mustFail names a break run did not see failing. Under a break, any failure of a named test
// catches it, an error as well as an assertion (2026-11-07: a test that crashed because the break
// removed its element was called a broken test, and the whole proof ran again, twice).
export function survivors(mustFail, reasons) {
  const failed = reasons.map(r => r.name.toLowerCase());
  return mustFail.filter(part => !failed.some(name => name.includes(String(part).toLowerCase())));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { process.stdout.write('RED-PROOF: failed — ' + e.message + '\n'); process.exit(2); });
}

async function main() {
  const argv = process.argv.slice(2);
  const dash = argv.indexOf('--');
  const opts = dash >= 0 ? argv.slice(0, dash) : argv;
  const command = dash >= 0 ? argv.slice(dash + 1) : [];
  const opt = (name) => { const i = opts.indexOf(name); return i >= 0 ? opts[i + 1] : undefined; };
  const said = [];
  const say = (line) => { said.push(line); process.stdout.write(line + '\n'); };
  const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

  function restore(dir) {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    const problems = [];
    for (const entry of manifest.files) {
      const target = path.join(manifest.repo, entry.file);
      if (entry.existed) {
        const saved = fs.readFileSync(path.join(dir, entry.backup));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, saved);
        if (sha(fs.readFileSync(target)) !== entry.sha) problems.push(entry.file);
      } else if (fs.existsSync(target)) {
        fs.rmSync(target);
      }
    }
    if (problems.length) throw new Error('restore mismatch: ' + problems.join(', ') + ' — backups kept in ' + dir);
    fs.rmSync(dir, { recursive: true, force: true });
    return manifest.files.length;
  }

  if (opt('--restore')) {
    try { say(`RED-PROOF: restored ${restore(opt('--restore'))} file(s)`); process.exit(0); }
    catch (e) { say('RED-PROOF: RESTORE FAILED — ' + e.message); process.exit(2); }
  }

  const repo = opt('--repo') && path.resolve(opt('--repo'));
  const oldRef = opt('--old');
  const oldFiles = (opt('--files') || '').split(',').map((f) => f.trim().replace(/\\/g, '/')).filter(Boolean);
  const usage = () => {
    say('usage: red-proof.mjs --repo <path> [--old <git-ref> --files <a,b>] [--breaks <json>] [--then-green] [--base <ref>] [--cwd <dir>] [--log <file>] -- <executable> [args...]');
    say('   or: red-proof.mjs --repo <path> --break <file> --find <text> --put <text> [--cwd <dir>] [--log <file>] -- <executable> [args...]');
    process.exit(2);
  };
  // The breaks to run: from --breaks, or the single --break.
  let breaks = [];
  try {
    if (opt('--breaks')) breaks = JSON.parse(fs.readFileSync(path.resolve(opt('--breaks')), 'utf8'));
    else if (opt('--break')) breaks = [{ name: 'break', file: opt('--break'), find: opt('--find'), put: opt('--put'), single: true }];
  } catch (e) { say('RED-PROOF: cannot read --breaks — ' + e.message); process.exit(2); }
  if (!Array.isArray(breaks) || breaks.some(b => !b || typeof b.file !== 'string' || typeof b.find !== 'string' || !b.find || typeof b.put !== 'string' ||
    (!b.single && (!Array.isArray(b.mustFail) || !b.mustFail.length)))) {
    say('RED-PROOF: each break needs file, find, put and a non-empty mustFail list.'); process.exit(2);
  }
  let plan = null;
  if (opt('--plan')) {
    try { plan = JSON.parse(fs.readFileSync(path.resolve(opt('--plan')), 'utf8')); breaks = plan.breaks || []; }
    catch (e) { say('RED-PROOF: cannot read --plan — ' + e.message); process.exit(2); }
    if (!Array.isArray(breaks) || breaks.some(b => !b || typeof b.file !== 'string' || typeof b.find !== 'string' || !b.find || typeof b.put !== 'string' || !Array.isArray(b.mustFail) || !b.mustFail.length)) {
      say('RED-PROOF: each break needs file, find, put and a non-empty mustFail list.'); process.exit(2);
    }
  }
  const green = opts.includes('--then-green') || Boolean(plan?.green);
  // Each run tests a few files, so half the machine's cores run at once (8 on a 16-core machine).
  const parallel = Math.max(1, Number.parseInt(opt('--parallel') || '', 10) || Math.max(2, Math.floor(os.cpus().length / 2)));
  const oldPlan = Array.isArray(plan?.old) && plan.old.length ? plan.old : null;
  const oldLabel = oldPlan ? String(plan.oldLabel || 'the old code') : oldRef;
  const oldNames = oldPlan ? oldPlan.map(o => o.file) : oldFiles;
  const hasOld = Boolean(oldPlan || oldRef);
  if (!repo || !command.length || (oldRef ? !oldFiles.length : false) || (!hasOld && !breaks.length)) usage();
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  for (const b of breaks) {
    b.file = b.file.replace(/\\/g, '/');
    const target = path.join(repo, b.file);
    const hits = fs.existsSync(target) ? fs.readFileSync(target, 'utf8').split(b.find).length - 1 : 0;
    if (hits !== 1) { say(`RED-PROOF: ${b.single ? '--find' : `break "${b.name}"`} matches ${hits} time(s) in ${b.file}; it must match exactly once. Nothing changed.`); process.exit(2); }
  }
  if (oldRef) {
    try { git('rev-parse', '--verify', oldRef + '^{commit}'); }
    catch { say(`RED-PROOF: unknown --old ref ${oldRef}`); process.exit(2); }
  }
  // The test files proved: hashed before anything changes (only product files are ever swapped).
  const base = opt('--base') || defaultBase(repo);
  const testFiles = changedTestFiles(repo, base);
  const fileHashes = testFiles ? testFileHashes(repo, testFiles) : null;

  // On the test machine when there is one, by itself (2026-11-07: the rule "tests run on the test
  // machine" was written, but this script only ran here, so the proof ran on the busy desktop).
  // `--local` runs here instead (only when the user says so, or there is no test machine).
  const gitText = (args) => { try { return execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
  const remoteHost = gitText(['config', '--get', 'sanad.remoteHost']);
  if (remoteHost && !opts.includes('--local') && !plan && !breaks.some(b => b.single)) return runRemote();

  function runRemote() {
    const remoteRepo = gitText(['config', '--get', 'sanad.remoteRepo']).replace(/\\/g, '/').replace(/\/$/, '');
    if (!remoteRepo) { say('RED-PROOF: git config sanad.remoteHost is set but sanad.remoteRepo is not; set it, or run with --local.'); process.exit(2); }
    const remoteNode = gitText(['config', '--get', 'sanad.remoteNode']) || 'node';
    const windows = /^[A-Za-z]:\//.test(remoteRepo);
    const sync = spawnSync('bash', [path.join(os.homedir(), '.claude', 'scripts', 'remote', 'remote-sync.sh')], { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 10 * 60 * 1000 });
    const syncOut = (sync.stdout || '') + (sync.stderr || '');
    if (/REMOTE-DOWN/.test(syncOut)) { say('RED-PROOF: REMOTE-DOWN — the test machine does not answer. Ask the user before running here (--local).'); process.exit(4); }
    const synced = /SYNCED \S+ (\w+) tree (\w+)/.exec(syncOut);
    if (!synced) { say('RED-PROOF: the test machine was not synced — ' + (syncOut.split(/\r?\n/).find(l => /NO-REMOTE|REMOTE-DIRTY|FAILED|fatal|error/i.test(l)) || 'no SYNCED line')); process.exit(2); }
    // The address remote-sync reached when the machine's name did not answer (its VIA line).
    const via = /^VIA (\S+)/m.exec(syncOut);
    const viaOpt = via ? ['-o', 'HostName=' + via[1]] : [];
    say(`RED-PROOF: on ${remoteHost}${via ? ' at ' + via[1] : ''} (${synced[1].slice(0, 12)})`);
    const dir = remoteRepo + '/.git/sanad-proof';
    const local = fs.mkdtempSync(path.join(os.tmpdir(), 'sanad-proof-'));
    fs.writeFileSync(path.join(local, 'plan.json'), JSON.stringify({
      oldLabel: oldRef, green, breaks,
      old: hasOld ? oldFiles.map(f => { try { return { file: f, content64: git('show', `${oldRef}:${f}`).toString('base64') }; } catch { return { file: f, content64: null }; } }) : [],
    }));
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const f of ['red-proof.mjs', 'proof-record.mjs', 'check-ticket-lines.mjs']) fs.copyFileSync(path.join(here, f), path.join(local, f));
    const ssh = (cmd) => spawnSync('ssh', [...viaOpt, remoteHost, cmd], { encoding: 'utf8', windowsHide: true, timeout: 40 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
    ssh(windows ? `if not exist "${dir.replace(/\//g, '\\')}" mkdir "${dir.replace(/\//g, '\\')}"` : `mkdir -p '${dir}'`);
    // scp reads "C:/..." as a host name, so it copies by file name from inside the folder.
    const scp = spawnSync('scp', ['-q', ...viaOpt, 'plan.json', 'red-proof.mjs', 'proof-record.mjs', 'check-ticket-lines.mjs', `${remoteHost}:${dir}/`], { cwd: local, encoding: 'utf8', windowsHide: true, timeout: 120000 });
    if (scp.status !== 0) { say('RED-PROOF: could not copy the proof to the test machine — ' + ((scp.stderr || '').trim().split(/\r?\n/).pop() || 'scp failed')); process.exit(2); }
    const q = (a) => (/[\s"&|<>^()]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a);
    const exe = /^node(?:\.exe)?$/i.test(path.basename(command[0])) ? remoteNode : command[0];
    const rel = path.relative(repo, opt('--cwd') ? path.resolve(opt('--cwd')) : repo).replace(/\\/g, '/');
    const remoteCmd = [q(remoteNode), q(dir + '/red-proof.mjs'), '--repo', q(remoteRepo), '--local', '--plan', q(dir + '/plan.json'),
      ...(opt('--parallel') ? ['--parallel', String(parallel)] : []), '--base', 'HEAD', '--cwd', q(rel ? remoteRepo + '/' + rel : remoteRepo), '--log', q(dir + '/proof.log'),
      '--', q(exe), ...command.slice(1).map(q)].join(' ');
    const r = ssh(remoteCmd);
    const text = ((r.stdout || '') + (r.stderr || '')).split(/\r?\n/).filter(l => l.trim() && !/post-quantum|store now|openssh\.com\/pq/.test(l));
    for (const l of text) say(l);
    if (opt('--log')) {
      const logPath = path.resolve(opt('--log'));
      spawnSync('scp', ['-q', ...viaOpt, `${remoteHost}:${dir}/proof.log`, path.basename(logPath)], { cwd: path.dirname(logPath), windowsHide: true, timeout: 120000 });
    }
    fs.rmSync(local, { recursive: true, force: true });
    // The record is this machine's: the test files proved are the ones here, unchanged since the sync.
    const unchanged = fileHashes && JSON.stringify(testFileHashes(repo, Object.keys(fileHashes))) === JSON.stringify(fileHashes);
    if (r.status === 0 && unchanged && breaks.length) {
      try { writeRecord(repo, { ok: true, base, files: fileHashes, breaks: breaks.length, old: hasOld, green, remote: remoteHost }); }
      catch (e) { say('RED-PROOF: could not write the proof record — ' + e.message); }
    }
    process.exit(r.status ?? 2);
  }

  // One run with some files changed: back up, change, run, always restore.
  function swapRun(changes) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'red-proof-'));
    const manifest = { repo, files: [] };
    changes.forEach((c, i) => {
      const target = path.join(repo, c.file);
      const existed = fs.existsSync(target);
      const entry = { file: c.file, existed, backup: `file-${i}` };
      if (existed) { const buf = fs.readFileSync(target); fs.writeFileSync(path.join(dir, entry.backup), buf); entry.sha = sha(buf); }
      manifest.files.push(entry);
    });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    say(`RED-PROOF: backups in ${dir} (if this run is killed: node ${process.argv[1]} --restore "${dir}")`);
    let result, swapError = null;
    try {
      for (const c of changes) {
        const target = path.join(repo, c.file);
        const next = c.content(target);
        if (next === null) { if (fs.existsSync(target)) fs.rmSync(target); }
        else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, next); }
      }
      result = runCommand();
    } catch (e) {
      swapError = e;
    } finally {
      try { restore(dir); }
      catch (e) { say('RED-PROOF: RESTORE FAILED — ' + e.message); process.exit(2); }
    }
    if (swapError) { say('RED-PROOF: could not swap the files — ' + swapError.message + '; files restored.'); process.exit(2); }
    return result;
  }
  function runCommand() {
    return spawnSync(command[0], command.slice(1), {
      cwd: opt('--cwd') ? path.resolve(opt('--cwd')) : repo, encoding: 'utf8', shell: false,
      windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000,
    });
  }
  const logs = [];
  function read(result, label) {
    const output = (result.stdout || '') + (result.stderr || '');
    logs.push(`===== ${label} =====\n${output}`);
    if (result.error) { say(`RED-PROOF: the test command could not run — ${result.error.message}`); finish(2); }
    return { output, code: result.status, why: result.status !== 0 ? failureReasons(output) : [] };
  }
  function finish(code) {
    // The log opens with this run's own lines (review-brief.mjs --proof-log reads them), then each run's output.
    if (opt('--log')) fs.writeFileSync(path.resolve(opt('--log')), said.join('\n') + '\n\n' + logs.join('\n'));
    process.exit(code);
  }
  function setupStop(r) {
    const setup = r.why.filter((w) => w.kind === 'setup');
    if (setup.length || (!r.why.length && r.code !== 0 && SETUP_OUTPUT.test(r.output))) {
      showWhy(r);
      say(`RED-PROOF: SETUP ✗ — ${setup.length || 'the run'} failed for a setup reason (element not found, type or build error, timeout), not because of the code. Fix the test or the machine, then run again; files restored.`);
      finish(3);
    }
  }
  function showWhy(r) { for (const w of r.why.slice(0, 12)) say(`  ${w.kind === 'assert' ? '✓ assert' : w.kind === 'setup' ? '✗ setup ' : '? other '}  ${w.name}${w.why ? ' — ' + w.why : ''}`); }

  // The runs: the old code, each break, then green on the fixed tree.
  const jobs = [];
  if (hasOld) jobs.push({ kind: 'old', label: 'old code', changes: oldPlan
    ? oldPlan.map(o => ({ file: o.file, content: () => (o.content64 == null ? null : Buffer.from(o.content64, 'base64')) }))
    : oldFiles.map(file => ({ file, content: () => { try { return git('show', `${oldRef}:${file}`); } catch { return null; } } })) });
  for (const b of breaks) jobs.push({ kind: 'break', b, label: 'break ' + b.name, changes: [{ file: b.file, content: (target) => fs.readFileSync(target, 'utf8').replace(b.find, () => b.put) }] });
  if (green) jobs.push({ kind: 'green', label: 'green', changes: [] });
  const results = parallel > 1 && !breaks.some(b => b.single) ? await runParallel(jobs) : jobs.map(j => (j.kind === 'green' ? runCommand() : swapRun(j.changes)));

  // Each run in its own temporary copy, `parallel` at a time; the working folder is never touched.
  async function runParallel(list) {
    const lines = (args) => { try { return execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/).filter(Boolean); } catch { return []; } };
    const dirty = [...new Set([...lines(['diff', '--name-only', 'HEAD']), ...lines(['ls-files', '--others', '--exclude-standard'])])];
    const modules = ['node_modules', ...fs.readdirSync(repo).map(d => d + '/node_modules')]
      .filter(m => { try { return fs.lstatSync(path.join(repo, m)).isDirectory(); } catch { return false; } });
    const cwdRel = path.relative(repo, opt('--cwd') ? path.resolve(opt('--cwd')) : repo);
    const out = new Array(list.length);
    let next = 0;
    say(`RED-PROOF: ${list.length} run(s), ${Math.min(parallel, list.length)} at a time, each in its own copy`);
    async function worker() {
      while (next < list.length) {
        const i = next++;
        const copy = path.join(os.tmpdir(), 'red-proof-copy-' + crypto.randomBytes(6).toString('hex'));
        const links = [];
        try {
          execFileSync('git', ['worktree', 'add', '--detach', copy, 'HEAD'], { cwd: repo, stdio: 'ignore', windowsHide: true });
          for (const f of dirty) {
            const from = path.join(repo, f), to = path.join(copy, f);
            if (fs.existsSync(from)) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); }
            else if (fs.existsSync(to)) fs.rmSync(to);
          }
          for (const m of modules) { const to = path.join(copy, m); if (!fs.existsSync(to)) { fs.symlinkSync(path.join(repo, m), to, 'junction'); links.push(to); } }
          for (const c of list[i].changes) {
            const target = path.join(copy, c.file);
            const text = c.content(target);
            if (text === null) { if (fs.existsSync(target)) fs.rmSync(target); }
            else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text); }
          }
          out[i] = await runAsync(path.join(copy, cwdRel));
        } catch (e) {
          out[i] = { status: null, stdout: '', stderr: '', error: e };
        } finally {
          for (const l of links) { try { fs.unlinkSync(l); } catch { /* a link that is gone needs nothing */ } }
          try { execFileSync('git', ['worktree', 'remove', '--force', copy], { cwd: repo, stdio: 'ignore', windowsHide: true }); }
          catch { try { execFileSync('git', ['worktree', 'prune'], { cwd: repo, stdio: 'ignore', windowsHide: true }); } catch { /* prune later */ } }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(parallel, list.length) }, worker));
    return out;
  }
  function runAsync(cwd) {
    return new Promise((resolve) => {
      let stdout = '', stderr = '';
      const child = spawn(command[0], command.slice(1), { cwd, shell: false, windowsHide: true });
      const timer = setTimeout(() => child.kill(), 30 * 60 * 1000);
      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
      child.on('error', (error) => { clearTimeout(timer); resolve({ status: null, stdout, stderr, error }); });
      child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    });
  }

  let ok = true;
  // 1. The old code.
  if (hasOld) {
    const r = read(results[0], 'old code');
    if (r.code !== 0) {
      setupStop(r); showWhy(r);
      const asserts = r.why.filter((w) => w.kind === 'assert').length;
      say(`RED-PROOF: RED ✓ — the tests fail on ${oldLabel} for ${oldNames.join(', ')} (exit ${r.code}${r.why.length ? `; ${asserts} of ${r.why.length} failing test(s) by an assertion` : '; failure reasons not read from this runner'}); files restored.`);
    } else {
      say(`RED-PROOF: NOT RED ✗ — the tests pass on ${oldLabel}, so they do not prove the fix; files restored.`); ok = false;
    }
  }
  // 2. Each break of the rule under test.
  for (let i = 0; i < breaks.length; i++) {
    const b = breaks[i];
    const r = read(results[(hasOld ? 1 : 0) + i], 'break ' + b.name);
    if (b.single) {
      if (r.code !== 0) { setupStop(r); showWhy(r); say(`RED-PROOF: RED ✓ — the test fails with ${b.file} broken (exit ${r.code}); files restored.`); }
      else { say(`RED-PROOF: NOT RED ✗ — the test passes with ${b.file} broken, so it does not check that code; files restored.`); ok = false; }
      continue;
    }
    const left = survivors(b.mustFail, r.why);
    if (r.code !== 0 && !left.length) say(`  BREAK ✓ ${b.name}: all ${b.mustFail.length} named test(s) fail`);
    else { say(`  BREAK ✗ ${b.name}: still pass (or not seen failing): ${left.join(' | ')}`); ok = false; }
  }
  // 3. Green on the fixed tree.
  if (green) {
    const r = read(results[results.length - 1], 'green');
    if (r.code === 0) say('  GREEN ✓ the tests pass on the fixed tree');
    else { setupStop(r); showWhy(r); say('  GREEN ✗ the tests fail on the fixed tree'); ok = false; }
  }
  if (breaks.length && !breaks[0].single) say(ok ? `RED-PROOF: PROVED ✓ — ${hasOld ? 'red on the old code, ' : ''}${breaks.length} break(s) caught${green ? ', green on the fix' : ''}; files restored.` : 'RED-PROOF: NOT PROVED ✗ — see the lines above; files restored.');
  // The record pre-review reads: only a run that proved at least one break of the rule under test.
  if (ok && fileHashes) {
    try { writeRecord(repo, { ok: true, base, files: fileHashes, breaks: breaks.length, old: hasOld, green }); }
    catch (e) { say('RED-PROOF: could not write the proof record — ' + e.message); }
  }
  finish(ok ? 0 : 1);
}
