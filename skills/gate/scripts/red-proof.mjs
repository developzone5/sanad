#!/usr/bin/env node
// red-proof.mjs — prove new tests can fail, without leaving a failed check behind. Each run swaps
// files, runs the test command once, and always puts the files back byte for byte.
//
//   old code   (--old <ref> --files <fix files>): the tests fail on the code before the fix.
//   breaks     (--breaks <json>): for each break of the rule under test (one exact text replaced in
//              one product file), the named tests must fail. 2026-11-07: three rounds in a row a
//              "nothing happens" check passed review that no run had ever seen fail; the old code
//              proves only the first failing line of each test. A break proves the rest.
//   green      (--then-green): the same command on the fixed tree passes, before any reviewer reads. It runs
//              FIRST and alone; when it fails, no red run starts (2026-11-11).
//   one break  (--break <file> --find <text> --put <text>): a test of code that already works.
//
// Why a script: a red run typed as a plain test command is kept as a failed check by the push
// guard forever, and a hand-written "swap; test; restore" compound can never be re-run green.
// Exit 0 = every requested proof held (each failing test named, with its reason), 1 = NOT RED,
// a break the tests did not catch, or a red green run; 2 = usage or restore problem; 3 = SETUP (a
// test failed for a setup reason: element not found, type or build error, timeout; or the fixed tree
// does not compile); 4 = REMOTE-DOWN (the test machine does not answer); 5 = TIMEOUT (a run passed
// --timeout-min: it and every process it started were stopped, files restored, the run named).
//
// Usage:
//   node ~/.claude/skills/gate/scripts/red-proof.mjs --repo <path> [--old <git-ref> --files <a,b>]
//        [--breaks <json>] [--then-green] [--base <ref>] [--cwd <dir>] [--log <file>] [--parallel <n>]
//        [--timeout-min <n>] [--test-env <path>] [--local] [--show-remote] -- <executable> [args...]
//   node ~/.claude/skills/gate/scripts/red-proof.mjs --repo <path> --break <file> --find <text> --put <text>
//        [--cwd <dir>] [--log <file>] [--timeout-min <n>] [--test-env <path>] -- <executable> [args...]
//   node ~/.claude/skills/gate/scripts/red-proof.mjs --repo <path> --warm [--parallel <n>] [--cwd <dir>] -- <test command>
//   node ~/.claude/skills/gate/scripts/red-proof.mjs --restore <backup-dir>
//   node ~/.claude/skills/gate/scripts/red-proof.mjs --repo <path> --drop-copies
// --breaks file: [{ "name": "...", "file": "<repo-relative>", "find": "<exact text, once>",
//   "put": "<replacement>", "mustFail": ["<part of a test name>", ...] }, ...]
//   A mustFail part may come from a test's method name or from its xUnit DisplayName.
// --old with a fix file that only adds lines, and adds names the tests use (a new message, a new
// constant): that file stays at the fix for the old-code run, so the old code compiles; the run says so.
// --warm: at the task's start, the kept copies (below) are brought to the tree and built once.
// A passing run records the test files it proved (see proof-record.mjs); pre-review's test check
// reads that record. The test command runs without a shell and without typed input; pass the real
// executable (node <entrypoint>, dotnet, ...), not a .cmd shim. cmd.exe without /c is refused
// (2026-11-09: Git Bash turns /c into C:/, and cmd.exe then waited for typed input for 25 minutes):
// write //c in Git Bash, or better, put test settings in --test-env instead of a .cmd wrapper.
//
// --parallel <n> (2026-11-07: eleven runs one after another took 2 minutes): each run gets its own
// copy of the repository (the uncommitted files copied in and every node_modules folder linked), n at
// a time; the working folder is never touched. Kept copies (2026-11-09: 7 copies each built the whole
// .NET solution from scratch, 5 to 13 minutes): the copies live on in <temp>/red-proof-copies/<repo
// id>/<n> with their build output, one run at a time each, and before each run are reset to the tree
// under test, writing only the files that differ. MSBuild then rebuilds only the projects whose files
// changed. Build output copied in from another folder would not help: a build at a new path
// recompiles every project (MSBuild hashes the full reference paths). A copy's first proof is cold;
// a run stopped at the time limit drops its copy. --drop-copies deletes the kept copies (on the test
// machine, run it there).
//
// Compile check (2026-11-09: a missing `using` failed all 6 copies after full builds): a `dotnet test`
// command first runs once with --list-tests on the fixed tree (in the first copy, which stays warm);
// a build error stops there with the compiler lines (SETUP, exit 3), before any run starts.
//
// --timeout-min <n> (default 15, decimals allowed): the limit for each run and for the compile check.
// --test-env <path> (2026-11-09: opt-in MySQL tests need a connection string with a password):
// KEY=VALUE lines (# comments, blank lines and a leading `export ` allowed; one pair of quotes around a
// value is removed) added to every run's environment. Only the names are printed; a value of 6 or more
// characters (and a Password= or Pwd= part) that a test prints shows as *** in the output and the log.
// Not named --env-file: Node itself checks a `--env-file <path>` anywhere before `--`, even after the
// script name, and stops with exit 9 when that path is not on this machine.
//
// The test machine (git config sanad.remoteHost, sanad.remoteRepo, sanad.remoteNode): the proof runs
// there, its lines shown as they come. --test-env is then a path on that machine (use forward
// slashes), read there; `git config sanad.remoteTestEnv <path>` sets it once per repository.
// --show-remote prints the command the test machine would run, and stops. --plan <json> is how this
// mode hands a run to the test machine: { old: [{ file, content64|null }], oldLabel, breaks, green }.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalTop, changedTestFiles, defaultBase, testFileHashes, writeRecord } from './proof-record.mjs';

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
// xUnit prints a test's DisplayName, not its method, in its Failed line (2026-11-10: four breaks read "not
// seen failing" although their tests had failed: mustFail named the methods). `pairs` ({display, method},
// from displayNames) let a mustFail part match either name.
export function survivors(mustFail, reasons, pairs = []) {
  const failed = [];
  for (const r of reasons) {
    const name = r.name.toLowerCase();
    failed.push(name);
    for (const p of pairs) {
      const display = p.display.toLowerCase(), method = p.method.toLowerCase();
      // A theory's display name is followed by its arguments; a method is printed with its class before it.
      if (name === display || name.startsWith(display + '(') || name.startsWith(display + ' (')) failed.push(method);
      else if (new RegExp(`(?:^|\\.)${method}(?:\\(|$)`).test(name)) failed.push(display);
    }
  }
  return mustFail.filter(part => !failed.some(name => name.includes(String(part).toLowerCase())));
}

