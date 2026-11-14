# Loop — rare cases and details

[loop.md](loop.md) is the loop. This file holds what a normal task does not need: the timer, what a tool answer means, work split in parts, several PRs, the expert panel, the full review round and machine load. When this file and loop.md differ, loop.md wins.

## Timer

The timer starts, marks its stages and ends by itself: the first code edit starts it, `red-proof.mjs`, `pre-review.mjs`, `evidence.mjs` and a reviewer launch mark their stage, and a stop after `GATE: PASS` ends it. Its folder is named in `~/.claude/state/sanad-timer-active-<session id>`.

- The ship brief ends with `node ~/.claude/skills/gate/scripts/sanad-timer.mjs report <folder>`. When the user asks about time, show that report; never rebuild it from memory.
- A wait for the user or a machine: `sanad-timer.mjs wait <folder> "<why>"`.
- Other work with no timer of its own: `sanad-timer.mjs pause <folder> "<what>"`, then `resume <folder>`. A paused task is resumed before its first edit.
- A review runs beside the other stages, so it is listed apart and never added to the total.

## What a tool answer means

- **Test machine.** One clone there is shared by every worktree of a repository. `REMOTE-DOWN` → ask the user before running here. `REMOTE-BUSY` (exit 11) → another folder's check or browser-check app uses the clone: wait, or stop that app (`remote-web.sh stop` in its folder). `REMOTE-DIRTY` → files there differ, untracked ones included. A check over ssh that finds other code in the clone does not start: run `remote-sync.sh`, then the check again. More in [remote-host.md](remote-host.md).
- **Warm copies.** Once the branch exists and the preflight says ready: `red-proof.mjs --repo <repo> --warm [--cwd <dir>] -- <the proof's test command>` in the background. Let it finish before the proof. A server (dotnet) proof runs only in copies that built before, and builds there without the commit id, so a new sync recompiles nothing and a break recompiles only its project. With no built copy it builds once and runs its runs one after another in that copy: the line "copies never built here sit out" says so; it is not a hang. Warm again after `--drop-copies` or a Sanad install.
- **red-proof.mjs.**
  - The green run on the fix goes first and alone. When it fails, the proof ends there: often an older test still expects the old behavior.
  - `RED ✓` → quote its failing line. `NOT RED ✗` → the test proves nothing: rewrite it. The old code is RED only when a named test fails; a failure by a product error counts and the line says so, so check it is the bug.
  - A setup failure (element not found, type error, timeout) → fix the test. One exception: after a passing green run, an element the old code (or a break) does not render is red, shown as `? missing`; read that line and confirm the missing element is the bug. Keep `--then-green` on page proofs, or it stays SETUP.
  - A break whose named tests still pass → the tests do not isolate the rule: fix the tests, not the list.
  - `BREAK INVALID ✗` → the break does not compile or changes nothing. A break changes one rule.
  - `ENVIRONMENT ✗` (exit 6) → the database or the machine failed: `remote-preflight.sh --db`, then the same proof again. Do not touch the tests.
  - A `mustFail` text is part of a test's own title, and every test with that text must fail. Name a new test by words of its own title, not by its `[Cn]` tag: a part that matches a new test and an older one (an old ticket's `[C1]` in the same file) is refused before any run (`BREAK AMBIGUOUS`, exit 2). A part may name older tests alone, and a test's whole title is always accepted.
  - A test of code that already works has no old version that fails: use `--break <file> --find <text> --put <text>` in place of `--old` and `--files`.
  - `--local` only on the user's word. `--files` names product files only.
