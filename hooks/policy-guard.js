#!/usr/bin/env node
/*
 * policy-guard.js — PreToolUse(Bash|PowerShell) hook.
 * Mechanically enforces the CLAUDE.md rules that used to live in prose only:
 *
 *   DENY (impossible from Claude; the human can still run it by hand):
 *     - git push whose target is main/master/prod/production/release/*
 *     - outgoing code without completed verification and passing review/gate
 *     - git add . / -A / --all            (stage named files only)
 *     - gh pr merge · gh release *        (never merge, never cut a release)
 *     - gh pr create without --base, or with a prod base
 *     - gh api / graphql calls that merge, release, or delete
 *     - rm -r on a catastrophic target (/, ~, ., ..)
 *   ASK (forces the permission prompt even when an allow rule matches):
 *     - force-push, remote-branch delete, --all/--mirror/--tags
 *     - direct push to the integration branch (bypasses the PR flow)
 *     - non-draft PR, PR base that is not the integration branch, gh pr ready
 *     - git reset --hard · checkout -- / . · restore <path> · clean -f ·
 *       branch -D · stash drop/clear · tag · commit -a / --no-verify /
 *       --amend of a pushed commit · merge/rebase while on a shared branch
 *     - docker compose down -v · docker volume prune/rm · system prune ·
 *       docker push (GHCR auto-pull = a deploy)
 *     - rm -r / Remove-Item -Recurse outside build-output dirs
 *     - dotnet ef database drop · migrations remove · database update <target>
 *     - DROP/TRUNCATE/ALTER…DROP/DELETE-without-WHERE sent to a DB client
 *
 * Self-gating: anything else → allow instantly (no git call, no transcript
 * read). Publishing evidence fails closed; other inspection errors preserve an
 * existing denial or leave unrelated commands alone. Deterministic, no LLM.
 *
 * Author: Eng. Mohammed Almutairi - Developzone.net
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

function allow() { process.exit(0); }
function emit(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason },
  }));
  process.exit(0);
}

// deny outranks ask; the first reason of the winning kind is reported.
let verdict = null;
function deny(reason) { if (!verdict || verdict.d !== 'deny') verdict = { d: 'deny', r: 'Blocked by policy-guard: ' + reason }; }
function ask(reason) { if (!verdict) verdict = { d: 'ask', r: 'policy-guard: ' + reason + ' — needs explicit confirmation (CLAUDE.md one-way door).' }; }

function readStdin() {
  try {
    let s = fs.readFileSync(0, 'utf8');
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    return s;
  } catch (e) { return ''; }
}

let input = {};
try { input = JSON.parse(readStdin().trim() || '{}'); } catch (e) { allow(); }
const cmd = input && input.tool_input && input.tool_input.command;
if (typeof cmd !== 'string' || !cmd.trim()) allow();
const cwd = input.cwd || process.cwd();
let gitCwd = cwd;

let scan = null;
try { scan = require(path.join(__dirname, 'lib', 'transcript-scan.js')); } catch (e) { scan = null; }
let shell = null;
try { shell = require(path.join(__dirname, 'lib', 'shell-command.cjs')); } catch (e) { shell = null; }
// ON_UNKNOWN without the shared grammar: irreversible actions deny, deletes ask,
// everything else passes (a weaker fallback parser would silently misjudge).
if (!shell) {
  if (/\b(?:git|gh)(?:\.exe)?["']?\s[^\n]*\b(?:push|merges?|releases?)\b|\b(?:npm|pnpm|yarn|bun)\S*\s[^\n]*\b(?:un)?publish\b|\bnuget\b[^\n]*\bpush\b/i.test(cmd))
    emit('deny', 'Blocked by policy-guard: its command parser (hooks/lib/shell-command.cjs) could not be loaded, so this publishing/merge command cannot be checked. Restore the library, then retry.');
  if (/(?:^|[\s;&|({"'])(?:rm|rmdir|rd|del|erase|ri|Remove-Item|rimraf)\b/i.test(cmd))
    emit('ask', 'policy-guard: command parser unavailable (hooks/lib/shell-command.cjs) — confirm this delete manually.');
  allow();
}
const { tokenize } = shell;
const SHELL_OPTS = { tool: input.tool_name === 'Bash' ? 'Bash' : 'PowerShell', home: require('os').homedir(), tmp: (require('os').tmpdir || (() => ''))() };

function gitRaw(args) {
  return execFileSync('git', args, { cwd: gitCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
}
function git(args) {
  try { return gitRaw(args).trim(); } catch (e) { return ''; }
}
let _branch;
function currentBranch() { if (_branch === undefined) _branch = git(['rev-parse', '--abbrev-ref', 'HEAD']); return _branch; }
function headIsPushed() { return git(['branch', '-r', '--contains', 'HEAD']) !== ''; }

const PROD_BRANCH = /^(main|master|prod|production|release(\/.+)?)$/i;
const INTEGRATION_BRANCH = /^(staging|develop|dev)$/i;
// Only untracked build output inside the effective directory (or anything in the
// temp folder) is exempt from delete confirmation — judged on the RESOLVED path.
const GENERATED_DIR = /^(?:bin|obj|node_modules|dist|build|out|coverage|TestResults|\.vite|\.cache|\.next|\.turbo)$/i;
const CATASTROPHIC = /^(\/|\/\*|~|~\/|~\/\*|\.|\.\.|\*|\$HOME|\$env:USERPROFILE|[A-Za-z]:\\?|[A-Za-z]:\/?)$/;
// PowerShell accepts any unambiguous parameter prefix: -r … -Recurse, -Recurse:$true.
const PS_RECURSE = /^-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?(?::\$?true)?$/i;

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

function checkGit(g) {
  const a = g.args;
  const has = (re) => a.some((t) => re.test(t));
  const shortHas = (letter) => a.some((t) => new RegExp('^-[a-zA-Z]*' + letter + '[a-zA-Z]*$').test(t));

  switch (g.sub) {
    case 'push': return checkPush(a, g.config || {});

    case 'add': {
      const bad = a.find((t) => /^(\.|\.\/|\*|-A|--all|:\/|:\/\.|--no-ignore-removal)$/.test(t));
      if (bad) deny('`git add ' + bad + '` stages everything — CLAUDE.md Ground rules: stage named files only.');
      else if (has(/^(-u|--update)$/) || shortHas('u')) ask('`git add -u` stages every tracked change; CLAUDE.md wants named files');
      return;
    }
    case 'commit':
      if (has(/^--no-verify$/) || shortHas('n')) ask('`--no-verify` skips the repo hooks (CLAUDE.md: never bypass a failing check unless asked)');
      if (has(/^--all$/) || shortHas('a')) ask('`git commit -a` commits every tracked change; CLAUDE.md wants named files staged');
      if (has(/^--amend$/) && headIsPushed()) ask('`--amend` of a commit that already exists on a remote rewrites pushed history');
      return;
    case 'reset':
      if (has(/^--hard$/)) ask('`git reset --hard` destroys uncommitted work');
      return;
    case 'checkout': {
      if (has(/^(--|\.|-f|--force)$/) || shortHas('f')) { ask('`git checkout` with `--` / `.` / `-f` discards uncommitted changes'); return; }
      // `git checkout <existing file>` (no --) also discards that file's changes.
      const file = a.find((t) => !t.startsWith('-') && fileExists(t));
      if (file) ask('`git checkout ' + file + '` discards the uncommitted changes in that file');
      return;
    }
    case 'restore': {
      const staged = has(/^(--staged|-S)$/), worktree = has(/^(--worktree|-W)$/);
      if (!(staged && !worktree)) ask('`git restore` discards working-tree changes (only `--staged` alone is safe)');
      return;
    }
    case 'clean':
      if (has(/^--force$/) || has(/^-[a-zA-Z]*[fdxX]/)) ask('`git clean` deletes untracked files');
      return;
    case 'branch':
      if (has(/^(-d|-D|--delete)$/) || shortHas('d') || shortHas('D'))
        ask('deleting a branch — CLAUDE.md: branch deletion needs explicit confirmation (-D also loses unmerged commits)');
      return;
    case 'stash':
      if (has(/^(drop|clear)$/)) ask('`git stash drop/clear` deletes stashed work');
      return;
    case 'tag':
      if (a.some((t) => !t.startsWith('-')) && !has(/^(-l|--list|-n\d*)$/)) ask('creating/deleting a tag — CLAUDE.md: never tag a release');
      return;
    case 'merge':
    case 'rebase': {
      const b = currentBranch();
      if (PROD_BRANCH.test(b) || INTEGRATION_BRANCH.test(b))
        ask('`git ' + g.sub + '` while on shared branch `' + b + '` — CLAUDE.md: never merge into a shared/prod branch locally; use a PR');
      return;
    }
    case 'worktree':
      if (has(/^remove$/) && (has(/^(-f|--force)$/))) ask('force-removing a worktree discards its uncommitted changes');
      return;
    case 'filter-branch':
    case 'filter-repo':
    case 'replace':
      ask('`git ' + g.sub + '` rewrites history');
      return;
    case 'update-ref':
      if (has(/^-d$/)) ask('deleting a ref');
      return;
    default: return;
  }
}

function fileExists(t) {
  try { return fs.statSync(path.resolve(cwd, t)).isFile(); } catch (e) { return false; }
}

function checkPush(a, cliConfig) {
  // The last dry-run flag wins in git; a mix of both is ambiguous, so deny it.
  const dryFlags = a.filter((t) => /^(--dry-run|-n|--no-dry-run)$/.test(t));
  if (dryFlags.length && dryFlags.every((t) => t !== '--no-dry-run')) return;
  if (dryFlags.some((t) => t !== '--no-dry-run') && dryFlags.includes('--no-dry-run')) {
    deny('conflicting dry-run flags (`--dry-run`/`-n` with `--no-dry-run`) make it unclear whether this push publishes. Use one form.');
    return;
  }
  // Push-affecting configuration given on the command line changes where a
  // refspec lands; it cannot be checked against the saved configuration.
  if (Object.keys(cliConfig).some((k) => /^(?:push\.|remote\..*\.push$|branch\..*\.merge$)/.test(k)) || a.some((t) => /^--config-env(?:=|$)/.test(t))) {
    deny('this push overrides push configuration on the command line (`-c push.*` / `remote.<name>.push` / `--config-env`). Push with an explicit `HEAD:refs/heads/<branch>` and no overrides.');
    return;
  }
  let force = false, del = false, wide = false, remote = null;
  const refspecs = [];
  for (let i = 0; i < a.length; i++) {
    const t = a[i];
    if (/^(--force|--force-with-lease(=.*)?|--force-if-includes)$/.test(t) || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(t)) { force = true; continue; }
    if (/^(--delete|-d)$/.test(t)) { del = true; continue; }
    if (/^(--mirror|--all|--tags|--prune)$/.test(t)) { wide = true; continue; }
    if (/^(-o|--push-option|--receive-pack|--repo|--exec)$/.test(t)) { i++; continue; }
    // Shell redirections are not refspecs: `> out.txt`, `2> err`, `>file`, `2>&1`.
    if (/^(\d*>>?|&>>?|\d*<)$/.test(t)) { i++; continue; }
    if (/^(\d*>>?|&>>?|\d*<)\S/.test(t) || /^\d*>&\d+$/.test(t)) continue;
    if (t.startsWith('-')) continue;
    if (remote === null) remote = t; else refspecs.push(t);
  }

  const deleteMode = del; // --delete applies to all following refs; :ref applies only to itself.
  let publishesCode = refspecs.length === 0 && !deleteMode;
  const dsts = [];
  // A saved remote.<name>.push refspec or push.default=upstream silently remaps
  // a colon-less refspec (`git push origin feat/x` can land on main). Resolve the
  // real destination; when the saved mapping cannot be judged, require src:dst.
  const remoteName = remote || 'origin';
  const mappedPush = git(['config', '--get-all', 'remote.' + remoteName + '.push']);
  const pushDefault = (git(['config', '--get', 'push.default']) || 'simple').toLowerCase();
  const colonless = refspecs.some((r) => !deleteMode && !r.replace(/^\+/, '').includes(':'));
  if (mappedPush && (colonless || refspecs.length === 0) && !deleteMode) {
    deny('`remote.' + remoteName + '.push` is configured, so this push may land on a different branch than it names. Push with an explicit `HEAD:refs/heads/<branch>`.');
  }
  if (pushDefault === 'matching' && refspecs.length === 0 && !deleteMode) {
    deny('`push.default=matching` pushes every matching branch. Push the checked-out branch explicitly: `git push origin HEAD:refs/heads/<branch>`.');
  }
  for (let r of refspecs) {
    r = r.replace(/^\+/, '');
    if (r === ':') {
      deny('matching-branch pushes cannot be verified as one code change. Push the explicit checked-out feature branch after its review and gate.');
      continue;
    }
    if (r.startsWith(':')) { del = true; continue; }
    const i = r.indexOf(':');
    const src = i >= 0 ? r.slice(0, i) : r;
    if (!deleteMode) publishesCode = true;
    if (!deleteMode && src !== 'HEAD') {
      const sourceCommit = git(['rev-parse', '--verify', src + '^{commit}']);
      const headCommit = git(['rev-parse', '--verify', 'HEAD^{commit}']);
      if (!sourceCommit || !headCommit || sourceCommit !== headCommit) {
        deny('push source `' + src + '` is not the verified checked-out HEAD (or cannot be resolved). Check out the intended source branch, review and gate it, then push.');
      }
    }
    let d = i >= 0 ? r.slice(i + 1) : r;
    d = d.replace(/^refs\/heads\//, '');
    if (d === 'HEAD') d = currentBranch();
    // push.default=upstream/tracking sends a colon-less branch to its upstream.
    if (i < 0 && src !== 'HEAD' && /^(?:upstream|tracking)$/.test(pushDefault)) {
      const upstream = git(['config', '--get', 'branch.' + src + '.merge']).replace(/^refs\/heads\//, '');
      if (upstream) d = upstream;
    }
    if (d) dsts.push(d);
  }
  if (refspecs.length === 0) {
    const up = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    const d = up ? up.replace(/^[^/]+\//, '') : currentBranch();
    if (d && d !== 'HEAD') dsts.push(d);
  }

  const prod = dsts.find((d) => PROD_BRANCH.test(d));
  if (prod) deny('this push targets `' + prod + '` — CLAUDE.md: push feature branches to the integration branch (staging/develop/dev) via a PR, never main/master/prod/release/*.');

  // Deleting a remote ref publishes no code; retain its separate approval below.
  if (publishesCode) {
    try { gateCheck(); }
    catch (e) { deny('push verification could not be completed. Resolve the missing or unreadable evidence before publishing.'); }
  }

  const integ = dsts.find((d) => INTEGRATION_BRANCH.test(d));
  if (integ) ask('direct push to the integration branch `' + integ + '` bypasses the PR flow');
  if (force) ask('force-push rewrites pushed history (never on a shared branch)');
  if (del) ask('deleting a remote branch');
  if (wide) ask('`--all` / `--mirror` / `--tags` pushes more than this branch');
}

// Outgoing code requires current verification and passing review/gate verdicts.
function gateCheck(base) {
  if (!scan) { deny('verification scanner is unavailable; restore it before publishing.'); return; }
  publishBase = base || null;
  cachedBase = undefined; cachedPaths = undefined;
  const files = pushCodePaths();
  const tp = input.transcript_path;
  if (!tp || !fs.existsSync(tp)) {
    if (files.length > 0) deny('outgoing code has no session verification evidence. Run the review and /gate in this session before pushing.');
    return;
  }
  let r;
  try { r = scan.scanTranscript(tp); } catch (e) { deny('verification transcript could not be read. Re-run review and /gate before pushing.'); return; }
  if (!r) { deny('verification transcript could not be scanned. Re-run review and /gate before pushing.'); return; }
  if (r.lastEdit === -1 && files.length === 0) return;
  const checked = r.completedCheck;
  const root = gitRaw(['rev-parse', '--show-toplevel']).trim().replace(/\\/g, '/').toLowerCase();
  const tree = gitRaw(['rev-parse', 'HEAD^{tree}']).trim();
  if (!checked || r.lastBoundCheck <= r.lastEdit ||
      String(checked.source?.toplevel || '').replace(/\\/g, '/').toLowerCase() !== root ||
      checked.source?.treeBefore !== tree || checked.source?.treeAfter !== tree) {
    deny('publishing requires a completed evidence.mjs check of this repository and the exact outgoing tree. Run the final check through skills/gate/scripts/evidence.mjs; bare output or a written PASS cannot replace it. Commit or ignore unrelated untracked files before checking.');
  }
  const file = r.lastEditPath === '<git>' ? ' (last change: a git merge/reset/switch/stash)' : r.lastEditPath && r.lastEditPath !== '<generated>' ? ' (last edit: ' + path.basename(r.lastEditPath) + ')' : '';
  if (r.lastVerify <= r.lastEdit || r.lastFailedVerify !== -1 || r.lastPendingVerify !== -1) {
    deny('code has missing, failing, or pending verification' + file + '. Complete the checks, collect their results, then run review and /gate. For a malformed command or lost result that cannot be retried, use the recovery procedure in skills/gate/reference/command-evidence.md; never rerun destructive setup just to clear evidence.');
  }
  if (r.lastGate <= Math.max(r.lastEdit, r.lastVerifyResult) || r.lastGateVerdict !== 'PASS') {
    deny('code requires `GATE: PASS` after the last edit and completed verification' + file + '. ' +
         'Run /gate (Definition of Done + security checklist, real quoted output), present the ship brief, get the explicit yes — then push.');
  }
  if (r.lastReview <= r.lastEdit || r.lastReviewVerdict !== 'PASS' || r.lastGate <= r.lastReview) {
    deny('code requires `REVIEW: PASS` after the last edit and before the passing gate' + file + '. ' +
         'Run the independent Claude reviewer (/sanad Step 3.5) on the final source, fix its findings, then re-gate.');
  }
  // The verdict must rest on a real reviewer run: an agent whose prompt starts
  // "You are the independent reviewer", launched (or continued) after the last
  // change and completed before the verdict. A reused review (promotion) instead
  // needs a `git range-diff` equivalence check after the last change.
  const reused = /\breused\b/i.test(r.lastReviewText || '') && r.lastRangeDiff > r.lastEdit;
  if (!reused && (r.lastReviewerRun <= r.lastEdit || r.lastReviewerResult === -1 || r.lastReview <= r.lastReviewerResult)) {
    deny('`REVIEW: PASS` needs a completed independent reviewer run after the last change' + file + '. ' +
         'Launch (or continue) the Sanad Step 3.5 reviewer — its prompt starts "You are the independent reviewer" — collect its finished report, then write the verdict. ' +
         'A promotion that reuses a review labels the verdict "reused" and runs `git range-diff` after the last change.');
  }
  const relational = relationalCodeChanged();
  if (relational && (r.lastProviderRun <= r.lastEdit || r.lastFailedProvider !== -1 || r.lastPendingProvider !== -1 || r.lastGate <= r.lastProviderResult)) {
    deny('code adds ExecuteUpdate/ExecuteDelete, raw SQL or a migration and has no completed real-provider run after the last edit' + file + '. ' +
         'Exercise the affected flow against MySQL (docker exec … mysql, a live API request, or the smoke script), quote it in the gate, then re-review and re-gate. Unrepeatable malformed checks require the documented recovery procedure in skills/gate/reference/command-evidence.md.');
  }
}

// Non-test .cs lines this push changes that only the real provider can prove:
// set-based writes, raw SQL, or migration DDL. InMemory tests never run them.
const RELATIONAL_RE = /\b(ExecuteUpdate|ExecuteDelete|FromSqlRaw|FromSqlInterpolated|FromSql|ExecuteSqlRaw|ExecuteSqlInterpolated|ExecuteSql|SqlQueryRaw|SqlQuery)(Async)?\s*[<(]|\bmigrationBuilder\./;
function relationalCodeChanged() {
  const mb = pushBase();
  if (!mb) return false;
  if (pushCodePaths().some(file => /\.sql$|(?:^|\/)Migrations\//i.test(file))) return true;
  const diff = gitRaw(['diff', '--unified=0', mb, 'HEAD', '--', '*.cs']);
  let file = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('--- ')) { file = line.slice(4).replace(/^a\//, ''); continue; }
    if (line.startsWith('+++ ')) {
      if (line !== '+++ /dev/null') file = line.slice(4).replace(/^b\//, '');
      continue;
    }
    if (!/^[+-]/.test(line) || /^\+\+\+|^---/.test(line)) continue;
    if (!file || /(^|\/)(?:[^/]*Tests?(\.[^/]*)?|tests?)\//.test(file)) continue;
    if (RELATIONAL_RE.test(line)) return true;
  }
  return false;
}

// Check the full branch against its integration merge-base, even after an
// earlier push. Fall back to the upstream only when no integration ref exists.
let publishBase = null, cachedBase, cachedPaths;
function pushBase() {
  if (cachedBase !== undefined) return cachedBase;
  if (publishBase) return cachedBase = gitRaw(['merge-base', 'origin/' + publishBase, 'HEAD']).trim();
  for (const b of ['staging', 'develop', 'dev']) {
    if (git(['rev-parse', '--verify', '--quiet', 'origin/' + b])) return cachedBase = gitRaw(['merge-base', 'origin/' + b, 'HEAD']).trim();
  }
  const base = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!base) return '';
  return cachedBase = gitRaw(['merge-base', base, 'HEAD']).trim();
}

function pushCodePaths() {
  if (cachedPaths) return cachedPaths;
  const base = pushBase();
  if (!base) throw new Error('Missing comparison base.');
  // Inspect both sides of a rename, including code renamed to a non-code suffix.
  // Paths also retain mode-only, empty-file and binary changes with zero text lines.
  const changed = gitRaw(['diff', '--no-renames', '--name-only', '-z', base, 'HEAD']).split('\0').filter(Boolean);
  return cachedPaths = changed.filter(file => {
    // Only positively identified prose is exempt; configuration and executable
    // policy files require the same proof as code, wherever they live.
    if (!/\.(md|txt|rst|adoc)$/i.test(file) || /(?:^|\/)(?:requirements[^/]*\.txt|CMakeLists\.txt|AGENTS\.md|CLAUDE\.md|SKILL\.md)$/i.test(file) || /(?:^|\/)\.(?:claude|github|gitlab)(?:\/|$)/i.test(file)) return true;
    const entries = [base, 'HEAD'].flatMap(ref => gitRaw(['ls-tree', '-z', ref, '--', file]).split('\0').filter(Boolean));
    return !entries.length || entries.some(entry => !entry.startsWith('100644 blob '));
  }).sort();
}

// ---------------------------------------------------------------------------
// gh
// ---------------------------------------------------------------------------

// g: shell-command ghInvocation — { command, sub, args, repo } with inherited
// -R/--repo already removed wherever it appeared.
function checkGh(g, raw) {
  const sub = g.command;
  const act = g.sub === 'new' ? 'create' : g.sub;
  const t = g.args;
  if (g.repo !== null && /^(?:create|edit)$/.test(act)) return deny('cross-repository PR publishing cannot use local evidence. Run gh pr create from the verified repository without --repo.');

  if (sub === 'pr' && act === 'merge') return deny('`gh pr merge` — CLAUDE.md: never merge a PR; promotion is the human\'s call, per action.');
  if (sub === 'pr' && act === 'ready') return ask('marking a PR ready — only after the full gate is green (CLAUDE.md "Draft until proven")');
  if (sub === 'alias' && /^(?:set|import)$/.test(act)) return ask('`gh alias ' + act + '` can hide a merge/release command behind a new name');
  if (sub === 'pr' && (act === 'create' || act === 'edit')) {
    let base = null, draft = false, head = null;
    for (let i = 0; i < t.length; i++) {
      const x = t[i];
      // Option values are data even when they look like another option. In
      // particular, a title/body must never replace the actual head or base.
      if (/^(?:--title|-t|--body|-b|--body-file|-F|--assignee|-a|--label|-l|--milestone|-m|--project|-p|--reviewer|-r|--template|-T|--recover|--add-assignee|--remove-assignee|--add-label|--remove-label|--add-project|--remove-project|--add-reviewer|--remove-reviewer)$/.test(x)) { i++; continue; }
      if (x === '--base' || x === '-B') base = t[++i] || '';
      else if (x.startsWith('--base=')) base = x.slice(7);
      else if (/^-B.+/.test(x)) base = x.slice(2);
      else if (x === '--head' || x === '-H') head = t[++i] || '';
      else if (x.startsWith('--head=')) head = x.slice(7);
      else if (/^-H.+/.test(x)) head = x.slice(2);
      else if (x === '--draft' || x === '-d') draft = true;
    }
    if (act === 'create' && base === null) deny('`gh pr create` without an explicit `--base` — CLAUDE.md: never rely on the default base; pass `--base <integration branch>` (staging/develop/dev).');
    if (base !== null) {
      if (PROD_BRANCH.test(base)) deny('PR base `' + base + '` — CLAUDE.md: PRs target the integration branch only, never main/master/prod/release/*.');
      else if (!INTEGRATION_BRANCH.test(base)) ask('PR base `' + base + '` is not the integration branch (staging/develop/dev)');
    }
    if (act === 'create' && !draft) ask('non-draft PR — CLAUDE.md "Draft until proven": open as DRAFT unless every Definition-of-Done item passed');
    if (act === 'create') {
      try {
        const branch = currentBranch();
        if (!branch || branch === 'HEAD' || (head !== null && head !== branch)) deny('PR head must be the verified checked-out branch.');
        const commit = gitRaw(['rev-parse', '--verify', 'HEAD^{commit}']).trim();
        const upstream = git(['rev-parse', '--verify', '@{u}^{commit}']);
        if (!upstream || upstream !== commit) deny('push the verified branch first; the PR upstream must match the checked-out HEAD.');
        if (base && INTEGRATION_BRANCH.test(base)) gateCheck(base);
        else deny('PR creation requires an explicit integration base (staging/develop/dev) for evidence validation.');
      } catch { deny('PR verification could not be completed. Resolve missing repository or evidence before publishing.'); }
    }
    return;
  }
  if (sub === 'release' && /^(create|delete|upload|edit|delete-asset)$/.test(act)) return deny('`gh release ' + act + '` — CLAUDE.md: never tag/cut a release.');
  if (sub === 'repo' && /^(delete|archive|rename)$/.test(act)) return deny('`gh repo ' + act + '` is destructive and out of scope.');
  if ((sub === 'workflow' && act === 'run') || (sub === 'run' && /^(rerun|cancel)$/.test(act))) return ask('triggering/cancelling a workflow run can deploy');
  if (sub === 'api') return checkGhApi(t, raw);
}

function checkGhApi(t, raw) {
  let method = 'GET', endpoint = '';
  for (let i = 0; i < t.length; i++) {
    const x = t[i];
    if (x === '-X' || x === '--method') method = (t[++i] || '').toUpperCase();
    else if (/^-X.+/.test(x)) method = x.slice(2).replace(/^=/, '').toUpperCase();
    else if (x.startsWith('--method=')) method = x.slice(9).toUpperCase();
    else if (/^(-f|-F|--field|--raw-field|--input)$/.test(x)) { if (method === 'GET') method = 'POST'; i++; }
    else if (/^-[fF].+/.test(x)) { if (method === 'GET') method = 'POST'; }
    else if (/^--(field|raw-field|input)=/.test(x)) { if (method === 'GET') method = 'POST'; }
    else if (/^(-H|--header|-q|--jq|-t|--template|--hostname|-p|--preview|--cache)$/.test(x)) i++;
    else if (!x.startsWith('-') && !endpoint) endpoint = x;
  }
  if (/^graphql$/i.test(endpoint)) {
    if (/createPullRequest/i.test(raw) || /(?:--input|query=@)/i.test(raw)) return deny('create pull requests through the evidence-checked gh pr create command.');
    if (/mergePullRequest|enablePullRequestAutoMerge|createRelease|deleteRef|deleteBranch|updateRefs?\b/i.test(raw)) return deny('GraphQL mutation that merges, releases, moves or deletes refs — never from Claude.');
    // A query held in a variable or file cannot be inspected here.
    for (let i = 0; i < t.length; i++) {
      const field = /^(?:-f|-F|--field|--raw-field)$/.test(t[i]) ? t[i + 1] : (/^--(?:field|raw-field)=/.test(t[i]) ? t[i].slice(t[i].indexOf('=') + 1) : null);
      if (field && /^query=/i.test(field) && /[$@`%]/.test(field.slice(6))) return deny('`gh api graphql` with a query taken from a variable or file cannot be checked — pass the literal query text.');
    }
    if (/\bmutation\b/i.test(raw)) return ask('GraphQL mutation via `gh api graphql`');
    return;
  }
  if (method === 'GET') return;
  if (/\/pulls\/?(?:\?|$)/i.test(endpoint)) return deny('create pull requests through the evidence-checked gh pr create command.');
  if (/\/merges?\b/i.test(endpoint)) return deny('`gh api` on a merge endpoint — CLAUDE.md: never merge.');
  if (/\/releases\b/i.test(endpoint)) return deny('`gh api` on a releases endpoint — CLAUDE.md: never cut a release.');
  if (/\/git\/refs\b/i.test(endpoint)) return deny('`gh api ' + method + '` on git refs can move or delete a branch — never from Claude.');
  if (method === 'DELETE') return ask('`gh api DELETE ' + endpoint + '`');
  if (/\/(dispatches|deployments)\b/.test(endpoint)) return ask('`gh api ' + method + ' ' + endpoint + '` can trigger a deploy');
  ask('mutating `gh api ' + method + ' ' + endpoint + '`');
}

// ---------------------------------------------------------------------------
// docker / rm / Remove-Item / dotnet ef / raw SQL
// ---------------------------------------------------------------------------

function checkDocker(seg) {
  const t = tokenize(seg).map((x) => x.toLowerCase());
  const isCompose = t[0].startsWith('docker-compose') || t[1] === 'compose';
  const hasVol = t.some((x) => /^(-v|--volumes)$/.test(x));
  if (isCompose) {
    const start = t[0].startsWith('docker-compose') ? 1 : 2;
    let sub = '';
    for (let i = start; i < t.length; i++) {
      if (/^(-f|--file|-p|--project-name|--env-file|--profile|--project-directory)$/.test(t[i])) { i++; continue; }
      if (t[i].startsWith('-')) continue;
      sub = t[i]; break;
    }
    if (sub === 'down' && hasVol) ask('`docker compose down -v` deletes the named volumes (local DB data)');
    if (sub === 'rm' && hasVol) ask('`docker compose rm -v` deletes anonymous volumes');
    if (sub === 'exec') checkSql(seg);
    return;
  }
  if (t[1] === 'volume' && /^(prune|rm|remove)$/.test(t[2] || '')) ask('deleting docker volumes destroys local DB data');
  if (t[1] === 'system' && t[2] === 'prune') ask('`docker system prune` is a mass delete');
  if (t[1] === 'push') ask('`docker push` publishes an image — staging auto-pulls from GHCR, so this is a deploy outside CI');
  if (t[1] === 'rm' && hasVol) ask('`docker rm -v` deletes the container\'s volumes');
  if (t[1] === 'exec') checkSql(seg);
}

// rec: a shell-command segment record. Recursive deletes of anything other than
// disposable output ask; catastrophic targets deny. Any doubt (unresolvable path,
// link/junction, pattern-driven delete, git unreadable) asks.
function checkDelete(rec) {
  let tokens = rec.tokens, recursive = false;
  const p = rec.program;
  if (p === 'npx' || p === 'rimraf') {
    if (p === 'npx') { if (String(rec.args[0] || '').toLowerCase() !== 'rimraf') return; tokens = rec.args; }
    recursive = true;
  } else if (p === 'rm') {
    recursive = tokens.slice(1).some((x) => /^-[a-zA-Z]*[rR][a-zA-Z]*$|^--recursive$/.test(x) || PS_RECURSE.test(x));
  } else if (/^(?:remove-item|ri|del|erase|rd|rmdir)$/.test(p)) {
    const slashS = tokens.some((x) => /^\/s$/i.test(x));
    if (SHELL_OPTS.tool === 'Bash' && !rec.nested && (p === 'rmdir' || p === 'rd') && !slashS) return;   // coreutils rmdir: empty dirs only
    recursive = slashS || tokens.slice(1).some((x) => PS_RECURSE.test(x));
  } else return;
  if (!recursive) return;

  const targets = [];
  let pattern = false;
  for (let i = 1; i < tokens.length; i++) {
    const x = tokens[i];
    if (/^-(?:path|literalpath)$/i.test(x)) { if (tokens[i + 1] !== undefined) targets.push(tokens[++i]); continue; }
    if (/^-(?:include|exclude|filter)$/i.test(x)) { pattern = true; i++; continue; }
    if (/^-(?:stream|credential)$/i.test(x)) { i++; continue; }
    if (x === '--' || x.startsWith('-')) continue;
    if (/^\/[a-z]$/i.test(x) && /^(?:rd|rmdir|del|erase)$/.test(p)) continue;   // cmd switches (/s /q); in Git Bash /c is drive C
    targets.push(x);
  }
  const boom = targets.find((x) => CATASTROPHIC.test(x));
  if (boom) return deny('recursive delete of `' + boom + '` — catastrophic target.');
  const resolved = targets.map((x) => shell.shellPath(x, rec.cwd, SHELL_OPTS));
  const root = resolved.find((r) => r && catastrophicPath(r));
  if (root) return deny('recursive delete of `' + root + '` — catastrophic target.');
  if (pattern || !targets.length) return ask('recursive delete of ' + (targets.join(' ') || '(unparsed target)') + ' with a pattern or unparsed target — mass file delete');
  const unsafe = targets.find((x, i) => !disposable(resolved[i], rec.cwd));
  if (unsafe !== undefined) ask('recursive delete of `' + unsafe + '` — only untracked build output inside the current directory, or the temp folder, is exempt from confirmation');
}

function samePath(a, b) { return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase(); }
function inside(child, parent) {
  const c = path.resolve(child).toLowerCase(), p = path.resolve(parent).toLowerCase();
  return c !== p && c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}
function catastrophicPath(r) {
  const home = SHELL_OPTS.home;
  return /^[A-Za-z]:\\?$/.test(r) || (home && (samePath(r, home) || samePath(r, path.dirname(home)))) || (SHELL_OPTS.tmp && samePath(r, SHELL_OPTS.tmp));
}
function disposable(target, base) {
  if (!target) return false;
  try {
    if (fs.lstatSync(target).isSymbolicLink()) return false;          // symlinks and junctions: the delete could follow them
    if (!samePath(fs.realpathSync.native(target), target)) return false;
  } catch (e) { return false; }                                       // missing or unreadable: never assume harmless
  if (SHELL_OPTS.tmp && inside(target, SHELL_OPTS.tmp)) return true;
  if (!base || !inside(target, base) || !GENERATED_DIR.test(path.basename(target))) return false;
  try {
    return execFileSync('git', ['ls-files', '-z', '--', target], { cwd: base, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000, windowsHide: true }) === '';
  } catch (e) { return /not a git repository/i.test(String(e.stderr || '')); }   // tracked content is never build output
}

// Package managers: publishing and new dependencies need the human (CLAUDE.md),
// whatever the executable spelling (npm.cmd, quoted paths, node …/npm-cli.js).
const PM_VALUE_OPTS = /^(?:--registry|--workspace|-w|--prefix|--cache|--userconfig|--tag|--save-prefix|--omit|--include|--install-strategy|--otp|--access|-C|--cwd|--dir|--filter|-F|--index-url|-i|--extra-index-url|-r|--requirement|-c|--constraint|--target|-t)$/;
function positionals(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (PM_VALUE_OPTS.test(args[i])) { i++; continue; }
    if (!String(args[i]).startsWith('-')) out.push(String(args[i]));
  }
  return out;
}
function checkPackageManager(rec) {
  const p = rec.program, lower = rec.args.map((a) => String(a).toLowerCase());
  if (/^(?:npm|pnpm|yarn|bun)$/.test(p)) {
    if (lower.some((a) => /^(?:publish|unpublish|deprecate)$/.test(a))) return ask('publishing/unpublishing a package');
    const [verb, ...packages] = positionals(rec.args);
    const v = String(verb || '').toLowerCase();
    if (v === 'add' || (/^(?:install|i|in|ins|inst|insta|instal|isnt|isnta|isntal|isntall)$/.test(v) && packages.length))
      return ask('adding a dependency (`' + p + ' ' + rec.args.join(' ') + '`) — CLAUDE.md: no new dependencies without asking');
    return;
  }
  if (p === 'dotnet') {
    if (lower.includes('nuget') && lower.includes('push')) return ask('publishing a package');
    const pos = positionals(rec.args).map((a) => a.toLowerCase());
    if ((pos[0] === 'add' && pos.includes('package')) || (pos[0] === 'package' && pos[1] === 'add'))
      return ask('adding a NuGet dependency — CLAUDE.md: no new dependencies without asking');
    return;
  }
  const viaPython = /^(?:python3?|py)$/.test(p) && lower[0] === '-m' && /^pip3?$/.test(lower[1] || '');
  if (/^pip3?$/.test(p) || viaPython) {
    const pos = positionals(viaPython ? rec.args.slice(2) : rec.args);
    if (String(pos[0] || '').toLowerCase() === 'install' && pos.length > 1) return ask('installing a Python package — CLAUDE.md: no new dependencies without asking');
  }
}

function checkEf(seg) {
  const t = tokenize(seg).map((x) => x.toLowerCase());
  const i = t.indexOf('ef');
  const area = t[i + 1] || '', verb = t[i + 2] || '';
  if (area === 'database' && verb === 'drop') return ask('`dotnet ef database drop` destroys the database');
  if (area === 'migrations' && verb === 'remove') return ask('`dotnet ef migrations remove` — CLAUDE.md: never remove/down an applied migration without confirmation');
  if (area === 'database' && verb === 'update') {
    const target = t.slice(i + 3).find((x) => !x.startsWith('-') && !/^(--|-)/.test(x));
    if (target !== undefined && !/^--/.test(target)) ask('`dotnet ef database update ' + target + '` targets a specific migration — that can run Down() on applied migrations');
  }
}

function checkSql(seg) {
  const s = String(seg);
  if (/\b(DROP\s+(TABLE|DATABASE|SCHEMA|INDEX)|TRUNCATE(\s+TABLE)?\s+\S+|ALTER\s+TABLE\s+\S+\s+DROP)\b/i.test(s)) return ask('destructive SQL (DROP/TRUNCATE/ALTER…DROP) sent to a database');
  const del = /\bDELETE\s+FROM\s+\S+([^;"']*)/i.exec(s);
  if (del && !/\bWHERE\b/i.test(del[1])) return ask('`DELETE FROM` without WHERE sent to a database');
  const upd = /\bUPDATE\s+\S+\s+SET\b([^;"']*)/i.exec(s);
  if (upd && !/\bWHERE\b/i.test(upd[1])) return ask('`UPDATE … SET` without WHERE sent to a database');
}

// ---------------------------------------------------------------------------
// Walk every segment; deny outranks ask; first reason of the winning kind wins.
// ---------------------------------------------------------------------------

function checkTypeScriptProject(seg, directory) {
  if (!scan) return; // Publishing fails closed in gateCheck when a module is missing.
  const { invalidVerificationTarget, isInspection } = require(path.join(__dirname, 'lib', 'verification-target.cjs'));
  const tokens = tokenize(seg);
  if (isInspection(tokens.slice(1))) return;
  const reason = invalidVerificationTarget(tokens[0], tokens.slice(1), directory);
  if (reason) deny(reason);
}

try {
  const records = shell.parseCommand(cmd, { ...SHELL_OPTS, cwd });
  for (const rec of records) {
    if (!rec.tokens.length) continue;
    checkTypeScriptProject(rec.text, rec.cwd || cwd);

    if (rec.git) {
      const g = rec.git;
      gitCwd = g.cwd || cwd; _branch = undefined;
      // A push whose repository cannot be resolved cannot be verified: deny.
      if (g.sub === 'push' && !g.certain) { deny('this push cannot be checked (' + g.why + '). Run plain `git push` from the repository directory, as its own command.'); continue; }
      checkGit(g);
      continue;
    }
    if (rec.gh) { gitCwd = rec.cwd || cwd; _branch = undefined; checkGh(rec.gh, rec.text); continue; }

    const p = rec.program;
    if (p === 'docker' || p === 'docker-compose') { checkDocker(rec.text); continue; }
    if (/^(?:rm|rmdir|rd|del|erase|remove-item|ri|rimraf|npx)$/.test(p)) { checkDelete(rec); if (p !== 'npx') continue; }
    if (p === 'dotnet' && String(rec.args[0] || '').toLowerCase() === 'ef') { checkEf(rec.text); continue; }
    if (/^(?:mysql|mysqlsh|psql|sqlcmd|sqlite3)$/.test(p)) { checkSql(rec.text); continue; }
    checkPackageManager(rec);
  }
} catch (e) {
  // A parser/check failure on a guarded action must not fall through to allow.
  if (verdict) emit(verdict.d, verdict.r);
  const hits = shell.tripwire(cmd);
  if (hits.has('push') || hits.has('gh-merge') || hits.has('gh-release') || hits.has('publish')) emit('deny', 'Blocked by policy-guard: the command could not be checked (' + String(e && e.message || e).slice(0, 120) + '). Split it into simple commands and retry.');
  if (hits.has('delete')) emit('ask', 'policy-guard: this delete could not be checked — confirm it manually.');
  allow();
}

if (verdict) emit(verdict.d, verdict.r);
allow();
