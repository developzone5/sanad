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
//   fix round  (--breaks <json> --changed-since <git ref>, 2026-11-16: in a fix round of a big task every re-proof
//              ran all 48 breaks, about 15 minutes, though each fix touched one or two files; four rounds lost
//              about an hour): only the breaks the change since <ref> can reach run; the old code and green run
//              as usual. It says RED-PROOF: PARTIAL, never PROVED, and never writes the proof's own entry (it saves
//              the result of each break it ran, see below): run the full proof (without --changed-since) once
//              before the final review.
//
// Why a script: a red run typed as a plain test command is kept as a failed check by the push
// guard forever, and a hand-written "swap; test; restore" compound can never be re-run green.
// Exit 0 = every requested proof held (each failing test named, with its reason), 1 = NOT RED,
// a break the tests did not catch, an invalid break, or a red green run; 2 = usage or restore problem,
// or the run was stopped (Ctrl-C, SIGTERM, Ctrl-Break: files restored); 3 = SETUP (a
// test failed for a setup reason: element not found, type or build error, timeout; or the fixed tree
// does not compile. After a passing green run, an element not found on the old code or under a break
// is the product's failure, caught, not SETUP: green found it with the same query); 4 = REMOTE-DOWN
// (the test machine does not answer); 5 = TIMEOUT (a run passed
// --timeout-min: it and every process it started were stopped, files restored, the run named);
// 6 = ENVIRONMENT (a run failed on the database or the test host, not on the tests).
//
// What counts (2026-11-12, after an audit found proofs that read PROVED on a stopped database):
//   - A run that failed on the environment (no database connection, a crashed test host, out of
//     memory) proves nothing either way: the proof stops with ENVIRONMENT, exit 6.
//   - The old code is normally RED when a named test fails. It can also be red by build when green
//     passes and every compiler error is a test using a new name absent from the old code. A build
//     failure proves a test only with a caught break that names it (2026-11-20).
//   - A break is caught only when every test a mustFail part names fails, matched by the test's own
//     title (vitest: the last part of "file > describe > test"; dotnet: the method or DisplayName),
//     and every test in the changed test files whose title holds that part fails. A break that does
//     not compile or run (ReferenceError, SyntaxError, "is not defined", a compiler error) or changes
//     nothing is BREAK INVALID.
//   - A mustFail part whose words are in the title of a test this change added AND of an older test is
//     BREAK AMBIGUOUS (2026-11-14): refused before any run, exit 2. A part may name older tests alone.
//   - A new "nothing happens" check (check-test-asserts.mjs) in a test file this command runs, where no break
//     names the test that holds it, is UNPROVEN: refused before any run, exit 2 (2026-11-15; by test and not by
//     file since 2026-11-17: one caught test certified another rule's check in the same file). Pre-review counts
//     such a check only from a break run that caught a break naming its own test; the old code never counts.
//     --old with no --breaks is refused the same way; one --break is not checked (see the refusal in main).
//   - --files may not name a test file; product files left out of it are named in a WARNING.
//   - --log is emptied when the run starts and written however it ends; its first line names the tree.
//
// Usage:
//   node ~/.claude/skills/gate/scripts/red-proof.mjs --repo <path> [--old <git-ref> --files <a,b>]
//        [--breaks <json> [--changed-since <git ref>]] [--then-green] [--base <ref>] [--cwd <dir>] [--log <file>]
//        [--parallel <n>] [--timeout-min <n>] [--test-env <path>] [--local] [--show-remote] -- <executable> [args...]
//   node ~/.claude/skills/gate/scripts/red-proof.mjs --repo <path> --break <file> --find <text> --put <text>
//        [--cwd <dir>] [--log <file>] [--timeout-min <n>] [--test-env <path>] -- <executable> [args...]
//   node ~/.claude/skills/gate/scripts/red-proof.mjs --repo <path> --warm [--parallel <n>] [--cwd <dir>] -- <test command>
//   node ~/.claude/skills/gate/scripts/red-proof.mjs --restore <backup-dir>
//   node ~/.claude/skills/gate/scripts/red-proof.mjs --repo <path> --drop-copies
// --check-plan (2026-11-19, with the proof's own options and command): only the checks that come before any run
//   (each break filled in, each find matches once, no AMBIGUOUS part, no UNPROVEN check, every mustFail part names a
//   test). It ends with the line `PLAN OK` (exit 0) or the refusal (exit 2); no test machine, no copy, no log, no record.
// --strict-tests (2026-11-19): a new test that is red on no old code and named by no caught break fails the proof (its row
//   TEST NOT PROVEN is always printed).
// --fresh (2026-11-19): run every break again; without it a local run skips the breaks this exact tree already
//   caught (it says RESUMED k of n breaks from saved results of this tree).
// --at <commit> (2026-11-19): the proof is for that commit. It is refused before any run when HEAD is another
//   commit or the work tree differs from it (the sync to the test machine sends the working tree).
// A usage refusal (a bad option, an unknown ref, --at not met, FOREIGN? files) ends with the exact last line
//   `RED-PROOF: REFUSED — nothing ran`, exit 2. A passing green run that ran no test reads `GREEN ✗ no test ran`.
// --breaks file: [{ "name": "...", "file": "<repo-relative>", "find": "<exact text, once>",
//   "put": "<replacement>", "mustFail": ["<part of a test's own title>", ...] }, ...]
//   A mustFail part may come from a test's method name or from its xUnit DisplayName, never from a
//   describe block or a file name; every test in the changed test files whose title holds it must fail.
//   A tag shared with older tests ("[C1]" of an earlier ticket) is refused: name each test by its own words.
//   The find text may be written with LF or CRLF line endings; it matches either.
// --changed-since <git ref> (only with --breaks; a commit, a branch or a tree id such as a proof log's first line
//   names): a break runs when its file differs between <ref> and the working tree (untracked files count), or when
//   a mustFail part names a test in a test file that differs (a declared title holds the part, or the file's text). Before
//   any run: "RED-PROOF: PARTIAL — <k> of <n> break(s) changed since <ref>: <names>; the others are not run." At the
//   end: "RED-PROOF: PARTIAL ✓ — <k> of <n> break(s) caught …" with exit 0, or the usual failure and exit code. No
//   break changed is allowed: the old code and green still run (with neither asked, nothing runs, exit 0). The
//   breaks are checked whole first (each matches once, no ambiguous or unproven part). The run record holds
//   `partial: true`; the proof's entry in the record is left as it is. On the test machine only the kept breaks are sent.
// --old with a fix file that only adds lines, and adds names the tests use (a new message, a new
// constant): that file stays at the fix for the old-code run, so the old code compiles; the run says so.
// 2026-11-20: a related file may hide the fix. Keep it only if its diff also just adds lines.
// The tests are read as code: a name only a comment or a string's text holds is not a use (2026-11-15).
// --warm: at the task's start, the kept copies (below) are brought to the tree and built once.
// A passing --breaks run records, under its command and folder, the tests its breaks made fail (each by its
// test file, its title and the full name the runner printed), the files its breaks changed, and one id of the
// code under test (see proof-record.mjs); pre-review's test check reads that record. A --breaks run that starts
// and does not end PROVED leaves that entry as not ok, with the reason (2026-11-17: an older success outlived a
// failed re-proof); a --changed-since run does so only when one of its own runs failed. A run with no --breaks
// (old code only, one --break) leaves the record alone.
// One result per break (2026-11-19: every result was read after all runs, so a stop or one run past the limit lost
// the finished breaks): a run here (--local, or no test machine) judges each break when its own run ends and saves
// its result at once (proof-record.mjs writeBreakResult: caught, not-caught, invalid or timeout, for the exact code
// tree the runs test), and saves that the passing run passed on that tree (writeRunFacts). A machine or database
// failure (exit 6) takes back what its run saved (takeBackRun). On the test machine nothing is stored: a caught
// break's RED-PROOF-CAUGHT line goes out when its run ends. THE LIMITS that stay: the machine that asked still
// writes its record only when the whole proof there ends, and a second start still runs every break again.
// The test command runs without a shell and without typed input; pass the real
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
// a run stopped at the time limit drops its copy. Build once (2026-11-13: each sync to the test machine
// is a new commit, and the SDK writes the commit id into every assembly, so every copy recompiled every
// project at every proof, about 5 minutes a copy): a dotnet run in a copy builds without the commit id
// (copyRunEnv); dotnet runs go only to copies that built before (the first, which the compile check
// builds, and those an earlier proof or --warm built), one run after another in each, so each run
// compiles only what its change touched; a copy that never built sits out. Other commands never take
// a copy a dotnet command built. --drop-copies deletes the kept copies (on the test
// machine, run it there).
//
// Compile check (2026-11-09: a missing `using` failed all 6 copies after full builds): a `dotnet test`
// command first runs once with --list-tests on the fixed tree (in the first copy, which stays warm);
// a build error stops there with the compiler lines (SETUP, exit 3), before any run starts.
//
// --timeout-min <n> (default 15, decimals allowed): the limit for each run and for the compile check.
// A stuck run stops sooner (2026-11-15): once two red runs have finished in their own copies, a red run still
// going at twice the slowest of them (never under a fifth of the limit) is stopped and named stuck (exit 5).
// The database (2026-11-20, skipped tests passed before Docker was ready): start it beside the compile
// check and green run. Before it is ready, only passing green with zero skips can start the red runs.
// Otherwise wait, then run green again. If the database stays down, stop with ENVIRONMENT, exit 6.
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
// mode hands a run to the test machine: { old: [{ file, content64|null }], oldLabel, breaks, green,
// commit, testFiles, partial }. `partial` ({ ref, of }, 2026-11-16) marks a --changed-since run: the machine there
// says PARTIAL, not PROVED. `commit` is the commit the sync made (2026-11-12: the proof there read HEAD again
// after the sync, and a second sync in between moved it); the copies are that commit and nothing else.
// The proof record is written by the machine that asked (2026-11-17): for each caught break the test machine
// prints one `RED-PROOF-CAUGHT: <base64 JSON>` line, the failing tests as its runner named them; the machine that
// asked reads it (it is not shown) and matches the names to its own test files. Its code id is taken before the
// sync, and after the sync the working tree must still be the tree the sync sent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { createInterface } from 'node:readline';
import { breakId, breakStates, canonicalTop, changedTestFiles, codeFingerprint, csClassList, declaredTests, defaultBase, enclosingTest, helperCallers, namedBy, proofHint, provenHas, provenTests, readRecord, recordKey, takeBackRun, testFileHashes, testSpans, withdrawRunFacts, writeBreakResult, writeEntry, writeRunFacts } from './proof-record.mjs';
import { TEST_FILE } from './check-ticket-lines.mjs';
import { newLines, nothingChecks } from './new-lines.mjs';
import { codeLines, codeOnly } from './size-check.mjs';
import { isMain } from './is-main.mjs';
import { keepRunRecord } from './run-record.mjs';
import { bashEnv, gitBash } from './git-bash.mjs';
import { selectCommand } from './proof-select.mjs';
import { changeSet, foreignLine } from './change-set.mjs';

// Why each test failed (2026-11-06). An assertion about behavior proves the code is wrong. A
// missing element, a type, reference or build error, or a timeout means the test itself (or the
// machine) is wrong, so the run proves nothing yet: exit 3, SETUP.
const SETUP_ERR = /TestingLibraryElementError|Unable to find (?:an? )?(?:accessible )?element|Found multiple elements|\bTypeError\b|\bReferenceError\b|\bSyntaxError\b|Cannot read propert|is not a function|is not defined|Test timed out|Hook timed out|Cannot find module|Failed to resolve import|NullReferenceException|\berror (?:CS|TS)\d{3,5}\b/;
// A jest-dom matcher prints `expect(element).toBeInTheDocument()`, Moq and NSubstitute their own
// exceptions (2026-11-12: with the old code red only by an assertion, these must read as one).
const ASSERT_ERR = /AssertionError|\bexpected\b.*\bto\b|Assert\.\w+\(\) Failure|Xunit\.Sdk\.\w+Exception|AssertFailedException|Shouldly|^Expected:|^(?:Error:\s*)?expect\(\w*\)\.(?:not\.)?\w+\(|MockException|ReceivedCallsException|\bDid not expect\b/i;
const SETUP_OUTPUT = /\berror (?:CS|TS)\d{3,5}\b|Build FAILED|Failed to resolve import|Cannot find module|SyntaxError/;
// A Testing Library query that found no element (or not the one element it wants). After a passing green run
// the same query found its element on the fixed tree, so on the old code (or under a break) this is the
// product's own failure, not a broken test (2026-11-13: the old code did not render the notice the fix
// renders, and the proof stopped as SETUP).
const ELEMENT_ERR = /TestingLibraryElementError|Unable to find (?:an? |a label )?(?:accessible )?(?:element|role|label)\b|Unable to find role=/;
// The machine, not the tests (2026-11-12, S2): a stopped database or a crashed test host failed every
// red run, and the proof read PROVED. ENV_ERR reads a failing test's reason; ENV_OUTPUT the whole output
// of a failed run (a host crash names no test). A MySqlException counts only with a connection reason:
// a duplicate key under a break is a real catch.
const ENV_ERR = /Unable to connect|MySqlException\b.*\b(?:Connect Timeout|Too many connections|Access denied for user)|\bECONNREFUSED\b|\bETIMEDOUT\b|Connection refused|No connection could be made|A connection attempt failed|Test host process crashed|testhost(?:\.exe)? process (?:exited|crashed)|The active test run was aborted|OutOfMemoryException|JavaScript heap out of memory|\bout of memory\b/i;
const ENV_OUTPUT = /The active test run was aborted|Test host process crashed|testhost(?:\.exe)? process (?:exited|crashed)|JavaScript heap out of memory|OutOfMemoryException|Unable to connect to any of the specified MySQL hosts|Worker exited unexpectedly/i;
// A break that does not compile or run (2026-11-12, S6): it fails every test, so it isolates no rule.
// Read from a failing test's reason (not an assertion's text), and from the output for a build that failed.
const INVALID_REASON = /\bReferenceError\b|\bSyntaxError\b|\bis not defined\b|Cannot find name\b|\berror CS\d{3,5}\b/;
const INVALID_OUTPUT = /\berror CS\d{3,5}\b|\berror TS\d{3,5}\b|Build FAILED|Transform failed with \d+ errors?/;
// A run in which no test ran (2026-11-12, S7: a test file in --files made "No test files found" read red).
const NO_TESTS = /No test files found|No tests found|No test matches the given testcase filter|No test is available in/;
// Signs that a runner ran at least one test: the dotnet totals of a project, the vitest totals.
const TESTS_RAN = /^\s*(?:Passed!|Failed!)\s|^\s*Total tests:\s*[1-9]|^\s*Test Run (?:Successful|Failed)|^\s*Tests\s+\d+ (?:passed|failed)/m;
// A run that passed and ran no test (2026-11-19: a filter that matches nothing exits 0, and it read GREEN). The
// runner says so (NO_TESTS) and nothing in the output shows a test that ran: in a solution run, one project with
// no matching test prints the same words while another project runs its tests, and that run is a real one.
export function ranNoTest(result) {
  if (!result || result.timedOut || result.error || result.status !== 0) return false;
  const output = (result.stdout || '') + (result.stderr || '');
  return NO_TESTS.test(output) && !TESTS_RAN.test(output) && !failureReasons(output).length;
}
// 2026-11-20: zero skips must come from the runner's totals. Green counts as "proven without the database" only
// when EVERY summary line of the run is readable and NONE shows a skip (round 2, R1: a run of several projects
// prints one summary each, and a skip shows as `Skipped!`, `Skipped: N` or `N skipped` on any of them).
function skippedNone(result) {
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.replace(/\x1b\[[0-9;]*m/g, '');
  let summaries = 0;
  for (const line of output.split(/\r?\n/)) {
    if (/^\s*Skipped!/.test(line)) return false;
    const dotnet = /^\s*(?:Passed!|Failed!)\s*-/.test(line);
    const vitest = /^\s*Tests[:\s]/.test(line) && /\b\d+\s+(?:passed|failed|skipped|total)\b/.test(line);
    const counts = [...line.matchAll(/\bSkipped:\s*(\d+)|\b(\d+)\s+skipped\b/g)].map(m => Number(m[1] ?? m[2]));
    if (counts.some(n => n > 0)) return false;
    if (dotnet) { if (!/\bSkipped:\s*\d+(?=\s*(?:,|$))/.test(line)) return false; summaries++; }
    else if (vitest) { if (!counts.length) return false; summaries++; }
  }
  return summaries > 0;
}
// A run whose output shows its build finished (2026-11-19: a copy was marked built after any run that ended, also
// one whose build failed, and the next run in that copy compiled the whole solution): the run passed, or tests
// ran (a failing test is named, or the runner printed its totals) and no build error is in the output.
export function buildFinished(result) {
  if (!result || result.timedOut || result.error) return false;
  if (result.status === 0) return true;
  const output = (result.stdout || '') + (result.stderr || '');
  if (INVALID_OUTPUT.test(output)) return false;
  return TESTS_RAN.test(output) || failureReasons(output).length > 0;
}
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
      // An assertion or a missing element that only names a connection error (a screen text, an expected
      // error code) is the test's own failure, not the machine's.
      if (ENV_ERR.test(l) && !ASSERT_ERR.test(l) && !/TestingLibraryElementError|Unable to find/.test(l)) { kind = 'env'; why = l; break; }
      if (SETUP_ERR.test(l)) { kind = 'setup'; why = l; break; }
      if (ASSERT_ERR.test(l)) { kind = 'assert'; why = l; break; }
    }
    found.set(name, { name, kind, why: why.slice(0, 140), runner: vitest ? 'vitest' : 'dotnet' });
  }
  return [...found.values()];
}

// A failing test's own names, lower case (2026-11-12, S22: a mustFail part matched the full name, so a
// tag on a describe or a file name let any failing test in it stand for all). vitest: the last part of
// "file > describe > test" (a file-level failure "file [ file ]" has none); dotnet: the method (the
// last part of Namespace.Class.Method, arguments dropped) or the DisplayName as printed and without its
// arguments. xUnit prints a test's DisplayName, not its method, in its Failed line (2026-11-10: four
// breaks read "not seen failing" although their tests had failed: mustFail named the methods), so `pairs`
// ({display, method}, from displayNames) add the other name.
// A dotnet printed name without its arguments (2026-11-18, audit: an argument text with a parenthesis, `Refuses(role: "a (b)")`,
// was never cut): the arguments start at the first `(` after a dotted name; any other name loses a last `(...)` group.
function dotnetBare(name) {
  const m = /^([\w.`+]+)\s*\(.*\)\s*$/s.exec(String(name));
  return m ? m[1] : String(name).replace(/\s*\([^()]*\)\s*$/, '');
}
export function ownNames(reason, pairs = []) {
  const name = String(reason.name).toLowerCase();
  const names = new Set();
  const vitest = reason.runner ? reason.runner === 'vitest' : name.includes(' > ');
  if (vitest) { if (!/\s\[\s.*\s\]$/.test(name)) names.add(name.split(' > ').pop()); }
  else {
    const bare = dotnetBare(name);
    if (/^[\w.`+]+$/.test(bare)) names.add(bare.split('.').pop());
    else { names.add(name); names.add(bare); }
  }
  for (const p of pairs) {
    const display = p.display.toLowerCase(), method = p.method.toLowerCase();
    if (names.has(display)) names.add(method);
    if (names.has(method)) names.add(display);
  }
  return names;
}