- **pre-review.mjs.** Lint and types of the changed packages, the ticket lines, the places list, new test lines, the commits (one task in one commit; a Conventional subject of at most 72 characters that ends with exactly one ticket ID; `git config sanad.ticketRequired false` for a repository without tickets; `lines.mjs --no-ticket` marks one branch as a task without a ticket), the size and the project's mechanical check (`git config sanad.mechanical`). A check it could not run shows as `NOT RUN` and fails. `--before-proof` runs every part except the proof part of the test asserts check, so the cheap fixes land before the proof. A ticket line quoted only in an older, unchanged test fails: quote it above a test this change adds or edits. A quote or a `[Cn]` tag on a skipped test does not count.
- **review-brief.mjs.** `--proof-log` once per proof (server and page). It pins the diff to the merge base, lists every changed file and the places list, adds the open outside items (`git config sanad.outsideList`), and uses the larger of the routed and the measured size.
- **size-check.mjs.** Callers are counted by the declaring type (C#) and the import path (JS). A change in a file named like an access file, or under an Auth or Security folder, is an access change.
- **evidence.mjs.** A failed check prints its totals and failing tests above its receipt. `CHECK_RERUN` → every failure is a test timeout, in test files the change does not touch: send its `CHECK RETIRED` line alone, in a text-only message, then run the printed replacement exactly; it must pass. Any other failure gets no offer: fix it.
- **Locks.** A check lock counts only while the process that wrote it still holds its id; an id taken by a newer process is stale (the edit guard, `REMOTE-BUSY`, pre-review's sync).
- **Stop and push guards.** A switch, pull, merge, reset or checkout that leaves a clean tree equal to a remote branch tip is not an edit. A check whose exit code is hidden (`| head`, `| grep`, `; echo`, `$(…)`) counts only when its output shows the runner's own pass line: run checks plainly. A red run is cleared by the same command passing. Edits by helper agents, deleted code files and formatter runs count as edits. A command sent through ssh or a here-document is read like a local one.

## Work split in parts

- **Exact briefs.** Before a helper gets a fix, the main session finds the cause and writes the exact files and the exact change; the helper applies it, tests it and reports. "Find out why" is for real unknowns only, and the brief says so.
- **Tests beside the code.** A `sonnet-worker` may write the tests from the check lines and breaks while the main session writes the fix; one helper per test file, launched in one message, each running only its own file. Its brief carries the `[Cn]` tag, the check line and the verbatim ticket lines to quote. The main session reads and owns that diff. A new test that fails on working code may be a real bug: it goes back to the main session.
- **Fast test loop.** Every helper runs only its touched test files and reuses the build output folder: never clean it, and skip restore when no dependency changed.
- **Review finished parts early.** A finished part gets a scoped re-check on its own commits while the other parts are built. After the join, prove the merge added nothing (`git show --cc <merge>` empty, or equal `git patch-id --stable` before and after); only conflict edits then need a review. An early re-check never replaces the review that completes after the last change.
- **Joins in stacked PRs.** A join that needed conflict edits is reviewed on `git show --remerge-diff <merge>` as soon as it is committed. One full suite then runs on the top branch.
- **A requested review of a whole PR** is [full-pr-review.md](full-pr-review.md): one session per PR. A re-check's PASS covers only its scope: report it as "this fix passed", never "this PR passed".

## Several PRs

One PR per ticket by default. The plan is shown before code and waits for the user's OK (loop.md Step 1).

- One reviewable behavior per PR: at most about 400 changed lines of logic and 30 files (tests, translations and generated files do not count).
- Shared contracts and expand-only migrations go in the first PR that needs them. Split backend and frontend when both are large.
- Each PR builds, passes its tests and is safe to merge alone. No PR shows users a half-built feature.
- PRs are independent: each starts from the integration branch. A PR that really needs another one is marked `depends on #n` and starts only after that one is merged. No stacks of open PRs.
- A series carries its order in the title (`[n/N]`). A PR that grows past the limits is re-planned with the user.

## The expert panel (Big)

- After the size line, launch the fact checks, the panel and the Test designer ([test-designer.md](../../braintrust/experts/test-designer.md)) in one message, and read the code while they work. The designer's `SETUP`, `CASES` and `BREAKS` become the tests and `breaks.json`; its `EXTRA TESTS OUTSIDE THE TICKET` are notes for the user, like a reviewer's.
- Every seat's brief carries its cap: about 4 minutes and 40 tool uses, probes on the test machine, no scan of the whole repository. Still running at 8 minutes → one message asking for the report; none at 12 → a failed seat, named to the boss, never invented.
- Database optimizer (a database change): its `DB SWEEP` is the database verdict. Security auditor (a security change): its `SEC SWEEP` is the security verdict. Every `→ finding` becomes a proof at the gate; every `? unchecked` is named at the gate.
- The decision record is the plan. Deviating from it means saying so and why, in one line. A new fact that breaks the plan goes back to the same boss.
- At the gate, the standing proofs: an index in the same migration for every new WHERE, JOIN or ORDER BY column, the generated SQL quoted, no I/O inside a transaction, a stable unique order for every list; anonymous → 401, wrong role → 403, not owner → 404/403, missing anti-forgery → rejected.

## The full review round (Big)

- **Risk files.** The engine's risk reviewer reads only the changed files on a sensitive boundary (access, database, money, files and URLs, shared contracts) with their callers and writers, and a trace list of 5–10 inputs the author did not test: the null, empty, huge or malformed value, the other role, the other tenant, the duplicate or concurrent request, the replay after an unclear commit, the missing row, the failing dependency, the opposite lifecycle state, an old row that already breaks a new rule.
- **Whole diff.** The engine's whole-diff reviewer reads every changed file against the check lines and [review-checklist.md](review-checklist.md). It starts its report with `ESCALATE: sensitive — <reason>` when it finds a boundary the risk reviewer did not cover; the risk reviewer then runs on that scope before any verdict.
- **Fresh eyes.** The risk reviewer again, with a prompt that starts `You are the independent reviewer — FRESH EYES` and holds only the user's words, the ticket, the whole PR diff, the places list and the project rules. No author claims, no earlier findings, no test results.
- **The other engine.** A Claude task adds a Codex review, a Codex task a Claude Opus review, on the machine where that engine is signed in, with the fresh-eyes inputs. Unavailable is reported as incomplete before the push, never skipped silently.
- **Author-proof inputs.** The ask is the user's own words, quoted. Everything from the author or the boss (design decisions, "known gaps", rulings) goes only under `Author claims — attack these`.
- All of them launch in one message; one batched fix round covers every note. Reviewers advise and never edit. An unfinished reviewer is reported incomplete, never invented.

## Machine load

- Agents think on the API; builds and tests load the machine. Start every independent part at once and keep adding while CPU stays under about 80% and free memory above about 2 GB.
- Full suites are the heavy load: at most 2 at once on one machine, one at a time when they share a database. Check free memory first.
- No source edit while a full suite runs: the evidence helper refuses a run whose files changed under it. Hold the fixes, apply them in one batch, run once more.
- A suite never runs beside reviewers on this machine.
