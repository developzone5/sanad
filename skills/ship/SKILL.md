---
name: ship
description: Walk the change through the teach-back brief, then push to staging and open a DRAFT PR — never main/master/prod. Use when the user types /ship or asks to push, open a PR, or ship the change. Stops for explicit approval before pushing.
---

<!-- Author: Eng. Mohammed Almutairi - Developzone.net -->

# /ship — teach-back, then push to staging

This file is the single source for the shipping flow (moved from CLAUDE.md 2026-09-28): the teach-back brief, the integration-branch and draft rules, and the after-deploy smoke — see **Rules** below. CLAUDE.md's "Self-review your diff first" still applies before the brief.

**Pushing and opening a PR are explicit-approval steps. Brief first, ask, wait for a yes, then push. Never automatic — and a "yes" to the task is not a "yes" to the push; approval is per-action and expires.**

## Pre-flight — check all four before the brief

1. **Fresh base.** Synchronize before final verification/review per [execution.md](../sanad/reference/execution.md). This pre-flight is the final freshness check, not the first integration update. `git fetch origin` must succeed — a failed or timed-out fetch is a stop (report it; never publish on stale remote data). Then: (a) `gh pr view --json number,state,baseRefName` — if this branch's PR is already **MERGED**, do not push more commits to it: create a new branch off `origin/<integration>` (`git checkout -b <type>/<name> origin/<integration>`), cherry-pick/re-apply the work, and re-brief; (b) if the branch is **behind** `origin/<integration>` (`git rev-list --left-right --count origin/<integration>...HEAD`), merge it into the feature branch (never rebase a pushed branch), collect affected checks and the required review for changed content/context, then re-run `/gate`. If no relevant inputs changed, reuse the completed evidence. The `session-start.js` hook prints this state at startup; re-check here because it changes mid-session.
2. **Review + gate.** Both PASS for the current result, per `/gate` (it owns the evidence rules: completed independent review, source-bound evidence.mjs receipt, docs-only exception); each verdict line plain at line start in a text-only message. An already-reviewed cherry-pick follows [promotion.md](reference/promotion.md). Missing, pending or failed required checks block the push, drafts included.
3. **Identity.** Commit author is `developzone5` + the noreply email (CLAUDE.md Ground rules) — check `git config user.name` / `user.email` before the first commit; a fresh clone has none set. Never commit as `RND`.
4. **Spec.** Finalize its implementation milestones, actual verification evidence and `In review` status before independent review so the spec ships in the reviewed snapshot. Do not edit it during this pre-flight or after the gate. Necessary later changes require review again; final review/gate/approval results live in the conversation, saved evidence and PR body. Mark `Shipped` only after the feature actually ships, in a later documentation update.

## Flow

1. **Branch & commit.** On `main`/`master` or the integration branch → create a feature branch first. Stage named files only (no `git add .`); Conventional Commit messages (CLAUDE.md Ground rules).
2. **Discover the PR base — never assume.** Read the repo's branches: `staging` → `develop` → `dev`, first that exists is the base. **Never** `main` / `master` / `prod` / `production` / `release/*` — even if checked out on one. If no integration branch exists (only `main`/`master`), STOP and ask which branch is the integration target — never default to `main`.
3. **Self-review the staged diff** (CLAUDE.md), then give the **teach-back brief** (Rules below), stating the target out loud: `Pushing <branch> → PR base <integration branch>`. Then wait for explicit approval — do not push while waiting.
4. **Push, then open the PR as DRAFT** with an explicit base — `gh pr create --draft --base <integration>` — never rely on the repo's default base. The PR body reuses the brief: `## Summary` / `## Test plan` / `## Risk / migrations / config` / `## Rollback`, per "Draft until proven" below. Test plan lists only what actually ran.
   **Follow-up push to an existing PR: update the body** from the current brief and gate (`gh pr edit <n> --body-file`). Read the existing body, remove invalidated claims, and preserve valid evidence with its original command/output, checked revision and source link. Label reused evidence honestly; never claim it ran again this session. Add a `## Review` section with findings/dispositions and reused source reviews when applicable.
