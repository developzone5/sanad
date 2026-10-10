---
name: sanad
effort: medium
description: Entry point for every user request. Handle teaching and explanations directly; for implementation, bounded work is self-routed and a Fable boss routes uncertain or sensitive work to Claude review or braintrust. Preserve applicable verification and publishing approval.
argument-hint: "<task> [effort=low|medium|high|xhigh|max]"
---

<!-- Author: Eng. Mohammed Almutairi - Developzone.net -->

# /sanad — the task loop

Every request enters Sanad. Start at Step 0 to select the appropriate branch and effort. Teaching, explanations, checks and other direct requests finish in the short branch with proportionate evidence; they do not run or narrate the six implementation stages. Implementation starts with a brief boss route assessment before edits. Substantive routes then follow **understand → check the facts → selected design route → build and prove → independent review → gate and ship.** Cosmetic/mechanical implementation follows the boss-selected direct checks. Nothing is pushed without the explicit yes.

## The six steps — every substantive task, in this order

Each step has one exit rule: no exit, no next step. The sections below keep their historical numbers because CLAUDE.md and the other skills cite them. Everything in this file stays stack-neutral — a project's own lessons live in that project (see Rules).

1. **Understand** (Steps 0–1). Draft `Done means`: 3–8 checkable results in the user's words, including what must NOT change — read what the code does today before listing it. *Exit:* every line can be checked by a test, a request + status, or a rendered screen. Unclear → one question.
2. **Check the facts** (Step 1.5). Every fact the design depends on that lives outside the code is proven with a real sample, or written down as an open assumption the user accepts. *Exit:* `facts: <n> proven, <m> open`.
3. **Design** (Step 2). Follow the boss route: `review` records the bounded approach without a panel; `braintrust` convenes experts. Choose the smallest change that meets `Done means`, plus the touch list. *Exit:* decision, final `Done means` and touch list written.
4. **Build and prove** (Step 3). Red before green for a bug; tests through the public entry point, per lifecycle state, and for a failure the code did not expect; the real provider when data writes change; run it for real. *Exit:* required agent-owned checks green with real output; user-owned browser acceptance may stay pending during static review, then must be confirmed before the gate passes.
5. **Independent review** (Step 3.5). One review campaign on frozen source, with inputs the author cannot frame. *Exit:* `REVIEW: PASS`, nothing open.
6. **Gate and ship** (Steps 4–5). `/gate` once on the final source, then the ship brief and the explicit yes. *Exit:* `GATE: PASS` and the user's yes.

## Step 0 — Loop-worthy?

Classify the current request before choosing tools (user-approved 2026-09-21):

**Effort by request (2026-09-21):** every request enters Sanad. Its native skill uses medium effort for routing, teaching, explanations and focused checks. For substantive implementation or an implementation continuation, invoke the internal `sanad-implementation` skill after routing; it applies xhigh effort and continues the steps below. This is a stage inside Sanad, not another user workflow. Direct handling elsewhere in these instructions means Sanad's short branch, not bypassing Sanad. Invoke skills through the host's native skill mechanism: reading a file or writing an effort label does not change runtime effort. Do not restore a global forced-max environment variable. Relaunch sessions that inherited the removed variable. If the host cannot activate skill effort, report that limit rather than claiming a switch.

- **Teaching / explanation / lesson status:** read the relevant lesson tracker and code, then answer or give one teaching step. Do not build, run tests, inspect unrelated infrastructure, or launch a review panel just to explain or resume a lesson. Check prerequisites when the actual hands-on step needs them.
- **Check my work:** inspect the user's changes and run the smallest relevant check. Report exactly what it proves and what remains unverified; this is not a full gate or permission to publish. In a teaching session, the user still makes lab code changes.
- **Implement / fix (including simple frontend edits):** route before edits per `sanad/reference/boss-routing.md` (relative to the skills root): self-route clearly bounded `direct`/`review` work; call the Fable 5.1 / xhigh boss only when scope, risk or approach is uncertain or a sensitive boundary is touched. Follow the route, preserving its required proof and publishing approval. Reuse a valid decision for an unchanged continuation. A real implementation request during a lesson is routed the same way; explanation alone is not.

Route each new request by its intent, not merely by the project or the previous turn. A question during implementation gets a direct answer, then the existing task continues. These teaching/check routes do not waive security, destructive-action, publishing controls, or unfinished checks for an implementation change.

