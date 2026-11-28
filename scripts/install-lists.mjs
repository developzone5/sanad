#!/usr/bin/env node
// install-lists.mjs — which install steps a change needs, and which suite failures are only a clock under load.
//
// 2026-11-28 (owner, batch b task 4): every install took 13 to 15 minutes, whatever changed: the proof on the test
// machine, the replay of about 34,000 past commands, then the hook suite and the gate suite one after the other. These
// lists, in this one file, decide what the installer may leave out. The rules:
//   - The proof on the test machine runs when a changed file is one the proof or the test machine uses (PROOF_FILES,
//     PROOF_PREFIXES).
//   - The replay runs when a changed file is under hooks/ or is one the replay reads (REPLAY_PREFIXES).
//   - A changed file on no list (not a proof file, not a replay file, not on NEITHER) means every step runs, as before.
//     When unsure, it runs. The installer and this file themselves always mean every step runs (ALWAYS_ALL).
//   - No suite is ever left out: both suites run on every install, at the same time.
//   - TIME_LIMIT_TESTS: the few test files with a wall-clock limit that can fail only because both suites share the
//     machine. A suite that failed only in those files runs those files again, alone; any other failing test is a real
//     failure and the install rolls back.
// Paths are the candidate's: claude/... (mirrors ~/.claude), agents/skills/..., codex/...
//
//   node install-lists.mjs decide <file with one changed path per line>   prints E2E=run|skip and REPLAY=run|skip, each with why
//   node install-lists.mjs retry <suite log> <suite: hooks|gate>          prints the files to run again alone, or NONE
//   node install-lists.mjs concurrency <hooks|gate> [<cores>]              prints the --test-concurrency of that suite
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const GATE = 'claude/skills/gate/scripts/';
// Every script the proof copies to the test machine and loads there: red-proof.mjs and each file it imports, as
// red-proof.mjs proofScripts() follows them, plus the ones it loads with import(). A test keeps this list equal to them.
// Review (batch b): and the hook files those scripts and the test machine's scripts load with require (size-check.mjs
// loads code-paths.cjs, remote-busy.mjs loads process-start.cjs, note-check.mjs loads the scanner and what it requires).
export const PROOF_FILES = [
  ...['change-set.mjs', 'check-ticket-lines.mjs', 'git-bash.mjs', 'is-main.mjs', 'kept.mjs', 'new-lines.mjs', 'note-check.mjs', 'proof-record.mjs',
    'proof-select.mjs', 'red-proof.mjs', 'run-record.mjs', 'size-check.mjs', 'stack.mjs', 'test-machine-lock.mjs', 'test-names.mjs', 'ts-parser.mjs'].map((n) => GATE + n),
  ...['code-paths.cjs', 'process-start.cjs', 'transcript-scan.js', 'verification-target.cjs', 'shell-command.cjs', 'session-root.cjs'].map((n) => 'claude/hooks/lib/' + n),
];
// The test machine's own scripts (the sync, the preflight, the launch and wait helpers).
export const PROOF_PREFIXES = ['claude/scripts/remote/'];
// Everything under hooks/ (the replay loads hooks/lib/transcript-scan.js and what it requires) and the replay itself.
export const REPLAY_PREFIXES = ['claude/hooks/', 'claude/scripts/replay/'];
// The installer and these lists: a change here runs every step.
export const ALWAYS_ALL = ['claude/scripts/workflow-install.sh', 'claude/scripts/install-lists.mjs'];
// Files known to need neither the proof on the test machine nor the replay. Both suites still run.
export const NEITHER = [
  /^claude\/skills\/[^/]+(?:\/[^/]+)*\/[^/]+\.md$/,          // skill pages and their references
  /^claude\/skills\/gate\/tests\/[^/]+$/,                     // the gate suite's own tests
  /^claude\/skills\/gate\/reviewer-cases\//,                  // the reviewer seats' fixed cases
  /^claude\/skills\/gate\/scripts\/[^/]+\.mjs$/,              // a gate script that is not a proof file (checked first)
  /^claude\/agents\/[^/]+\.md$/,                              // agent files
  /^claude\/CLAUDE\.md$/, /^claude\/output-styles\/[^/]+\.md$/,
  /^agents\/skills\//,                                        // the ~/.agents mirrors
  /^codex\//,                                                 // the Codex config and roles
];
// The tests with a wall-clock limit that two suites at once can push past (2026-11-25: sanad.test.mjs failed at 1.4 s
// under load and passed at 0.65 s alone). Short on purpose. Review (batch b): each one is named by its file, its title
// and the words of its time assertion; a failure counts as the clock only when all three match. Any other failure, also
// another assertion of the same test, is a real failure.
export const TIME_LIMIT_TESTS = [
  { file: 'claude/skills/gate/tests/sanad.test.mjs', title: 'next answers in under 1 second on a repository with 1,500 untracked files, and reads no proof for it', timing: /AssertionError[^\n]*: next took \d+ ms/ },
  { file: 'claude/skills/gate/tests/change-set.test.mjs', title: 'a folder with 1,500 untracked files: a FOREIGN? answer in under 2 seconds that names the folder once', timing: /AssertionError[^\n]*: took \d+ ms/ },
  { file: 'claude/skills/gate/tests/pre-review-stream.test.mjs', title: 'three checks of 0.1 s, 1 s and 3 s print their lines at those times, and the summary comes last', timing: /AssertionError[^\n]*: the (?:0\.1 s check is printed when it ends, not with the slow ones|1 s check at about 1 s): \d+ ms/ },
  { file: 'claude/skills/gate/tests/pre-review-stream.test.mjs', title: 'an instant failure is printed at once, with its lines, while a slow check still runs', timing: /AssertionError[^\n]*: printed long before the slow check ends: / },
  { file: 'claude/skills/gate/tests/notes-dir.test.mjs', title: 'a lock left by a dead process is taken over; an unsigned or very old one only when it is old enough', timing: /AssertionError[^\n]*: no wait for a writer that is gone/ },
  { file: 'claude/skills/gate/tests/test-machine-lock.test.mjs', title: 'two proofs share the machine (the server\'s and the page\'s), and another host is never waited for', timing: /AssertionError[^\n]*: a second proof waited/ },
  { file: 'claude/hooks/tests/scan-incremental.test.mjs', title: 'a large transcript is read in pieces and a later call reads only the new part fast', timing: /AssertionError[^\n]*: a later call took \d+ ms/ },
];

