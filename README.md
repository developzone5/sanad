<p align="center">
  <img src="logo.png" alt="Sanad" width="120" />
</p>

<h1 align="center">Sanad سند</h1>

<p align="center">
  <b>A gated engineering loop for Claude Code and Codex. Nothing ships without proof.</b>
</p>

<p align="center">
  <a href="https://developzone.net/Sanad/index.html">Website</a> ·
  <a href="#quick-install">Install</a> ·
  <a href="#the-loop">The loop</a> ·
  <a href="#whats-inside">What's inside</a> ·
  <a href="#faq">FAQ</a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
  <img alt="Claude Code" src="https://img.shields.io/badge/Claude%20Code-skills%20%7C%20agents%20%7C%20hooks-7c3aed.svg" />
  <a href="https://github.com/developzone5/sanad/actions/workflows/tests.yml"><img alt="Tests" src="https://github.com/developzone5/sanad/actions/workflows/tests.yml/badge.svg" /></a>
  <a href="https://github.com/developzone5/sanad/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/developzone5/sanad?style=flat" /></a>
</p>

---

> *Sanad* (سند) is the verified chain that authenticates a narration. Nothing is accepted until every link is checked. Sanad applies the same idea to code: every change walks one gated loop, and every claim is backed by real command output.

Sanad provides a shared workflow for Claude Code and Codex: an always-on rulebook, one task loop (`/sanad`), and specialist agents. Six deterministic guards enforce parts of the workflow in Claude Code. Codex uses the same canonical instructions and applies review, evidence and approval requirements explicitly; Claude hooks do not run automatically in Codex. The workflow is opinionated and backend-first.

## Table of contents

