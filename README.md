<p align="center">
  <img src="logo.png" alt="Sanad" width="120" />
</p>

<h1 align="center">Sanad سند</h1>

<p align="center">
  <b>A gated engineering loop for Claude Code. Nothing ships without proof.</b>
</p>

<p align="center">
  <a href="https://developzone5.github.io/sanad/">Website</a> ·
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

Sanad is a complete working setup for [Claude Code](https://docs.claude.com/en/docs/claude-code): an always-on rulebook, one task loop (`/sanad`), a panel of specialist agents, and five deterministic guards that make the rules mechanical. It is opinionated, backend-first, and built for teams that ship to production.

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

| Request | What happens |
|---|---|
| A question or explanation | Direct answer. No build, no panel. |
| "Check my work" | The smallest relevant check, plus an honest list of what is still unverified. |
| A feature, fix or change | Routed **before any edit**. Bounded work is self-routed. Uncertain or sensitive work goes to a routing boss that picks a review or a braintrust panel. Then the six-step loop runs. |

The chat stays short: one `▸ stage: verdict` line per stage, a braintrust result of at most six lines, and a final ship brief under twelve lines. Full evidence is kept and shown only when you ask.

## Quick install

**Windows (PowerShell), one command after cloning:**

```powershell
git clone https://github.com/developzone5/sanad.git
cd sanad
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

The installer:

1. backs up every file it replaces to `%USERPROFILE%\.claude\backups\sanad-install-<timestamp>\`;
2. copies `CLAUDE.md`, `skills\`, `hooks\`, `agents\` and `scripts\workflow-install.sh`;
3. writes `settings.json` with the hook paths pointed at **your** `.claude\hooks\`;
4. runs both test suites from the installed location and refuses to finish on a failure.

Options: `-Dest <path>` installs somewhere else, `-KeepSettings` leaves your `settings.json` untouched, `-SkipTests` skips step 4.

Then restart Claude Code and check `/hooks` and `/help`.

**macOS / Linux (manual):** copy the same five items into `~/.claude/`, then open `settings.json` and replace every `C:\\Users\\Asus\\.claude\\hooks\\` with your own absolute hooks path. The hooks are plain Node scripts and run anywhere Node runs.

**Requirements:** Claude Code, Node.js 20 or newer (tested on 25), Git. The C# formatting guard needs [CSharpier](https://csharpier.com) only if you commit `.cs` files.

**Not included on purpose:** credentials, machine-local `settings.local.json`, caches, sessions, per-project `memory/`, and the private `autoMode.environment` block.

## The loop

A substantive change runs six steps. Each step has exactly one exit rule, and there is no next step without it.

| # | Step | Exit rule |
|---|---|---|
| 1 | **Understand** | `Done means`: 3–8 checkable results in your words, including what must NOT change. |
| 2 | **Check the facts** | Every outside fact the design depends on is proven with a real sample, or listed as an open assumption you accept. |
| 3 | **Design** | The smallest change that meets `Done means`, plus the list of files to touch. Bounded work goes direct; risky work gets a braintrust. |
| 4 | **Build and prove** | Red before green for a bug. Tests through the public entry point. The real provider when data writes change. Real output for every claim. |
| 5 | **Independent review** | One fresh, read-only reviewer reads the frozen source for bugs, missed requirements and data/security risk. Exit: `REVIEW: PASS`. |
| 6 | **Gate and ship** | `/gate` runs once on the final source with real quoted output. Then a short ship brief, a **draft PR to the integration branch**, and your explicit yes. Exit: `GATE: PASS`. |

The ship ask is the hard stop. No stage, effort level or mode removes it. Sanad never pushes to `main`, never merges, never deploys.

## What's inside

```
sanad/
├── CLAUDE.md                 the always-on rulebook
├── settings.json             models, effort per model, permissions, hooks
├── skills/                   /sanad and the steps it reaches for
├── agents/                   six pinned agent types (model + effort + read-only)
├── hooks/                    five deterministic guards, shared lib, 157 tests
├── scripts/workflow-install.sh   versioned releases of the workflow itself
└── install.ps1               one-command installer (Windows)
```

### Skills

| Skill | Invoke | What it does |
|---|---|---|
| **sanad** | automatic / `/sanad` | The entry point for every request. Classifies it, routes implementation before any edit, then runs the loop and reports one line per stage. |
| **sanad-implementation** | internal | The xhigh-effort implementation stage Sanad switches into after routing. Not user-invocable. |
| **braintrust** | `/braintrust <question>` | Seats 2–6 independent Claude specialists for the *open questions* (Pragmatist, Architect, Skeptic, Performance, Product advocate, Database optimizer, Security auditor, Authenticity reviewer). A separate boss reviews every report and gives one evidence-backed recommendation. Claude-only, no API keys. Effort dial `low → max` caps the room. |
| **gate** | `/gate` | Runs the Definition of Done and the security checklist against the current change: build, tests, red-team, negative tests, with real quoted output. Ends in `GATE: PASS` or `GATE: FAIL`. |
| **ship** | `/ship` | Teach-back brief (what & why / proof / risk / left / target), then a **draft PR to the integration branch**. Never main, master or prod. Stops for the explicit yes. Also owns PR review and cherry-pick promotion rules. |
| **spec** | `/spec` | One lean, committed spec file per multi-session feature: goal, decisions, plan, risks, running log. |
| **worktree** | `/worktree` | A parallel git worktree with its own branch, so a second session can work a second track. |
| **demo** | `/demo` | A paced, screen-share walkthrough of the loop. Presentation only: it never builds, tests, commits or opens PRs. |
| **full-output-enforcement** | applied to a task | Complete, unabridged code output. Bans `// ...`, `TODO` and placeholder elisions. |
| **impeccable** | frontend tasks | Design, redesign, audit, critique and polish of interfaces: layout, typography, color, motion, accessibility, responsive, RTL. |

### Agents

Each role is pinned to the model that is strongest for it. The Agent tool sets a model but not effort, so the effort lives in the agent definition.

| Agent | Model / effort | Role |
|---|---|---|
| `routing-boss` | Fable 5.1 / xhigh | Routes uncertain or sensitive work. Reviews braintrust reports and makes the final design call. Read-only, never writes code. |
| `braintrust-expert` | Opus 5.5 / xhigh | Deep-risk seats: Architect, Skeptic, Database optimizer, Security auditor, Authenticity. Read-only. |
| `braintrust-expert-sonnet` | Sonnet 5.5 / xhigh | Practical seats: Pragmatist, Performance, Product advocate. Read-only. |
| `independent-reviewer` | Opus 5.5 / xhigh | Step 5 reviewer for sensitive changes (auth, tenant, DB, money, files). Read-only. |
| `routine-reviewer` | Sonnet 5.5 / xhigh | Step 5 reviewer for routine changes. Reports `ESCALATE` to hand a change to Opus. Read-only. |
| `sonnet-worker` | Sonnet 5.5 / medium | Mechanical edits (typo, rename, one obvious line) and evidence chores (run the named tests, read logs). |

The main session writes all behavior code. Agents advise or do chores; they never own a change. Haiku is not used.

### Hooks

Five plain Node scripts, wired in `settings.json`. No model calls, no latency tax, no way to talk your way past them. When one fires, you fix the cause.

| Hook | Event | What it enforces |
|---|---|---|
| `policy-guard.js` | PreToolUse (Bash, PowerShell) | Branch, destructive-action and publishing controls. A push or PR needs a completed evidence receipt, a finished reviewer run after the last change, then `REVIEW: PASS` and `GATE: PASS`. Refuses `git add .`, pushes to `main`/`prod`, merges and releases. |
| `precommit-guard.js` | PreToolUse | Denies a commit or push that carries a hardcoded secret (new files included), a credential file or AI attribution. |
| `csharpier-guard.js` | PreToolUse | Denies a commit with unformatted or partly staged `.cs` files. |
| `stop-gate.js` | Stop | After a code change, missing, failed or pending verification blocks the turn once, then warns honestly. A dev server is not verification; a real test run is. |
| `session-start.js` | SessionStart | Prints branch, ahead/behind, uncommitted count and PR state before any code is touched. |

Supporting pieces: `hooks/lib/` (shell parsing, transcript scan, verification target), `hooks/tests/` (157 tests, `node --test`), and `skills/gate/scripts/evidence.mjs`, which runs one real check and saves the receipt the publishing guard reads (18 tests of its own).

### The rulebook

`CLAUDE.md` is the always-on part: a senior backend bar (correctness over happy path, data discipline, money is `decimal`, time is UTC), a security gate for every change, a Definition of Done with **no invented evidence**, the "verify fast" ladder (host tests before containers), self-review of the diff, and the publishing rules. The reference stack is ASP.NET Core + EF Core + MySQL, but the rules are written to be adapted.

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

```powershell
cd sanad
git pull
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Every run backs up what it replaces, so rolling back is a copy from `backups\sanad-install-<timestamp>\`.

## Changing the workflow itself

Edits to the workflow (skills, hooks, `CLAUDE.md`, settings, agents) ship as a release, not an in-place edit:

```bash
bash ~/.claude/scripts/workflow-install.sh <candidate> <base> <release-name>
```

It checks for drift, backs up every replaced file, installs, runs both test suites and appends one line to `backups/RELEASES.md`.

## FAQ

**Does it call other models or need API keys?**
No. Everything runs inside Claude Code on Claude models. The hooks are plain Node.

**Will it push or merge for me?**
Never. It opens a draft PR to the integration branch after your explicit yes. `main`, `master` and `prod` are refused by the guard.

**I only want the hooks.**
Copy `hooks/` and the `hooks` section of `settings.json`. Run `node --test` in `hooks/tests` to confirm.

**My stack is not .NET.**
The loop, agents and guards are stack-neutral. Only the backend bar in `CLAUDE.md` and the CSharpier guard are .NET-flavoured; edit or drop those.

**Why not a Claude Code plugin?**
A plugin does not load `CLAUDE.md` as context or apply model effort settings, and both are core to Sanad. The installer gives the same one-command experience without losing them.

## Contributing

Issues and pull requests are welcome. CI installs Sanad on a clean Windows runner and runs both suites on every PR. Locally:

```bash
cd hooks/tests && node --test
cd skills/gate/tests && node --test
```

Keep the skills stack-neutral; project-specific lessons belong in that project's memory, not here.

## License

[MIT](LICENSE) © 2026 Mohammed Almutairi · [Developzone.net](https://developzone.net)