Run the loop for a substantive implementation task: a feature, a behavior change, a bug fix, a migration, a refactor with behavior risk. Use Sanad's direct branch without the implementation loop for: questions ("why/how/what if"), PR reviews, doc/comment edits, trivial mechanical fixes (typo, rename, one obvious line). For implementation, route before edits per [boss-routing.md](reference/boss-routing.md): clearly bounded work is self-routed, uncertain or sensitive work goes to the boss. Questions, reviews and documentation-only work stay direct. A one-line behavior change is not automatically cosmetic.

**Workflow changes skip the reviewer (user rule 2026-09-28):** the independent reviewer and the boss run on the tasks and bugs the user gives, not on changes to the workflow itself (`~/.claude` skills, hooks, CLAUDE.md, settings, `~/.agents` mirrors). Build those as a release: copy the live files to a scratch candidate plus an untouched base copy, edit the candidate, run its suites (`hooks/tests`, `skills/gate/tests`), then install with `bash ~/.claude/scripts/workflow-install.sh <candidate> <base> <release-name>` (drift guard, backup, suites, `backups/RELEASES.md` line). Use literal paths in install commands. Hooks apply on their next run; settings changes (effort, permissions) need a fresh session.

Multi-session feature? Compose with `/spec` first (or update the existing spec); the loop then works one milestone of that spec at a time.

Already-reviewed PR being cherry-picked/promoted? Use [promotion.md](../ship/reference/promotion.md) directly. Equivalent changes reuse the original reviews; the target receives compatibility checks and required verification. Do not restart design, implementation or independent review merely for a new branch/session. New conflict edits or changed behavior follow the loop only for that delta.

Read [execution.md](reference/execution.md) once for substantive work. Keep the user's requested behavior as the scope; `Done means` records necessary outcomes and proof, not extra features. Read the current handoff and verified project commands before recreating setup.

**A bug the user reports in shipped or PR'd work is logged BEFORE it is fixed:** one line in the project's `memory/missed-bugs.md` (bug · CLASS · WHY MISSED · CATCH = the concrete check that would have caught it), then the fix runs through the loop, and the escaped-bug count on that task's line in `memory/task-metrics.md` goes up by one. That file is read by the Step 3.5 reviewers and the braintrust evidence pack — a class logged once becomes a standing check.

## Steps 1–5 — the implementation loop

Steps 1 (impact triage), 1.5 (check the facts), 2 (braintrust), 3 (implement), 3.5 (independent review), 4 (gate) and 5 (ask to ship) live in [reference/loop.md](reference/loop.md). The `sanad-implementation` stage reads that file in full before continuing; "Sanad Step N" anywhere refers to it. Questions, teaching and checks never need it.

## Reporting contract — how the loop talks

The user watches progress, not essays. Hard format, no exceptions:

- **One line per stage, as it happens:** `▸ <stage>: <verdict>` — e.g. `▸ understand: done means 6 lines (2 must-not-change)` · `▸ facts: 2 proven, 0 open` · `▸ braintrust: soft-delete + tombstone — index DeletedAt · done means: 5 lines` · `▸ build: 3 files, migration added`. Review and gate results use their own plain `REVIEW:` / `GATE:` verdict lines (Step 3.5, `/gate`), never a `▸` line.
- **Zero prose between stages.** No "now I will…", no restating the task, no explaining what a stage does.
- **Braintrust result to the user: max 6 short lines in simple words** — the braintrust "What the user reads" block (decision, why, options with scores, trap, safe rollout, check next), one line each. The full record goes into the spec's Decisions section, not the chat.
- **The final message is the ship brief ONLY**, in `/ship`'s format (What & why / Proof / Risk / Left / Target, one line each), then the ask. Under 12 lines total.
- **Detail is pull, not push.** Keep the full evidence (SQL, test output, sweeps) ready and give it ONLY when asked ("show the detail"). Writing it unasked is a contract violation even when it feels helpful.

## Rules

- **A cycle, not a script.** Red gate → rebuild; invalidated decision → re-convene; every loop-back stated in one line.
- **Skips are stated, never silent.** Every stage either runs or gets a one-line `skipped: <reason>`.
- **User steering:** answer questions and incorporate corrections immediately. Queue genuinely separate work explicitly; do not delay a simple status request behind the loop.
- **Project incident records stay in the project.** A teammate or post-PR finding is logged in that project's `memory/missed-bugs.md` and becomes a check in THAT project — its tests, its lint, its rules file. It is never added to this file, the global CLAUDE.md or a reviewer prompt; global text stays stack-neutral and must still read correctly for a different stack. Expert instruction gaps follow the user-approved exception: after the PR is open and the task handoff is delivered, fix the responsible expert's own skill guidance file through [expert-learning.md](../braintrust/reference/expert-learning.md), with explicit applicability and no duplicate project-memory lesson.
- **The ship ask is the hard stop.** No stage, effort level, or mode removes it.