// A declared title against a failing test's own names; a title with placeholders (`${x}`, %s, $name)
// matches any text in their place.
function titleMatches(title, own) {
  const t = String(title).toLowerCase();
  if (own.has(t)) return true;
  if (!/\$\{|%[sdifjoc#]|\$\w/.test(t)) return false;
  const re = new RegExp('^' + t.split(/\$\{[^}]*\}|%[sdifjoc#]|\$\w+/).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+') + '$');
  return [...own].some(n => re.test(n));
}

// The failing tests a runner printed, each with its own names, its full printed name and the test file it printed
// (a vitest "file > ... > test" head), for failingFor.
function printedIn(r) {
  const head = String(r.name).split(' > ')[0].trim().split(/\s+/).pop().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').toLowerCase();
  return String(r.name).includes(' > ') && /\.\w+$/.test(head) ? head : '';
}
function failingTests(reasons, pairs = []) {
  return reasons.filter(r => r.kind !== 'env').map(r => ({ name: String(r.name), own: ownNames(r, pairs), file: printedIn(r) }));
}
// A dotnet name printed as Namespace.Class.Method (nested: Outer+Inner): its class must be the class of the test.
// A test the class has by inheritance is printed with the derived class. It is credited only by a failing test whose
// class is the declaring class or is known to derive from it, directly or through other classes, in the test files
// read for this run (2026-11-18, audit: any class was accepted for a test marked inherited, so an unrelated class's
// failure credited an abstract base's test). `derived` is a Set of lower-case class names that derive from d.klass
// (derivedOf). THE LIMIT that stays: a derived class in a file this run does not read, or two classes of the same
// name in different namespaces, cannot be told apart here.
function classFits(name, d, derived = new Set()) {
  const bare = dotnetBare(name);
  if (!d.klass) return true;
  // 2026-11-18 (audit): a failure that prints no class (xUnit prints a DisplayName only) can come from any class, so it
  // cannot credit a test that is inherited while no derived class is known; a plain test is still credited by it.
  if (!/^[\w.`+]+$/.test(bare) || !bare.includes('.')) return !(d.inherited && !derived.size);
  const parts = bare.split('.');
  const printed = parts[parts.length - 2].split('+').pop().toLowerCase();
  return printed === d.klass.toLowerCase() || derived.has(printed);
}
// The base map across all the test files read: for each declared test, the names of the classes that derive from its
// class (transitively). `items` are declaredTests / testSpans items (each carries its file's classes); `extra` are
// further class lists ({ name, bases }) from files read that hold no test.
function derivedOf(items, extra = []) {
  const all = [...extra];
  for (const it of items) if (it && it.classes) all.push(...it.classes);
  const bases = new Map();
  for (const c of all) {
    const set = bases.get(c.name.toLowerCase()) || new Set();
    for (const b of c.bases) set.add(b.toLowerCase());
    bases.set(c.name.toLowerCase(), set);
  }
  return (klass) => {
    const want = String(klass || '').toLowerCase(), out = new Set();
    let grew = true;
    while (grew) {
      grew = false;
      for (const [n, bs] of bases) if (!out.has(n) && n !== want && (bs.has(want) || [...bs].some(b => out.has(b)))) { out.add(n); grew = true; }
    }
    return out;
  };
}
// THE ONE IDENTITY MATCHER (2026-11-18, audit finding 5: the result that is shown and the record that is saved must
// take the same failing test for a declared test). The index of the failing test that is test `d`, or -1: its title
// matches; a failure printed with a test file is that file's test, never another file's; a failure printed with no
// file may stand for it only when a dotnet name that holds its class names the class that really holds the test. A
// failure printed with the test's own file is taken first. `d` comes from declaredTests or testSpans (file, klass).
function failingFor(failing, used, d, derivedFor = () => new Set()) {
  const is = (f, i) => !used.has(i) && d.titles.some(t => titleMatches(t, f.own));
  let k = failing.findIndex((f, i) => is(f, i) && f.file && (!d.file || ('/' + String(d.file).toLowerCase()).endsWith('/' + f.file)));
  if (k < 0) { const derived = derivedFor(d.klass); k = failing.findIndex((f, i) => is(f, i) && !f.file && classFits(f.name, d, derived)); }
  return k;
}

// The mustFail parts a break run did not see failing. Under a break, any failure of a named test
// catches it, an error as well as an assertion (2026-11-07: a test that crashed because the break
// removed its element was called a broken test, and the whole proof ran again, twice), except an
// environment failure. A part is matched against each failing test's own names (ownNames). When the
// changed test files declare tests whose title holds the part (`declared`, from declaredTests), each
// of them must fail; when they declare none, one failing test whose own name holds the part is enough.
export function survivors(mustFail, reasons, pairs = [], declared = [], classes = []) {
  const failing = failingTests(reasons, pairs);
  const derivedFor = derivedOf(declared, classes);
  const seen = (p) => failing.some(f => [...f.own].some(n => n.includes(p)));
  const left = [];
  for (const part of mustFail) {
    const p = String(part).toLowerCase();
    const wanted = declared.filter(d => d.titles.some(t => String(t).toLowerCase().includes(p)));
    if (!wanted.length) { if (!seen(p)) left.push(String(part)); continue; }
    const used = new Set(), missing = [], orphan = [];
    for (const d of wanted) {
      const k = failingFor(failing, used, d, derivedFor);
      if (k < 0) missing.push(d.titles[d.titles.length - 1]); else used.add(k);
      // An inherited test with no derived class known cannot be matched to any failure: say so and name the base class.
      if (k < 0 && d.inherited && !derivedFor(d.klass).size) orphan.push(d.klass);
    }
    const note = orphan.length ? ` (cannot be matched: the test is inherited from ${[...new Set(orphan)].join(', ')} and no class that derives from it is in the test files read, so no failing test can be tied to it)` : '';
    if (missing.length) left.push(seen(p) ? `${part} (not failing: ${missing.map(t => `"${t}"`).join(', ')})${note}` : String(part) + note);
  }
  return left;
}

// Each test a changed test file declares, marked new or older (2026-11-14). Older: the file at the merge
// base declared a test with the same titles (an it()/test() title; a C# method and its DisplayName), counted
// once per time it did. New: this change added the test or changed its title. `baseText` is null for a file
// the base did not have.
export function markNewTests(text, baseText, file = '') {
  const before = new Map();
  for (const d of baseText == null ? [] : declaredTests(baseText, file)) {
    const k = JSON.stringify(d.titles);
    before.set(k, (before.get(k) || 0) + 1);
  }
  return declaredTests(text, file).map(d => {
    const k = JSON.stringify(d.titles), n = before.get(k) || 0;
    if (n) before.set(k, n - 1);
    const item = { file, line: d.line, titles: d.titles, isNew: !n };
    // The class of a C# test rides on the item without showing in its fields (2026-11-20: two classes with one method name).
    if (d.klass) Object.defineProperty(item, 'klass', { value: d.klass, enumerable: false });
    return item;
  });
}

// The mustFail parts that hold a new test's title and an older test's title at once (2026-11-14: "[C1]" held
// the task's new test and an older "[C1]" test of an earlier ticket in the same file; every test whose title
// holds a part must fail, so the proof read NOT PROVED after a full run of every copy). Matched as survivors()
// matches: the part, in lower case, inside a declared title. A part with only older titles may name an
// existing test of the rule. A part that is a matched test's whole title is left alone: no narrower words
// name that test, so refusing it would leave no way through.
export function ambiguousParts(breaks, tests) {
  const shown = (d) => d.titles[d.titles.length - 1];
  const found = [];
  for (const b of breaks) {
    if (!b || b.single || !Array.isArray(b.mustFail)) continue;
    for (const part of b.mustFail) {
      const p = String(part).toLowerCase();
      const hits = tests.filter(d => d.titles.some(t => String(t).toLowerCase().includes(p)));
      if (hits.some(d => d.titles.some(t => String(t).toLowerCase() === p))) continue;
      const fresh = hits.filter(d => d.isNew), older = hits.filter(d => !d.isNew);
      if (fresh.length && older.length) found.push({ name: String(b.name), part: String(part), fresh: fresh.map(shown), older: older.map(shown) });
    }
  }
  return found;
}

// A break's text in a file whose line endings may differ from the break's (2026-11-12, S6: a copy that
// checked the file out with CRLF never matched an LF break, so the break changed nothing and read as
// "still pass"). The pairs to try: as written, then with the file's line endings.
function breakVariants(text, find, put) {
  const crlf = String(text).includes('\r\n');
  const to = (s) => (crlf ? String(s).replace(/\r?\n/g, '\r\n') : String(s).replace(/\r\n/g, '\n'));
  return [[find, put], [to(find), to(put)]];
}
// How many times a break's text is in a file (the first form that is there at all).
export function breakHits(text, find) {
  for (const [f] of breakVariants(text, find, '')) { const n = String(text).split(f).length - 1; if (n) return n; }
  return 0;
}
// The file with the break applied, or null when the break would change nothing (its text is not there
// exactly once, or the new text is the old one).
export function applyBreak(text, find, put) {
  const src = String(text);
  for (const [f, p] of breakVariants(src, find, put)) {
    if (src.split(f).length - 1 !== 1) continue;
    const next = src.replace(f, () => p);
    return next === src ? null : next;
  }
  return null;
}

// The line that shows a failed run failed on the environment, or null.
function environmentFailure(r) {
  const w = r.why.find(x => x.kind === 'env');
  if (w) return { named: true, line: `${w.name} — ${w.why}` };
  const line = String(r.output).split(/\r?\n/).find(l => ENV_OUTPUT.test(l));
  return line ? { named: false, line: line.trim().slice(0, 200) } : null;
}
// The line that shows a break run failed because the break does not compile or run, or null.
function breakInvalid(r) {
  const w = r.why.find(x => x.kind !== 'assert' && INVALID_REASON.test(x.why));
  if (w) return `${w.name} — ${w.why}`;
  const line = String(r.output).split(/\r?\n/).find(l => INVALID_OUTPUT.test(l));
  return line ? line.trim().slice(0, 200) : null;
}

// The changed test files that hold a test a mustFail part names (2026-11-12, S4/C5). A part found in no declared
// title names the files whose text holds it. 2026-11-17: the proof record no longer credits these whole files (one
// caught test certified every check of its file); it names the caught tests themselves (caughtTests below). This
// reading stays for --changed-since, which only picks the breaks to run again (keptSince).
export function caughtTestFiles(files, parts, textOf) {
  const docs = files.map(f => {
    let text = '';
    try { text = String(textOf(f)); } catch { /* a file gone since: not credited */ }
    return { f, text: text.toLowerCase(), titles: declaredTests(text, f).flatMap(d => d.titles.map(t => String(t).toLowerCase())) };
  });
  const credited = new Set();
  for (const part of parts) {
    const p = String(part).toLowerCase();
    const hits = docs.filter(d => d.titles.some(t => t.includes(p)));
    for (const d of (hits.length ? hits : docs.filter(d => d.text.includes(p)))) credited.add(d.f);
  }
  return [...credited].sort();
}

// The tests a caught break made fail, each by its own identity (2026-11-17, audit "one caught test certifies
// another rule's vacuous negative check": the record held whole test files, so a caught test proved every
// "nothing happens" check of its file, another rule's vacuous one too). A test counts when a mustFail part names
// it (namedBy: its declared title holds the part, as survivors() matches) and a failing test the runner printed is
// that test (titleMatches on the failing test's own names; a .each row fills its title's placeholders). `spans`
// are the tests the changed test files declare (testSpans of proof-record.mjs). Each result is { file, line,
// title, ran }: the test file, the test's line and title there, and the full name as the runner printed it. One
// failing test stands for one declared test; a failing test printed with the same file is taken first, and a
// title written out before a title with placeholders, so a row is not taken for a test it only resembles.
export function caughtTests(mustFail, reasons, pairs = [], spans = [], classes = []) {
  const failing = failingTests(reasons, pairs);
  const derivedFor = derivedOf(spans, classes);
  const open = (d) => d.titles.some(t => /\$\{|%[sdifjoc#]|\$\w/.test(String(t)));
  const found = new Map();
  for (const part of mustFail) {
    const used = new Set();
    const wanted = spans.filter(d => namedBy([part], d)).sort((a, b) => Number(open(a)) - Number(open(b)));
    for (const d of wanted) {
      // A failure printed with another test file is that file's test, never this one's (2026-11-17, audit: an older
      // test with the same title in an unchanged file certified a new vacuous test); a dotnet name must name the class
      // that holds this test. The same matcher the shown result uses (failingFor, 2026-11-18).
      const k = failingFor(failing, used, d, derivedFor);
      if (k < 0) continue;
      used.add(k);
      found.set(d.file + '\n' + d.line, { file: d.file, line: d.line, title: d.titles[d.titles.length - 1], ran: failing[k].name });
    }
  }
  return [...found.values()];
}

// One caught break as the test machine says it to the machine that asked (2026-11-17): the break's place in the
// plan and the failing tests as the runner named them, as base64 JSON, so a title with quotes or in any script
// crosses ssh as it is. readCaughtLine gives { i, failed: [{ name, runner, kind }] } back, or null for any other line.
export function caughtLine(index, failed) {
  return 'RED-PROOF-CAUGHT: ' + Buffer.from(JSON.stringify({ i: index, failed: failed.map(f => ({ name: String(f.name), runner: f.runner })) }), 'utf8').toString('base64url');
}
export function readCaughtLine(line) {
  const m = /^RED-PROOF-CAUGHT: ([A-Za-z0-9_-]+)$/.exec(String(line).trim());
  if (!m) return null;
  try {
    const sent = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
    if (!sent || !Number.isInteger(sent.i) || !Array.isArray(sent.failed)) return null;
    return { i: sent.i, failed: sent.failed.filter(f => f && typeof f.name === 'string')
      .map(f => ({ name: f.name, runner: f.runner === 'vitest' || f.runner === 'dotnet' ? f.runner : undefined, kind: 'other' })) };
  } catch { return null; }
}

// The failing test names of the old-code run, as the test machine says them to the machine that asked (the old
// code run there, the new tests known here): base64 JSON, like caughtLine. readOldRedLine gives the names, or null.
export function oldRedLine(names) {
  return 'RED-PROOF-OLDRED: ' + Buffer.from(JSON.stringify({ names: names.map(String) }), 'utf8').toString('base64url');
}
export function readOldRedLine(line) {
  const m = /^RED-PROOF-OLDRED: ([A-Za-z0-9_-]+)$/.exec(String(line).trim());
  if (!m) return null;
  try {
    const sent = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
    return sent && Array.isArray(sent.names) ? sent.names.filter(n => typeof n === 'string') : null;
  } catch { return null; }
}
// 2026-11-20 (V1): the passing run's own line. The test machine prints it when its passing run ends well, so the machine
// that asked saves the passing-run fact then, not only when the whole command ends (a stopped proof kept nothing).
export const greenLine = () => 'RED-PROOF-GREEN: passed';
export const isGreenLine = (line) => String(line).trim() === 'RED-PROOF-GREEN: passed';

// 2026-11-20 (V1): every caught-break line the proof prints ends in a fixed tail with the break's id and the id of the
// code tree it was caught on: `[break=<16 hex> tree=<40-64 hex>]`. A later run skips a break only when the session log
// holds such a line from an earlier red-proof command (sessionCaught). The record alone is a file the author can write.
export const caughtTail = (id, tree) => ` [break=${id} tree=${tree}]`;
const TAIL_LINE = /^[ \t]*(?:BREAK ✓|ran) .*\[break=([0-9a-f]{16}) tree=([0-9a-f]{40,64})\][ \t]*\r?$/gm;
// The break ids and tree ids of the caught lines in a text, as "<id> <tree>" keys.
export function caughtTails(text) {
  // A caught break has its tail on its run line and again on the report line: each key once (2026-11-20, U2).
  return [...new Set([...String(text).matchAll(TAIL_LINE)].map(m => m[1] + ' ' + m[2]))];
}
// The caught lines this session's log holds, from the results of earlier red-proof commands only (a tool call whose
// command names red-proof, and the result that answers it). Reads the newest session log of the repository, the way
// note-check.mjs finds it (transcriptCandidates), in chunks, and looks at tool results the way the hooks' scanner does
// (the result's content and the host's stdout/stderr fields). { found, why, keys }: found is false when no log is
// found or it cannot be read; then no break is resumed. THE LIMIT that stays: a command that names red-proof can print
// such a line by hand; the author writes that command in the open, where the review reads it.
// 2026-11-20 (U2): does a shell command RUN red-proof.mjs: a command word `node` (or `node.exe`, after env, timeout, time or
// nohup) with red-proof.mjs as its script argument. A mention inside cat, grep, echo, type, Get-Content, a comment or a
// quoted string given to another program is no run. Words are split at ; && || | and line breaks outside quotes.
export function runsRedProof(command) {
  const text = String(command ?? '');
  const segs = [];
  let words = [], cur = '', has = false, quote = '', i = 0;
  const endWord = () => { if (has) words.push(cur); cur = ''; has = false; };
  const endSeg = () => { endWord(); if (words.length) segs.push(words); words = []; };
  for (; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = '';
      else if (c === '\\' && quote === '"' && i + 1 < text.length && /[\\$"`]/.test(text[i + 1])) cur += text[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; has = true; continue; }
    if (c === '#' && !has) { while (i < text.length && text[i] !== '\n') i++; endSeg(); continue; }
    if (c === ';' || c === '|' || c === '&' || c === '\n' || c === '\r') {
      // A lone `&` at the start of a segment is the PowerShell call operator; any other of these ends the segment.
      if (c === '&' && !has && !words.length && text[i + 1] !== '&') continue;
      endSeg(); while (i + 1 < text.length && (text[i + 1] === c || (c === '&' && text[i + 1] === '&'))) i++; continue;
    }
    if (c === ' ' || c === '\t') { endWord(); continue; }
    cur += c; has = true;
  }
  endSeg();
  const base = (w) => String(w).split(/[\\/]/).pop().toLowerCase();
  const WRAP = new Set(['env', 'timeout', 'time', 'nohup', 'command', 'exec']);
  return segs.some(w => {
    let k = 0;
    while (k < w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[k]) || WRAP.has(base(w[k])) || (k > 0 && /^-?[0-9.]+[smhd]?$/.test(w[k])))) k++;
    if (k >= w.length || !/^(node|nodejs)(\.exe)?$/.test(base(w[k]))) return false;
    for (let j = k + 1; j < w.length; j++) {
      if (w[j] === '--') continue;
      if (/^-/.test(w[j]) || /^[0-9]+$/.test(w[j])) continue;
      return base(w[j]) === 'red-proof.mjs';
    }
    return false;
  });
}
export async function sessionCaught(repo) {
  const out = { found: false, why: '', keys: new Set() };
  let file = '';
  try { file = (await import('./note-check.mjs')).transcriptCandidates(repo)[0] || ''; }
  catch { out.why = 'the session log finder could not be loaded'; return out; }
  if (!file) { out.why = 'no session log was found'; return out; }
  const ids = new Set();
  const feed = (l) => {
    if (l.startsWith('{"type":"api-request')) return;
    const call = l.includes('"tool_use"') && l.includes('red-proof');
    const result = l.includes('"tool_result"') && l.includes('tree=');
    if (!call && !result) return;
    let entry; try { entry = JSON.parse(l); } catch { return; }
    const content = entry && entry.message && entry.message.content;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use' && b.id && b.input && typeof b.input.command === 'string' && runsRedProof(b.input.command)) ids.add(b.id);
      else if (b.type === 'tool_result' && b.tool_use_id && ids.has(b.tool_use_id)) {
        let s = '';
        if (typeof b.content === 'string') s += b.content;
        else if (Array.isArray(b.content)) for (const c of b.content) if (c && typeof c.text === 'string') s += c.text + '\n';
        const r = entry.toolUseResult;
        if (r && typeof r === 'object') { if (typeof r.stdout === 'string') s += '\n' + r.stdout; if (typeof r.stderr === 'string') s += '\n' + r.stderr; }
        // The result must hold a report line of the run itself (a RED-PROOF: line), not only text that looks like a caught line.
        if (/^[ 	]*RED-PROOF: /m.test(s)) for (const k of caughtTails(s)) out.keys.add(k);
      }
    }
  };
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const dec = new StringDecoder('utf8'), buf = Buffer.alloc(4 * 1024 * 1024);
    let carry = '';
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      const parts = (carry + dec.write(buf.subarray(0, n))).split('\n');
      carry = parts.pop();
      parts.forEach(feed);
    }
    feed(carry + dec.end());
  } catch { out.keys.clear(); out.why = 'the session log could not be read'; return out; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
  out.found = true;
  return out;
}
// What the resume line says about the breaks the record holds but that were not resumed.
const refusedWhy = (sess) => sess.why || "no earlier line of this session's log shows them caught";
export const resumeNote = (refused, why) => (refused > 0 ? '; ' + refused + ' more saved for this tree but refused: ' + why : '');