const norm = (f) => String(f || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
const isProof = (f) => PROOF_FILES.includes(f) || PROOF_PREFIXES.some((p) => f.startsWith(p));
const isReplay = (f) => REPLAY_PREFIXES.some((p) => f.startsWith(p));

/** What the change needs: { e2e: { run, why }, replay: { run, why }, onNoList: [...] }. */
export function decide(changedFiles) {
  const files = [...new Set((changedFiles || []).map(norm).filter(Boolean))];
  const always = files.filter((f) => ALWAYS_ALL.includes(f));
  const onNoList = files.filter((f) => !ALWAYS_ALL.includes(f) && !isProof(f) && !isReplay(f) && !NEITHER.some((re) => re.test(f)));
  if (!files.length) return { e2e: { run: true, why: 'no changed file was named, so every step runs' }, replay: { run: true, why: 'no changed file was named, so every step runs' }, onNoList };
  if (always.length) { const why = `${always[0]} changed, so every step runs`; return { e2e: { run: true, why }, replay: { run: true, why }, onNoList }; }
  if (onNoList.length) { const why = `${onNoList[0]} is on no list (${onNoList.length} such file(s)), so every step runs`; return { e2e: { run: true, why }, replay: { run: true, why }, onNoList }; }
  const proof = files.filter(isProof), replay = files.filter(isReplay);
  return {
    e2e: proof.length ? { run: true, why: `${proof[0]} is used by the proof or the test machine` } : { run: false, why: 'no changed file is used by the proof or the test machine' },
    replay: replay.length ? { run: true, why: `${replay[0]} is under hooks/ or read by the replay` } : { run: false, why: 'no changed file is under hooks/ or read by the replay' },
    onNoList,
  };
}

// The failing tests of a spec-reporter log: [{ file, title, text }], one per block of the "failing tests:" part, each
// from its `test at <file>:<line>:<col>` line and the `✖ <title> (<n>ms)` line under it. null when the part is missing,
// a failure has no such lines, or the count differs from the run's own `ℹ fail <n>` (review, batch b: a log cut short).
export function failingTests(log) {
  const text = String(log || '').replace(/\r\n/g, '\n');
  const at = text.indexOf('\n✖ failing tests:');
  if (at < 0) return null;
  const summary = [...text.matchAll(/^ℹ fail (\d+)\s*$/gm)].map((m) => Number(m[1]));
  if (summary.length !== 1 || !(summary[0] > 0)) return null;
  const part = text.slice(at + 1);
  const heads = (part.match(/^✖ /gm) || []).length - 1;   // the heading itself is one
  const blocks = part.split(/\n(?=test at )/).slice(1);
  const out = [];
  for (const b of blocks) {
    const m = /^test at (.+?):\d+:\d+\n✖ (.+?) \(\d+(?:\.\d+)?m?s\)\n/.exec(b);
    if (!m) return null;
    out.push({ file: m[1].replace(/\\/g, '/'), title: m[2], text: b });
  }
  if (!out.length || out.length !== heads || out.length !== summary[0]) return null;
  return out;
}

/** The files of a failed suite to run again alone, as paths in its tests folder, or null when any failure is real. */
export function retryFiles(log, suite) {
  const failed = failingTests(log);
  if (!failed) return null;
  const folder = suite === 'hooks' ? 'claude/hooks/tests/' : 'claude/skills/gate/tests/';
  const names = [];
  for (const f of failed) {
    const name = f.file.replace(/^.*?tests\//, '');
    const named = TIME_LIMIT_TESTS.find((t) => t.file === folder + name && t.title === f.title);
    if (!named || !named.timing.test(f.text)) return null;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** The --test-concurrency of a suite when both run at once: the hook suite gets 2 slots, the gate suite the rest. */
export function concurrency(suite, cores) {
  const n = Math.max(2, Number.isFinite(cores) && cores > 0 ? Math.floor(cores) : 4);
  return suite === 'hooks' ? 2 : Math.max(1, n - 2);
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === fs.realpathSync(process.argv[1]).toLowerCase()) {
  const [cmd, a, b] = process.argv.slice(2);
  try {
    if (cmd === 'decide') {
      const d = decide(fs.readFileSync(a, 'utf8').split('\n'));
      process.stdout.write(`E2E=${d.e2e.run ? 'run' : 'skip'}\t${d.e2e.why}\nREPLAY=${d.replay.run ? 'run' : 'skip'}\t${d.replay.why}\n`);
    } else if (cmd === 'retry') {
      const r = retryFiles(fs.readFileSync(a, 'utf8'), b);
      process.stdout.write(r ? r.join('\n') + '\n' : 'NONE\n');
    } else if (cmd === 'concurrency') {
      process.stdout.write(String(concurrency(a, b ? Number(b) : (os.availableParallelism ? os.availableParallelism() : os.cpus().length))) + '\n');
    } else { process.stderr.write('usage: install-lists.mjs decide <file> | retry <log> <hooks|gate> | concurrency <hooks|gate> [<cores>]\n'); process.exitCode = 2; }
  } catch (e) { process.stderr.write('install-lists: ' + String(e && e.message) + '\n'); process.exitCode = 2; }
}
