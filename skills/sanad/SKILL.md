---
name: sanad
effort: medium
description: Entry point for every user request. Ask once per new task for Claude or Codex, recommending the current chat engine. Route bounded work directly and uncertain or sensitive work through the selected engine. All Codex roles use xhigh; preserve verification and publishing approval.
argument-hint: "<task> [engine=claude|codex] [effort=low|medium|high|xhigh|max]"
---

<!-- Author: Eng. Mohammed Almutairi - Developzone.net -->

# /sanad — the task loop

Every request enters here. Route by intent, then load only what the route needs. Nothing is pushed without the explicit yes.

## Step 0 — Choose engine, then route

For a new actionable task, ask **"Which engine for this task?"** with the current chat engine recommended first (Claude or Codex), then wait for the answer. An explicit engine choice answers it already. Follow [engines.md](reference/engines.md) for selection, saved task state, role assignments and host handoff. Follow-ups, questions and delegated children reuse the task choice. Claude keeps medium routing; **Codex stays xhigh for every role and stage**.

- **Teaching / explanation / lesson status** → read the relevant tracker and code, then answer or give one teaching step, in the CLAUDE.md reply shape. No build, no tests, no panel, no reviewer. Nothing else from this skill loads.
- **Check my work / PR review / a question during a task** → the smallest relevant check (or `ship/reference/pr-review.md` for a PR). Report exactly what it proves and what stays unverified. Not a gate, not permission to publish. The existing task then continues.
- **Implement / fix / continue implementation** (a feature, behavior change, bug fix, migration, refactor with behavior risk; a one-line behavior change is not cosmetic) → route before edits per [boss-routing.md](reference/boss-routing.md): self-route clearly bounded work and show `▸ size: tiny edit|small fix — reason`; call the selected engine's boss only when scope, risk or approach is uncertain or a sensitive boundary is touched. Then invoke the internal `sanad-implementation` skill (xhigh) through the host's native skill mechanism; it reads [reference/loop.md](reference/loop.md) and [reference/execution.md](reference/execution.md) and runs Steps 1–5: understand → check the facts → design → build and prove → two-pass review → gate and ship brief. Reuse a valid route and completed decisions for an unchanged continuation; ask the same boss to reassess only when new scope, risk or evidence invalidates them.
- **Docs/comment edits, trivial mechanical fixes** (typo, rename, one obvious line) → direct, with proportionate verification.
- **Multi-session feature** → `/spec` first (or update the existing spec); then one milestone at a time. **Already-reviewed PR being cherry-picked or promoted** → [promotion.md](../ship/reference/promotion.md): equivalent changes reuse the original reviews; only conflict edits or changed behavior re-enter the loop.

Route each new request by its intent, not by the project or the previous turn. No route waives security, destructive-action or publishing controls, or an unfinished check. Reading a file or writing an effort label does not change runtime effort; if the host cannot activate the required effort, say so.

## Rules on every route

- **Workflow changes skip the reviewer (user rule 2026-09-28):** the independent reviewer and the boss run on the tasks and bugs the user gives, not on changes to the workflow itself (`~/.claude` skills, hooks, CLAUDE.md, settings, `~/.agents` mirrors, Sanad Codex config/agents). Build those as a release: copy the live files to a scratch candidate plus an untouched base copy, edit the candidate, run its suites (`hooks/tests`, `skills/gate/tests`), then install with `bash ~/.claude/scripts/workflow-install.sh <candidate> <base> <release-name>` (drift guard, backup, suites, `backups/RELEASES.md` line). Use literal paths. Hooks apply on their next run; settings changes need a fresh session.
- **A bug the user reports in shipped or PR'd work is logged BEFORE it is fixed:** one line in the project's `memory/missed-bugs.md` (bug · CLASS · WHY MISSED · CATCH = the concrete check that would have caught it); the escaped-bug count on that task's line in `memory/task-metrics.md` goes up by one; the CATCH becomes a mechanical check or a review-prompt line within the week. Then the fix runs through the loop.
- **Project incident records stay in the project.** A teammate or post-PR finding becomes a check in THAT project (its tests, lint, rules file), never a line in this file, the global CLAUDE.md or a reviewer prompt; global text stays stack-neutral. Expert instruction gaps are fixed after the PR is open through [expert-learning.md](../braintrust/reference/expert-learning.md).
- **A cycle, not a script.** Red gate → rebuild; invalidated decision → re-convene; every loop-back stated in one line. **Skips are stated, never silent.** **User steering** is answered at once; separate work is queued explicitly. **The ship ask is the hard stop** — no stage, effort or mode removes it.

## Reporting contract — how the loop talks

- **Plain words in chat (user rule 2026-10-22).** Every line the user sees follows CLAUDE.md "How you talk" (Codex: `~/.codex/AGENTS.md`). The user must understand each line without asking. Internal names (route, facts, boss, braintrust, Pass A/B, Done means, gate) stay in files, records and agent prompts; the chat uses the plain shapes below.
- One line per stage, as it happens, in a self-explaining shape:
  - Size of the job (route `direct` / `review` / `braintrust`): `▸ size: tiny edit | small fix | big or risky, expert panel first — <reason>`
  - Facts checked before building: `▸ checked: <n> facts confirmed, <m> not sure yet`
  - Build: `▸ built: <n> files changed, <n> tests pass`
- Review and gate keep their machine lines (`REVIEW:` / `GATE:`, read by the hooks), never a `▸` line. Put one plain sentence on the line before each, e.g. `🟢 A second AI checked the change and found no problems.`
- **Running list for multi-item work (user rule 2026-10-26).** When the task has 3 or more items (review comments, bugs, acceptance steps), keep one numbered list in the user's words, each line marked 🟢 done · 🟡 working on it · 🔵 not started · 🔴 blocked. Show it when work starts, again after each item finishes or changes state, and whenever the user asks for status — the user never has to ask "where is the list". Same numbers throughout; new items join at the end.
- Zero prose between stages. No "now I will…", no restating the task.
- Braintrust result to the user: the 6-line "What the user reads" block only; the full record goes to the spec.
- The final message is the ship brief ONLY, in `/ship`'s format (What I changed and why / How I checked it / Risk / Not done / Where it goes, one line each), then the ask. Under 12 lines.
- Detail is pull, not push: keep the evidence (SQL, test output, sweeps) ready and give it only when asked.
