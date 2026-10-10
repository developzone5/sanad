# Sanad سند

**A professional engineering framework for Claude Code** — an always-on rulebook plus one gated task loop (`/sanad`: understand → check facts → design → build and prove → independent review → gate → ship) where nothing ships without proof.

> *Sanad* (سند) — the verified chain that authenticates a narration; nothing is accepted until the chain is unbroken. Same idea, applied to code.

Built by **Eng. Mohammed Almutairi** · Developzone.net

Portable copy of my global Claude Code config. Move this whole folder to a new PC and install.

---

## Install on a new PC

1. Install Claude Code and Node.js (the hooks and tests run on Node).
2. Copy these into `%USERPROFILE%\.claude\` (create the folder if missing), overwriting:
   - `CLAUDE.md`      → my global engineering rules (senior backend bar, security gate, Definition of Done, git/PR flow)
   - `settings.json`  → models, effort per model, permissions and the hooks
   - `skills\`        → the skills (see below)
   - `hooks\`         → the deterministic guards (see Hooks below)
   - `agents\`        → the pinned reviewer / expert / worker agent types (see Models below)
   - `scripts\workflow-install.sh` → installs a tested change to this workflow as one versioned release
3. **Fix the hook paths for this PC.** `settings.json` points every hook at an absolute path under
   `C:\Users\Asus\.claude\hooks\`. If your Windows username isn't `Asus`, edit those paths.
4. Run `claude` and **log in** — credentials are NOT in this bundle (security); re-authenticate.
5. Restart Claude so skills + hooks load. Verify with `/help` and `/hooks`.
6. Prove the guards work on your machine:

```
cd %USERPROFILE%\.claude\hooks\tests && node --test
cd %USERPROFILE%\.claude\skills\gate\tests && node --test
```

---

## The loop — `/sanad`

Every request enters `/sanad`. It first decides what kind of request it is:

- **Teaching / explanation** → answered directly. No build, no panel.
- **Check my work** → the smallest relevant check, and an honest "what is still unverified".
- **Implement / fix** → routed before any edit. Clearly bounded work is self-routed (`direct` or `review`); uncertain or sensitive work goes to a routing boss that picks `review` or a `braintrust` panel.

A substantive implementation then runs six steps, each with one exit rule:

| Step | Name | Exit rule |
|---|---|---|
| 1 | Understand | `Done means`: 3–8 checkable results, including what must NOT change |
| 2 | Check the facts | every outside fact proven with a real sample, or listed as an open assumption |
| 3 | Design | the smallest change that meets `Done means`, plus the touch list |
| 4 | Build and prove | red before green for a bug; real output for every claim |
| 5 | Independent review | one fresh read-only reviewer on frozen source → `REVIEW: PASS` |
| 6 | Gate and ship | `/gate` once on the final source → `GATE: PASS`, then the ship brief and the explicit yes |

The chat shows one `▸ stage: verdict` line per stage, a braintrust result of at most 6 short lines, and a final ship brief under 12 lines. Full evidence is kept and shown only when asked.

---

## The skills

| Skill | Invoke | What it does |
|---|---|---|
| **sanad** | automatic / `/sanad` | The entry point for every request. Routes it, then runs the loop above for real implementation. |
| **sanad-implementation** | internal | The xhigh-effort implementation stage Sanad switches into after routing. Not user-invocable. |
| **braintrust** | `/braintrust <question>` | Seats 2–6 independent Claude specialists for the open questions (Pragmatist, Architect, Skeptic, Performance, Product advocate, Database optimizer, Security auditor, Authenticity reviewer), then a separate boss reviews every report and gives **one evidence-backed recommendation**. Claude-only, no API keys. Effort dial `low→max` caps the room. |
| **gate** | `/gate` | Runs the Definition-of-Done + security gate against the current change — build, tests, red-team, security checklist — with **real quoted command output**. Ends in `GATE: PASS` or `GATE: FAIL`. |
| **ship** | `/ship` | Teach-back brief (what & why / proof / risk / left / target), then publishes the branch to the **integration branch** as a **DRAFT PR**. Never main/master/prod. Stops for the explicit yes first. Also owns PR review and promotion (cherry-pick) rules. |
| **spec** | `/spec` | One lean, committed spec file per multi-session feature (goal, decisions, plan, risks, log). Manual-only. |
| **worktree** | `/worktree` | A parallel git worktree with its own branch, so a second session can work a second track. |
| **demo** | `/demo` | A paced, screen-share walkthrough of the loop (`/sanad → /spec → /braintrust → /gate → /ship`). Presentation only — never builds, tests, commits or opens PRs. |
| **full-output-enforcement** | (applied to a task) | Forces complete, unabridged code output — bans `// ...`, `TODO`, placeholder elisions. |
| **impeccable** | (frontend tasks) | Frontend UI work: design, redesign, audit, critique, polish — layout, typography, color, motion, accessibility, responsive, RTL. |

