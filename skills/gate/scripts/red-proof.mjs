#!/usr/bin/env node
// red-proof.mjs — prove a new test fails on the OLD code (red before green) without leaving a
// failed check behind. It swaps in the old version of the fix files, runs the test once, always
// puts the files back byte-for-byte, and reports RED (the test catches the bug) or NOT RED (the
// test passes on the old code, so it proves nothing).
//
// Why a script: a red run typed as a plain test command is kept as a failed check by the push
// guard forever, and a hand-written "swap; test; restore" compound can never be re-run green.
// This helper is not a test command itself, so only its own result counts: exit 0 = RED as
// expected (each failing test named, with its reason), 1 = NOT RED, 2 = usage or restore
// problem, 3 = SETUP (a test failed for a setup reason, not because of the old code).
//
// Usage:
//   node ~/.claude/skills/gate/scripts/red-proof.mjs --repo <path> --old <git-ref> --files <a,b,...>
//        [--cwd <dir>] [--log <file>] -- <executable> [args...]
//   node ~/.claude/skills/gate/scripts/red-proof.mjs --repo <path> --break <file> --find <text> --put <text>
//        [--cwd <dir>] [--log <file>] -- <executable> [args...]
//   node ~/.claude/skills/gate/scripts/red-proof.mjs --restore <backup-dir>
// --files are repo-relative paths of the FIX (not the test): each takes its <old> version for the
// run (a file that did not exist at <old> is removed for the run). The test command runs without
// a shell; pass the real executable (node <entrypoint>, dotnet, ...), not a .cmd shim.
// --break proves a test of code that already works, where no old version fails: for one run it
// replaces <text> in that one file, which must match exactly once, then puts the file back.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

// Why each test failed (2026-11-06). An assertion about behavior proves the old code is wrong. A
// missing element, a type, reference or build error, or a timeout means the test itself (or the
// machine) is wrong, so the run proves nothing yet: exit 3, SETUP.
const SETUP_ERR = /TestingLibraryElementError|Unable to find (?:an? )?(?:accessible )?element|Found multiple elements|\bTypeError\b|\bReferenceError\b|\bSyntaxError\b|Cannot read propert|is not a function|is not defined|Test timed out|Hook timed out|Cannot find module|Failed to resolve import|NullReferenceException|\berror (?:CS|TS)\d{3,5}\b/;
const ASSERT_ERR = /AssertionError|\bexpected\b.*\bto\b|Assert\.\w+\(\) Failure|Xunit\.Sdk\.\w+Exception|AssertFailedException|Shouldly|^Expected:/i;
const SETUP_OUTPUT = /\berror (?:CS|TS)\d{3,5}\b|Build FAILED|Failed to resolve import|Cannot find module|SyntaxError/;
function failureReasons(text) {
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

const argv = process.argv.slice(2);
const dash = argv.indexOf('--');
const opts = dash >= 0 ? argv.slice(0, dash) : argv;
const command = dash >= 0 ? argv.slice(dash + 1) : [];
const opt = (name) => { const i = opts.indexOf(name); return i >= 0 ? opts[i + 1] : undefined; };
const say = (line) => process.stdout.write(line + '\n');
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
const breakFile = opt('--break')?.replace(/\\/g, '/');
const find = opt('--find');
const put = opt('--put');
const files = breakFile ? [breakFile] : (opt('--files') || '').split(',').map((f) => f.trim().replace(/\\/g, '/')).filter(Boolean);
const ready = breakFile ? find && put !== undefined : oldRef && files.length;
if (!repo || !ready || !command.length) {
  say('usage: red-proof.mjs --repo <path> --old <git-ref> --files <a,b> [--cwd <dir>] [--log <file>] -- <executable> [args...]');
  say('   or: red-proof.mjs --repo <path> --break <file> --find <text> --put <text> [--cwd <dir>] [--log <file>] -- <executable> [args...]');
  process.exit(2);
}
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
if (breakFile) {
  const target = path.join(repo, breakFile);
  const hits = fs.existsSync(target) ? fs.readFileSync(target, 'utf8').split(find).length - 1 : 0;
  if (hits !== 1) { say(`RED-PROOF: --find matches ${hits} time(s) in ${breakFile}; it must match exactly once. Nothing changed.`); process.exit(2); }
} else {
  try { git('rev-parse', '--verify', oldRef + '^{commit}'); }
  catch { say(`RED-PROOF: unknown --old ref ${oldRef}`); process.exit(2); }
}

// Back up the current files (outside the repo) before anything changes.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'red-proof-'));
const manifest = { repo, oldRef, files: [] };
files.forEach((file, i) => {
  const target = path.join(repo, file);
  const existed = fs.existsSync(target);
  const entry = { file, existed, backup: `file-${i}` };
  if (existed) { const buf = fs.readFileSync(target); fs.writeFileSync(path.join(dir, entry.backup), buf); entry.sha = sha(buf); }
  manifest.files.push(entry);
});
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
say(`RED-PROOF: backups in ${dir} (if this run is killed: node ${process.argv[1]} --restore "${dir}")`);

let result;
let swapError = null;
try {
  for (const entry of manifest.files) {
    const target = path.join(repo, entry.file);
    if (breakFile) { fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace(find, () => put)); continue; }
    let old = null;
    try { old = git('show', `${oldRef}:${entry.file}`); } catch { old = null; }
    if (old === null) { if (fs.existsSync(target)) fs.rmSync(target); }
    else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, old); }
  }
  result = spawnSync(command[0], command.slice(1), {
    cwd: opt('--cwd') ? path.resolve(opt('--cwd')) : repo, encoding: 'utf8', shell: false,
    windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000,
  });
} catch (e) {
  swapError = e;
} finally {
  try { restore(dir); }
  catch (e) { say('RED-PROOF: RESTORE FAILED — ' + e.message); process.exit(2); }
}
if (swapError) { say('RED-PROOF: could not swap in the old files — ' + swapError.message + '; files restored.'); process.exit(2); }

const output = (result.stdout || '') + (result.stderr || '');
if (opt('--log')) fs.writeFileSync(path.resolve(opt('--log')), output);
const tail = output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).filter((l) => l.trim()).slice(-25).join('\n');
if (result.error) { say(`RED-PROOF: the test command could not run — ${result.error.message}`); process.exit(2); }
const code = result.status;
say(tail);
if (code !== 0) {
  const why = failureReasons(output);
  for (const w of why.slice(0, 12)) say(`  ${w.kind === 'assert' ? '✓ assert' : w.kind === 'setup' ? '✗ setup ' : '? other '}  ${w.name}${w.why ? ' — ' + w.why : ''}`);
  const setup = why.filter((w) => w.kind === 'setup');
  if (setup.length || (!why.length && SETUP_OUTPUT.test(output))) {
    say(`RED-PROOF: SETUP ✗ — ${setup.length || 'the run'} failed for a setup reason (element not found, type or build error, timeout), not because of the old code. Fix the test or the machine, then run again; files restored.`);
    process.exit(3);
  }
  const asserts = why.filter((w) => w.kind === 'assert').length;
  say(`RED-PROOF: RED ✓ — the test fails ${breakFile ? `with ${breakFile} broken` : `on ${oldRef} for ${files.join(', ')}`} (exit ${code}${why.length ? `; ${asserts} of ${why.length} failing test(s) by an assertion` : '; failure reasons not read from this runner'}); files restored.`);
  process.exit(0);
}
say(`RED-PROOF: NOT RED ✗ — the test passes ${breakFile ? `with ${breakFile} broken, so it does not check that code` : `on ${oldRef}, so it does not prove the fix`}; files restored.`);
process.exit(1);
