#!/usr/bin/env node
// red-proof.mjs — prove a new test fails on the OLD code (red before green) without leaving a
// failed check behind. It swaps in the old version of the fix files, runs the test once, always
// puts the files back byte-for-byte, and reports RED (the test catches the bug) or NOT RED (the
// test passes on the old code, so it proves nothing).
//
// Why a script: a red run typed as a plain test command is kept as a failed check by the push
// guard forever, and a hand-written "swap; test; restore" compound can never be re-run green.
// This helper is not a test command itself, so only its own result counts: exit 0 = RED as
// expected, 1 = NOT RED, 2 = usage or restore problem.
//
// Usage:
//   node ~/.claude/skills/gate/scripts/red-proof.mjs --repo <path> --old <git-ref> --files <a,b,...>
//        [--cwd <dir>] [--log <file>] -- <executable> [args...]
//   node ~/.claude/skills/gate/scripts/red-proof.mjs --restore <backup-dir>
// --files are repo-relative paths of the FIX (not the test): each takes its <old> version for the
// run (a file that did not exist at <old> is removed for the run). The test command runs without
// a shell; pass the real executable (node <entrypoint>, dotnet, ...), not a .cmd shim.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

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
const files = (opt('--files') || '').split(',').map((f) => f.trim().replace(/\\/g, '/')).filter(Boolean);
if (!repo || !oldRef || !files.length || !command.length) {
  say('usage: red-proof.mjs --repo <path> --old <git-ref> --files <a,b> [--cwd <dir>] [--log <file>] -- <executable> [args...]');
  process.exit(2);
}
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
try { git('rev-parse', '--verify', oldRef + '^{commit}'); }
catch { say(`RED-PROOF: unknown --old ref ${oldRef}`); process.exit(2); }

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
  say(`RED-PROOF: RED ✓ — the test fails on ${oldRef} for ${files.join(', ')} (exit ${code}); files restored.`);
  process.exit(0);
}
say(`RED-PROOF: NOT RED ✗ — the test passes on ${oldRef}, so it does not prove the fix; files restored.`);
process.exit(1);