5. **Check the PR head.** Read its head SHA, required CI and review findings after pushing. Pending or failing required checks keep it draft. Re-check the SHA before declaring CI green; after any new commit, repeat affected local proof and check CI on the new head. Never merge or change repository protection settings.
6. **Report** the PR URL plus what remains unverified (e.g. UI not browser-tested). Push rejected (non-fast-forward) → fetch and merge locally (never rebase a pushed branch), then re-brief if the diff changed; never force-push a shared branch.
   **Record task metrics (user choice 2026-09-28):** append one line to the project's `memory/task-metrics.md` — `date · task · PR · route (direct/review/braintrust) · agents (boss/panel/reviewer runs) · review rounds · full-suite runs · elapsed (first request → PR) · escaped bugs: 0`. Use real counts from this session; unknown stays `?`. Compare these lines before tuning the workflow further; no unmeasured speed or quality claims.

7. **Deferred expert maintenance.** After the PR is open, required task work is complete and the PR handoff above has been delivered, process pending boss coaching notes through [expert-learning.md](../braintrust/reference/expert-learning.md). Reuse existing findings and evidence; update only the responsible expert's skill guidance file. Report this separately from the task handoff. Do not delay PR creation or task completion, change the reviewed project snapshot, rerun the panel or reopen cleared reviews for skill-only maintenance. If there are no pending notes, skip it. If shipping or task completion is still pending, retain the notes as pending; do not claim background work will run after the session ends.

## Rules (single source; moved from CLAUDE.md 2026-09-28)

### Teach before you push

Pushing and opening a PR are **explicit-approval steps, never automatic.** Before a push, stop and tell the human **what you fixed and why** — that is the whole point of the brief. Lead with it, make it clear, then add only what's needed to approve:

- **What & why** — the heart of the brief: each change and the reason behind it, one clear line each. Not a diff dump, not an essay — the fix and the decision. Name the tradeoff you rejected if it wasn't obvious.
- **Proof** — what you ran → what you saw (build, tests, the real run).
- **Risk** — migrations, config/env, deleted code, anything needing a manual step. `none` if nothing.
- **Left** — what you didn't touch, guessed, or left for the human.
- **Target** — `Pushing <branch> → PR base <staging>. Approve?`

Talk like a peer explaining a change, not a form and not a wall of text. Then **wait for the yes.** Told to "just push" with the task → still give the what-and-why first, then push. A "yes" to the task is not a "yes" to the push. (`/ship` runs this brief + the draft-PR flow, and still stops for the explicit yes.)

### Push only to the integration branch

Push branches and open PRs against the staging/dev integration branch ONLY — never `main`, `master`, `prod`, `production`, or any `release/*` branch, even if currently checked out on one.
- State the target out loud before acting: "Pushing `<branch>` → PR base `<integration>`."
- Discover the base, don't assume: read the repo's branches (default-branch ref, branch list). A `develop`/`staging`/`dev` branch is the base. If only `main` exists, STOP and ask which branch is the integration target — never default to `main`.
- PR-create MUST pass an explicit base; never rely on the default base.
- Never merge a PR, never merge into a shared/prod branch, never tag a release, never trigger a prod deploy. Promotion to prod is the human's call, per-action.
- If told to target prod directly, restate the target and require a one-time confirmation before acting.

#### Draft until proven
Open as a DRAFT unless every Definition-of-Done item passed. Mark ready only after the full gate is green, stating which items you verified vs. couldn't (e.g. UI not browser-tested). A branch that can't deploy cleanly stays draft. The PR body reuses the teach-back — don't invent new prose:
- `## Summary` — what + why.
- `## Test plan` — only what you actually ran, per the gate. Not aspirational. Opt-in tests that CI skips (environment-gated real-provider tests) are listed with their local result and the note "not run by CI".
- `## Risk / migrations / config` — migrations? new env/config keys? a manual step? Write "none" explicitly.
- `## Rollback` — how to undo; for an applied migration, the down/expand-contract path. "Irreversible" is a blocker — flag it.

No AI attribution (no session links or `Claude-Session:` trailers either), no internal agent notes.

### After the deploy

Merging isn't done. Once it deploys, smoke the primary happy path end to end against the deployed URL (the one flow this change touches, hit for real) and scan logs for new errors/warnings just after deploy; paste the result. Can't reach the environment → list the exact manual smoke steps, don't mark it verified.

For any new flow crossing a boundary (HTTP in, external call, background job, multi-step write), make it traceable without a debugger: a correlation/request id on every log line, a structured info event at the business start and end with key ids, an error event with that id on the catch — never a bare "failed". Surface the correlation id in the user-facing error so a report maps to a log line. No secrets/PII in any of it.