// The new tests the old-code run failed (2026-11-20): a failing name IS the test, never merely holds its title. The
// name equals the test's last title or its full title path (joined by a separator a runner uses), or ends with one
// of them right after such a separator (a file or suite prefix), compared whole and without case. A name that fits
// two new tests credits neither of them. Gives { file, line, title } for each credited test.
const NAME_SEPARATORS = [' > ', ' › ', '::', '.'];
// A parameterized .NET test fails as `Class.Method(quantity: 2)` (2026-11-20): its argument list is cut before matching.
// A vitest or jest name that starts with a test file ("a.test.js > suite > test") names that file: the new test must be
// in the same file (an old test file's failure never credits a test of another file). No file in the name: any file.
const TEST_FILE_PART = /\.[cm]?[jt]sx?$/i;
const sameFile = (a, b) => {
  const x = String(a).split(String.fromCharCode(92)).join('/').toLowerCase(), y = String(b).split(String.fromCharCode(92)).join('/').toLowerCase();
  return x === y || x.endsWith('/' + y) || y.endsWith('/' + x);
};
export function redOldMatches(newTests, names) {
  const tests = (newTests || []).filter(t => Number.isInteger(t.line) && Array.isArray(t.titles) && t.titles.length);
  const forms = tests.map(t => {
    const titles = t.titles.map(x => String(x).trim().toLowerCase());
    return [...new Set([titles[titles.length - 1], ...NAME_SEPARATORS.map(sep => titles.join(sep))])];
  });
  const credited = new Set();
  // The tests a name fits: the longest form wins (a name with its suite in it belongs to the test with that suite).
  const fitting = (n, file) => {
    const fit = tests.map((t, i) => ({ t, len: Math.max(0, ...forms[i].filter(f => n === f || NAME_SEPARATORS.some(sep => n.endsWith(sep + f))).map(f => f.length)) }))
      .filter(x => x.len > 0 && (!file || sameFile(file, x.t.file)));
    const best = Math.max(0, ...fit.map(x => x.len));
    return fit.filter(x => x.len === best);
  };
  for (const raw of names || []) {
    let n = String(raw).trim().toLowerCase();
    let file = null;
    const parts = n.split(' > ');
    if (parts.length > 1 && TEST_FILE_PART.test(parts[0].trim())) file = parts[0].trim();
    // 2026-11-20: the exact name first; a trailing `(...)` is cut as an argument list only when the exact name fits no test.
    let top = fitting(n, file);
    if (!top.length && !n.includes(' > ')) { const bare = dotnetBare(n).trim(); if (bare !== n) { n = bare; top = fitting(n, file); } }
    // 2026-11-20: two tests with one method name in different classes: the class the name carries tells them apart.
    // The name can tell them apart only when it carries a class (Namespace.Class.Method) that fits just one of them.
    if (top.length > 1) {
      const segs = n.split(/[.+]/);
      const byClass = top.filter(x => x.t.klass && segs.slice(0, -1).includes(String(x.t.klass).toLowerCase()));
      if (byClass.length === 1) top = byClass;
    }
    if (top.length === 1) credited.add(top[0].t);
  }
  return tests.filter(t => credited.has(t));
}
export function redOldTests(newTests, names) {
  return redOldMatches(newTests, names).map(t => ({ file: t.file, line: t.line, title: String(t.titles[t.titles.length - 1]) }));
}

// The breaks a --changed-since run keeps (2026-11-16): a break whose file is among `changed` (repository paths, as
// git prints them), or whose mustFail names a test in a changed test file (caughtTestFiles: a declared title holds
// the part, or, when no title does, the file's text). On Windows a path matches in any case.
export function keptSince(breaks, changed, textOf, platform = process.platform) {
  const fold = (f) => { const p = String(f).replace(/\\/g, '/').replace(/^(?:\.\/)+/, ''); return platform === 'win32' ? p.toLowerCase() : p; };
  const files = new Set(changed.map(fold));
  const tests = changed.filter(f => TEST_FILE.test(String(f).replace(/\\/g, '/')));
  return breaks.filter(b => files.has(fold(b.file)) || (tests.length > 0 && caughtTestFiles(tests, (b.mustFail || []).map(String), textOf).length > 0));
}

// The id of the tree a proof runs on: the working tree as git would commit it (the same temporary-index
// way remote-sync.sh builds the tree it sends), or a commit's tree. When that fails: HEAD's tree, marked
// "dirty" when the folder has changes.
export function treeId(repo, commit = '') {
  const g = (args, env = {}) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ...env } }).trim();
  if (commit) { try { return g(['rev-parse', commit + '^{tree}']); } catch { return 'unknown'; } }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'red-proof-index-'));
  try {
    const env = { GIT_INDEX_FILE: path.join(dir, 'index') };
    g(['read-tree', 'HEAD'], env);
    g(['add', '-A'], env);
    return g(['write-tree'], env);
  } catch {
    try { return g(['rev-parse', 'HEAD^{tree}']) + (g(['status', '--porcelain']) ? ' dirty' : ''); } catch { return 'unknown'; }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
// `Name(`, `Name {`, or `Name:` in a script file), not in the old file, and a whole word in the test files'
// code (`testText` as testCode reads it).
export function addedNames(diff, oldText, testText, file = '') {
  return namesOnAddedLines(addedLines(diff), oldText, testText, file);
}

function addedLines(diff) {
  const lines = String(diff).split(/\r?\n/);
  const hunk = lines.findIndex(l => l.startsWith('@@ '));
  if (hunk >= 0 && lines.slice(0, hunk).some(l => l.startsWith('old mode '))) return [];
  const body = hunk < 0 ? lines : lines.slice(hunk + 1);
  if (body.some(l => l.startsWith('-'))) return []; // A changed or deleted line may hold the fix.
  return body.filter(l => l.startsWith('+')).map(l => l.slice(1));
}

function namesOnAddedLines(added, oldText, testText, file) {
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

// A test file as code only (2026-11-15: a comment, `// … (QuestionService.PictureNotAllowedMessage).`, kept a fix
// file at the fix for the old-code run; it called a helper of another file that went back, and the old code did
// not compile: SETUP). Comments (//, ///, /* */) and the text of strings are left out (size-check.mjs codeLines and
// codeOnly): a name there is no compile-time use. The code inside an interpolated string stays: `${X}` in a
// template, {X} in a C# $"…" string. A test file without // comments (Python) is read whole.
export function testCode(text, file = '') {
  const src = String(text);
  if (!/\.(?:cs|[cm]?[jt]sx?|go)$/i.test(file)) return src;
  const code = codeLines(src);
  const cs = /\.cs$/i.test(file);
  return src.split(/\r?\n/).map((line, i) => (code[i] ? [codeOnly(line), ...interpolated(line, cs)].join(' ') : '')).join('\n');
}
// The code inside one line's interpolated strings.
function interpolated(line, cs) {
  if (!cs) return [...line.matchAll(/\$\{([^{}]*)\}/g)].map(m => m[1]);
  const at = line.search(/\$@?"|@\$"/);
  return at < 0 ? [] : [...line.slice(at).matchAll(/(?<!\{)\{(?!\{)([^{}]+)\}/g)].map(m => m[1]);
}

function codeNames(text) {
  return new Set(text.match(/[$_\p{ID_Start}][$\p{ID_Continue}]*/gu) || []);
}

function compilerErrors(output) {
  return output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)
    .filter(l => /(?:^|:\s*|\s+-\s+)\s*(?:fatal\s+)?error\s+[A-Z]+\d+\s*:/i.test(l) ||
      /(?:^|:\s*|\s+-\s+)\s*(?:fatal\s+)?error\s*:/.test(l));
}

// 2026-11-20: a missing name hid a second compiler error. Account for each error at its own location.
function missingTestNames(errors, names, testNames, textAt) {
  if (!names.size) return [];
  const missing = new Set();
  const sites = new Map(), inference = [];
  for (const line of errors) {
    const at = /^\s*(.+?)(?:\((\d+),(\d+)(?:,\d+,\d+)?\)|:(\d+):(\d+))\s*(?::| -)?\s*error\s+(CS\d+|TS\d+)\s*:\s*(.*)$/i.exec(line);
    if (!at) return [];
    const [, file, csLine, csCol, tsLine, tsCol, rawCode, message] = at;
    const code = rawCode.toUpperCase();
    const refs = [...testNames].filter(([f]) => sameFile(file, f));
    if (refs.length !== 1) return [];
    const [testFile, namesInTest] = refs[0];
    const row = Number(csLine || tsLine), column = Number(csCol || tsCol);
    const project = /\[[^\]]+\.(?:cs|fs|vb)proj\]\s*$/.exec(message)?.[0] || '';
    const site = `${file.replace(/\\/g, '/')}:${row} ${project}`;
    // C# cannot infer a deconstruction or an out variable when the call itself cannot resolve.
    if (/^CS(?:8130|8183|8197)$/.test(code)) { inference.push({ site, code, testFile, row, column }); continue; }
    let name;
    if (/^CS(?:0103|0234|0246|0117|1061|1739)$/.test(code)) {
      name = /(?:The (?:type or namespace )?name|definition for|parameter named) '([^']+)'/.exec(message)?.[1];
    } else if (/^TS(?:2304|2305|2339|2459|2551|2614|2694|2724)$/.test(code)) {
      name = /(?:Cannot find name|(?:has no|no) exported member|Property|declares) '([^']+)'/.exec(message)?.[1];
    }
    if (!name || !names.has(name) || !namesInTest.has(name)) return [];
    missing.add(name);
    if (!sites.has(site)) sites.set(site, []);
    sites.get(site).push({ code, column });
  }
  for (const { site, code, testFile, row, column } of inference) {
    const causes = code === 'CS8130' ? ['CS0103', 'CS0117', 'CS1061', 'CS1739'] : ['CS0117', 'CS1061', 'CS1739'];
    let source;
    try { source = textAt(testFile).split(/\r?\n/)[row - 1]; } catch { return []; }
    if (!source || !sites.get(site)?.some(primary => {
      const start = Math.min(column, primary.column), end = Math.max(column, primary.column);
      return causes.includes(primary.code) && start > 0 && end <= source.length && !source.slice(start - 1, end - 1).includes(';');
    })) return [];
  }
  return [...missing];
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