---

## Models — each in its strength

| Role | Model | Agent type (`agents\`) |
|---|---|---|
| Routing boss / braintrust final reviewer | Fable 5.1, xhigh | `routing-boss` (read-only; judges, never writes code) |
| Main worker (all behavior code) | Opus 5.5 | the main session |
| Deep-risk braintrust seats | Opus 5.5, xhigh | `braintrust-expert` (read-only) |
| Practical braintrust seats | Sonnet 5.5, xhigh | `braintrust-expert-sonnet` (read-only) |
| Independent reviewer, sensitive change | Opus 5.5, xhigh | `independent-reviewer` (read-only) |
| Independent reviewer, routine change | Sonnet 5.5, xhigh | `routine-reviewer` (read-only; can `ESCALATE` to Opus) |
| Mechanical edits + evidence chores | Sonnet 5.5, medium | `sonnet-worker` |

Haiku is not used. The main session is the only editor of behavior code; reviewers advise.

---

## Hooks — the gate is automatic

All deterministic Node scripts under `hooks\`, wired in `settings.json`. Fix the cause when one fires; never bypass it.

- **`policy-guard.js`** (PreToolUse, Bash + PowerShell) — branch, destructive-action and publishing controls. Publishing needs completed passing verification, a source-bound evidence receipt, a completed reviewer run after the last change, then `REVIEW: PASS` and `GATE: PASS`.
- **`precommit-guard.js`** (PreToolUse) — denies a commit or publish carrying a secret (new files included), a credential file or AI attribution.
- **`csharpier-guard.js`** (PreToolUse) — denies a commit with unformatted or partly staged `.cs` files.
- **`stop-gate.js`** (Stop) — after a code change, missing/failed/pending verification blocks once, then warns honestly.
- **`session-start.js`** (SessionStart) — prints branch, ahead/behind, uncommitted count and PR state.
- **`hooks\lib\`** — shared helpers (shell command parsing, transcript scan, verification target). **`hooks\tests\`** — the suite (`node --test`).

Evidence helper: `skills\gate\scripts\evidence.mjs` records a real command run as the receipt the publishing guard checks.

---

## Changing the workflow itself

Workflow edits (skills, hooks, `CLAUDE.md`, settings, agents) ship as a release, not an in-place edit:

```
bash ~/.claude/scripts/workflow-install.sh <candidate> <base> <release-name>
```

It checks for drift, backs up every replaced file to `backups\<release-name>\`, installs, runs both test suites and appends one line to `backups\RELEASES.md`.

---

## Deliberately NOT included

- `.credentials.json` — auth token (a secret; never copy it around — re-login instead)
- `settings.local.json` — machine-local permission overrides
- the `autoMode.environment` block of `settings.json` — describes my private repos and hosts
- caches, `history.jsonl`, `sessions/`, `projects/`, `telemetry/`, `shell-snapshots/`, `backups/`
- per-project `memory/` and project-specific scripts (they live under each project)
- third-party plugins and synced marketplace skills