// The DisplayName of each test method in a C# test file, with the method it names.
export function displayNames(text) {
  const src = String(text);
  const names = [...src.matchAll(/DisplayName\s*=\s*"((?:[^"\\]|\\.)*)"/g)];
  const methods = [...src.matchAll(/\b(?:public|internal|private|protected)\s+(?:static\s+)?(?:async\s+)?(?:void|Task|ValueTask)(?:<[^>]*>)?\s+(\w+)\s*\(/g)];
  const pairs = [];
  names.forEach((n, i) => {
    const m = methods.find(x => x.index > n.index);
    if (m && (i + 1 >= names.length || m.index < names[i + 1].index)) pairs.push({ display: n[1].replace(/\\(.)/g, '$1'), method: m[1] });
  });
  return pairs;
}

// The names a fix file adds that the tests use, when the file only adds lines (2026-11-10: a file in --files
// only added the new error message; the old code could not compile against the new tests, SETUP, and the
// whole proof ran again). Such a file stays at the fixed version for the old-code run: its new names exist,
// and every line the old code had is the same. A name counts when it is declared in an added line (`Name =`,
// `Name(`, `Name {`, or `Name:` in a script file), not in the old file, and a whole word in the test files.
export function addedNames(diff, oldText, testText, file = '') {
  const lines = String(diff).split(/\r?\n/);
  if (lines.some(l => l.startsWith('-') && !l.startsWith('---'))) return []; // it changes or removes lines: it may hold the fix
  const added = lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1));
  const colon = /\.(?:[cm]?[jt]sx?)$/i.test(file) ? '|:' : '';
  const word = (n) => new RegExp(`(?<![\\w$])${n}(?![\\w$])`);
  const names = new Set();
  for (const line of added) {
    for (const m of line.matchAll(/\b[A-Za-z_]\w*[A-Z_]\w*\b/g)) {
      const n = m[0];
      if (n.length < 6 || names.has(n)) continue;
      const declared = new RegExp(`(?:^|[^.\\w$])${n}\\s*(?:=(?![=>])|=>|\\{|\\(${colon})`).test(line);
      if (declared && !word(n).test(oldText) && word(n).test(testText)) names.add(n);
    }
  }
  return [...names];
}

// The KEY=VALUE lines of an env file. `bad` holds the numbers of the lines that are not, never their
// text: a line may hold a password.
export function parseEnvFile(text) {
  const vars = {}, bad = [];
  String(text).replace(/^﻿/, '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) { bad.push(i + 1); return; }
    let value = m[2].trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) value = value.slice(1, -1);
    vars[m[1]] = value;
  });
  return { vars, bad };
}

// Hides each env value of 6 or more characters, and each Password=/Pwd= part of a connection string,
// wherever a test prints it. Only what is shown or logged is hidden; failing tests are read unhidden.
export function hider(values) {
  const secrets = new Set();
  for (const value of values) {
    if (value.length >= 6) secrets.add(value);
    for (const part of value.split(';')) {
      const m = /^\s*(?:password|pwd)\s*=\s*(.+?)\s*$/i.exec(part);
      if (m && m[1].length >= 3) secrets.add(m[1]);
    }
  }
  const list = [...secrets].sort((a, b) => b.length - a.length);
  return (text) => list.reduce((t, s) => t.split(s).join('***'), String(text));
}

