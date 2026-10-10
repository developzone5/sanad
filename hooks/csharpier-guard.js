#!/usr/bin/env node
/*
 * csharpier-guard.js — PreToolUse(Bash|PowerShell) hook.
 * Blocks a `git commit` / `git push` whose C# files are not CSharpier-formatted,
 * so CI's `dotnet csharpier check` can never be the first thing to notice.
 *
 * Self-gating: exits 0 (allow) for anything that is not a git commit/push, for
 * repos without a CSharpier tool manifest, and when no .cs file is involved.
 * Fail-OPEN: any error (no git, no dotnet, parse failure) → allow. Only DENIES
 * when CSharpier itself reports an unformatted file, so it cannot brick the shell.
 *
 * Author: Eng. Mohammed Almutairi - Developzone.net
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// Hook plumbing (same shape as precommit-guard.js)
// ---------------------------------------------------------------------------

// Set CSHARPIER_GUARD_DEBUG=1 to trace every decision on stderr (never on stdout —
// stdout is the hook's JSON channel).
const DEBUG = !!process.env.CSHARPIER_GUARD_DEBUG;
function dbg(label, value) {
  if (DEBUG) process.stderr.write('[csharpier-guard] ' + label + ': ' + (typeof value === 'string' ? value : JSON.stringify(value)) + '\n');
}

function allow(why) { dbg('allow', why || ''); process.exit(0); }

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

function readStdin() {
  try {
    let s = fs.readFileSync(0, 'utf8');
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    return s;
  } catch (e) { return ''; }
}

// No shell: repo-controlled strings (paths, branch names) never reach a shell parser.
function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 8000,
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (e) { return ''; }
}

// ---------------------------------------------------------------------------
// 1) Is this a git commit or push?
// ---------------------------------------------------------------------------

let input;
try { input = JSON.parse(readStdin() || '{}'); } catch (e) { allow('stdin was not valid JSON (fail-open)'); }

const cmd = String((input && input.tool_input && input.tool_input.command) || '');
// The shared grammar resolves which repository the commit/push really targets
// (`git -C dir`, `cd /c/…`, `Set-Location`, blocks, git.exe spellings).
let shell;
try { shell = require(path.join(__dirname, 'lib', 'shell-command.cjs')); } catch (e) { allow('shell-command library missing (fail-open)'); }
const records = shell.parseCommand(cmd, { cwd: (input && input.cwd) || process.cwd(), tool: input && input.tool_name === 'Bash' ? 'Bash' : 'PowerShell', home: os.homedir(), tmp: os.tmpdir() });
const action = records.find((r) => r.git && (r.git.sub === 'commit' || r.git.sub === 'push'));
if (!action) allow('not a git commit/push');
// Formatting is not a security boundary: an unresolvable target stays fail-open
// (precommit-guard owns the fail-closed side of the same command).
if (!action.git.certain) allow('target repository unresolved: ' + action.git.why);
const verb = action.git.sub;
dbg('verb', verb);

// ---------------------------------------------------------------------------
// 2) Repo root + the directory that owns the CSharpier tool manifest
// ---------------------------------------------------------------------------

const startDir = action.git.cwd;
const rawRoot = git(['rev-parse', '--show-toplevel'], startDir).trim();
if (!rawRoot) allow('no git root from ' + startDir);
// git prints the root with forward slashes even on Windows; resolve it so every
// comparison below uses the platform's own separator (otherwise nothing matches).
const root = path.resolve(rawRoot);
dbg('root', root);

// The manifest can sit at the root or one level down (this monorepo keeps it in EduQuest/).
function hasCsharpier(dir) {
  try {
    const manifest = path.join(dir, '.config', 'dotnet-tools.json');
    return fs.existsSync(manifest) && /csharpier/i.test(fs.readFileSync(manifest, 'utf8'));
  } catch (e) { return false; }
}

let toolDirs = [];
try {
  if (hasCsharpier(root)) toolDirs.push(root);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.startsWith('.') && hasCsharpier(path.join(root, entry.name)))
      toolDirs.push(path.join(root, entry.name));
  }
} catch (e) { dbg('manifest scan error', String(e)); }
dbg('toolDirs', toolDirs);
if (toolDirs.length === 0) allow('no CSharpier manifest');

// ---------------------------------------------------------------------------
// 3) Which files does this commit/push carry?
// ---------------------------------------------------------------------------

let listed = '';
if (verb === 'commit') {
  listed = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'], root);
  // `git commit -a` / `--all` also sweeps in unstaged modifications.
  if (action.git.args.some((a) => a === '--all' || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(a)))
    listed += '\n' + git(['diff', '--name-only', '--diff-filter=ACMR'], root);
  // `git commit <paths>` commits those paths whether staged or not.
  const pathArgs = action.git.args.filter((a) => !a.startsWith('-') && /\.cs$/i.test(a));
  listed += '\n' + pathArgs.map((s) => path.resolve(startDir, s)).join('\n');
} else {
  // Every file touched by a commit that no remote has yet — covers first pushes too.
  listed = git(['log', '--format=', '--name-only', '--diff-filter=ACMR', 'HEAD', '--not', '--remotes'], root);
}

const files = [...new Set(
  listed.split(/\r?\n/).map(s => s.trim()).filter(f => f.toLowerCase().endsWith('.cs'))
)].map(f => path.resolve(root, f)).filter(f => fs.existsSync(f));
dbg('files', files);

if (files.length === 0) allow('no .cs files in this ' + verb);

// CSharpier checks the working file, but a plain commit records the staged blob.
// When a C# file is only partly staged the two differ, so the check would judge
// content that is not being committed: require the whole file to be staged.
if (verb === 'commit' && !action.git.args.some((a) => a === '--all' || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(a))) {
  const unstaged = new Set(git(['diff', '--name-only', '--diff-filter=ACMR'], root).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map((f) => path.resolve(root, f).toLowerCase()));
  const staged = new Set(git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'], root).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map((f) => path.resolve(root, f).toLowerCase()));
  const partial = files.filter((f) => staged.has(f.toLowerCase()) && unstaged.has(f.toLowerCase()));
  if (partial.length) {
    deny('Blocked: these C# files are only partly staged, so the formatting check cannot judge what this commit records:\n' +
      partial.map((f) => '  - ' + path.relative(root, f)).join('\n') + '\nStage each whole file (git add <file>) or stash the unstaged part, then re-run the same git command.');
  }
}

// ---------------------------------------------------------------------------
// 4) Ask CSharpier, per tool directory, about the files under it
// ---------------------------------------------------------------------------

function runCsharpier(dir, args) {
  return spawnSync('dotnet', ['csharpier', ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 45000,
    windowsHide: true,
  });
}

const problems = [];
for (const dir of toolDirs) {
  const prefix = (dir + path.sep).toLowerCase(); // Windows paths are case-insensitive
  const mine = files.filter(f => f.toLowerCase().startsWith(prefix));
  if (mine.length === 0) continue;

  let res = runCsharpier(dir, ['check', ...mine]);
  const notRestored = res.error || /could not execute|not found|NU1|tool.*restore/i.test((res.stdout || '') + (res.stderr || '')) && res.status !== 0 && !/Was not formatted/i.test(res.stdout || '');
  if (notRestored) {
    spawnSync('dotnet', ['tool', 'restore'], { cwd: dir, encoding: 'utf8', timeout: 60000, windowsHide: true });
    res = runCsharpier(dir, ['check', ...mine]);
  }
  dbg('csharpier ' + dir, { status: res.status, error: res.error ? String(res.error) : null, stdout: (res.stdout || '').slice(0, 600), stderr: (res.stderr || '').slice(0, 300) });
  if (res.error) continue; // dotnet missing or timed out → fail-open

  const out = (res.stdout || '') + (res.stderr || '');
  const bad = [...out.matchAll(/Error\s+(\S+)\s+-\s+Was not formatted/gi)].map(x => x[1]);
  if (res.status !== 0 && bad.length > 0) {
    problems.push({ dir, files: bad });
  }
}

if (problems.length === 0) allow('CSharpier reported no unformatted file');

const lines = ['Blocked: CSharpier would fail CI on these files (not formatted):'];
for (const p of problems) {
  for (const f of p.files) lines.push('  - ' + f);
  lines.push('Fix, then re-run the same git command:');
  lines.push('  cd "' + p.dir + '" && dotnet csharpier format ' + p.files.map(f => '"' + f + '"').join(' '));
}
deny(lines.join('\n'));
