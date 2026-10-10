---
name: worktree
description: Spin up a parallel git worktree (own directory, own branch off the integration branch) so a second Claude Code session can advance a second track concurrently; also lists and safely removes worktrees. Use when the user types /worktree, asks for a parallel worktree/track/session, or wants to work two branches at once.
---

<!-- Author: Eng. Mohammed Almutairi - Developzone.net -->

# /worktree — parallel tracks via git worktrees

Create, list, or remove sibling worktrees so two Claude Code sessions can work the same repo on different branches without colliding. The point is throughput: PRs merge fast, so two disjoint tracks ≈ 2× delivery. The guardrails below exist because the repo shares one schema snapshot, one dev container, and one local DB — read them before creating anything.

**Usage:** `/worktree <track-name>` (create) · `/worktree list` · `/worktree remove <track-name>`

## Create — `/worktree <track-name>`

1. **Guardrail check first — disjoint tracks only.** Ask (or infer from the stated task) what the new track will touch:
   - **The status board (see below):** any task already marked **In progress** is owned by another terminal — the new track must not overlap it.
   - **EF migrations / model snapshot:** if ANY existing branch or worktree already carries a pending migration or touches `*ModelSnapshot.cs`, a second schema track is BLOCKED — the snapshot merge-conflicts miserably. One schema branch at a time; say so and propose a non-schema track instead.
   - **Same files/services** as an in-flight track → warn about merge-conflict risk and suggest a more disjoint split (e.g. backend track A, frontend track B).
2. **Fresh base.** `git fetch origin`, then discover the integration branch — `staging` → `develop` → `dev`, first that exists (never `main`/`master`; if only `main` exists, STOP and ask, per CLAUDE.md).
3. **Create.** Sibling directory next to the repo root, branch named with the repo's convention (default `feat/<track-name>`):
   `git worktree add ../<repo>-<track-name> -b feat/<track-name> origin/<integration>`
4. **Claim the task on the status board.** Mark the new track's task **`In progress — <branch>`** on the board so other terminals see it's taken.
5. **Report** — the user opens the second session themselves; tell them exactly how:
   - Path of the new worktree and its branch.
   - Open a new terminal/window there and run `claude` (or open the folder in the IDE).
   - Remind: untracked local files (`.env`, local overrides) do NOT come along — copy them manually only if that track truly needs them.

## The status board — how terminals know about each other

Sessions in different terminals do NOT see each other; the project's work-tracker MD file is the coordination board (EduQuest: `EduQuest.Api\Doc\New Technology\PAGES-STATUS.md`). The convention:

- **`In progress — <branch>`** on a task = a terminal owns it. Other terminals must not touch that task or its files.
- **Claim before you start, update when you merge** (In progress → Done, from the merging terminal).
- **Single source of truth = the copy in the MAIN checkout** (the original repo directory, e.g. `<your repos folder>\EduQuest\...`), read/updated by absolute path from every worktree. Each worktree has its own stale copy of this tracked file — never use the local copy for coordination.
- Every session working in a worktree reads the board FIRST, before touching code.

## The two standing guardrails (repeat them in the report)

- **One schema branch at a time.** Only one track may add EF migrations or touch the model snapshot until it merges.
- **One app-runner at a time.** The dev container bind-mounts ONE checkout and there is one local DB / one app port. Only one worktree runs the app or the container; the other track verifies at the unit-test rung on the host (isolated artifacts, e.g. `dotnet test --artifacts-path <scratch>`) and gets its live smoke after merging.

Each track = its own PR to the integration branch, its own /gate, its own /ship. Never share a branch between worktrees.

## List — `/worktree list`

`git worktree list` plus, per worktree: current branch, dirty/clean (`git -C <dir> status --porcelain`), and ahead/behind the integration branch. Flag any worktree whose branch has already merged — it's cleanup-ready.

## Remove — `/worktree remove <track-name>`

Removal is destructive — check before acting:
1. Dirty working tree (`git -C <dir> status --porcelain` non-empty) → STOP, show what's uncommitted, ask for explicit confirmation. Never `--force` silently.
2. Branch not merged into the integration branch → say so and confirm the branch should be kept (remove the worktree, keep the branch) or deleted too.
3. Then: `git worktree remove ../<repo>-<track-name>`, `git branch -d feat/<track-name>` only if merged, and `git worktree prune`.
