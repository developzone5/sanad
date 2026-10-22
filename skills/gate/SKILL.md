---
name: gate
description: Run your Definition-of-Done and security gate against the current change, now, with real quoted command output. Use when the user types /gate, asks to "run the gate", "prove it works", or "verify before I ship", or before declaring a task done.
argument-hint: "[scope — defaults to the current diff]"
---

<!-- Author: Eng. Mohammed Almutairi - Developzone.net -->

# /gate — run the Definition of Done now

Execute the **"⛔ Definition of Done"** section of CLAUDE.md AND the full security checklist against the current change — rigorously, end to end, right now. A gate produces a verdict backed by real output, not a narrative of what probably works.

## Before anything

1. **Read `~/.claude/skills/gate/security-checklist.md`** (it sits next to this file) — that is the complete security gate; CLAUDE.md carries only the summary.
2. **Choose behavior evidence.** Read `reference/behavior-proof.md` for a behavior change and the proof-by-change-type and mechanical-checks sections of `../sanad/reference/engineering-bar.md`. Map applicable failure mechanisms and missed-bug classes to actual checks; record the outcomes in `Done means`.
3. **Pin down the change set.** `git status` + `git diff` (staged and unstaged), or the files edited this session if not in a repo. The gate runs against that diff — name it in the report so it is unambiguous what was gated.
4. Apply [execution.md](../sanad/reference/execution.md) and the project's verified commands. Reuse its evidence ledger; do not start a second verification plan or reconstruct a working runtime rig.
5. For an already-reviewed cherry-pick, apply [promotion.md](../ship/reference/promotion.md). Verified equivalent changes reuse the original independent/security reviews; item 4 does not require rerunning reviewers just because the session or commit IDs changed. Current target compatibility, applicable provider checks and required CI remain necessary.
6. For red-before-green, long command logs or HTTP probes, use [command-evidence.md](reference/command-evidence.md). Assert statuses/codes/persisted state, preserve native exits, and keep setup/test/cleanup separate.

Independent review is the Sanad Step 3.5 two-pass review's collected reports — Pass A on the risk files, Pass B on the whole diff, and the fresh Pass B re-check after the last fix (every prompt starts `You are the independent reviewer`) — or verified promotion reuse per `ship/reference/promotion.md` (verdict labelled "reused" after a `git range-diff`); a launched but unfinished reviewer does not count. Write `REVIEW: PASS` only after reading the latest reports and dispositioning every finding, after the last code edit; then complete verification before `GATE: PASS`.

Every code or configuration publication requires completed independent review and a successful source-bound receipt from `scripts/evidence.mjs` for the exact outgoing content. The helper records the Git tree before and after execution; both must match the outgoing commit. Plain terminal output cannot replace that receipt, including for mechanical changes. Only a diff consisting entirely of ordinary documentation can omit code proof. Failed, pending, missing or stale evidence blocks both pushes and draft PR creation.

**Browser acceptance is user-owned (user choice 2026-09-21).** Give the user the verified local URL, test account/role and a short checklist of actions and expected results for affected roles/locales. Record their reported result against the current branch/diff as human-provided evidence. Until they reply, mark browser acceptance pending and continue independent code checks/review; do not claim a full gate pass. Do not launch browser automation or create a browser probe solely for acceptance unless the user asks. Keep applicable existing automated tests and required code, API, security and real-provider checks. A relevant UI change invalidates the affected manual result. See `reference/behavior-proof.md` for the evidence boundary.

## The gate, in order

Execute **CLAUDE.md's "⛔ Definition of Done" items 1–6 in order** — none optional. Don't restate them here (CLAUDE.md is loaded every session and owns the wording); *run* them. Two items get a built-in tool and one gets a scope pin:

- **Item 3 (Actually run it)** — run agent-owned checks using verified project commands and HTTP requests; the user performs browser acceptance under the rule above. Quote the observed business result and its source, data size/provider, affected role and locale. Genuinely can't run it here → say so explicitly and give exact steps; never imply it ran. **Relational code (ExecuteUpdate / ExecuteDelete / raw SQL / a migration) is proven against the real provider — a MySQL query or a live API request — before the PR opens, not after; the push guard requires a completed provider run after the last edit.** If the integration branch was merged into this branch this session, restart the API container first (the watcher's hot reload fails on const or reference changes and keeps serving old code) and confirm the new code is live by an observation only the new code can produce.
- **Item 4 (Red-team)** — the independent review (`/sanad` Step 3.5: Pass A on the risk files with a trace list, Pass B on the whole diff against the **Done means** list, a fresh Pass B re-check after every fix, plus a selected-engine boss-model review only when assigned a named unresolved issue or expertise gap) is the primary input: quote its `REVIEW:` line. None for this diff, or code changed since the last pass → run the re-check first; self-review supplements the independent review and cannot replace it when publishing code. Then tick every **Done means** line with its evidence (test name / request + status / rendered screen) — no evidence = ✗.
- **Item 5 (Security)** — use **`/security-review`** if available, or an independent security review, over the pending diff first (reuse the completed independent review if it actually covers this exact security scope; otherwise request the missing scope), THEN `~/.claude/skills/gate/security-checklist.md` for what it can't know (multi-tenant query filters, idempotency, shared key-ring, audit rows). Run the **whole** checklist — its reading order routes attention, it waives no section; for the sections the change touches, call out each risk + mitigation explicitly in the report.