// The scripts the test machine needs: this one and every script it imports, followed through their own
// imports (2026-11-14: a new shared import, is-main.mjs, was missing from a hand-written list, and every
// proof on the test machine stopped with "Cannot find module").
export function proofScripts(dir) {
  const list = ['red-proof.mjs'];
  for (let i = 0; i < list.length; i++) {
    const text = fs.readFileSync(path.join(dir, list[i]), 'utf8');
    for (const m of text.matchAll(/^\s*import\b[^;]*?\bfrom\s+['"]\.\/([\w.-]+\.mjs)['"]/gm)) if (!list.includes(m[1])) list.push(m[1]);
  }
  return list;
}

// A `dotnet` command: its executable is dotnet or dotnet.exe, by any path.
export function isDotnetCommand(command) {
  return /^dotnet(?:\.exe)?$/i.test(String(command[0] || '').split(/[\\/]/).pop());
}

// The changed test files a test command runs (2026-11-15). A dotnet command runs the C#, F# and VB tests and any
// other command the rest, so the server proof and the page proof of one task each answer for their own files.
// A command that runs in a subfolder of the repository (`cwd`, as --cwd gives it) runs the test files under it.
// When the command's own words name some of them (a file or folder path; for dotnet also a test class by its
// file's name, as a --filter does), only those: one side may be proved by two commands, each its own record entry.
export function proofScope(command, files, cwd = '') {
  const dotnet = isDotnetCommand(command);
  const fold = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const under = fold(String(cwd).replace(/\\/g, '/').replace(/^(?:\.\/)+|\/+$/g, ''));
  const inCwd = (f) => !under || under === '.' || under === '..' || under.startsWith('../') || fold(f).startsWith(under + '/');
  const mine = files.filter(f => /\.(?:cs|fs|vb)$/i.test(f) === dotnet && inCwd(f));
  const words = command.slice(1).map(a => String(a).replace(/\\/g, '/'))
    .map(a => (a.startsWith('-') ? a.slice(a.indexOf('=') + 1 || a.length) : a).replace(/^(?:\.\/)+|\/+$/g, '')).filter(Boolean);
  const paths = words.filter(a => a.includes('/') || /\.\w+$/.test(a));
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const named = mine.filter(f => paths.some(a => ('/' + f).endsWith('/' + a) || ('/' + a).endsWith('/' + f) || ('/' + f).includes('/' + a + '/')) ||
    (dotnet && words.some(a => new RegExp(`(?<![\\w$])${esc(path.posix.basename(f).replace(/\.\w+$/, ''))}(?![\\w$])`).test(a))));
  return named.length ? named : mine;
}

// The environment of a dotnet run in a kept copy (2026-11-13). The SDK writes the commit id into every
// assembly ("1.0.0+<commit>"), and each sync to the test machine is a new commit, so every copy recompiled
// every project at every proof, about 5 minutes a copy (checked on a two-project build: a new commit with no
// file change recompiled both). Built without it, a new commit recompiles nothing, and a change recompiles
// only its project and those that depend on it. A value the env file or the machine sets is kept. Other
// runners, and the working folder, are left alone.
const SOURCE_REVISION = 'IncludeSourceRevisionInInformationalVersion';
export function copyRunEnv(command, env, platform = process.platform) {
  if (!isDotnetCommand(command)) return env;
  const same = (k) => (platform === 'win32' ? k.toUpperCase() === SOURCE_REVISION.toUpperCase() : k === SOURCE_REVISION);
  if (Object.keys(env).some(same)) return env;
  return { ...env, [SOURCE_REVISION]: 'false' };
}

// A `dotnet test` command's compile check: the same command listing its tests instead of running
// them, so it builds the tree once. Other runners have none (null).
export function compileCheckCommand(command) {
  if (!isDotnetCommand(command) || command[1] !== 'test' || command.includes('--list-tests') || command.includes('-t')) return null;
  const dash = command.indexOf('--', 2);
  return dash < 0 ? [...command, '--list-tests'] : [...command.slice(0, dash), '--list-tests', ...command.slice(dash)];
}

// This run's lines and outputs, for --log. Kept outside main() so a thrown error's line reaches the log too.
const state = { said: [], logs: [], logPath: null, head: '', remoteLog: null };

// A red run is stuck at STUCK_FACTOR times the slowest finished red run, once STUCK_PEERS of them finished.
const STUCK_FACTOR = 2, STUCK_PEERS = 2;
// The unproven check lines a refusal shows before it only counts the rest.
const UNPROVEN_SHOWN = 40;

if (isMain(import.meta.url)) {
  main().catch((e) => { const line = 'RED-PROOF: failed — ' + e.message; state.said.push(line); process.stdout.write(line + '\n'); process.exit(2); });
}

async function main() {
  const argv = process.argv.slice(2);
  const dash = argv.indexOf('--');
  const opts = dash >= 0 ? argv.slice(0, dash) : argv;
  const command = dash >= 0 ? argv.slice(dash + 1) : [];
  const opt = (name) => { const i = opts.indexOf(name); return i >= 0 ? opts[i + 1] : undefined; };
  const said = state.said;
  let hide = (text) => text; // set by --test-env: every line shown or logged passes through it
  const runFailed = (r) => !r || r.timedOut || r.error || r.status !== 0;
  // --check-plan (2026-11-19): only the checks that come before any run. No log, no run record, no test machine, no copy.
  const checkPlan = opts.includes('--check-plan');
  const say = (line) => { line = hide(line); said.push(line); process.stdout.write(line + '\n'); };
  const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
  // A file swapped in the working folder right now (its backup folder), and the test processes running:
  // a stop or an exit puts the file back and stops them (2026-11-12, S13).
  let swapped = null;
  const running = new Set();

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
  const cwdHere = opt('--cwd') ? path.resolve(opt('--cwd')) : repo;
  let plan = null;
  if (opt('--plan')) {
    try { plan = JSON.parse(fs.readFileSync(path.resolve(opt('--plan')), 'utf8')); }
    catch (e) { say('RED-PROOF: cannot read --plan — ' + e.message); process.exit(2); }
  }
  // The log (2026-11-12, S5): emptied now, before anything can stop the run, and written on every exit
  // (process.exit included), so an older run's PROVED never stays in it. Its first line names the tree
  // this run proves (on the test machine, the synced commit's); review-brief.mjs can compare it with the
  // tree under review.
  const stamp = (tree) => `RED-PROOF-LOG: tree ${tree} at ${new Date().toISOString()}`;
  if (opt('--log') && !checkPlan) {
    state.logPath = path.resolve(opt('--log'));
    state.head = stamp(repo ? treeId(repo, plan?.commit || '') : 'unknown (no --repo)');
    fs.writeFileSync(state.logPath, state.head + '\n');
  }
  process.on('exit', () => {
    if (swapped) putBack();
    if (!state.logPath) return;
    const body = state.remoteLog != null ? state.remoteLog : said.join('\n') + '\n\n' + state.logs.join('\n');
    try { fs.writeFileSync(state.logPath, state.head + '\n' + body); } catch { /* the output above stands */ }
  });
  // The run record the stop hook reads (run-record.mjs, 2026-11-15): a green run's result, kept when its output
  // went to a file. Written on exit, after the handler above put any swapped file back. The test machine's plan
  // run leaves it to the machine that asked. A --changed-since run's record says partial (2026-11-16).
  if (repo && !plan && !checkPlan && opts.includes('--then-green')) {
    keepRunRecord({ argv: process.argv.slice(2), said: state.said, tree: () => treeId(repo), startTree: (/^RED-PROOF-LOG: tree ([0-9a-f]{40,64}) /.exec(state.head) || [])[1],
      partial: opts.includes('--changed-since') });
  }
  // Puts the swapped file back; false (with the reason said) when that fails.
  function putBack() {
    const dir = swapped;
    swapped = null;
    if (!dir) return true;
    try { restore(dir); return true; } catch (e) { say('RED-PROOF: RESTORE FAILED — ' + e.message); return false; }
  }
  // A usage refusal (2026-11-19): nothing ran, and the last line says so in one fixed text the stop hook reads.
  // The refusals that judge the break plan (a find that matches twice, AMBIGUOUS, UNPROVEN) keep their own text.
  const refuse = (line) => { say(line); say('RED-PROOF: REFUSED — nothing ran'); process.exit(2); };
  const oldRef = opt('--old');
  const oldFiles = (opt('--files') || '').split(',').map((f) => f.trim().replace(/\\/g, '/')).filter(Boolean);
  const usage = () => {
    say('usage: red-proof.mjs --repo <path> [--old <git-ref> --files <a,b>] [--breaks <json> [--changed-since <git ref>]] [--then-green] [--base <ref>] [--cwd <dir>] [--log <file>] -- <executable> [args...]');
    say('   or: red-proof.mjs --repo <path> --break <file> --find <text> --put <text> [--cwd <dir>] [--log <file>] -- <executable> [args...]');
    say('   options: [--parallel <n>] [--timeout-min <n>] [--test-env <path>] [--local] [--show-remote]; or --repo <path> --drop-copies');
    say('   or: red-proof.mjs --repo <path> --warm [--parallel <n>] [--cwd <dir>] -- <executable> [args...]');
    say('RED-PROOF: REFUSED — nothing ran');
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
  // A copy a dotnet command has built in (its first build there compiled the whole solution): a marker in the
  // copy's .git folder, which a sync never touches; dropping the copy drops it.
  const builtIn = (copy) => fs.existsSync(path.join(copy, '.git', 'red-proof-built'));
  const markBuilt = (copy) => { try { fs.writeFileSync(path.join(copy, '.git', 'red-proof-built'), new Date().toISOString() + '\n'); } catch { /* not a copy */ } };
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
  if (plan) breaks = plan.breaks || [];
  // 2026-11-20: one break file held both page and server rules. Check only this proof's files.
  const inProofCwd = file => {
    if (!opt('--cwd')) return true;
    const rel = path.relative(cwdHere, path.resolve(repo, file.replace(/\\/g, '/')));
    return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
  };
  const deferredBreaks = [];
  if (repo && opt('--cwd') && Array.isArray(breaks)) {
    breaks = breaks.filter(b => {
      if (typeof b?.file !== 'string' || !b.file || inProofCwd(b.file)) return true;
      const file = b.file.replace(/\\/g, '/');
      const line = `  BREAK DEFERRED ${b.name || 'break'} (${file}): outside --cwd; left for another proof.`.replace(/[\r\n]/g, ' ');
      deferredBreaks.push(line);
      say(line);
      return false;
    });
  }
  const scopeFiltered = Boolean(plan?.scopeFiltered || deferredBreaks.length);
  // An entry that is not filled in (2026-11-19: `breaks.mjs seed` writes one entry per new test with file, find and put
  // left empty): each is named, so a half-written list is found at once. An empty put is named only by --check-plan:
  // a real run still takes it (a break that deletes text).
  if (Array.isArray(breaks)) {
    const emptyOf = (b) => ['file', 'find', ...(checkPlan ? ['put'] : [])].filter(k => b && !b.single && (b[k] === '' || b[k] == null));
    const unfilled = breaks.map((b, i) => ({ b, i, empty: emptyOf(b) })).filter(x => x.empty.length);
    for (const x of unfilled) say(`  BREAK EMPTY ✗ ${x.b.name || `entry ${x.i + 1}`}: its ${x.empty.join(', ')} ${x.empty.length === 1 ? 'is' : 'are'} empty; write the file, the exact text to find and the text to put`);
    if (unfilled.length) { say(`RED-PROOF: NOT PROVED ✗ — ${unfilled.length} of ${breaks.length} break(s) are not filled in. Nothing ran; files untouched.`); process.exit(2); }
  }
  if (!Array.isArray(breaks) || breaks.some(b => !b || typeof b.file !== 'string' || typeof b.find !== 'string' || !b.find || typeof b.put !== 'string' ||
    ((plan || !b.single) && (!Array.isArray(b.mustFail) || !b.mustFail.length)))) {
    say('RED-PROOF: each break needs file, find, put and a non-empty mustFail list.'); process.exit(2);
  }
  // --changed-since <ref> (2026-11-16, see the header) picks which of the --breaks run again, so it needs them; its
  // ref is checked below, once git is at hand. The test machine gets the kept breaks in its plan, not the option.
  const since = !plan && opts.includes('--changed-since') ? String(opt('--changed-since') ?? '') : null;
  if (since !== null && !opt('--breaks')) refuse('RED-PROOF: --changed-since needs --breaks: it picks which of those breaks run again. Nothing ran.');
  if (since !== null && (!since || since.startsWith('-'))) refuse('RED-PROOF: --changed-since needs a git ref (a commit, a branch or a tree id). Nothing ran.');
  // A break that puts back its own text changes nothing, so it proves nothing (2026-11-12, S6).
  const same = breaks.filter(b => b.put === b.find);
  if (same.length) {
    for (const b of same) say(`  BREAK INVALID ✗ ${b.name}: the break changes nothing (its put text is its find text); write a break that changes one rule`);
    say(`RED-PROOF: ${breaks[0].single ? 'NOT RED' : 'NOT PROVED'} ✗ — a break changes nothing, so nothing ran.`);
    process.exit(1);
  }
  const green = opts.includes('--then-green') || Boolean(plan?.green);
  const warm = opts.includes('--warm') || Boolean(plan?.warm);
  // Each run tests a few files, so half the machine's cores run at once (8 on a 16-core machine).
  const parallel = Math.max(1, Number.parseInt(opt('--parallel') || '', 10) || Math.max(2, Math.floor(os.cpus().length / 2)));
  const oldPlan = Array.isArray(plan?.old) && plan.old.length ? plan.old : null;
  const oldLabel = oldPlan ? String(plan.oldLabel || 'the old code') : oldRef;
  const oldNames = oldPlan ? oldPlan.map(o => o.file) : oldFiles;
  const hasOld = Boolean(oldPlan || oldRef);
  // A --changed-since plan with no kept break and no old code still runs green on the test machine (2026-11-16).
  if (!repo || !command.length || (oldRef ? !oldFiles.length : false) || (!hasOld && !breaks.length && !warm && !scopeFiltered && !(plan?.partial && green))) usage();
  if (warm && (hasOld || breaks.length)) { say('RED-PROOF: --warm only prepares the kept copies; run it alone, before the proof.'); process.exit(2); }
  // The time each run (and the compile check) may take (2026-11-09: a run hung 25 minutes, unseen).
  const timeoutMin = opt('--timeout-min') === undefined ? 15 : Number(opt('--timeout-min'));
  if (!(timeoutMin > 0)) { say('RED-PROOF: --timeout-min needs a number of minutes above 0.'); process.exit(2); }
  const limitMs = Math.round(timeoutMin * 60000);
  // cmd.exe without /c opens a prompt that runs nothing (2026-11-09: Git Bash turned /c into C:/).
  if (/^cmd(?:\.exe)?$/i.test(String(command[0]).split(/[\\/]/).pop()) && !command.slice(1).some(a => /^\/c$/i.test(a))) {
    refuse('RED-PROOF: cmd.exe without /c runs nothing and waits for typed input. Git Bash turns /c into C:/; write //c there. Better: pass test settings with --test-env, not a .cmd wrapper. Nothing ran.');
  }
  // The old-code run swaps product files only; a test file there would run the old tests (2026-11-12, S7:
  // "No test files found" then read as red).
  const testsNamed = oldNames.filter(f => TEST_FILE.test(f));
  if (testsNamed.length) {
    refuse(`RED-PROOF: --files names test file(s): ${testsNamed.join(', ')}. The old-code run puts back the fix's product files, and the new tests must stay; list only the product files of the fix. Nothing ran.`);
  }
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  // The --changed-since ref: a commit or a tree git knows (2026-11-16).
  if (since !== null) {
    let known = false;
    try { known = Boolean(git('rev-parse', '--verify', '-q', since + '^{tree}').toString('utf8').trim()); } catch { /* not known */ }
    if (!known) refuse(`RED-PROOF: unknown --changed-since ref ${since}; nothing ran.`);
  }
  // --at <commit> (2026-11-19): a proof for a pinned commit is true only when the work tree is that commit at the
  // start. The sync to the test machine sends the working tree, so a dirty tree or another HEAD is refused here.
  const at = !plan && opts.includes('--at') ? String(opt('--at') ?? '') : null;
  if (at !== null) {
    const one = (...a) => { try { return git(...a).toString('utf8').trim(); } catch { return null; } };
    const pin = !at || at.startsWith('-') ? null : one('rev-parse', '--verify', '-q', at + '^{commit}');
    if (!pin) refuse(`RED-PROOF: --at needs a commit git knows${at && !at.startsWith('-') ? ` (unknown: ${at})` : ''}. Nothing ran.`);
    const head = one('rev-parse', '--verify', '-q', 'HEAD^{commit}');
    if (head !== pin) refuse(`RED-PROOF: --at ${pin.slice(0, 12)}: the work tree is at ${head ? head.slice(0, 12) : 'no commit'}, not at that commit. Check out the pinned commit, or pin the commit you are on. Nothing ran.`);
    const dirty = one('status', '--porcelain', '--untracked-files=all');
    if (dirty === null || dirty) {
      const names = (dirty || '').split(/\r?\n/).filter(Boolean).map(l => l.slice(3));
      refuse(`RED-PROOF: --at ${pin.slice(0, 12)}: the work tree is not that commit${names.length ? `: ${names.length} file(s) differ (${names.slice(0, 4).join(', ')}${names.length > 4 ? ', …' : ''})` : ' (git status failed)'}. Commit them and pin the new commit. Nothing ran.`);
    }
  }
  // On the test machine, the commit its sync made (2026-11-12, S3): it must be there.
  if (plan?.commit) {
    let there = false;
    try { there = /^[0-9a-f]{7,64}$/i.test(String(plan.commit)) && Boolean(git('cat-file', '-e', plan.commit + '^{commit}')); } catch { /* not there */ }
    if (!there) { say(`RED-PROOF: the synced commit ${String(plan.commit).slice(0, 12)} is not on this machine; run the proof again (it syncs again).`); process.exit(2); }
  }
  // A file as the runs will see it: the synced commit's on the test machine, else the working folder's.
  const textAt = (file) => (plan?.commit ? git('show', `${plan.commit}:${file}`).toString('utf8') : fs.readFileSync(path.join(repo, file), 'utf8'));
  for (const b of breaks) {
    b.file = b.file.replace(/\\/g, '/');
    let hits = 0;
    try { hits = breakHits(textAt(b.file), b.find); } catch { /* no such file */ }
    if (hits !== 1) { say(`RED-PROOF: ${b.single ? '--find' : `break "${b.name}"`} matches ${hits} time(s) in ${b.file}; it must match exactly once. Nothing changed.`); process.exit(2); }
  }
  let oldSha = '';
  if (oldRef) {
    try { oldSha = String(git('rev-parse', '--verify', oldRef + '^{commit}')).trim(); }
    catch { say(`RED-PROOF: unknown --old ref ${oldRef}`); process.exit(2); }
  }
  // The test files proved, and the files the breaks change: hashed before anything changes.
  const base = opt('--base') || defaultBase(repo);
  // The FOREIGN? guard (change-set.mjs, 2026-11-19), before any run: a folder that is most likely another session's
  // is named with the one shared text. Read only on the machine that asks. Any git error skips it.
  if (!plan) {
    let foreign = [];
    try { foreign = changeSet(repo, base).foreign || []; } catch { foreign = []; }
    if (foreign.length) {
      for (const l of String(foreignLine(foreign)).split(/\r?\n/).filter(Boolean)) say(l);
      refuse('RED-PROOF: the work tree holds files that are most likely not this task\'s (FOREIGN? above); a proof of that tree would not be this change\'s. Nothing ran.');
    }
  }
  const testFiles = changedTestFiles(repo, base);
  const fileHashes = testFiles ? testFileHashes(repo, testFiles) : null;
  let targetHashes = {};
  try { targetHashes = plan ? {} : testFileHashes(repo, [...new Set(breaks.filter(b => !b.single).map(b => b.file))]); } catch { /* checked above */ }
  // A mustFail part that holds a new test and an older one stops here, before the test machine, the compile
  // check or any copy (2026-11-14, see ambiguousParts). New means new since the merge base with --base. Read
  // only on the machine that asks: the test machine's base is the synced commit, where no test is new. Any
  // git or read error skips the check (the proof then reads as before), so it never refuses by mistake.
  let newTests = null; // the tests this change added, for the evidence rows at the end (2026-11-19)
  if (!plan && testFiles?.length && (hasOld || breaks.some(b => !b.single))) {
    let tests = [];
    try {
      const from = git('merge-base', base, 'HEAD').toString('utf8').trim();
      const had = new Set(git('--literal-pathspecs', 'ls-tree', '-r', '--full-tree', '--name-only', '-z', from, '--', ...testFiles).toString('utf8').split('\0').filter(Boolean));
      tests = testFiles.flatMap(f => markNewTests(textAt(f), had.has(f) ? git('show', `${from}:${f}`).toString('utf8') : null, f));
    } catch { tests = []; }
    newTests = tests.filter(t => t.isNew);
    const unclear = ambiguousParts(breaks, tests);
    if (unclear.length) {
      const list = (titles) => titles.slice(0, 4).map(t => `"${t}"`).join(', ') + (titles.length > 4 ? ` (+${titles.length - 4} more)` : '');
      for (const u of unclear) say(`  BREAK AMBIGUOUS ✗ ${u.name}: mustFail part "${u.part}" holds new test(s) ${list(u.fresh)} and older test(s) ${list(u.older)}`);
      say('RED-PROOF: NOT PROVED ✗ — every test whose title holds a mustFail part must fail, so each older test above would have to fail under that break too; name each test by words of its own title (a part may still name an older test alone). Nothing ran; files untouched.');
      process.exit(2);
    }
  }
  // A new "nothing happens" check this proof would leave unproven stops here too, before the test machine, the
  // compile check or any copy (2026-11-15: one test file's checks were proven only by the old-code run; after a
  // full PROVED proof pre-review said UNPROVEN ×6, and the whole proof ran again with one more break). Pre-review
  // (check-test-asserts.mjs) counts such a check only when a current record entry names the test that holds its
  // line among the tests its breaks made fail (2026-11-17, audit "one caught test certifies another rule's vacuous
  // negative check": it went by whole test file, so an unrelated caught test in the file passed the check, and
  // this refusal let the proof run). So the lines it would refuse are the new "nothing happens" lines (newLines and
  // nothingChecks of new-lines.mjs, which it reads too) in the test files this command runs (proofScope), less the
  // lines whose own test a mustFail part of this run names (namedBy: a caught break makes every test it names fail)
  // and those whose own test another entry proves as the code is now. A line in no test (a helper, a hook) can be
  // proven by no break, so it is refused too. A run with
  // --breaks replaces its own entry (same command and folder), so that entry does not count; --old alone leaves
  // the record as it is, so with such checks unproven it is refused the same way, and a test an earlier break run
  // of this command proved still counts. One --break is not checked: it is for a test of code that already works
  // and never writes the record. Any git or read error skips the check, so it never refuses by mistake.
  if (!plan && testFiles?.length && (hasOld || breaks.some(b => !b.single))) {
    let unproven = [];
    try {
      const parts = breaks.filter(b => !b.single).flatMap(b => b.mustFail.map(String));
      const entries = readRecord(repo);
      const cwdRel = path.relative(repo, cwdHere).replace(/\\/g, '/');
      if (entries && parts.length) delete entries.entries[recordKey(command, cwdRel)];
      const scope = new Set(proofScope(command, testFiles, cwdRel));
      const spans = new Map();
      const ownOf = (l) => { if (!spans.has(l.file)) spans.set(l.file, testSpans(textAt(l.file), l.file)); return enclosingTest(spans.get(l.file), l.line); };
      let proven = null;
      for (const l of nothingChecks(newLines(repo, base) || [])) {
        if (!scope.has(l.file)) continue;
        const own = ownOf(l);
        if (namedBy(parts, own)) continue;
        if (own && provenHas((proven ??= provenTests(repo, entries)).get(l.file), own)) continue;
        // A line in a helper: a test of the file that calls the helper and is named here (or proven) counts (2026-11-17).
        if (!own && helperCallers(textAt(l.file), spans.get(l.file) || [], l.line).some(c => namedBy(parts, c)
          || provenHas((proven ??= provenTests(repo, entries)).get(l.file), c))) continue;
        unproven.push({ ...l, own });
      }
    } catch { unproven = []; }
    if (unproven.length) {
      const byFile = new Map();
      for (const l of unproven) byFile.set(l.file, [...(byFile.get(l.file) || []), l]);
      for (const [file, lines] of byFile) {
        say(`  UNPROVEN ✗ ${file}: ${lines.length} new "nothing happens" check(s) whose own test no break here names`);
      }
      // Every line, up to 40, then a count (2026-11-19: three lines per file were shown, and 8 unproven checks took two tries).
      for (const l of unproven.slice(0, UNPROVEN_SHOWN)) say(`    ${l.file}:${l.line} — ${l.text.trim().slice(0, 160)} → ${proofHint(l.own)}`);
      if (unproven.length > UNPROVEN_SHOWN) say(`    … and ${unproven.length - UNPROVEN_SHOWN} more line(s) not shown`);
      say('RED-PROOF: NOT PROVED ✗ — pre-review counts a new "nothing happens" check only when a --breaks run caught a break whose mustFail names the test that holds that check; another caught test in the same file does not count. Add a break of each such test\'s rule whose mustFail names that test (a run on the old code does not count for these lines). Nothing ran; files untouched.');
      process.exit(2);
    }
  }
  // --check-plan ends here (2026-11-19): every check above ran, and nothing else does. One more check is its own:
  // every mustFail part must name a test. A part in no title of the changed test files may still name an older
  // test, so it is refused only when no file of the repository holds its words (the breaks file itself left out).
  if (checkPlan) {
    const lost = [];
    try {
      const titles = (testFiles || []).flatMap(f => { try { return declaredTests(textAt(f), f); } catch { return []; } }).flatMap(d => d.titles.map(x => String(x).toLowerCase()));
      const own = opt('--breaks') ? path.relative(repo, path.resolve(opt('--breaks'))).replace(/\\/g, '/') : '';
      const spec = ['--', '.', ...(own && !own.startsWith('..') && !path.isAbsolute(own) ? [`:(exclude)${own}`] : [])];
      for (const b of breaks.filter(x => !x.single)) for (const part of b.mustFail.map(String)) {
        if (part && titles.some(x => x.includes(part.toLowerCase()))) continue;
        let held = Boolean(part);
        if (held) { try { git('grep', '-q', '-i', '-F', '--untracked', '-e', part, ...spec); } catch (e) { held = e.status !== 1; } }
        if (!held) lost.push({ name: b.name, part });
      }
    } catch { lost.length = 0; }
    if (lost.length) {
      for (const l of lost) say(`  BREAK UNNAMED ✗ ${l.name}: mustFail part "${l.part}" names no test: no test title and no file here holds these words`);
      say('RED-PROOF: NOT PROVED ✗ — every mustFail part must be words of the own title of a test this command runs. Nothing ran; files untouched.');
      process.exit(2);
    }
    const count = breaks.filter(x => !x.single).length;
    say(`RED-PROOF: plan checked — ${count} break(s): each is filled in and its find matches once, no mustFail part is ambiguous or names no test, and no new "nothing happens" check is left unproven. No run started, no test machine contacted, no copy taken.`);
    say('PLAN OK');
    process.exit(0);
  }
  // Fix files that only add names the tests use stay at the fixed version for the old-code run (addedNames).
  const buildTests = plan ? (plan.buildTests || []) : (newTests || []).filter(t => inProofCwd(t.file));
  const keptAtFix = [];
  const oldMissingNames = new Set(Array.isArray(plan?.oldMissingNames) ? plan.oldMissingNames : []);
  const oldTestCode = new Map();
  const oldTestFiles = plan ? plan.testFiles : testFiles;
  if (hasOld && Array.isArray(oldTestFiles)) for (const f of oldTestFiles) {
    try { oldTestCode.set(f, testCode(textAt(f), f)); } catch { /* no test code to check */ }
  }
  if (oldRef && !plan && oldTestCode.size) {
    const testText = [...oldTestCode.values()].join('\n');
    const namesUsedByTests = codeNames(testText);
    const files = [];
    for (const f of oldFiles) {
      let oldText = null, fixedText = '', diff;
      try { oldText = git('show', `${oldRef}:${f}`).toString('utf8'); } catch { /* a new file: every line is added */ }
      try { fixedText = textAt(f); } catch { /* a removed file has no code now */ }
      try {
        diff = oldText !== null ? git('diff', '--no-color', '-U0', oldRef, '--', f).toString('utf8')
          : fixedText.split(/\r?\n/).map(l => '+' + l).join('\n');
      } catch { continue; }
      if (!diff) continue;
      const before = testCode(oldText || '', f);
      const beforeNames = codeNames(before), fixedNames = codeNames(testCode(fixedText, f));
      const added = addedLines(diff);
      files.push({ file: f, beforeNames, fixedNames, addOnly: added.length > 0 });
      const names = namesOnAddedLines(added, before, testText, f).filter(n => fixedNames.has(n));
      if (names.length) keptAtFix.push({ file: f, names });
    }
    // 2026-11-20: a related caller with edited lines hid the real old behavior.
    const shared = [...new Set(keptAtFix.flatMap(k => k.names))];
    for (const f of files) {
      if (!f.addOnly || keptAtFix.some(k => k.file === f.file)) continue;
      const names = shared.filter(n => f.fixedNames.has(n) || f.beforeNames.has(n));
      if (names.length) keptAtFix.push({ file: f.file, names, related: true });
    }
    if (keptAtFix.length === files.length) keptAtFix.length = 0; // no changed file would go back
    for (const f of files) if (!keptAtFix.some(k => k.file === f.file)) {
      for (const name of namesUsedByTests) if (f.fixedNames.has(name) && !f.beforeNames.has(name)) oldMissingNames.add(name);
    }
  }
  const oldRun = oldFiles.filter(f => !keptAtFix.some(k => k.file === f));
  for (const k of keptAtFix) say(`RED-PROOF: ${k.file} stays at the fix for the old-code run: ${k.related ? 'it declares or uses the same new names' : 'it only adds lines, and the tests use its new names'} (${k.names.slice(0, 4).join(', ')}).`);
  // Product files that differ from the old code but are not in --files stay at the fix for the old-code
  // run (2026-11-12, S7: a fix file left out made a mix of old and new read as "fails on the old code").
  if (oldRef && !plan) {
    const list = (...a) => { try { return git(...a).toString('utf8').split(/\r?\n/); } catch { return []; } };
    const differ = [...new Set([...list('diff', '--name-only', oldRef), ...list('ls-files', '--others', '--exclude-standard')])]
      .filter(f => f && !TEST_FILE.test(f) && !/\.md$/i.test(f) && !oldFiles.includes(f)).sort();
    if (differ.length) say(`RED-PROOF: WARNING — product file(s) differ from ${oldRef} but are not in --files, so the old-code run keeps them at the fix: ${differ.slice(0, 8).join(', ')}${differ.length > 8 ? ` (+${differ.length - 8} more)` : ''}. If the fix is in one of them, add it to --files.`);
  }
  // --changed-since (2026-11-16): only the breaks the change since <ref> can reach run (keptSince), here or on the
  // test machine: the list is cut before its plan is built. Every break was checked above (it matches once, no part
  // is ambiguous or leaves a check unproven), so the full proof later refuses nothing new. `partial` ({ ref, of })
  // makes the verdict PARTIAL and keeps the proof record as it is; on the test machine it comes in the plan.
  const partial = since !== null ? { ref: since, of: breaks.length }
    : plan?.partial ? { ref: String(plan.partial.ref || ''), of: Number(plan.partial.of) || 0 } : null;
  if (since !== null) {
    let changed;
    try {
      const list = (...a) => git(...a).toString('utf8').split('\0').filter(Boolean);
      changed = [...new Set([...list('diff', '--name-only', '--no-renames', '--relative', '-z', since, '--'), ...list('ls-files', '--others', '--exclude-standard', '-z')])];
    } catch (e) {
      say(`RED-PROOF: could not list the files changed since ${since} — ${(String(e.stderr || '').trim().split(/\r?\n/).pop() || e.message)}; nothing ran.`);
      process.exit(2);
    }
    const kept = keptSince(breaks, changed, textAt);
    const also = [hasOld && 'the old code', green && 'green'].filter(Boolean).join(' and ');
    say(kept.length
      ? `RED-PROOF: PARTIAL — ${kept.length} of ${breaks.length} break(s) changed since ${since}: ${kept.map(b => b.name).join(', ')}; ${kept.length === breaks.length ? 'that is every break' : 'the others are not run'}.`
      : `RED-PROOF: PARTIAL — 0 of ${breaks.length} break(s) changed since ${since}; no break is run${also ? `, only ${also}` : ''}.`);
    breaks = kept;
    if (!kept.length && !hasOld && !green) {
      say(`RED-PROOF: PARTIAL ✓ — 0 of ${partial.of} break(s) run (none changed since ${since}), and no --old or --then-green run was asked, so nothing ran; run the full proof (without --changed-since) once before the final review.`);
      process.exit(0);
    }
  }

  // The proof record's entry of this proof, and whether an older success in it may stand (2026-11-17, audit "stale
  // mutation proof survives dependency edits and even a failed re-proof": a later run of the same proof that failed
  // left the older success in the record, and pre-review went on counting it). Only a --breaks run on the machine
  // that asked keeps an entry (the old code alone, one --break and the test machine's plan run never did). Once its
  // runs start (proofStarts), a full proof marks its entry not ok at once, so a run that is stopped or killed leaves
  // no older success behind. When the process ends without PROVED written, the entry says why. A --changed-since
  // run writes no success and no mark at its start: it takes the entry back only when it ends in a failure after
  // its runs started. `code` is the id of the code under test a full proof will record (codeFingerprint), taken
  // before any file is swapped here, or before the sync when the runs go to the test machine.
  if (scopeFiltered && !hasOld && !breaks.length && !green && !warm) process.exit(0);
  const recordCwd = path.relative(repo, cwdHere).replace(/\\/g, '/');
  const keepsRecord = !plan && (partial ? partial.of > 0 : breaks.some(b => !b.single));
  // The run facts (green on this tree, red on the old code) are kept for a proof with breaks and also for one with only an
  // old-code run (2026-11-19): else an honest --old proof left nothing for the checks before review to read.
  const keepsFacts = !plan && !partial && (keepsRecord || hasOld);
  const proof = { key: recordKey(command, recordCwd), proved: false, code: '', why: '' };
  function takeBack(reason) {
    try { writeEntry(repo, proof.key, { ok: false, reason: String(reason).slice(0, 300), base, command, cwd: recordCwd, ...(partial ? { partial: true } : {}) }); }
    catch { /* not written: an entry's code id still voids it after any edit */ }
  }
  function proofStarts() {
    if (!keepsRecord) return;
    if (!partial) takeBack('the proof started and did not end: it was stopped or killed before its result');
    process.on('exit', (code) => {
      // A --changed-since run takes a full proof back only on a real test verdict (exit 1: a break not caught, or red
      // on the fix); a machine, timeout or connection stop (3/4/5/6/255) says nothing about the tests (2026-11-17, audit).
      if (proof.proved || (partial && code !== 1)) return;
      takeBack(proof.why || [...said].reverse().find(l => /^RED-PROOF: /.test(l)) || `the proof ended with exit ${code}`);
    });
  }

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
    const rel = recordCwd;
    // The env file is read on the test machine: only its path crosses over, never a value. The repository's default
    // (sanad.remoteTestEnv, a database connection) goes only to `dotnet` runs; --test-env always applies.
    const dotnetRun = isDotnetCommand(command);
    const envFile = (opt('--test-env') || (dotnetRun ? gitText(['config', '--get', 'sanad.remoteTestEnv']) : '')).replace(/\\/g, '/');
    const remoteCmd = [q(remoteNode), q(dir + '/red-proof.mjs'), '--repo', q(remoteRepo), '--local', '--plan', q(dir + '/' + planName),
      ...(opt('--parallel') ? ['--parallel', String(parallel)] : []), '--timeout-min', String(timeoutMin), ...(envFile ? ['--test-env', q(envFile)] : []),
      '--base', 'HEAD', '--cwd', q(rel ? remoteRepo + '/' + rel : remoteRepo), '--log', q(dir + '/' + logName),
      '--', q(exe), ...command.slice(1).map(q)].join(' ');
    if (opts.includes('--show-remote')) { say(`RED-PROOF: on ${remoteHost} this runs: ${remoteCmd}`); process.exit(0); }
    const dbContainer = gitText(['config', '--get', 'sanad.remoteDbContainer']);
    const watchDb = dotnetRun && !warm && Boolean(dbContainer);
    let dbReady = false, dbPreflight;
    if (watchDb) {
      // 2026-11-20: keep startup beside the compile check and the first green run.
      const pre = spawn(gitBash().exe, [path.join(os.homedir(), '.claude', 'scripts', 'remote', 'remote-preflight.sh'), '--db'],
        { cwd: repo, env: bashEnv(), windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      let preResult = '', preError = '';
      const readPreflight = (line) => {
        if (/^(?:READY|DB-DOWN|DOCKER-DOWN|FAILED|NO-REMOTE|REMOTE-DOWN)\b/.test(line)) preResult = line.slice(0, 400);
      };
      for (const stream of [pre.stdout, pre.stderr]) {
        let rest = '';
        stream.setEncoding('utf8');
        stream.on('data', chunk => {
          const lines = (rest + chunk).split(/\r?\n/);
          rest = lines.pop().slice(0, 400);
          lines.forEach(readPreflight);
        });
        stream.on('end', () => readPreflight(rest));
      }
      const stop = () => stopTree(pre.pid);
      process.once('exit', stop);
      dbPreflight = new Promise(resolve => {
        const timer = setTimeout(() => { stop(); resolve({ reason: 'database check timed out' }); }, 8 * 60 * 1000);
        pre.on('error', error => { preError = error.message; });
        pre.on('close', status => {
          clearTimeout(timer);
          process.removeListener('exit', stop);
          dbReady = status === 0 && /^READY\b/.test(preResult);
          resolve({ ready: dbReady, down: status === 4 || /^REMOTE-DOWN\b/.test(preResult),
            reason: preResult || preError || `database check ended with exit ${status}` });
        });
      });
    }
    // The code id this machine will record (2026-11-17): the code as it is when the proof is sent. It is taken
    // before the sync, and after the sync the working tree must still be the tree the sync sent (below), so the id
    // is of the code the test machine runs; an edit in between leaves an id no later check will match.
    // 2026-11-20 (V1): the tree as git builds it (the way the sync does) is taken on both sides of the code id. When the
    // folder moved between them, or the sync sent another tree, the code id is of other code than the one sent.
    let treeBefore = '';
    if (keepsFacts || keepsRecord) { treeBefore = treeId(repo); proof.code = codeFingerprint(repo); if (treeId(repo) !== treeBefore) treeBefore = ''; }
    const sync = spawnSync(gitBash().exe, [path.join(os.homedir(), '.claude', 'scripts', 'remote', 'remote-sync.sh')], { cwd: repo, env: bashEnv(), encoding: 'utf8', windowsHide: true, timeout: 10 * 60 * 1000 });
    const syncOut = (sync.stdout || '') + (sync.stderr || '');
    const remoteDown = 'RED-PROOF: REMOTE-DOWN — the test machine does not answer. Ask the user before running here (--local).';
    if (sync.status === 4 || /^REMOTE-DOWN\b/m.test(syncOut)) { say(remoteDown); process.exit(4); }
    const synced = /SYNCED \S+ (\w+) tree (\w+)/.exec(syncOut);
    if (!synced) { say('RED-PROOF: the test machine was not synced — ' + (syncOut.split(/\r?\n/).find(l => /NO-REMOTE|REMOTE-DIRTY|FAILED|fatal|error/i.test(l)) || 'no SYNCED line')); process.exit(2); }
    // The address remote-sync reached when the machine's name did not answer (its VIA line).
    const via = /^VIA (\S+)/m.exec(syncOut);
    const viaOpt = via ? ['-o', 'HostName=' + via[1]] : [];
    say(`RED-PROOF: on ${remoteHost}${via ? ' at ' + via[1] : ''} (${synced[1].slice(0, 12)})`);
    // The log names the tree the sync sent: the one the runs there test.
    if (state.logPath) state.head = stamp(synced[2]);
    // The record is about this machine's code: its tree now (built the way the sync builds the tree it sends) must
    // be the tree the sync sent (2026-11-17). When it is not, the proof still runs, and no success is recorded.
    if ((keepsFacts || keepsRecord) && (!treeBefore || treeBefore !== synced[2])) {
      proof.why = treeBefore ? `the working tree here (${treeBefore.slice(0, 12)}) is not the tree the sync sent (${synced[2].slice(0, 12)}): a file changed while the proof was sent` : 'the folder changed while the code id of this proof was taken, before the sync';
      say('RED-PROOF: the folder changed before the sync: no resume, no saved results for this run (the proof still runs and judges as before).');
    }
    if (keepsFacts && !proof.why) {
      const here = treeId(repo);
      if (here !== synced[2]) proof.why = `the working tree here (${here.slice(0, 12)}) is not the tree the sync sent (${synced[2].slice(0, 12)}): a file changed while the proof was sent`;
    }
    // 2026-11-19: a break already caught on this exact tree (the rule the local resume uses) is not sent again. Any
    // doubt, or nothing left to send, sends them all. sendIdx maps a break's place in the plan back to its place here.
    let sendBreaks = breaks, sendIdx = breaks.map((_, i) => i);
    const droppedCaught = [];
    const remoteRun = `${Date.now().toString(36)}-${process.pid}`;
    if (keepsRecord && !partial && !proof.why && !opts.includes('--fresh') && !breaks.some(b => b.single)) {
      try {
        const rec = readRecord(repo);
        const states = breakStates(repo, proof.key, breaks, proof.code, rec);
        // 2026-11-20 (V1): as the local resume, only a break this session's log shows caught on this tree is not sent.
        const held = states.map((s, i) => i).filter(i => states[i].state === 'proved' && states[i].counts);
        const sess = held.length ? await sessionCaught(repo) : { why: '', keys: new Set() };
        const skip = new Set(held.filter(i => sess.keys.has(states[i].id + ' ' + proof.code)));
        const refusedHere = held.length - skip.size;
        const kept = states.map((s, i) => i).filter(i => !skip.has(i));
        if (!skip.size && refusedHere) say(`Resume refused for ${refusedHere} of ${breaks.length} breaks: saved for this tree, but ${refusedWhy(sess)}; sending all ${breaks.length}`);
        if (kept.length && kept.length < breaks.length) {
          states.forEach((s, i) => {
            if (!skip.has(i)) return;
            for (const [file, list] of Object.entries(rec.perBreak[proof.key][s.id].caught || {})) for (const t of list) droppedCaught.push({ file, ...t, by: String(breaks[i].name) });
          });
          sendBreaks = kept.map(i => breaks[i]); sendIdx = kept;
          say(`RESUMED ${breaks.length - kept.length} of ${breaks.length} breaks from saved results of this tree; sending the other ${kept.length}${resumeNote(refusedHere, refusedWhy(sess))}`);
        }
      } catch { sendBreaks = breaks; sendIdx = breaks.map((_, i) => i); droppedCaught.length = 0; }
    }
    // A new run for this tree starts: the saved pass of the tree is withdrawn first (written again only on success).
    if (green && (keepsRecord || keepsFacts) && proof.code) { try { withdrawRunFacts(repo, proof.key, proof.code); } catch (e) { if (e && e.code === 'RECORD_BUSY') refuse('RED-PROOF: the saved pass of this tree cannot be withdrawn: the proof record is busy. Run the command again.'); } }
    const local = fs.mkdtempSync(path.join(os.tmpdir(), 'sanad-proof-'));
    // The commit this sync made goes with the plan: the test machine tests it, not whatever HEAD it has by
    // then (2026-11-12, S3). The changed test files go too: there, nothing differs from that commit.
    fs.writeFileSync(path.join(local, planName), JSON.stringify({
      oldLabel: oldRef, green, breaks: sendBreaks, commit: synced[1], testFiles: testFiles || [],
      warm, kept: keptAtFix.map(k => k.file), ...(partial ? { partial } : {}), ...(scopeFiltered ? { scopeFiltered } : {}),
      ...(oldMissingNames.size ? {
        oldMissingNames: [...oldMissingNames], buildTests,
        resumedBreaks: breaks.filter((_, i) => !sendIdx.includes(i)).map(({ name, mustFail }) => ({ name, mustFail })),
      } : {}),
      ...(watchDb ? { watchDb: true } : {}),
      old: hasOld ? oldRun.map(f => { try { return { file: f, content64: git('show', `${oldRef}:${f}`).toString('base64') }; } catch { return { file: f, content64: null }; } }) : [],
    }));
    const here = path.dirname(fileURLToPath(import.meta.url));
    const scripts = proofScripts(here);
    for (const f of scripts) fs.copyFileSync(path.join(here, f), path.join(local, f));
    // BatchMode: a password prompt nobody can answer fails at once instead of waiting.
    const sshOpts = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', ...viaOpt];
    spawnSync('ssh', [...sshOpts, remoteHost, windows ? `if not exist "${dir.replace(/\//g, '\\')}" mkdir "${dir.replace(/\//g, '\\')}"` : `mkdir -p '${dir}'`], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
    // scp reads "C:/..." as a host name, so it copies by file name from inside the folder.
    const scp = spawnSync('scp', ['-q', ...sshOpts, planName, ...scripts, `${remoteHost}:${dir}/`], { cwd: local, encoding: 'utf8', windowsHide: true, timeout: 120000 });
    if (scp.status !== 0) { say('RED-PROOF: could not copy the proof to the test machine — ' + ((scp.stderr || '').trim().split(/\r?\n/).pop() || 'scp failed')); process.exit(2); }
    // Each line as it comes, so a long proof is never silent. The runs there stop at their own limit;
    // this wait is the backstop for a lost connection.
    const runs = (hasOld ? 1 : 0) + sendBreaks.length + (green ? (watchDb ? 2 : 1) : 0) + (warm ? 1 : 0);
    const waitMin = Math.ceil(timeoutMin * (runs + 2) + 10);
    // The proof is sent: its runs start there now (2026-11-17, see proofStarts).
    proofStarts();
    // The failing tests of each caught break, as the test machine's runner named them (its RED-PROOF-CAUGHT lines).
    const sentCaught = [];
    let sentOldRed = null, reportedCaught = 0;
    let dbUnavailable;
    const r = await new Promise((resolve) => {
      const child = spawn('ssh', ['-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=6', ...sshOpts, remoteHost, remoteCmd], { windowsHide: true, stdio: [watchDb ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
      if (watchDb) child.stdin.on('error', () => { /* ssh's exit reports a lost connection */ });
      const show = (l) => {
        if (watchDb && l === 'RED-PROOF-DB-START: ready?') {
          child.stdin.write(dbReady ? 'ready\n' : 'pending\n');
          return;
        }
        if (watchDb && l === 'RED-PROOF-DB-WAIT: ready?') {
          dbPreflight.then(result => {
            if (child.stdin.destroyed || child.stdin.writableEnded) return;
            if (!result.ready) dbUnavailable = result;
            child.stdin.end(result.ready ? 'ready\n' : 'unavailable\n');
          });
          return;
        }
        const oldNames = readOldRedLine(l);
        if (oldNames) { sentOldRed = oldNames; return; }
        // The passing run's line: its fact is saved now, under the code id taken before the sync (2026-11-20, V1).
        if (isGreenLine(l)) {
          if (green && (keepsRecord || keepsFacts) && proof.code && !proof.why) { try { writeRunFacts(repo, proof.key, { tree: proof.code, run: remoteRun, green: true }); } catch { /* not saved */ } }
          return;
        }
        const sent = readCaughtLine(l);
        if (sent) {
          sent.i = sendIdx[sent.i];
          sentCaught.push(sent);
          // Saved now, as its line arrives (2026-11-19), not only when the whole proof ends.
          if (keepsRecord && !partial && proof.code && !proof.why && breaks[sent.i] && !breaks[sent.i].single) {
            try {
              const b = breaks[sent.i];
              const sp = (testFiles || []).flatMap(f => { try { return testSpans(textAt(f), f); } catch { return []; } });
              writeBreakResult(repo, proof.key, b, { state: 'caught', tree: proof.code, run: remoteRun, ms: null, caught: caughtTests(b.mustFail, sent.failed, namePairs(), sp) });
            } catch { /* not saved: the end of the proof still records it */ }
          }
          // The caught result's own line, with the tail (2026-11-20, U2): a proof stopped before its report still shows it.
          if (keepsRecord && !partial && proof.code && !proof.why && breaks[sent.i] && !breaks[sent.i].single) say(`  BREAK ✓ ${breaks[sent.i].name}: caught on the test machine${caughtTail(breakId(breaks[sent.i]), proof.code)}`);
          return;
        } // read for the record: the BREAK ✓ line of the report says it again
        // A caught line of the report gets the tail of this machine's own break id and code id (the test machine does not
        // know them). The report lists the caught breaks in the plan's order, as the RED-PROOF-CAUGHT lines named them.
        const caughtRow = /^(\s*BREAK ✓ )(.+?): all \d+ named test\(s\) fail\s*$/.exec(l);
        if (caughtRow && keepsRecord && proof.code && !proof.why) {
          const order = [...new Set(sentCaught.map(c => c.i))].sort((a, b) => a - b);
          const at = order[reportedCaught++];
          if (at !== undefined && breaks[at] && !breaks[at].single && String(breaks[at].name) === caughtRow[2]) l += caughtTail(breakId(breaks[at]), proof.code);
        }
        if (l.trim() && !/post-quantum|store now|openssh\.com\/pq/.test(l)) say(l);
      };
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
    const dbFailed = !r.timedOut && r.status === 6 && dbUnavailable;
    const status = r.timedOut ? 5 : r.status === 255 || dbFailed?.down ? 4 : r.status ?? 2;
    const dbVerdict = status === 6 && dbFailed
      ? `RED-PROOF: ENVIRONMENT ✗ — the database on the test machine was not ready (${dbFailed.reason}); nothing proved.` : '';
    if (dbVerdict) say(dbVerdict);
    if (status === 4) say(remoteDown);
    // A machine or database stop (exit 6) says nothing about the code: what this run saved is taken back, as the local path does.
    if (status === 6 && (keepsRecord || keepsFacts)) { try { takeBackRun(repo, remoteRun); } catch { /* an entry's tree still voids it after any edit */ } }
    if (r.error) say('RED-PROOF: could not start ssh — ' + r.error.message);
    if (r.timedOut) say(`RED-PROOF: TIMEOUT ✗ — ${remoteHost} sent no result within ${waitMin} min; each run there stops at its own ${timeoutMin} min limit.`);
    // The test machine's log, with its runs' output, becomes this log under this run's first line; when it
    // cannot be fetched, this run's own lines are written instead (by the exit handler).
    if (state.logPath) {
      spawnSync('scp', ['-q', ...sshOpts, `${remoteHost}:${dir}/${logName}`, logName], { cwd: local, windowsHide: true, timeout: 120000 });
      try { state.remoteLog = fs.readFileSync(path.join(local, logName), 'utf8'); } catch { /* not fetched */ }
      if (state.remoteLog) state.remoteLog = [...deferredBreaks, ...(dbFailed ? [dbVerdict || remoteDown] : []), state.remoteLog].join('\n');
    }
    const there = windows ? dir.split('/').join('\\') + '\\' : dir + '/';
    const mine = [planName, logName].map(n => `"${there}${n}"`).join(' ');
    spawnSync('ssh', [...sshOpts, remoteHost, windows ? `del /q ${mine} 2>nul` : `rm -f ${mine}`], { stdio: 'ignore', windowsHide: true, timeout: 60000 });
    fs.rmSync(local, { recursive: true, force: true });
    // The record is this machine's: the test files and break targets proved are the ones here, unchanged since the sync.
    // 2026-11-17: a passing run that cannot be recorded says why, and its entry stays not ok (proofStarts), so the
    // success of an earlier run does not stand in for it.
    const same = (hashes) => { try { return JSON.stringify(testFileHashes(repo, Object.keys(hashes))) === JSON.stringify(hashes); } catch { return false; } };
    const targets = (() => { try { return testFileHashes(repo, [...new Set(breaks.map(b => b.file))]); } catch { return null; } })();
    // The run facts (2026-11-19): green on this tree, and the new tests red on the old code (the machine says the failing
    // names of its old-code run). Saved under the code id taken before the sync, never the tree as it is now.
    if (status === 0 && (keepsFacts || keepsRecord) && proof.code && !proof.why) {
      if (green) {
        try { writeRunFacts(repo, proof.key, { tree: proof.code, run: remoteRun, green: true, ...(hasOld && sentOldRed ? { redOld: redOldTests(newTests, sentOldRed), old: oldSha } : {}) }); } catch { /* not saved */ }
      } else if (keepsFacts && hasOld && sentOldRed) {
        // No passing run in this call (2026-11-20): the red-on-old facts are saved beside the pass an earlier run left
        // for this same tree (its run id is kept), as the local path does.
        const red = redOldTests(newTests, sentOldRed);
        if (red.length) {
          try {
            const prev = readRecord(repo)?.runs?.[proof.key]?.[proof.code];
            const factsRun = prev && typeof prev.run === 'string' && prev.run ? prev.run : remoteRun;
            writeRunFacts(repo, proof.key, { tree: proof.code, run: factsRun, redOld: red, old: oldSha });
          } catch { /* not saved */ }
        }
      }
    }
    if (status === 0 && keepsRecord && !partial) {
      if (!proof.why && !fileHashes) proof.why = `there is no merge base with ${base}, so the changed test files are not known`;
      if (!proof.why && !same(fileHashes)) proof.why = 'a test file here changed after the proof was sent';
      if (!proof.why && !(targets && breaks.length)) proof.why = 'a file a break changes is not here any more';
      if (proof.why) say(`RED-PROOF: could not write the proof record — ${proof.why}. Run the proof again.`);
      else {
        // The names the test machine's runner printed, matched to the tests this machine's test files declare.
        const pairsHere = namePairs();
        const spansHere = (testFiles || []).flatMap(f => { try { return testSpans(textAt(f), f); } catch { return []; } });
        record(targets, [...sentCaught.flatMap(c => (breaks[c.i] && !breaks[c.i].single
          ? caughtTests(breaks[c.i].mustFail, c.failed, pairsHere, spansHere).map(t => ({ ...t, by: String(breaks[c.i].name) })) : [])), ...droppedCaught], { remote: remoteHost });
      }
    }
    process.exit(status);
  }

  // The proof record entry of a passing --breaks run (2026-11-12, S4/C5/S12/S8): under this command and
  // folder, the tests its breaks made fail and the files the breaks changed. 2026-11-17 (audit): `caught` names
  // those tests one by one ({ line, title, ran, by } per test file; `files` holds the hash of each such file) in
  // place of every changed test file that held one, and `code` is the id of the code under test (proofStarts).
  // `caught` comes from caughtTests: here from each caught break's own run, after a test machine's run from the
  // names it sent.
  function record(targets, caught, extra = {}) {
    // A --changed-since run proved only the breaks it kept: it never writes the record, so pre-review never takes it
    // for the full proof (2026-11-16). Here and after a test machine's run.
    if (partial) return;
    const parts = breaks.filter(b => !b.single).flatMap(b => b.mustFail.map(String));
    if (!parts.length || !testFiles) return;
    if (!proof.code) {
      proof.why = 'git could not give one id of the code under test (its add or write-tree failed)';
      say(`RED-PROOF: could not write the proof record — ${proof.why}`);
      return;
    }
    const byFile = {};
    for (const t of caught) if (fileHashes[t.file]) (byFile[t.file] ||= []).push({ line: t.line, title: t.title, ran: t.ran, by: t.by });
    const files = Object.keys(byFile).sort();
    try {
      writeEntry(repo, proof.key, { ok: true, base, command, cwd: recordCwd, breaks: breaks.length, old: hasOld, green,
        files: Object.fromEntries(files.map(f => [f, fileHashes[f]])), targets, caught: Object.fromEntries(files.map(f => [f, byFile[f]])), code: proof.code, ...extra });
      proof.proved = true;
    } catch (e) { say('RED-PROOF: could not write the proof record — ' + e.message); }
  }

  // One run with some files changed: back up, change, run, always restore. This changes the WORKING FOLDER
  // (one --break, or --parallel 1), so a stop must put the file back (2026-11-12, S13: Ctrl-C or a stopped
  // task left the product file broken; only a --restore hint was printed). Ctrl-C, SIGTERM and Ctrl-Break
  // stop the test run, put the files back and end the proof (exit 2); a thrown error or any other exit puts
  // them back through the exit handler. A hard kill (taskkill /F) runs no handler: the --restore hint stays.
  // The command for one break (2026-11-19): only the tests its mustFail names, built on the machine that runs it.
  // The passing run and the old-code run keep the full command. A narrowed run that ran no test runs once more in
  // full. Any doubt gives the full command (selectCommand). The record key stays the full command.
  async function runForJob(job, cwd, env, control = null) {
    let cmd = command;
    if (job && job.kind === 'break' && !job.b.single) {
      try { const sel = selectCommand(command, job.b.mustFail, selectable, { cwd: path.relative(repo, cwdHere) }); if (sel.narrowed && Array.isArray(sel.command)) cmd = sel.command; } catch { cmd = command; }
    }
    let r = await runProcess(cmd, cwd, env, control);
    // 2026-11-19: a narrowed run that missed a failure the break names is judged only after the full command ran once.
    if (cmd !== command && (ranNoTest(r) || (!r.timedOut && !r.error && breakState(job.b, r).state === 'not-caught'))) r = await runProcess(command, cwd, env, control);
    return r;
  }
  async function swapRun(changes, job = null) {
    if (!swapRun.guarded) {
      swapRun.guarded = true;
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
        process.on(signal, () => {
          for (const pid of running) stopTree(pid);
          const back = putBack();
          say(`RED-PROOF: NOT PROVED ✗ — stopped by ${signal}; ${back ? 'files restored' : 'the files could NOT be restored (see above)'}.`);
          process.exit(2);
        });
      }
    }
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
    swapped = dir;
    try {
      for (const c of changes) {
        const target = path.join(repo, c.file);
        const next = c.content(target);
        if (next === null) { if (fs.existsSync(target)) fs.rmSync(target); }
        else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, next); }
      }
      result = await runForJob(job, cwdHere, runEnv);
    } catch (e) {
      swapError = e;
    } finally {
      if (!putBack()) process.exit(2);
    }
    if (swapError?.noop) return { status: null, stdout: '', stderr: '', noop: true, why: swapError.message };
    if (swapError) { say('RED-PROOF: could not swap the files — ' + swapError.message + '; files restored.'); process.exit(2); }
    return result;
  }
  // One process: no typed input (2026-11-09: an open input pipe let cmd.exe wait for ever), the env
  // file's variables (a kept copy's run: copyRunEnv), and the time limit, past which it and every process it
  // started are stopped.
  // `control` (a kept copy's run): runParallel's stuck watch gets control.stop, which ends the run like the limit.
  function runProcess(argv, cwd, env = runEnv, control = null) {
    return new Promise((resolve) => {
      let stdout = '', stderr = '', settled = false, timedOut = false, grace = null, timer = null;
      const end = (r) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(grace); resolve({ stdout, stderr, timedOut, ...r }); };
      let child;
      try {
        child = spawn(argv[0], argv.slice(1), { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      } catch (error) { end({ status: null, error }); return; }
      if (child.pid) { running.add(child.pid); child.on('close', () => running.delete(child.pid)); }
      timer = setTimeout(() => { timedOut = true; stopTree(child.pid); }, limitMs);
      if (control) control.stop = () => { timedOut = true; stopTree(child.pid); };
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
  const logs = state.logs;
  function read(result, label) {
    const output = (result.stdout || '') + (result.stderr || '');
    logs.push(`===== ${label} =====\n${hide(output)}`);
    if (result.error) { say(`RED-PROOF: the test command could not run — ${result.error.message}`); finish(2); }
    return { output, code: result.status, why: result.status !== 0 ? failureReasons(output) : [] };
  }
  // The log opens with its tree line and this run's own lines (review-brief.mjs --proof-log reads them),
  // then each run's output; the exit handler writes it, on this exit and on every other.
  function finish(code) { process.exit(code); }
  function setupStop(r, { oldCode = false, buildError = false } = {}) {
    const setup = r.why.filter((w) => w.kind === 'setup');
    if (setup.length || buildError || (!r.why.length && r.code !== 0 && SETUP_OUTPUT.test(r.output))) {
      showWhy(r);
      // The old code without names the new tests use: say which, and the way out.
      const missing = oldCode ? [...new Set([...r.output.matchAll(/error CS\d+:.*?(?:definition for|The name|namespace name) '(\w+)'/g)].map(m => m[1]))] : [];
      if (missing.length) say(`RED-PROOF: the old code lacks names the tests use: ${missing.slice(0, 6).join(', ')}. The fix file that declares them also changes lines, so it cannot stay at the fix: prove that file with --breaks alone, or move the new names into a file that only adds lines.`);
      say(`RED-PROOF: SETUP ✗ — ${setup.length || 'the run'} failed for a setup reason (element not found, type or build error, timeout), not because of the code. Fix the test or the machine, then run again; files restored.`);
      finish(3);
    }
  }
  function showWhy(r) { for (const w of r.why.slice(0, 12)) say(`  ${w.kind === 'assert' ? '✓ assert' : w.kind === 'setup' ? '✗ setup ' : w.kind === 'env' ? '✗ env   ' : w.kind === 'missing' ? '? missing' : '? other '}  ${w.name}${w.why ? ' — ' + w.why : ''}`); }

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
    const dotnet = isDotnetCommand(command);
    const slots = Array.from({ length: parallel }, () => takeSlot(dotnet));
    say(`RED-PROOF: warming ${slots.length} kept cop${slots.length === 1 ? 'y' : 'ies'}${check ? ', each built once' : ''}`);
    const lines = await Promise.all(slots.map(async (copy, k) => {
      const t0 = Date.now();
      const secs = () => `${Math.round((Date.now() - t0) / 1000)} s`;
      try { syncCopy(copy, tree.head, tree.dirty, tree.commonDir); }
      catch (e) { return `  copy ${k}: could not prepare — ${e.message}`; }
      if (!check) return `  copy ${k}: ready (${secs()})`;
      const r = await runProcess(check, path.join(copy, cwdRel), copyRunEnv(command, runEnv));
      logs.push(`===== warm copy ${k} =====\n${hide((r.stdout || '') + (r.stderr || ''))}`);
      if (r.timedOut || r.error) { try { dropCopy(copy); } catch { /* the next sync clones it again */ } }
      // Only a build that ended with exit 0 marks the copy built (2026-11-19: a failed build marked it too).
      else if (r.status === 0) markBuilt(copy);
      return `  copy ${k}: ${r.timedOut ? 'stopped at the time limit' : r.error ? 'could not build' : r.status === 0 ? 'built' : `build failed (exit ${r.status}); the proof will show why`} (${secs()})`;
    }));
    lines.forEach(l => say(l));
    say(`RED-PROOF: WARM ✓ — ${slots.length} cop${slots.length === 1 ? 'y' : 'ies'} ready in ${Math.round((Date.now() - started) / 1000)} s; the proof rebuilds only what changes.`);
    finish(0);
  }

  // What a break's result is judged against, read once before any run (2026-11-19: it was read after all runs, and
  // a break is now judged when its own run ends). A mustFail part may name a test's method or its DisplayName, and
  // is matched against the tests the changed test files declare (survivors).
  const pairs = namePairs();
  const titleFiles = (Array.isArray(plan?.testFiles) ? plan.testFiles : testFiles) || [];
  const declared = titleFiles.flatMap(f => { try { return declaredTests(textAt(f), f); } catch { return []; } });
  // The tests each caught break made fail (2026-11-17, see caughtTests): here they go into the proof record. On the
  // test machine each caught break says the failing tests as its runner named them (caughtLine; an env value in a
  // name is hidden first), and the machine that asked matches them to its own test files.
  const spans = plan ? [] : titleFiles.flatMap(f => { try { return testSpans(textAt(f), f); } catch { return []; } });
  // The test spans of every covered file, also on the test machine, for the narrowed run (selectCommand, 2026-11-19).
  const selectable = (() => { const all = titleFiles.flatMap(f => { try { return testSpans(textAt(f), f); } catch { return []; } }); return all.length ? all : declared; })();
  // The classes of every C# test file read, also one with no test of its own (a derived class), for the base map.
  const fileClasses = titleFiles.filter(f => /\.cs$/i.test(f)).flatMap(f => { try { return csClassList(textAt(f), f); } catch { return []; } });

  // The proof's runs start here (2026-11-17, see proofStarts): from now on an older success of this proof stands
  // only when this run ends PROVED. The code id is taken now, before a run swaps a file in the working folder.
  if (keepsFacts) proof.code = codeFingerprint(repo);
  proofStarts();
  // One result per break, saved when its own run ends (2026-11-19: every result was read after all runs, so a stop,
  // a lost link or one run past the limit lost the finished breaks too). `saveTree` is the code the runs test, taken
  // before any file is swapped; a --changed-since run saves its results too, and still writes no success entry.
  // The state is the one the report gives the break at the end: caught, not-caught, invalid or timeout. A machine
  // or database failure saves nothing, and takes back what this run saved (see the ENVIRONMENT stop).
  const runId = `${Date.now().toString(36)}-${process.pid}`;
  let saveTree = '';
  if (keepsRecord || keepsFacts) { try { saveTree = proof.code || codeFingerprint(repo); } catch { saveTree = ''; } }
  const savedState = new Map(), sentNow = new Set();
  function breakState(b, res) {
    if (res.noop) return { state: 'invalid', why: [] };
    if (res.timedOut) return { state: 'timeout', why: [] };
    const output = (res.stdout || '') + (res.stderr || '');
    const r = { output, code: res.status, why: res.status !== 0 ? failureReasons(output) : [] };
    if (r.code !== 0 && environmentFailure(r)) return { state: 'machine', why: r.why };
    if (r.code !== 0 && breakInvalid(r)) return { state: 'invalid', why: r.why };
    return { state: r.code !== 0 && !survivors(b.mustFail, r.why, pairs, declared, fileClasses).length ? 'caught' : 'not-caught', why: r.why };
  }
  function saveBreak(i, state, why = [], ms = null) {
    if (plan || !keepsRecord || !saveTree) return;
    const b = breaks[i];
    try {
      writeBreakResult(repo, proof.key, b, { state, tree: saveTree, run: runId, ms,
        caught: state === 'caught' ? caughtTests(b.mustFail, why, pairs, spans, fileClasses) : [] });
      savedState.set(i, state);
    } catch { /* not saved: the report at the end still reads this run */ }
  }
  // Called when one break's run ends. On the test machine nothing is stored: a caught break's line goes out at once.
  // Gives the tail for the run's own line when the break was judged caught and saved (2026-11-20, U2): a proof that is
  // stopped later has still left this break's tail in its output, so a later run can resume it.
  function judgeNow(job, res, ms = null) {
    const i = breaks.indexOf(job.b);
    if (job.kind !== 'break' || i < 0 || job.b.single || !res || res.error) return '';
    let judged;
    try { judged = breakState(job.b, res); } catch { return ''; }
    if (judged.state === 'machine') return '';
    if (plan) {
      if (judged.state === 'caught' && !partial) { process.stdout.write(caughtLine(i, judged.why.filter(w => w.kind !== 'env').map(w => ({ name: w.name, runner: w.runner }))) + '\n'); sentNow.add(i); }
      return '';
    }
    saveBreak(i, judged.state, judged.why, ms);
    return judged.state === 'caught' && !partial && savedState.get(i) === 'caught' ? tailOf(job.b) : '';
  }
  // The tail of a caught line: this break's id and the tree it ran on (only where the result is saved: not on the test machine).
  const tailOf = (b) => (!plan && keepsRecord && saveTree && !b.single ? caughtTail(breakId(b), saveTree) : '');
  // The passing run passed on this tree: a break's own result counts as proof only beside this fact (proof-record.mjs).
  function greenNow(res) {
    // On the test machine the passing run says so at once (greenLine); the machine that asked saves the fact.
    if (plan) { if (!runFailed(res) && !ranNoTest(res)) process.stdout.write(greenLine() + '\n'); return; }
    if (!(keepsRecord || keepsFacts) || !saveTree || runFailed(res) || ranNoTest(res)) return;
    try { writeRunFacts(repo, proof.key, { tree: saveTree, run: runId, green: true }); } catch { /* not saved */ }
  }
  // The runs: the old code, each break, then green on the fixed tree (the order the report reads them in).
  // Green RUNS first (2026-11-11, TUW-242: an older test still expected the old behavior, and the proof
  // said so only after its four red runs, 7 minutes in). It takes about a minute in the copy the compile
  // check warmed; when the fixed tree fails, the red runs are skipped and the proof ends at once.
  const jobs = [];
  if (hasOld) jobs.push({ kind: 'old', label: 'old code', changes: oldPlan
    ? oldPlan.map(o => ({ file: o.file, content: () => (o.content64 == null ? null : Buffer.from(o.content64, 'base64')) }))
    : oldRun.map(file => ({ file, content: () => { try { return git('show', `${oldRef}:${file}`); } catch { return null; } } })) });
  // A break that would change nothing in the file the run sees (its text not there once, or the same text)
  // is not run: its result says so (`noop`), and it reads BREAK INVALID (2026-11-12, S6).
  const breakContent = (b) => (target) => {
    const next = applyBreak(fs.readFileSync(target, 'utf8'), b.find, b.put);
    if (next !== null) return next;
    const e = new Error(`its find text is not there once, or its put text is the same, in ${b.file} as this run sees it`);
    e.noop = true;
    throw e;
  };
  // Resume (2026-11-19): a break this tree already caught (saved when its run ended, see saveBreak) is not run again.
  // Only a local run that keeps the record, and not --fresh, and never a --changed-since run. The passing run and
  // the old-code run always run. Any doubt (no tree id, a changed test file, a changed break) runs the break.
  const resumedBy = new Map();
  if (!plan && keepsRecord && !partial && saveTree && !opts.includes('--fresh') && !breaks.some(b => b.single)) {
    // 2026-11-20 (V1): the record alone is not enough. A break is skipped only when an earlier tool result of this
    // session's log shows it caught on this same tree (sessionCaught); no log, or no line, runs the break again.
    let refused = 0, sess = { why: '' };
    try {
      const rec = readRecord(repo);
      const states = breakStates(repo, proof.key, breaks, saveTree, rec);
      const held = states.map((s, i) => i).filter(i => states[i].state === 'proved' && states[i].counts);
      if (held.length) {
        sess = await sessionCaught(repo);
        for (const i of held) { if (sess.keys.has(states[i].id + ' ' + saveTree)) resumedBy.set(i, rec.perBreak[proof.key][states[i].id]); else refused++; }
      }
    } catch { resumedBy.clear(); }
    if (resumedBy.size) say(`RESUMED ${resumedBy.size} of ${breaks.length} breaks from saved results of this tree; running the other ${breaks.length - resumedBy.size}${resumeNote(refused, refusedWhy(sess))}`);
    else if (refused) say(`Resume refused for ${refused} of ${breaks.length} breaks: saved for this tree, but ${refusedWhy(sess)}; running all ${breaks.length}`);
  }
  // A new run for this tree starts: the saved pass of the tree is withdrawn first (after the resume reading above).
  // It is written again only when this run's passing run succeeds (greenNow), so a failed run leaves no pass.
  if (!plan && green && (keepsRecord || keepsFacts) && saveTree) { try { withdrawRunFacts(repo, proof.key, saveTree); } catch (e) { if (e && e.code === 'RECORD_BUSY') refuse('RED-PROOF: the saved pass of this tree cannot be withdrawn: the proof record is busy. Run the command again.'); } }
  breaks.forEach((b, i) => jobs.push({ kind: 'break', b, label: b.single ? 'break' : 'break ' + b.name, changes: [{ file: b.file, content: breakContent(b) }], ...(resumedBy.has(i) ? { resumed: resumedBy.get(i) } : {}) }));
  if (green) jobs.push({ kind: 'green', label: 'green', changes: [] });
  const greenAt = green ? jobs.length - 1 : -1;
  // 2026-11-20: ask the caller about its preflight. Only the proof worker uses this input pipe.
  function askDb(when) {
    return new Promise(resolve => {
      const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
      input.once('line', line => { resolve(line); input.close(); });
      input.once('close', () => resolve(''));
      process.stdout.write(`RED-PROOF-DB-${when}: ready?\n`);
    });
  }
  async function waitForDb() {
    say('RED-PROOF: waiting for the database before judging the proof.');
    return (await askDb('WAIT')) === 'ready';
  }
  function ensureSyncedCommit() {
    if (plan?.commit && gitText(['rev-parse', 'HEAD']) !== plan.commit) {
      say(`RED-PROOF: this folder is no longer at the synced commit ${plan.commit.slice(0, 12)} (another sync moved it); run the proof again.`);
      finish(2);
    }
  }
  async function runGreen(cwd, env, control) {
    const readiness = plan?.watchDb ? await askDb('START') : 'ready';
    if (readiness !== 'ready' && readiness !== 'pending') throw new Error('no database status from the machine that started the proof');
    const result = await runProcess(command, cwd, env, control);
    if (readiness === 'ready' || (!runFailed(result) && !ranNoTest(result) && skippedNone(result))) return result;
    logs.push(`===== green before database was ready =====\n${hide((result.stdout || '') + (result.stderr || ''))}`);
    if (!(await waitForDb())) return { ...result, dbBlocked: true };
    if (cwd === cwdHere) ensureSyncedCommit();
    say('RED-PROOF: the database is ready; running green again.');
    return runProcess(command, cwd, env, control);
  }
  let results;
  if (parallel > 1 && !breaks.some(b => b.single)) results = await runParallel(jobs);
  else {
    // The working folder must be the commit the sync made (2026-11-12, S3): another sync may have moved it.
    ensureSyncedCommit();
    await compileCheck(cwdHere);
    if (!green && plan?.watchDb) {
      if (!(await waitForDb())) finish(6);
      ensureSyncedCommit();
    }
    results = new Array(jobs.length);
    if (green) {
      const result = await runGreen(cwdHere);
      if (result.dbBlocked) finish(6);
      results[greenAt] = result;
      greenNow(result);
    }
    if (!green || !(runFailed(results[greenAt]) || ranNoTest(results[greenAt]))) {
      for (let i = 0; i < jobs.length; i++) {
        if (i === greenAt) continue;
        if (jobs[i].resumed) { results[i] = { status: 0, stdout: '', stderr: '', resumed: true }; continue; }
        const t0 = Date.now();
        const result = await swapRun(jobs[i].changes, jobs[i]);
        results[i] = result;
        const tail = judgeNow(jobs[i], result, Date.now() - t0);
        if (tail) say(`  ran ${jobs[i].label}: caught${tail}`);
      }
    }
  }
  if (results[greenAt]?.dbBlocked) finish(6);

  // A `dotnet test` command builds the fixed tree once before any run (2026-11-09: a missing `using`
  // failed all 6 copies after full builds). A build error stops here: SETUP, with the compiler lines.
  async function compileCheck(cwd, env = runEnv) {
    const check = compileCheckCommand(command);
    if (!check) return;
    const started = Date.now();
    say('RED-PROOF: compile check — the fixed tree builds once (--list-tests) before any run');
    const r = await runProcess(check, cwd, env);
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
  // The tree under test: HEAD, the folder's uncommitted files, and the repository's object store. On the
  // test machine (a plan with a commit), that commit alone: the folder's HEAD may have moved since the sync.
  function treeUnderTest() {
    const listed = (args) => { try { return execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean); } catch { return []; } };
    if (plan?.commit) return { dirty: [], head: plan.commit, commonDir: path.resolve(repo, gitText(['rev-parse', '--git-common-dir'])) };
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
    const dotnet = isDotnetCommand(command);
    const env = copyRunEnv(command, runEnv);
    let slots = Array.from({ length: width }, () => takeSlot(dotnet));
    if (compileCheckCommand(command)) {
      try { syncCopy(slots[0], head, dirty, commonDir); }
      catch (e) { say('RED-PROOF: could not prepare a copy for the compile check — ' + e.message); finish(2); }
      await compileCheck(path.join(slots[0], cwdRel), env);
      markBuilt(slots[0]);
    }
    // Build once (2026-11-13): a dotnet build in a folder that never built compiles the whole solution, and
    // build output copied in from another folder does not help (checked: MSBuild hashes the full reference
    // paths, so every project recompiled). So dotnet runs go only to copies that built before (the first,
    // which the compile check just built, and copies an earlier proof or --warm built), one run after another
    // in each; there a change recompiles only its project and those that depend on it. A copy that never
    // built is handed back unused.
    // 2026-11-19: the proof builds the cold copies itself first (the --warm build, side by side; at most `parallel`
    // of them), so every built copy takes runs. A copy whose build fails sits out, with the reason.
    const sitOut = [], sitWhy = [];
    if (dotnet) {
      const cold = slots.slice(1).filter(c => !builtIn(c));
      const check = compileCheckCommand(command);
      if (cold.length && check) {
        say(`RED-PROOF: building ${cold.length} cold cop${cold.length === 1 ? 'y' : 'ies'} side by side before the runs`);
        const why = await Promise.all(cold.map(async (c, k) => {
          try {
            syncCopy(c, head, dirty, commonDir);
            const r = await runProcess(check, path.join(c, cwdRel), env);
            logs.push(`===== cold copy ${k} build =====\n${hide((r.stdout || '') + (r.stderr || ''))}`);
            if (r.timedOut || r.error) { try { dropCopy(c); } catch { /* the next sync clones it again */ } return r.timedOut ? 'the build ran past the time limit' : 'the build could not start'; }
            if (r.status !== 0) return `the build failed (exit ${r.status})`;
            markBuilt(c);
            return '';
          } catch (e) { return `could not prepare it (${e.message})`; }
        }));
        cold.forEach((c, k) => { if (why[k]) { sitOut.push(c); sitWhy.push(why[k]); } });
      } else sitOut.push(...cold);
    }
    for (const c of sitOut) releaseSlot(c);
    slots = slots.filter(c => !sitOut.includes(c));
    if (!green && plan?.watchDb && !(await waitForDb())) finish(6);
    const out = new Array(list.length);
    let next = 0;
    // Green first, in the first copy (the one the compile check warmed); the other runs start when it
    // passes, and none starts when it fails.
    const order = [...list.keys()].sort((a, b) => Number(list[b].kind === 'green') - Number(list[a].kind === 'green'));
    let releaseGreen = () => {}, stopped = false;
    const greenGate = list.some(j => j.kind === 'green') ? new Promise(r => { releaseGreen = r; }) : null;
    say(`RED-PROOF: ${list.length} run(s), ${slots.length} at a time, each in its own copy${greenGate ? '; green first' : ''}` +
      (sitOut.length ? `; ${sitOut.length} cop${sitOut.length === 1 ? 'y' : 'ies'} sit out (${sitWhy.length ? [...new Set(sitWhy)].join('; ') : 'never built here, and no build command to build it'})` : ''));
    // Progress (2026-11-19): at the start and after every few runs, from the measured time per run.
    const todo = list.filter(j => !j.resumed).length;
    let doneRuns = 0, doneMs = 0;
    const progress = () => {
      const left = todo - doneRuns;
      const min = doneRuns && slots.length ? Math.max(1, Math.round((doneMs / doneRuns) * left / slots.length / 60000)) : null;
      say(`  done ${doneRuns} of ${todo}${min === null ? '' : `, about ${left ? min : 0} min left`}`);
    };
    progress();
    // The stuck watch (2026-11-15, role-sync task: one break kept a lock held, so its run waited the full 15
    // minutes while its peers had each finished in about 4). Once two red runs have finished, a red run still
    // going at twice the slowest of them, and never under a fifth of the time limit, is stuck: it is stopped
    // like a run past the limit. The green run runs alone and has no peer: only the limit stops it.
    const active = new Map(), peerMs = [];
    const watch = setInterval(() => {
      if (peerMs.length < STUCK_PEERS) return;
      const stuckMs = Math.max(limitMs / 5, STUCK_FACTOR * Math.max(...peerMs));
      if (stuckMs >= limitMs) return;
      for (const [i, a] of active) if (a.control.stop && Date.now() - a.started > stuckMs) { a.control.stuckMs = stuckMs; active.delete(i); a.control.stop(); }
    }, 500);
    async function worker(copy) {
      while (next < list.length) {
        const i = order[next++];
        if (list[i].resumed) { out[i] = { status: 0, stdout: '', stderr: '', resumed: true }; continue; }
        if (greenGate && list[i].kind !== 'green') { await greenGate; if (stopped) return; }
        const started = Date.now();
        const control = {};
        if (list[i].kind !== 'green') active.set(i, { started, control });
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
          const cwd = path.join(copy, cwdRel);
          out[i] = list[i].kind === 'green' ? await runGreen(cwd, env, control) : await runForJob(list[i], cwd, env, control);
          if (control.stuckMs && out[i].timedOut) out[i].stuckMs = control.stuckMs;
          if (dotnet && buildFinished(out[i])) markBuilt(copy);
        } catch (e) {
          out[i] = e.noop ? { status: null, stdout: '', stderr: '', noop: true, why: e.message } : { status: null, stdout: '', stderr: '', error: e };
        } finally {
          // The copy goes back to the tree under test; its build output stays for the next run.
          for (const s of saved) { try { if (s.before === null) fs.rmSync(s.target, { force: true }); else fs.writeFileSync(s.target, s.before); } catch { unsure = true; } }
          for (const l of links) { try { fs.unlinkSync(l); } catch { /* a link that is gone needs nothing */ } }
          // A stopped or failed run can leave half-written build output: that copy starts over.
          if (unsure || out[i].timedOut || out[i].error) { try { dropCopy(copy); } catch { /* the next sync clones it again */ } }
          active.delete(i);
        }
        const ms = Date.now() - started;
        if (list[i].kind !== 'green' && !out[i].timedOut && !out[i].error && !out[i].noop) peerMs.push(ms);
        const ranLine = `  ran ${list[i].label}: ${out[i].stuckMs ? `stopped as stuck (twice the slowest finished run: ${Math.round(out[i].stuckMs / 1000)} s)` : out[i].timedOut ? 'stopped at the time limit' : out[i].error ? 'could not run' : out[i].noop ? 'not run, the break changes nothing there' : 'exit ' + out[i].status} (${Math.round(ms / 1000)} s)`;
        // Judged and saved now, when this run ends (2026-11-19), not after every run has ended.
        const caughtTailNow = judgeNow(list[i], out[i], ms);
        say(ranLine + caughtTailNow);
        doneRuns++; doneMs += ms;
        if (doneRuns % 3 === 0 || doneRuns === todo) progress();
        if (list[i].kind === 'green') {
          stopped = out[i].dbBlocked || runFailed(out[i]) || ranNoTest(out[i]);
          if (!out[i].dbBlocked) greenNow(out[i]);
          releaseGreen();
        }
      }
    }
    try { await Promise.all(slots.map(worker)); } finally { clearInterval(watch); }
    return out;
  }

  // A kept copy for this proof: the first slot no running proof holds (its lock names this process,
  // released when this process ends). A dotnet command takes a copy it built in first (2026-11-13: there its
  // next build compiles only what changed); any other command never takes one, so a page proof that runs
  // beside a server proof leaves the built copies to it.
  function takeSlot(dotnet = false) {
    fs.mkdirSync(slotsRoot, { recursive: true });
    if (!takeSlot.held) {
      takeSlot.held = [];
      process.on('exit', () => { for (const l of takeSlot.held) { try { fs.rmSync(l, { force: true }); } catch { /* gone */ } } });
    }
    const take = (k) => {
      const lock = path.join(slotsRoot, `${k}.lock`);
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
          takeSlot.held.push(lock);
          return path.join(slotsRoot, String(k));
        } catch (e) {
          if (e.code !== 'EEXIST' || lockOwner(lock)) return null; // in use: the next slot
          try { fs.rmSync(lock, { force: true }); } catch { return null; } // a stale lock: take it over
        }
      }
      return null;
    };
    if (dotnet) {
      const built = fs.readdirSync(slotsRoot).filter(n => /^\d+$/.test(n)).map(Number).sort((a, b) => a - b)
        .filter(k => builtIn(path.join(slotsRoot, String(k))));
      for (const k of built) { const copy = take(k); if (copy) return copy; }
    }
    for (let k = 0; ; k++) {
      if (!dotnet && builtIn(path.join(slotsRoot, String(k)))) continue;
      const copy = take(k);
      if (copy) return copy;
    }
  }
  // A copy this proof took but will not use goes back at once, so another proof can take it.
  function releaseSlot(copy) {
    const lock = copy + '.lock';
    takeSlot.held = takeSlot.held.filter(l => l !== lock);
    try { fs.rmSync(lock, { force: true }); } catch { /* gone */ }
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

  // Every run's output, read once, in the order the report reads them (a run not started reads null).
  const reads = jobs.map((j, i) => (results[i] && !results[i].noop && !results[i].resumed ? read(results[i], j.label) : null));
  // The environment first (2026-11-12, S2): a run that failed on the database or the test host proves
  // nothing, red or caught; the whole proof stops so it is run again on a working machine.
  for (let i = 0; i < jobs.length; i++) {
    const r = reads[i];
    const env = r && !results[i].timedOut && r.code !== 0 ? environmentFailure(r) : null;
    if (!env) continue;
    if (env.named) showWhy(r); else say(`  ✗ env     ${jobs[i].label}: ${env.line}`);
    say('RED-PROOF: ENVIRONMENT ✗ — the test machine failed (database or host), not the tests; fix it and run the same proof again.');
    // What this run saved says nothing about the code: it is taken back (2026-11-19).
    if (!plan && keepsRecord) { try { takeBackRun(repo, runId); } catch { /* an entry's tree still voids it after any edit */ } }
    finish(6);
  }
  // Green ran first and failed: the fixed tree fails its own tests, so no red run started.
  if (green && runFailed(results[greenAt])) {
    const g = results[greenAt];
    if (g.timedOut) { say(`RED-PROOF: TIMEOUT ✗ — green ran past ${timeoutMin} min; it and every process it started were stopped; no red run started; files restored.`); finish(5); }
    const r = reads[greenAt];
    setupStop(r); showWhy(r);
    say('  GREEN ✗ the tests fail on the fixed tree');
    say('RED-PROOF: NOT PROVED ✗ — the fixed tree fails its own tests, so the red runs were skipped. An older test may still expect the old behavior: fix the tests or the code, then run again; files restored.');
    finish(1);
  }
  // Green ran first, passed and ran no test (2026-11-19): it shows nothing, so it is never green and no red run started.
  if (green && ranNoTest(results[greenAt])) {
    const none = NO_TESTS.exec(reads[greenAt].output);
    say(`  GREEN ✗ no test ran on the fixed tree (exit 0: "${none[0]}")`);
    say('RED-PROOF: NOT PROVED ✗ — the green run ran no test, so it shows nothing and the red runs were skipped. Check the test command and its filter, then run again; files restored.');
    finish(1);
  }
  // Green passed (when it ran): every test of the command passed on the fixed tree. A test that then fails on
  // the old code, or under a break, because a Testing Library query found no element is caught: the query is
  // proven, the element is what the old code lacks. Read as 'missing'; without a green run it stays SETUP.
  const greenPassed = green && !runFailed(results[greenAt]);
  const foundByGreen = (r) => {
    if (!greenPassed) return 0;
    let n = 0;
    for (const w of r.why) if (w.kind === 'setup' && ELEMENT_ERR.test(w.why)) { w.kind = 'missing'; n++; }
    return n;
  };
  const missingNote = (n) => (n ? `${n} by another error (an element green found on the fixed tree is missing)` : '');
  let ok = true, oldRedByBuild = false;
  // 0. A run past the time limit proves nothing: named first, the others still read.
  const late = jobs.filter((j, i) => results[i]?.timedOut);
  const stuck = jobs.filter((j, i) => results[i]?.stuckMs);
  for (const j of late) {
    const s = results[jobs.indexOf(j)].stuckMs;
    say(s ? `RED-PROOF: TIMEOUT ✗ — ${j.label} was stuck: still running after ${Math.round(s / 1000)} s, twice the slowest finished run; it and every process it started were stopped; files restored.`
      : `RED-PROOF: TIMEOUT ✗ — ${j.label} ran past ${timeoutMin} min; it and every process it started were stopped; files restored.`);
  }
  // 1. The old code: red only when a named test fails by an assertion (2026-11-12, S2/S7: a crash, a run
  // with no test, or a runner whose failures are not read used to print RED ✓).
  if (hasOld) {
    const r = reads[0];
    const errors = !results[0].timedOut && r.code !== 0 ? compilerErrors(r.output) : [];
    const missingNames = errors.length
      ? missingTestNames(errors, oldMissingNames, new Map([...oldTestCode].map(([f, code]) => [f, codeNames(code)])), textAt) : [];
    // 2026-11-20: another project's missing name can appear inside a named test's assertion output.
    if (missingNames.length && r.why.some(w => w.kind === 'setup')) {
      const buildLines = new Set(errors);
      r.why = failureReasons(r.output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).filter(l => !buildLines.has(l)).join('\n'));
    }
    const buildRed = greenPassed && missingNames.length && !r.why.length
      && !/^\s*(?:Failed!|Test Run Failed|Tests\s+\d+ failed)/m.test(r.output);
    if (results[0].timedOut) ok = false;
    else if (buildRed) {
      oldRedByBuild = true;
      say(`RED-PROOF: RED ✓ — red by build: the old code has no ${missingNames.join(', ')}; files restored.`);
    }
    else if (r.code !== 0) {
      const missing = foundByGreen(r);
      const asserts = r.why.filter((w) => w.kind === 'assert').length;
      setupStop(r, { oldCode: true, buildError: errors.length > 0 && !missingNames.length }); showWhy(r);
      // A NAMED test that fails by a product error (an exception the old code throws) is the bug too. It
      // counts, and the line says so, so a reader checks the reason printed above is the bug and not a
      // broken test. Setup and environment failures never reach this line.
      const others = r.why.filter((w) => w.kind === 'other').length;
      const none = NO_TESTS.exec(r.output);
      const extra = [others ? `${others} by another error` : '', missingNote(missing)].filter(Boolean).join(', ');
      if (asserts || others || missing) say(`RED-PROOF: RED ✓ — the tests fail on ${oldLabel} for ${(oldPlan ? oldNames : oldRun).join(', ')} (exit ${r.code}; ${asserts} of ${r.why.length} failing test(s) by an assertion${extra ? `, ${extra}: check above that it is the bug` : ''}); files restored.`);
      else if (none) say(`RED-PROOF: NOT RED ✗ — no test ran on ${oldLabel} (exit ${r.code}: "${none[0]}"); check the test command and its file filter; files restored.`);
      else if (!r.why.length) say(`RED-PROOF: NOT RED ✗ — the run fails on ${oldLabel} (exit ${r.code}), but no failing test was named (failure reasons not read from this runner); a crash or a run with no test proves nothing. Run the tests with a runner that names its failures (vitest, dotnet test); files restored.`);
      else say(`RED-PROOF: NOT RED ✗ — ${r.why.length} test(s) fail on ${oldLabel} (exit ${r.code}), but none by an assertion (${[...new Set(r.why.map(w => w.kind))].join(', ')}); a crash proves nothing. Make the test assert the behavior; files restored.`);
      if (!asserts && !others && !missing) ok = false;
    } else {
      say(`RED-PROOF: NOT RED ✗ — the tests pass on ${oldLabel}, so they do not prove the fix; files restored.`); ok = false;
      const kept = plan ? (Array.isArray(plan.kept) ? plan.kept : []) : keptAtFix.map(k => k.file);
      if (kept.length) say(`RED-PROOF: ${kept.join(', ')} stayed at the fix (see above). If the fix itself is in there, prove it with --breaks alone.`);
    }
  }
  // The old code was red: the failing names go to the machine that asked, which knows the new tests (oldRedLine).
  if (plan && hasOld && !partial && reads[0] && reads[0].code !== 0 && !results[0].timedOut) {
    process.stdout.write(oldRedLine(reads[0].why.filter(w => w.kind !== 'env').map(w => String(w.name))) + '\n');
  }
  // 2. Each break of the rule under test, judged against the titles read before the runs (pairs, declared, spans).
  // A result saved when its run ended must be the one this report gives: a saved 'caught' that the report does
  // not confirm is written again as not caught (settle), so a saved result never says more than the report.
  const settle = (i, state) => { if (savedState.has(i) && savedState.get(i) !== state) saveBreak(i, state); };
  const caught = [], caughtIdx = new Set();
  for (let i = 0; i < breaks.length; i++) {
    const b = breaks[i];
    const res = results[(hasOld ? 1 : 0) + i];
    const r = reads[(hasOld ? 1 : 0) + i];
    const notRed = (why) => { if (b.single) say(`RED-PROOF: NOT RED ✗ — ${why}, so it proves nothing; files restored.`); ok = false; };
    if (res.resumed) {
      // Caught earlier on this exact tree: its saved tests go into the record entry as if it ran now.
      say(`  BREAK ✓ ${b.name}: caught earlier on this exact tree (saved result, not run again)${tailOf(b)}`);
      caughtIdx.add(i);
      for (const [file, list] of Object.entries(jobs[(hasOld ? 1 : 0) + i].resumed.caught || {})) for (const t of list) caught.push({ file, ...t, by: String(b.name) });
      continue;
    }
    if (res.noop) {
      logs.push(`===== ${jobs[(hasOld ? 1 : 0) + i].label} =====\n(not run: ${res.why})`);
      say(`  BREAK INVALID ✗ ${b.name}: the break changes nothing (${res.why}); write a break that changes one rule`);
      notRed('the break changes nothing');
      settle(i, 'invalid');
      continue;
    }
    if (res.timedOut) { ok = false; settle(i, 'timeout'); continue; }
    // A break that does not compile or run fails every test: it isolates no rule (2026-11-12, S6).
    const invalid = r.code !== 0 ? breakInvalid(r) : null;
    if (invalid) {
      say(`  BREAK INVALID ✗ ${b.name}: the break does not compile/run; write a break that changes one rule`);
      say(`    ${invalid}`);
      notRed('the break does not compile or run');
      settle(i, 'invalid');
      continue;
    }
    if (b.single) {
      const none = r.code !== 0 && NO_TESTS.exec(r.output);
      if (none) { say(`RED-PROOF: NOT RED ✗ — no test ran with ${b.file} broken (exit ${r.code}: "${none[0]}"); check the test command; files restored.`); ok = false; }
      else if (r.code !== 0) {
        const missing = foundByGreen(r);
        setupStop(r); showWhy(r);
        say(`RED-PROOF: RED ✓ — the test fails with ${b.file} broken (exit ${r.code}${missing ? `; ${missingNote(missing)}: check above that it is the bug` : ''}); files restored.`);
      }
      else { say(`RED-PROOF: NOT RED ✗ — the test passes with ${b.file} broken, so it does not check that code; files restored.`); ok = false; }
      continue;
    }
    const left = survivors(b.mustFail, r.why, pairs, declared, fileClasses);
    if (r.code !== 0 && !left.length) {
      say(`  BREAK ✓ ${b.name}: all ${b.mustFail.length} named test(s) fail${tailOf(b)}`);
      caughtIdx.add(i);
      if (!plan) caught.push(...caughtTests(b.mustFail, r.why, pairs, spans, fileClasses).map(t => ({ ...t, by: String(b.name) })));
      // The names go unhidden (2026-11-17, audit: a test named with an env value came back as *** and matched no
      // test) and straight to stdout, not through say(): the line is base64, read by the machine that asked and
      // never shown or logged here.
      else if (!partial && !sentNow.has(i)) process.stdout.write(caughtLine(i, r.why.filter(w => w.kind !== 'env').map(w => ({ name: w.name, runner: w.runner }))) + '\n');
      settle(i, 'caught');
    }
    else {
      say(`  BREAK ✗ ${b.name}: still pass (or not seen failing): ${(left.length ? left : b.mustFail).join(' | ')}`);
      ok = false;
      settle(i, 'not-caught');
    }
  }
  // 2b. One row per new test (2026-11-19: a new test no break named and the old code did not fail slipped through):
  // 2026-11-20: a build failure ran no named test. Each new test in this proof needs its own caught break.
  const caughtBreaks = [...(plan?.resumedBreaks || []), ...[...caughtIdx].map(i => breaks[i]).filter(b => !b.single)];
  const reportedTests = oldRedByBuild ? buildTests : newTests;
  if (oldRedByBuild && !partial && !caughtBreaks.length) ok = false;
  if (reportedTests?.length && !partial && !late.length) {
    const oldRed = (hasOld && reads[0] && reads[0].code !== 0 && !results[0].timedOut) ? redOldMatches(reportedTests, reads[0].why.map(w => String(w.name))) : [];
    for (const t of reportedTests) {
      const title = String(t.titles[t.titles.length - 1]);
      const by = caughtBreaks.find(b => namedBy(b.mustFail, t));
      if (hasOld && oldRed.includes(t)) say(`  TEST ✓ ${title}: old code RED`);
      else if (by) say(`  TEST ✓ ${title}: break ${by.name}`);
      else { say(`  TEST NOT PROVEN ✗ ${title}: it has no failing test result on the old code and no caught break names it; add a break whose mustFail names it`); if (oldRedByBuild || opts.includes('--strict-tests')) ok = false; }
    }
  }
  // The new tests red on the old code are saved beside the green fact (2026-11-19), so the checks before review read
  // "old code" for them. Only when the old run was red; the green fact is the one greenNow saved for this run.
  if (hasOld && keepsFacts && saveTree && newTests?.length && !late.length && reads[0] && reads[0].code !== 0 && !results[0].timedOut) {
    const red = redOldTests(newTests, reads[0].why.map(w => String(w.name)));
    // Without a green run here, the facts of the run that already passed on this tree are kept (its run id), not replaced.
    if (red.length) {
      try {
        let factsRun = runId;
        if (!green) { const prev = readRecord(repo)?.runs?.[proof.key]?.[saveTree]; if (prev && typeof prev.run === 'string' && prev.run) factsRun = prev.run; }
        writeRunFacts(repo, proof.key, { tree: saveTree, run: factsRun, redOld: red, old: oldSha });
      } catch { /* not saved */ }
    }
  }
  // 3. Green on the fixed tree.
  if (green) {
    const r = reads[reads.length - 1];
    if (results[results.length - 1].timedOut) ok = false;
    else if (r.code === 0) say('  GREEN ✓ the tests pass on the fixed tree');
    else { setupStop(r); showWhy(r); say('  GREEN ✗ the tests fail on the fixed tree'); ok = false; }
  }
  if (late.length) {
    say(stuck.length
      ? `RED-PROOF: NOT PROVED ✗ — ${late.length} run(s) did not finish (${stuck.length} stuck at twice the slowest finished run), so nothing is proved. Fix the hang (a test with no time bound of its own), then run again; a slow run that is not stuck: raise --timeout-min, which raises the stuck floor too. Files restored.`
      : `RED-PROOF: NOT PROVED ✗ — ${late.length} run(s) did not finish within ${timeoutMin} min, so nothing is proved. Fix the hang or raise --timeout-min, then run again; files restored.`);
    finish(5);
  }
  // A --changed-since run says PARTIAL, never PROVED (2026-11-16): it ran only the breaks the change reached.
  if (partial) {
    const ran = breaks.length ? `${breaks.length} of ${partial.of} break(s) caught` : `0 of ${partial.of} break(s) run (none changed since ${partial.ref})`;
    say(ok ? `RED-PROOF: PARTIAL ✓ — ${ran}${hasOld ? ', red on the old code' : ''}${green ? ', green on the fix' : ''}; files restored; run the full proof (without --changed-since) once before the final review.` : 'RED-PROOF: NOT PROVED ✗ — see the lines above; files restored.');
  } else if (breaks.length && !breaks[0].single) say(ok ? `RED-PROOF: PROVED ✓ — ${hasOld ? 'red on the old code, ' : ''}${breaks.length} break(s) caught${green ? ', green on the fix' : ''}; files restored.` : 'RED-PROOF: NOT PROVED ✗ — see the lines above; files restored.');
  else if (oldRedByBuild) say('RED-PROOF: NOT PROVED ✗ — red by build needs a caught break that names the test; files restored.');
  // The record pre-review reads: only a run that proved at least one break of the rule under test, written
  // here (the test machine's plan run leaves it to the machine that asked, see runRemote). 2026-11-17: with the
  // tests the breaks made fail; a run that does not get here PROVED leaves its entry not ok (proofStarts).
  if (ok && keepsRecord && !partial) {
    if (fileHashes) record(targetHashes, caught);
    else proof.why = `PROVED, but there is no merge base with ${base}, so the changed test files are not known and nothing is recorded`;
  }
  finish(ok ? 0 : 1);
}