- [How it works](#how-it-works)
- [Quick install](#quick-install)
- [The loop](#the-loop)
- [What's inside](#whats-inside)
  - [Skills](#skills)
  - [Agents](#agents)
  - [Hooks](#hooks)
  - [The rulebook](#the-rulebook)
- [Try the demo](#try-the-demo)
- [Philosophy](#philosophy)
- [Updating](#updating)
- [Changing the workflow itself](#changing-the-workflow-itself)
- [FAQ](#faq)
- [Contributing](#contributing)
- [License](#license)

## How it works

Every request enters `/sanad`. It decides what kind of request it is, then does only what that kind needs:

Choose Claude or Codex once per new task; an explicit choice or continuation reuses that selection. Every Codex role runs at **xhigh**.

| Request | What happens |
|---|---|
| A question or explanation | Direct answer. No build, no panel. |
| "Check my work" | The smallest relevant check, plus an honest list of what is still unverified. |
| A feature, fix or change | Routed **before any edit**. Bounded work is self-routed. Uncertain or sensitive work goes to a routing boss that picks a review or a braintrust panel. Then the six-step loop runs. |

The chat stays short and plain. Every reply, explanations included, is a one-sentence answer plus at most three short points in simple English (the `Plain and short` output style). Each stage gets one self-explaining line, such as `▸ size: small fix — <reason>` or `▸ checked: 3 facts confirmed, 0 not sure yet`. A braintrust result is at most six lines, and the final ship brief is under twelve lines. Full evidence is kept and shown only when you ask.

## Quick install

**Windows (PowerShell), one command after cloning:**

This installs the Claude resources. For Codex roles and shared entrypoints, follow [Codex setup](codex/README.md). Existing installations use the [versioned update procedure](#updating).

```powershell
git clone https://github.com/developzone5/sanad.git
cd sanad
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

The installer:

1. backs up every file it replaces to `%USERPROFILE%\.claude\backups\sanad-install-<timestamp>\`;
2. copies `CLAUDE.md`, `skills\`, `hooks\`, `agents\`, `output-styles\` and `scripts\workflow-install.sh`;
3. writes `settings.json` with the hook paths pointed at **your** `.claude\hooks\`;
4. runs both test suites from the installed location and refuses to finish on a failure.

Options: `-Dest <path>` installs somewhere else, `-KeepSettings` leaves your `settings.json` untouched, `-SkipTests` skips step 4.

Then restart Claude Code and check `/hooks` and `/help`.

**macOS / Linux (manual):** copy the same six items into `~/.claude/`, then open `settings.json` and replace every `C:\\Users\\Asus\\.claude\\hooks\\` with your own absolute hooks path. The hooks are plain Node scripts and run anywhere Node runs.

**Requirements:** the selected Claude Code or Codex host, Node.js 20 or newer (tested locally on 25), Git. The C# formatting guard needs [CSharpier](https://csharpier.com) only if you commit `.cs` files.

**Not included on purpose:** credentials, machine-local `settings.local.json`, caches, sessions, per-project `memory/`, and the private `autoMode.environment` block.

## The loop

Six rules hold on every task, whatever its size:

1. Before code, list every place that uses the rule or data the change touches. The list comes from a search.
2. A test for every ticket line and every place.
3. Every new test fails on the old code.
4. Tests, lint, types and the suite pass on the final code.
5. A second AI reviews. Every note it writes is fixed, or the user decides it. The author never closes a note alone.
6. The user checks in the browser and pushes.

Rules 1, 2, 4 and 5 are locks: a program refuses the next step until the rule holds. A size check picks the depth, not the author: **Small** (one side, no risk signal: no experts, one quick review), **Medium** (both sides, a query or the shared API: one full review and the full suite), **Big** (access, money, migrations, concurrency: experts plan first, then the full review round).

A substantive change runs six steps. Each step has exactly one exit rule, and there is no next step without it.

| # | Step | Exit rule |
|---|---|---|
| 1 | **Understand** | The ticket's lines, the list of places with every place closed, and the check lines (`Done means`), including what must NOT change. |
| 2 | **Check the facts** | Every outside fact the design depends on is proven with a real sample, or listed as an open assumption you accept. |
| 3 | **Design** | The smallest change that covers every place on the list. Small work has no design step; a changed query gets a database seat; big work gets a braintrust. |
| 4 | **Build and prove** | Red before green for a bug. Tests through the public entry point. The real provider when data writes change. Real output for every claim. |
| 5 | **Independent review** | Small and Medium: one fresh-eyes review. Big: the risk files, the whole diff, fresh eyes and the other engine, at once. Every note is answered `NOTE n: fixed — …` or `NOTE n: user — "…"`. Fixes receive a fresh scoped re-check. Exit: `REVIEW: PASS`. |
| 6 | **Gate and ship** | `/gate` verifies the final source with real quoted output. Then a short ship brief and your explicit yes, before any push or **draft PR to the integration branch**. Exit: `GATE: PASS`. |

The ship ask is the hard stop. No stage, effort level or mode removes it. Production branches are blocked by default; the human may explicitly designate an integration branch as described below. Sanad never merges or deploys.

## What's inside

```
sanad/
├── CLAUDE.md                 the always-on rulebook
├── settings.json             models, effort per model, permissions, hooks
├── skills/                   /sanad and the steps it reaches for
├── agents/                   pinned Claude roles (model + effort + permissions)
├── codex/                    Codex roles, shared entrypoints, config example
├── hooks/                    five deterministic guards, shared lib, tests
├── scripts/workflow-install.sh   versioned releases of the workflow itself
└── install.ps1               one-command installer (Windows)
```

### Skills

| Skill | Invoke | What it does |
|---|---|---|
| **sanad** | automatic / `/sanad` | The entry point for every request. Classifies it, routes implementation before any edit, then runs the loop and reports one line per stage. |
| **sanad-implementation** | internal | The xhigh-effort implementation stage Sanad switches into after routing. Not user-invocable. |
| **braintrust** | `/braintrust <question>` | Uses the selected engine's specialists for open questions and a separate boss to judge their reports. A single non-sensitive question can use the boss alone. DB/auth changes always include Database and Security. The `low → max` dial sizes the panel; it does not lower runtime effort. |
| **gate** | `/gate` | Runs the Definition of Done and the security checklist against the current change: build, tests, red-team, negative tests, with real quoted output. Ends in `GATE: PASS` or `GATE: FAIL`. |
| **ship** | `/ship` | Teach-back brief (what & why / proof / risk / left / target), then a **draft PR to the integration branch**. Never main, master or prod. Stops for the explicit yes. Also owns PR review and cherry-pick promotion rules. |
| **spec** | `/spec` | One lean, committed spec file per multi-session feature: goal, decisions, plan, risks, running log. |
| **worktree** | `/worktree` | A parallel git worktree with its own branch, so a second session can work a second track. |
| **demo** | `/demo` | A paced, screen-share walkthrough of the loop. Presentation only: it never builds, tests, commits or opens PRs. |
| **full-output-enforcement** | applied to a task | Complete, unabridged code output. Bans `// ...`, `TODO` and placeholder elisions. |
| **impeccable** | frontend tasks | Design, redesign, audit, critique and polish of interfaces: layout, typography, color, motion, accessibility, responsive, RTL. |

### Agents

Roles have explicit model and effort assignments. The table below describes Claude; [the engine map](skills/sanad/reference/engines.md) lists both engines. [Codex role definitions](codex/agents/) all pin xhigh. Confirm the actual runtime assignment rather than treating a prompt label as a model switch.

| Agent | Model / effort | Role |
|---|---|---|
| `routing-boss` | Fable (newest) / xhigh | Routes uncertain or sensitive work. Reviews braintrust reports and makes the final design call. Read-only, never writes code. |
| `braintrust-expert` | Opus (newest) / xhigh | Deep-risk seats: Architect, Skeptic, Database optimizer, Security auditor, Authenticity, Client state. Read-only; read-only probes such as `EXPLAIN` are expected. |
| `braintrust-expert-sonnet` | Sonnet (newest) / xhigh | Practical seats: Pragmatist, Performance, Product advocate, Test designer. Read-only. |

Every seat also loads the lines tagged for it in the stack's playbooks (`skills/braintrust/playbooks/`: .NET, React, Next.js, MySQL, SQL Server, PostgreSQL). The stack comes from `stack.mjs`, and no playbook line names a version without marking it.
| `independent-reviewer` | Opus (newest) / xhigh | Pass A: sensitive files and callers (auth, tenant, DB, money, files). Read-only. |
| `routine-reviewer` | Sonnet (newest) / xhigh | Pass B: whole-diff coverage and scoped re-checks. Reports `ESCALATE` for an uncovered sensitive boundary. Read-only. |
| `sonnet-worker` | Sonnet (newest) / medium | Mechanical edits (typo, rename, one obvious line) and evidence chores (run the named tests, read logs). |

The main session writes all behavior code. Agents advise or do chores; they never own a change. Haiku is not used.

### Hooks

Six plain Node scripts, wired into Claude Code through `settings.json`. They make no model calls. When a guard fires, fix the cause. Codex follows the same requirements explicitly; these hooks are not automatic Codex enforcement.

| Hook | Event | What it enforces |
|---|---|---|
| `policy-guard.js` | PreToolUse (Bash, PowerShell) | Branch, destructive-action and publishing controls. A push or PR needs a completed evidence receipt, a finished reviewer run after the last change, then `REVIEW: PASS` and `GATE: PASS`. Refuses `git add .`, pushes to `main`/`prod`, merges and releases. Prose-only pushes need no code proof. A git switch/pull/merge that leaves HEAD identical to the verified tree needs no rerun (same-tree memo). |
| `precommit-guard.js` | PreToolUse | Denies a commit or push that carries a hardcoded secret (new files included), a credential file or AI attribution. |
| `csharpier-guard.js` | PreToolUse | Denies a commit with unformatted or partly staged `.cs` files. |
| `stop-gate.js` | Stop | After a code change, missing, failed or pending verification blocks the turn once, then warns honestly. A dev server is not verification; a real test run is, also one run on another machine over `ssh`. Only a background command can still be "running"; a git change that lands on any tree a passing check verified, in any folder, needs no rerun. |
| `check-lock-guard.js` | PreToolUse (Edit, Write, Bash, PowerShell) | While a source-bound check runs (`evidence.mjs` holds a lock file), refuses an edit, a git switch or generated files inside that repository: such a change voids the whole run. Ignored paths and other folders stay open; a lock whose process is gone is removed. |
| `session-start.js` | SessionStart | Prints branch, ahead/behind, uncommitted count, PR state and the repo's stack line before any code is touched. |

Supporting pieces: `hooks/lib/` (shell parsing, transcript scan, verification target), `hooks/tests/` (`node --test`), and `skills/gate/scripts/evidence.mjs`, which runs one real check and saves the receipt the publishing guard reads. `skills/gate/scripts/check-ticket-lines.mjs` checks that every verbatim ticket line has a test that quotes it. `skills/gate/scripts/stack.mjs` reads the stack from the repo's own project files (.NET, React, Next.js; MySQL, SQL Server, PostgreSQL; versions from the files, saved until one changes). `skills/gate/scripts/size-check.mjs` sizes a task from facts (tiny, small, medium, big), names the roles each size needs, lists the callers of every changed function, and fails when the real change grew past its routed size. `skills/gate/scripts/pre-review.mjs` runs every check before review in parallel on the current repo (lint and incremental types of the changed packages, ticket lines, size, new test lines through `check-test-asserts.mjs`, the project's own check from `git config sanad.mechanical`); a repeat run takes seconds. `skills/gate/scripts/review-brief.mjs` writes each task's briefs from one template: the framed brief (ticket, numbered Check lines, callers, known and decided items, the proof result), the unframed fresh-eyes brief (ticket, missed-bug classes from `git config sanad.missedBugs`) and `launch.md` with every launch line. `skills/gate/scripts/red-proof.mjs` is one proof run: the tests fail on the old code, each break of the rule under test makes its named tests fail, and the tests pass on the fix; every run gets its own copy, half the cores at a time, on the remote test machine by itself when one is set (`git config sanad.remoteNode` names its node). It names why each failing test failed, and a setup failure (element not found, type error, timeout) is not proof. `skills/gate/scripts/check-test-asserts.mjs` refuses new test lines that assert a range where the exact value is known, a "nothing happens" check no break run proved, a Check line with no `[Cn]` test, and a value read with `!` inside an assertion. `skills/gate/scripts/check-commits.mjs` (in pre-review, and again before the push) wants one task in one commit, with a Conventional subject of at most 72 characters that ends with exactly one ticket ID, e.g. `fix(homework): clear filter on second click (TUW-225)` (`git config sanad.ticketRequired false` for a repository without tickets). `scripts/remote/remote-sync.sh` puts the exact working tree on an optional remote test machine (`git config --global sanad.remoteHost`, `git config sanad.remoteRepo`) without a push, so builds and tests run there. It tries the machine's name first, then each `git config --global --add sanad.remoteAddress <ip>`, and prints the address it used (`VIA`).

### The rulebook

`CLAUDE.md` keeps the always-on requirements: correctness, security, proof, scope and publishing approval. Detailed backend guidance, verification steps and review checks live in [engineering-bar.md](skills/sanad/reference/engineering-bar.md), loaded when needed. The reference stack is ASP.NET Core + EF Core + MySQL, but the rules are written to be adapted. Codex entrypoints link the canonical procedures instead of maintaining duplicate instructions.

## Try the demo

```
/demo
```

A screen-share friendly tour: a menu, then one card per step with a realistic example of what running it looks like. `/demo all` prints the whole deck. It makes no tool calls and opens no PRs.

## Philosophy

- **Proof, not claims.** "Builds clean" means the real command and its real output. A pass that was not run is a lie.
- **The gate is mechanical.** Rules that matter are enforced by scripts, not by asking nicely.
- **One editor.** The main session owns every behavior change. Experts and reviewers advise.
- **Short on the outside, rigorous on the inside.** One line per stage in chat; full evidence on request.
- **The human decides the one-way doors.** Pushing, merging, deleting, anything against a shared database.

## Updating

Use `workflow-install.sh` for an existing installation. First take an untouched base snapshot, prepare a separate candidate, inspect the full diff and run the checks. Obtain approval before installation. The initial `install.ps1` setup is not the update procedure.

The release layout mirrors the installed paths: `claude/` for `~/.claude/`, `agents/skills/` for `~/.agents/skills/`, and `codex/` for approved config/role changes in `~/.codex/`. Keep personal configuration out of the public bundle; merge intended settings into the candidate without replacing unrelated keys.

## Changing the workflow itself

Edits to the workflow (skills, hooks, `CLAUDE.md`, settings, agents) ship as a release, not an in-place edit:

```bash
bash ~/.claude/scripts/workflow-install.sh <candidate> <base> <release-name>
```

It checks for drift, backs up every replaced file, installs, runs both test suites and appends one line to `backups/RELEASES.md`.

## FAQ

**Does it call other models or need API keys?**
Each task runs on the selected Claude or Codex host, using that host's native agents and existing sign-in. Sanad needs no additional API key. Switching providers requires a real handoff; a prompt cannot switch engines. The hooks are plain Node.

**Will it push or merge for me?**
It may push and open a draft PR to the designated integration branch only after your explicit approval. It never merges. Production branch names are refused by default; the integration override below is a human decision.

**My repo only has `main`.**
Name it as the integration branch in that clone, yourself, once:

```bash
git config sanad.integration main
```

The guard then treats `main` like `staging`: pushes ask, PRs are allowed, and the evidence rules still apply. Claude is not allowed to set `sanad.*` keys; the guard asks first.

**I am editing Sanad's own hooks and skills.**
Set `git config sanad.lane workflow` in that clone. The independent reviewer is skipped for that lane; the evidence receipt and `GATE: PASS` are still required.

**I only want the hooks.**
Copy `hooks/` and the `hooks` section of `settings.json`. Run `node --test` in `hooks/tests` to confirm.

**My stack is not .NET.**
The loop, agents and guards are stack-neutral. Only the backend bar in `CLAUDE.md` and the CSharpier guard are .NET-flavoured; edit or drop those.

**Why not a Claude Code plugin?**
A plugin does not load `CLAUDE.md` as context or apply model effort settings, and both are core to Sanad. The installer gives the same one-command experience without losing them.

## Contributing

Issues and pull requests are welcome. CI checks the bundled Codex roles and entrypoints, then installs the Claude resources on a clean Windows runner and runs both suites on every PR. Locally:

```bash
cd hooks/tests && node --test
cd skills/gate/tests && node --test
```

One test needs a real TypeScript install and skips otherwise; point `WORKFLOW_TYPESCRIPT_RUNNER` at any `node_modules/typescript/bin/tsc` to run it.

Keep the skills stack-neutral; project-specific lessons belong in that project's memory, not here.

## License

[MIT](LICENSE) © 2026 Mohammed Almutairi · [Developzone.net](https://developzone.net)