A build failure (item 1) stops the gate — nothing downstream is meaningful; fix, then restart from item 1. Any other failing step: keep going, gather the complete picture, then report FAIL with everything found — one round trip, not five.

## Rules of evidence

- **No writes during the gate.** Do not run a formatter or touch source files while gating — a write (csharpier included) resets the guard's last-edit marker and invalidates the verification order. Changed C# files are formatted once before the final checks (Sanad Step 3), not per edit.
- **Human-provided browser evidence:** quote the user's actual result and identify the tested flow/revision. Do not invent command output or require a screenshot for an unambiguous pass/fail.
- **Real proof or no claim.** Every "builds / tests pass / works" line is backed by the actual command and its output **quoted in your reply**. No output = no claim — say "not run yet", never predict a pass or narrate what a run "would" print.
- **Avoid duplicate work.** Reuse a completed check only when its code state and relevant dependencies, configuration, toolchain and test data are unchanged; cite its original command/output. Run affected checks after a change and the full relevant suite once before handoff. This does not waive a gate item or a hook requirement.
- **Check actual coverage and native exit status.** A TypeScript solution root with `files: []` is not checked by bare `tsc --noEmit`; use the real app project or the repository's build command. `--listFilesOnly` and `--showConfig` are inspection, not verification. Capture each command's own exit status; a successful `tail`, `head`, or later command cannot prove it passed.
- **Fresh, completed evidence only.** Output must cover the current code after the last edit. Collect background commands to completion (their completion notification, or TaskOutput where the host has it); a launched process, a pending CI check, or a successful build followed by failed tests is unverified. Record branch/HEAD and the diff checked.
- **CI-skipped proof runs here.** A changed path proven only by opt-in tests that CI skips (environment-gated real-provider or integration tests) has them run after the last edit with the variable set, their result quoted in the gate (a skipped count is not a pass), and the PR body states CI does not run them. Not run → ✗ on tests.
- **Quote the decisive lines,** not the whole scroll: the final error/warning count, the test tally, the HTTP status + body, the row counts. Trim, never fabricate.
- **No silent skips.** Run every step; name any you skip and why (`–` in the verdict).
- **Proof by change type:** endpoint → request + status + body + one negative case (401/403/404); query → generated SQL + row counts before/after; UI → user-reported interaction/result for affected roles/locales; job/migration → log lines start→finish + affected rows.
- **Changed UI behavior needs a user interaction check.** Supply the affected click, navigation or error-path steps after the last relevant behavior edit and record the user's result. A compiler check does not prove the interaction. User-confirmed acceptance can satisfy ran it/goals with attribution; no reply or a failure cannot.
- Verify at the **cheapest correct rung** (CLAUDE.md "Verify fast") — the gate is rigorous about proof, never about rebuilding the world to get it.

## On failure

FAIL is a valid verdict, not an error to hide. Fix the cause where you can and re-run only the affected step; if a fix is out of reach now (missing env, needs a human decision), report `GATE: FAIL` naming the exact blocking item and what would flip it to PASS. Never downgrade a ✗ into a footnote under a PASS.

## Report format

End with a verdict block, not prose:

- One line per Definition-of-Done item: `✓ / ✗ / –  <item> — <command> → <quoted result>` (`–` = skipped, with why).
- **Security:** which checklist sections applied, each risk + mitigation in one line.
- **Gate summary**, one line, exactly this shape — `/ship` quotes it in the teach-back and proceeds only on PASS:

  `GATE: PASS|FAIL — build ✓, tests <n>/<n> ✓, attack tests ✓, security ✓, ran it ✓, review ✓, goals <k>/<k> ✓`

  Emit the actual verdict on its own line, outside a code fence, after verification finishes and the review verdict. Quoting this template is not a gate result.

  `attack tests` = the 401/403/404 + red-team probes from DoD items 4–5, quoted (not merely asserted). `review` = the `REVIEW:` verdict postdates the last code edit. `goals` = Done-means lines ticked with evidence. The line before it is one plain sentence for the user (Sanad Reporting contract). PASS requires every component ✓ or a justified `–` (e.g. docs-only change → tests/review `–`); a ✗ anywhere = FAIL.

- Emit the final gate verdict in the conversation and saved evidence record, never in tracked files after review (even bookkeeping invalidates the checked snapshot). Spec timing is owned by `/ship` pre-flight 4.