// A `dotnet test` command's compile check: the same command listing its tests instead of running
// them, so it builds the tree once. Other runners have none (null).
export function compileCheckCommand(command) {
  const exe = String(command[0] || '').split(/[\\/]/).pop();
  if (!/^dotnet(?:\.exe)?$/i.test(exe) || command[1] !== 'test' || command.includes('--list-tests') || command.includes('-t')) return null;
  const dash = command.indexOf('--', 2);
  return dash < 0 ? [...command, '--list-tests'] : [...command.slice(0, dash), '--list-tests', ...command.slice(dash)];
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
  let hide = (text) => text; // set by --test-env: every line shown or logged passes through it
  const say = (line) => { line = hide(line); said.push(line); process.stdout.write(line + '\n'); };
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
    say('   options: [--parallel <n>] [--timeout-min <n>] [--test-env <path>] [--local] [--show-remote]; or --repo <path> --drop-copies');
    say('   or: red-proof.mjs --repo <path> --warm [--parallel <n>] [--cwd <dir>] -- <executable> [args...]');
    process.exit(2);
  };

  // The kept copies of this repository (see the header): one folder per slot, each with a lock file
  // naming the process that uses it.
  const slotsRoot = repo && path.join(os.tmpdir(), 'red-proof-copies', crypto.createHash('sha1').update(canonicalTop(repo)).digest('hex').slice(0, 12));
  const alive = (pid) => { if (pid === process.pid) return true; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  const lockOwner = (lock) => {
    let pid = 0;
    try { pid = Number.parseInt(fs.readFileSync(lock, 'utf8'), 10) || 0; } catch { return null; }
    // A lock with no number yet is being written, unless it is older than 10 seconds.
    if (!pid) { try { return Date.now() - fs.statSync(lock).mtimeMs > 10000 ? null : -1; } catch { return null; } }
    return alive(pid) ? pid : null;
  };
  function dropCopy(dir) {
    if (!fs.existsSync(dir)) return false;
    // Links into the working folder's node_modules go first, so removing a copy never reaches through them.
    let names = []; try { names = fs.readdirSync(dir); } catch { /* removed below */ }
    for (const m of ['node_modules', ...names.map(d => d + '/node_modules')]) {
      const p = path.join(dir, m);
      try { if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p); } catch { /* not a link */ }
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    return true;
  }
  if (opts.includes('--drop-copies')) {
    if (!repo) usage();
    let removed = 0;
    for (const name of (fs.existsSync(slotsRoot) ? fs.readdirSync(slotsRoot) : []).filter(n => /^\d+$/.test(n))) {
      const lock = path.join(slotsRoot, name + '.lock');
      if (lockOwner(lock)) { say(`RED-PROOF: copy ${name} is in use by a running proof; kept.`); continue; }
      if (dropCopy(path.join(slotsRoot, name))) removed++;
      fs.rmSync(lock, { force: true });
    }
    try { fs.rmdirSync(slotsRoot); } catch { /* not empty, or not there */ }
    say(`RED-PROOF: removed ${removed} kept copy folder(s) of ${repo}`);
    process.exit(0);
  }
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
  const warm = opts.includes('--warm') || Boolean(plan?.warm);
  // Each run tests a few files, so half the machine's cores run at once (8 on a 16-core machine).
  const parallel = Math.max(1, Number.parseInt(opt('--parallel') || '', 10) || Math.max(2, Math.floor(os.cpus().length / 2)));
  const oldPlan = Array.isArray(plan?.old) && plan.old.length ? plan.old : null;
  const oldLabel = oldPlan ? String(plan.oldLabel || 'the old code') : oldRef;
  const oldNames = oldPlan ? oldPlan.map(o => o.file) : oldFiles;
  const hasOld = Boolean(oldPlan || oldRef);
  if (!repo || !command.length || (oldRef ? !oldFiles.length : false) || (!hasOld && !breaks.length && !warm)) usage();
  if (warm && (hasOld || breaks.length)) { say('RED-PROOF: --warm only prepares the kept copies; run it alone, before the proof.'); process.exit(2); }
  // The time each run (and the compile check) may take (2026-11-09: a run hung 25 minutes, unseen).
  const timeoutMin = opt('--timeout-min') === undefined ? 15 : Number(opt('--timeout-min'));
  if (!(timeoutMin > 0)) { say('RED-PROOF: --timeout-min needs a number of minutes above 0.'); process.exit(2); }
  const limitMs = Math.round(timeoutMin * 60000);
  // cmd.exe without /c opens a prompt that runs nothing (2026-11-09: Git Bash turned /c into C:/).
  if (/^cmd(?:\.exe)?$/i.test(String(command[0]).split(/[\\/]/).pop()) && !command.slice(1).some(a => /^\/c$/i.test(a))) {
    say('RED-PROOF: cmd.exe without /c runs nothing and waits for typed input. Git Bash turns /c into C:/; write //c there. Better: pass test settings with --test-env, not a .cmd wrapper. Nothing ran.');
    process.exit(2);
  }
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
  // Fix files that only add names the tests use stay at the fixed version for the old-code run (addedNames).
  const keptAtFix = [];
  if (oldRef && !plan && testFiles?.length) {
    const testText = testFiles.map(f => { try { return fs.readFileSync(path.join(repo, f), 'utf8'); } catch { return ''; } }).join('\n');
    for (const f of oldFiles) {
      let oldText = '', diff = '';
      try { oldText = git('show', `${oldRef}:${f}`).toString('utf8'); } catch { /* a new file: every line is added */ }
      try {
        diff = oldText ? git('diff', '--no-color', '-U0', oldRef, '--', f).toString('utf8')
          : fs.readFileSync(path.join(repo, f), 'utf8').split(/\r?\n/).map(l => '+' + l).join('\n');
      } catch { continue; }
      const names = addedNames(diff, oldText, testText, f);
      if (names.length) keptAtFix.push({ file: f, names });
    }
    if (keptAtFix.length >= oldFiles.length) keptAtFix.length = 0; // no file would go back: nothing to prove
  }
  const oldRun = oldFiles.filter(f => !keptAtFix.some(k => k.file === f));
  for (const k of keptAtFix) say(`RED-PROOF: ${k.file} stays at the fix for the old-code run: it only adds lines, and the tests use its new names (${k.names.slice(0, 4).join(', ')}).`);

  // On the test machine when there is one, by itself (2026-11-07: the rule "tests run on the test
  // machine" was written, but this script only ran here, so the proof ran on the busy desktop).
  // `--local` runs here instead (only when the user says so, or there is no test machine).
  const gitText = (args) => { try { return execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
  const remoteHost = gitText(['config', '--get', 'sanad.remoteHost']);
  if (remoteHost && !opts.includes('--local') && !plan && !breaks.some(b => b.single)) return runRemote();
  if (opts.includes('--show-remote')) { say('RED-PROOF: this proof runs here (no git config sanad.remoteHost, --local, or one --break); there is no remote command to show.'); process.exit(2); }

  // The env file's variables for every run, read where the tests run. Only the names are shown.
  let runEnv = process.env;
  if (opt('--test-env')) {
    const file = path.resolve(opt('--test-env'));
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { say(`RED-PROOF: cannot read --test-env ${file} (${e.code || 'error'}); nothing ran.`); process.exit(2); }
    const { vars, bad } = parseEnvFile(text);
    if (bad.length) { say(`RED-PROOF: --test-env ${file}: line(s) ${bad.join(', ')} are not KEY=VALUE (lines not shown); nothing ran.`); process.exit(2); }
    runEnv = { ...process.env };
    for (const [key, value] of Object.entries(vars)) {
      // Windows names are one variable in any case: drop the old spelling so the file's value wins.
      if (process.platform === 'win32') for (const old of Object.keys(runEnv)) if (old !== key && old.toUpperCase() === key.toUpperCase()) delete runEnv[old];
      runEnv[key] = value;
    }
    hide = hider(Object.values(vars));
    say(`RED-PROOF: environment from ${file}: ${Object.keys(vars).join(', ') || 'no variables'} (values hidden)`);
  }

  async function runRemote() {
    const remoteRepo = gitText(['config', '--get', 'sanad.remoteRepo']).replace(/\\/g, '/').replace(/\/$/, '');
    if (!remoteRepo) { say('RED-PROOF: git config sanad.remoteHost is set but sanad.remoteRepo is not; set it, or run with --local.'); process.exit(2); }
    const remoteNode = gitText(['config', '--get', 'sanad.remoteNode']) || 'node';
    const windows = /^[A-Za-z]:\//.test(remoteRepo);
    const dir = remoteRepo + '/.git/sanad-proof';
    // Each proof has its own plan and log there (2026-11-11: two proofs started together, the server's and
    // the page's, shared one plan.json and one proof.log). Both are removed when the proof ends.
    const runId = `${process.pid}-${Date.now().toString(36)}`;
    const planName = `plan-${runId}.json`, logName = `proof-${runId}.log`;
    const q = (a) => (/[\s"&|<>^()]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a);
    const exe = /^node(?:\.exe)?$/i.test(path.basename(command[0])) ? remoteNode : command[0];
    const rel = path.relative(repo, opt('--cwd') ? path.resolve(opt('--cwd')) : repo).replace(/\\/g, '/');
    // The env file is read on the test machine: only its path crosses over, never a value. The repository's default
    // (sanad.remoteTestEnv, a database connection) goes only to `dotnet` runs; --test-env always applies.
    const dotnetRun = /^dotnet(?:\.exe)?$/i.test(path.basename(command[0]));
    const envFile = (opt('--test-env') || (dotnetRun ? gitText(['config', '--get', 'sanad.remoteTestEnv']) : '')).replace(/\\/g, '/');
    const remoteCmd = [q(remoteNode), q(dir + '/red-proof.mjs'), '--repo', q(remoteRepo), '--local', '--plan', q(dir + '/' + planName),
      ...(opt('--parallel') ? ['--parallel', String(parallel)] : []), '--timeout-min', String(timeoutMin), ...(envFile ? ['--test-env', q(envFile)] : []),
      '--base', 'HEAD', '--cwd', q(rel ? remoteRepo + '/' + rel : remoteRepo), '--log', q(dir + '/' + logName),
      '--', q(exe), ...command.slice(1).map(q)].join(' ');
    if (opts.includes('--show-remote')) { say(`RED-PROOF: on ${remoteHost} this runs: ${remoteCmd}`); process.exit(0); }
    const sync = spawnSync('bash', [path.join(os.homedir(), '.claude', 'scripts', 'remote', 'remote-sync.sh')], { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 10 * 60 * 1000 });
    const syncOut = (sync.stdout || '') + (sync.stderr || '');
    if (/REMOTE-DOWN/.test(syncOut)) { say('RED-PROOF: REMOTE-DOWN — the test machine does not answer. Ask the user before running here (--local).'); process.exit(4); }
    const synced = /SYNCED \S+ (\w+) tree (\w+)/.exec(syncOut);
    if (!synced) { say('RED-PROOF: the test machine was not synced — ' + (syncOut.split(/\r?\n/).find(l => /NO-REMOTE|REMOTE-DIRTY|FAILED|fatal|error/i.test(l)) || 'no SYNCED line')); process.exit(2); }
    // The address remote-sync reached when the machine's name did not answer (its VIA line).
    const via = /^VIA (\S+)/m.exec(syncOut);
    const viaOpt = via ? ['-o', 'HostName=' + via[1]] : [];
    say(`RED-PROOF: on ${remoteHost}${via ? ' at ' + via[1] : ''} (${synced[1].slice(0, 12)})`);
    const local = fs.mkdtempSync(path.join(os.tmpdir(), 'sanad-proof-'));
    fs.writeFileSync(path.join(local, planName), JSON.stringify({
      oldLabel: oldRef, green, breaks,
      warm, kept: keptAtFix.map(k => k.file),
      old: hasOld ? oldRun.map(f => { try { return { file: f, content64: git('show', `${oldRef}:${f}`).toString('base64') }; } catch { return { file: f, content64: null }; } }) : [],
    }));
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const f of ['red-proof.mjs', 'proof-record.mjs', 'check-ticket-lines.mjs']) fs.copyFileSync(path.join(here, f), path.join(local, f));
    // BatchMode: a password prompt nobody can answer fails at once instead of waiting.
    const sshOpts = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', ...viaOpt];
    spawnSync('ssh', [...sshOpts, remoteHost, windows ? `if not exist "${dir.replace(/\//g, '\\')}" mkdir "${dir.replace(/\//g, '\\')}"` : `mkdir -p '${dir}'`], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
    // scp reads "C:/..." as a host name, so it copies by file name from inside the folder.
    const scp = spawnSync('scp', ['-q', ...sshOpts, planName, 'red-proof.mjs', 'proof-record.mjs', 'check-ticket-lines.mjs', `${remoteHost}:${dir}/`], { cwd: local, encoding: 'utf8', windowsHide: true, timeout: 120000 });
    if (scp.status !== 0) { say('RED-PROOF: could not copy the proof to the test machine — ' + ((scp.stderr || '').trim().split(/\r?\n/).pop() || 'scp failed')); process.exit(2); }
    // Each line as it comes, so a long proof is never silent. The runs there stop at their own limit;
    // this wait is the backstop for a lost connection.
    const runs = (hasOld ? 1 : 0) + breaks.length + (green ? 1 : 0) + (warm ? 1 : 0);
    const waitMin = Math.ceil(timeoutMin * (runs + 2) + 10);
    const r = await new Promise((resolve) => {
      const child = spawn('ssh', ['-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=6', ...sshOpts, remoteHost, remoteCmd], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const show = (l) => { if (l.trim() && !/post-quantum|store now|openssh\.com\/pq/.test(l)) say(l); };
      const rest = { stdout: '', stderr: '' };
      for (const key of ['stdout', 'stderr']) {
        child[key].setEncoding('utf8');
        child[key].on('data', (d) => { const parts = (rest[key] + d).split(/\r?\n/); rest[key] = parts.pop(); parts.forEach(show); });
      }
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, waitMin * 60000);
      child.on('error', (error) => { clearTimeout(timer); resolve({ status: null, error }); });
      child.on('close', (status) => { clearTimeout(timer); show(rest.stdout); show(rest.stderr); resolve({ status, timedOut }); });
    });
    if (r.error) say('RED-PROOF: could not start ssh — ' + r.error.message);
    if (r.timedOut) say(`RED-PROOF: TIMEOUT ✗ — ${remoteHost} sent no result within ${waitMin} min; each run there stops at its own ${timeoutMin} min limit.`);
    if (opt('--log')) {
      const logPath = path.resolve(opt('--log'));
      spawnSync('scp', ['-q', ...sshOpts, `${remoteHost}:${dir}/${logName}`, path.basename(logPath)], { cwd: path.dirname(logPath), windowsHide: true, timeout: 120000 });
    }
    const there = windows ? dir.split('/').join('\\') + '\\' : dir + '/';
    const mine = [planName, logName].map(n => `"${there}${n}"`).join(' ');
    spawnSync('ssh', [...sshOpts, remoteHost, windows ? `del /q ${mine} 2>nul` : `rm -f ${mine}`], { stdio: 'ignore', windowsHide: true, timeout: 60000 });
    fs.rmSync(local, { recursive: true, force: true });
    // The record is this machine's: the test files proved are the ones here, unchanged since the sync.
    const unchanged = fileHashes && JSON.stringify(testFileHashes(repo, Object.keys(fileHashes))) === JSON.stringify(fileHashes);
    if (r.status === 0 && unchanged && breaks.length) {
      try { writeRecord(repo, { ok: true, base, files: fileHashes, breaks: breaks.length, old: hasOld, green, remote: remoteHost }); }
      catch (e) { say('RED-PROOF: could not write the proof record — ' + e.message); }
    }
    process.exit(r.timedOut ? 5 : r.status ?? 2);
  }

  // One run with some files changed: back up, change, run, always restore.
  async function swapRun(changes) {
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
      result = await runProcess(command, cwdHere);
    } catch (e) {
      swapError = e;
    } finally {
      try { restore(dir); }
      catch (e) { say('RED-PROOF: RESTORE FAILED — ' + e.message); process.exit(2); }
    }
    if (swapError) { say('RED-PROOF: could not swap the files — ' + swapError.message + '; files restored.'); process.exit(2); }
    return result;
  }
  const cwdHere = opt('--cwd') ? path.resolve(opt('--cwd')) : repo;
  // One process: no typed input (2026-11-09: an open input pipe let cmd.exe wait for ever), the env
  // file's variables, and the time limit, past which it and every process it started are stopped.
  function runProcess(argv, cwd) {
    return new Promise((resolve) => {
      let stdout = '', stderr = '', settled = false, timedOut = false, grace = null, timer = null;
      const end = (r) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(grace); resolve({ stdout, stderr, timedOut, ...r }); };
      let child;
      try {
        child = spawn(argv[0], argv.slice(1), { cwd, env: runEnv, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      } catch (error) { end({ status: null, error }); return; }
      timer = setTimeout(() => { timedOut = true; stopTree(child.pid); }, limitMs);
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (error) => end({ status: null, error }));
      // A process the run started can hold the output open after the run ends: wait 2 s for it, no more.
      child.on('exit', (status) => { grace = setTimeout(() => end({ status }), 2000); });
      child.on('close', (status) => end({ status }));
    });
  }
  function stopTree(pid) {
    if (!pid) return;
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } } }
  }
  const logs = [];
  function read(result, label) {
    const output = (result.stdout || '') + (result.stderr || '');
    logs.push(`===== ${label} =====\n${hide(output)}`);
    if (result.error) { say(`RED-PROOF: the test command could not run — ${result.error.message}`); finish(2); }
    return { output, code: result.status, why: result.status !== 0 ? failureReasons(output) : [] };
  }
  function finish(code) {
    // The log opens with this run's own lines (review-brief.mjs --proof-log reads them), then each run's output.
    if (opt('--log')) fs.writeFileSync(path.resolve(opt('--log')), said.join('\n') + '\n\n' + logs.join('\n'));
    process.exit(code);
  }
  function setupStop(r, oldCode = false) {
    const setup = r.why.filter((w) => w.kind === 'setup');
    if (setup.length || (!r.why.length && r.code !== 0 && SETUP_OUTPUT.test(r.output))) {
      showWhy(r);
      // The old code without names the new tests use: say which, and the way out.
      const missing = oldCode ? [...new Set([...r.output.matchAll(/error CS\d+:.*?(?:definition for|The name|namespace name) '(\w+)'/g)].map(m => m[1]))] : [];
      if (missing.length) say(`RED-PROOF: the old code lacks names the tests use: ${missing.slice(0, 6).join(', ')}. The fix file that declares them also changes lines, so it cannot stay at the fix: prove that file with --breaks alone, or move the new names into a file that only adds lines.`);
      say(`RED-PROOF: SETUP ✗ — ${setup.length || 'the run'} failed for a setup reason (element not found, type or build error, timeout), not because of the code. Fix the test or the machine, then run again; files restored.`);
      finish(3);
    }
  }
  function showWhy(r) { for (const w of r.why.slice(0, 12)) say(`  ${w.kind === 'assert' ? '✓ assert' : w.kind === 'setup' ? '✗ setup ' : '? other '}  ${w.name}${w.why ? ' — ' + w.why : ''}`); }

  // The DisplayName ↔ method pairs of the C# files that hold a mustFail part (see survivors).
  function namePairs() {
    const parts = [...new Set(breaks.filter(b => !b.single).flatMap(b => b.mustFail.map(String)))];
    if (!parts.length) return [];
    let files = [];
    try {
      files = execFileSync('git', ['grep', '-l', '--untracked', '-F', ...parts.flatMap(p => ['-e', p]), '--', '*.cs'],
        { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/).filter(Boolean);
    } catch { return []; } // no file holds one
    return files.flatMap(f => { try { return displayNames(fs.readFileSync(path.join(repo, f), 'utf8')); } catch { return []; } });
  }

  // --warm (2026-11-10: a task's first proof found its copies cold; each run built the whole solution, 5 to
  // 13 minutes): at the task's start, bring the kept copies to the tree and build each once, so the proof
  // later rebuilds only the projects whose files changed. Run it alone, in the background, beside the
  // test machine's ready check, with the same --parallel as the proof.
  if (warm) {
    const started = Date.now();
    const tree = treeUnderTest();
    const cwdRel = path.relative(repo, cwdHere);
    const check = compileCheckCommand(command);
    const slots = Array.from({ length: parallel }, takeSlot);
    say(`RED-PROOF: warming ${slots.length} kept cop${slots.length === 1 ? 'y' : 'ies'}${check ? ', each built once' : ''}`);
    const lines = await Promise.all(slots.map(async (copy, k) => {
      const t0 = Date.now();
      const secs = () => `${Math.round((Date.now() - t0) / 1000)} s`;
      try { syncCopy(copy, tree.head, tree.dirty, tree.commonDir); }
      catch (e) { return `  copy ${k}: could not prepare — ${e.message}`; }
      if (!check) return `  copy ${k}: ready (${secs()})`;
      const r = await runProcess(check, path.join(copy, cwdRel));
      logs.push(`===== warm copy ${k} =====\n${hide((r.stdout || '') + (r.stderr || ''))}`);
      if (r.timedOut || r.error) { try { dropCopy(copy); } catch { /* the next sync clones it again */ } }
      return `  copy ${k}: ${r.timedOut ? 'stopped at the time limit' : r.error ? 'could not build' : r.status === 0 ? 'built' : `build failed (exit ${r.status}); the proof will show why`} (${secs()})`;
    }));
    lines.forEach(l => say(l));
    say(`RED-PROOF: WARM ✓ — ${slots.length} cop${slots.length === 1 ? 'y' : 'ies'} ready in ${Math.round((Date.now() - started) / 1000)} s; the proof rebuilds only what changes.`);
    finish(0);
  }

  // The runs: the old code, each break, then green on the fixed tree (the order the report reads them in).
  // Green RUNS first (2026-11-11, TUW-242: an older test still expected the old behavior, and the proof
  // said so only after its four red runs, 7 minutes in). It takes about a minute in the copy the compile
  // check warmed; when the fixed tree fails, the red runs are skipped and the proof ends at once.
  const jobs = [];
  if (hasOld) jobs.push({ kind: 'old', label: 'old code', changes: oldPlan
    ? oldPlan.map(o => ({ file: o.file, content: () => (o.content64 == null ? null : Buffer.from(o.content64, 'base64')) }))
    : oldRun.map(file => ({ file, content: () => { try { return git('show', `${oldRef}:${file}`); } catch { return null; } } })) });
  for (const b of breaks) jobs.push({ kind: 'break', b, label: b.single ? 'break' : 'break ' + b.name, changes: [{ file: b.file, content: (target) => fs.readFileSync(target, 'utf8').replace(b.find, () => b.put) }] });
  if (green) jobs.push({ kind: 'green', label: 'green', changes: [] });
  const greenAt = green ? jobs.length - 1 : -1;
  const runFailed = (r) => !r || r.timedOut || r.error || r.status !== 0;
  let results;
  if (parallel > 1 && !breaks.some(b => b.single)) results = await runParallel(jobs);
  else {
    await compileCheck(cwdHere);
    results = new Array(jobs.length);
    if (green) results[greenAt] = await runProcess(command, cwdHere);
    if (!green || !runFailed(results[greenAt])) {
      for (let i = 0; i < jobs.length; i++) if (i !== greenAt) results[i] = await swapRun(jobs[i].changes);
    }
  }

  // A `dotnet test` command builds the fixed tree once before any run (2026-11-09: a missing `using`
  // failed all 6 copies after full builds). A build error stops here: SETUP, with the compiler lines.
  async function compileCheck(cwd) {
    const check = compileCheckCommand(command);
    if (!check) return;
    const started = Date.now();
    say('RED-PROOF: compile check — the fixed tree builds once (--list-tests) before any run');
    const r = await runProcess(check, cwd);
    const output = (r.stdout || '') + (r.stderr || '');
    logs.push(`===== compile check =====\n${hide(output)}`);
    if (r.timedOut) { say(`RED-PROOF: TIMEOUT ✗ — the compile check ran past ${timeoutMin} min; it and every process it started were stopped. No run started.`); finish(5); }
    if (r.error) { say(`RED-PROOF: the compile check could not run — ${r.error.message}`); finish(2); }
    if (r.status !== 0) {
      const lines = output.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const errors = [...new Set(lines.filter(l => /\berror [A-Z]+\d+\s*:/.test(l)))];
      for (const l of (errors.length ? errors : lines.slice(-8)).slice(0, 12)) say('  ' + l.slice(0, 400));
      say(`RED-PROOF: SETUP ✗ — the fixed tree does not compile (exit ${r.status}); no run started. Fix the build, then run again.`);
      finish(3);
    }
    say(`RED-PROOF: compile check ✓ in ${Math.round((Date.now() - started) / 1000)} s`);
  }

  // Each run in its own kept copy, `parallel` at a time; the working folder is never touched.
  // The tree under test: HEAD, the folder's uncommitted files, and the repository's object store.
  function treeUnderTest() {
    const listed = (args) => { try { return execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean); } catch { return []; } };
    return {
      dirty: [...new Set([...listed(['diff', '--name-only', '-z', 'HEAD']), ...listed(['ls-files', '--others', '--exclude-standard', '-z'])])],
      head: gitText(['rev-parse', 'HEAD']),
      commonDir: path.resolve(repo, gitText(['rev-parse', '--git-common-dir'])),
    };
  }

  async function runParallel(list) {
    const { dirty, head, commonDir } = treeUnderTest();
    const modules = ['node_modules', ...fs.readdirSync(repo).map(d => d + '/node_modules')]
      .filter(m => { try { return fs.lstatSync(path.join(repo, m)).isDirectory(); } catch { return false; } });
    const cwdRel = path.relative(repo, cwdHere);
    const width = Math.min(parallel, list.length);
    const slots = Array.from({ length: width }, takeSlot);
    if (compileCheckCommand(command)) {
      try { syncCopy(slots[0], head, dirty, commonDir); }
      catch (e) { say('RED-PROOF: could not prepare a copy for the compile check — ' + e.message); finish(2); }
      await compileCheck(path.join(slots[0], cwdRel));
    }
    const out = new Array(list.length);
    let next = 0;
    // Green first, in the first copy (the one the compile check warmed); the other runs start when it
    // passes, and none starts when it fails.
    const order = [...list.keys()].sort((a, b) => Number(list[b].kind === 'green') - Number(list[a].kind === 'green'));
    let releaseGreen = () => {}, stopped = false;
    const greenGate = list.some(j => j.kind === 'green') ? new Promise(r => { releaseGreen = r; }) : null;
    say(`RED-PROOF: ${list.length} run(s), ${width} at a time, each in its own copy${greenGate ? '; green first' : ''}`);
    async function worker(copy) {
      while (next < list.length) {
        const i = order[next++];
        if (greenGate && list[i].kind !== 'green') { await greenGate; if (stopped) return; }
        const started = Date.now();
        const links = [], saved = [];
        let unsure = false;
        try {
          syncCopy(copy, head, dirty, commonDir);
          for (const m of modules) { const to = path.join(copy, m); if (!fs.existsSync(to)) { fs.symlinkSync(path.join(repo, m), to, 'junction'); links.push(to); } }
          for (const c of list[i].changes) {
            const target = path.join(copy, c.file);
            saved.push({ target, before: fs.existsSync(target) ? fs.readFileSync(target) : null });
            const text = c.content(target);
            if (text === null) { if (fs.existsSync(target)) fs.rmSync(target); }
            else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text); }
          }
          out[i] = await runProcess(command, path.join(copy, cwdRel));
        } catch (e) {
          out[i] = { status: null, stdout: '', stderr: '', error: e };
        } finally {
          // The copy goes back to the tree under test; its build output stays for the next run.
          for (const s of saved) { try { if (s.before === null) fs.rmSync(s.target, { force: true }); else fs.writeFileSync(s.target, s.before); } catch { unsure = true; } }
          for (const l of links) { try { fs.unlinkSync(l); } catch { /* a link that is gone needs nothing */ } }
          // A stopped or failed run can leave half-written build output: that copy starts over.
          if (unsure || out[i].timedOut || out[i].error) { try { dropCopy(copy); } catch { /* the next sync clones it again */ } }
        }
        say(`  ran ${list[i].label}: ${out[i].timedOut ? 'stopped at the time limit' : out[i].error ? 'could not run' : 'exit ' + out[i].status} (${Math.round((Date.now() - started) / 1000)} s)`);
        if (list[i].kind === 'green') { stopped = runFailed(out[i]); releaseGreen(); }
      }
    }
    await Promise.all(slots.map(worker));
    return out;
  }

  // A kept copy for this proof: the first slot no running proof holds (its lock names this process,
  // released when this process ends).
  function takeSlot() {
    fs.mkdirSync(slotsRoot, { recursive: true });
    if (!takeSlot.held) {
      takeSlot.held = [];
      process.on('exit', () => { for (const l of takeSlot.held) { try { fs.rmSync(l, { force: true }); } catch { /* gone */ } } });
    }
    for (let k = 0; ; k++) {
      const lock = path.join(slotsRoot, `${k}.lock`);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
          takeSlot.held.push(lock);
          return path.join(slotsRoot, String(k));
        } catch (e) {
          if (e.code !== 'EEXIST' || lockOwner(lock)) break; // in use: the next slot
          try { fs.rmSync(lock, { force: true }); } catch { break; } // a stale lock: take it over
        }
      }
    }
  }
  // Brings a kept copy to the tree under test (HEAD plus the folder's uncommitted files). Only files
  // that differ are written, so an unchanged file keeps its time and MSBuild skips its project.
  function syncCopy(copy, head, dirty, commonDir) {
    const g = (args, input) => execFileSync('git', args, { cwd: copy, encoding: 'utf8', windowsHide: true, input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    const norm = (p) => { const r = path.resolve(p).replace(/\\/g, '/'); return process.platform === 'win32' ? r.toLowerCase() : r; };
    let fresh = false;
    let alternates = [];
    try { alternates = fs.readFileSync(path.join(copy, '.git', 'objects', 'info', 'alternates'), 'utf8').split(/\r?\n/).filter(Boolean).map(norm); } catch { /* not a copy yet */ }
    if (!alternates.includes(norm(path.join(commonDir, 'objects')))) {
      // A clone that reads this repository's objects: not a worktree, so `git worktree list` stays clean.
      dropCopy(copy);
      execFileSync('git', ['clone', '-q', '--shared', '--no-checkout', commonDir, copy], { stdio: 'ignore', windowsHide: true });
      for (const key of ['core.autocrlf', 'core.eol', 'core.longpaths']) { const value = gitText(['config', '--get', key]); if (value) g(['config', key, value]); }
      fresh = true;
    }
    try { g(['update-index', '-q', '--refresh']); } catch { /* exit 1 names files that differ: handled below */ }
    let current = '';
    try { current = g(['rev-parse', '-q', '--verify', 'HEAD']).trim(); } catch { /* no commit checked out */ }
    if (fresh || current !== head) g(['checkout', '-q', '--force', '--detach', head]);
    const want = new Set(dirty);
    const back = g(['diff', '--name-only', '-z', 'HEAD']).split('\0').filter(f => f && !want.has(f));
    if (back.length) g(['checkout', '-q', 'HEAD', '--pathspec-from-file=-', '--pathspec-file-nul'], back.join('\0'));
    for (const f of g(['ls-files', '--others', '--exclude-standard', '-z']).split('\0')) if (f && !want.has(f)) fs.rmSync(path.join(copy, f), { recursive: true, force: true });
    for (const f of dirty) {
      const from = path.join(repo, f), to = path.join(copy, f);
      if (!fs.existsSync(from)) { fs.rmSync(to, { force: true }); continue; }
      const buf = fs.readFileSync(from);
      let same = false;
      try { same = fs.readFileSync(to).equals(buf); } catch { /* not there yet */ }
      if (!same) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, buf); }
    }
  }

  // Green ran first and failed: the fixed tree fails its own tests, so no red run started.
  if (green && runFailed(results[greenAt])) {
    const g = results[greenAt];
    if (g.timedOut) { say(`RED-PROOF: TIMEOUT ✗ — green ran past ${timeoutMin} min; it and every process it started were stopped; no red run started; files restored.`); finish(5); }
    const r = read(g, 'green');
    setupStop(r); showWhy(r);
    say('  GREEN ✗ the tests fail on the fixed tree');
    say('RED-PROOF: NOT PROVED ✗ — the fixed tree fails its own tests, so the red runs were skipped. An older test may still expect the old behavior: fix the tests or the code, then run again; files restored.');
    finish(1);
  }
  let ok = true;
  // 0. A run past the time limit proves nothing: named first, the others still read.
  const late = jobs.filter((j, i) => results[i]?.timedOut);
  for (const j of late) say(`RED-PROOF: TIMEOUT ✗ — ${j.label} ran past ${timeoutMin} min; it and every process it started were stopped; files restored.`);
  // 1. The old code.
  if (hasOld) {
    const r = read(results[0], 'old code');
    if (results[0].timedOut) ok = false;
    else if (r.code !== 0) {
      setupStop(r, true); showWhy(r);
      const asserts = r.why.filter((w) => w.kind === 'assert').length;
      say(`RED-PROOF: RED ✓ — the tests fail on ${oldLabel} for ${(oldPlan ? oldNames : oldRun).join(', ')} (exit ${r.code}${r.why.length ? `; ${asserts} of ${r.why.length} failing test(s) by an assertion` : '; failure reasons not read from this runner'}); files restored.`);
    } else {
      say(`RED-PROOF: NOT RED ✗ — the tests pass on ${oldLabel}, so they do not prove the fix; files restored.`); ok = false;
      const kept = plan ? (Array.isArray(plan.kept) ? plan.kept : []) : keptAtFix.map(k => k.file);
      if (kept.length) say(`RED-PROOF: ${kept.join(', ')} stayed at the fix (see above). If the fix itself is in there, prove it with --breaks alone.`);
    }
  }
  // 2. Each break of the rule under test. A mustFail part may name a test's method or its DisplayName.
  const pairs = namePairs();
  for (let i = 0; i < breaks.length; i++) {
    const b = breaks[i];
    const r = read(results[(hasOld ? 1 : 0) + i], 'break ' + b.name);
    if (results[(hasOld ? 1 : 0) + i].timedOut) { ok = false; continue; }
    if (b.single) {
      if (r.code !== 0) { setupStop(r); showWhy(r); say(`RED-PROOF: RED ✓ — the test fails with ${b.file} broken (exit ${r.code}); files restored.`); }
      else { say(`RED-PROOF: NOT RED ✗ — the test passes with ${b.file} broken, so it does not check that code; files restored.`); ok = false; }
      continue;
    }
    const left = survivors(b.mustFail, r.why, pairs);
    if (r.code !== 0 && !left.length) say(`  BREAK ✓ ${b.name}: all ${b.mustFail.length} named test(s) fail`);
    else { say(`  BREAK ✗ ${b.name}: still pass (or not seen failing): ${left.join(' | ')}`); ok = false; }
  }
  // 3. Green on the fixed tree.
  if (green) {
    const r = read(results[results.length - 1], 'green');
    if (results[results.length - 1].timedOut) ok = false;
    else if (r.code === 0) say('  GREEN ✓ the tests pass on the fixed tree');
    else { setupStop(r); showWhy(r); say('  GREEN ✗ the tests fail on the fixed tree'); ok = false; }
  }
  if (late.length) {
    say(`RED-PROOF: NOT PROVED ✗ — ${late.length} run(s) did not finish within ${timeoutMin} min, so nothing is proved. Fix the hang or raise --timeout-min, then run again; files restored.`);
    finish(5);
  }
  if (breaks.length && !breaks[0].single) say(ok ? `RED-PROOF: PROVED ✓ — ${hasOld ? 'red on the old code, ' : ''}${breaks.length} break(s) caught${green ? ', green on the fix' : ''}; files restored.` : 'RED-PROOF: NOT PROVED ✗ — see the lines above; files restored.');
  // The record pre-review reads: only a run that proved at least one break of the rule under test.
  if (ok && fileHashes) {
    try { writeRecord(repo, { ok: true, base, files: fileHashes, breaks: breaks.length, old: hasOld, green }); }
    catch (e) { say('RED-PROOF: could not write the proof record — ' + e.message); }
  }
  finish(ok ? 0 : 1);
}
