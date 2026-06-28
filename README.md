# Sanad سند

**A professional engineering framework for Claude Code** — an always-on rulebook plus a gated loop (`spec → braintrust → gate → qa → ship`) where nothing ships without proof.

> *Sanad* (سند) — the verified chain that authenticates a narration; nothing is accepted until the chain is unbroken. Same idea, applied to code.

Built by **Eng. Mohammed Almutairi** · Developzone.net

Portable copy of my global Claude Code config. Move this whole folder to a new PC and install.

---

## Install on a new PC

1. Install Claude Code.
2. Copy these into `%USERPROFILE%\.claude\` (create the folder if missing), overwriting:
   - `CLAUDE.md`      → my global engineering rules (senior backend bar, security gate, Definition of Done, git/PR flow)
   - `settings.json`  → model (opus) and hooks
   - `skills\`        → my custom skills (see below)
   - `hooks\`         → the pre-commit/push secrets guard (see Hooks below)
3. **Fix the hook path for this PC.** `settings.json` points the guard at an absolute path:
   `C:\Users\Asus\.claude\hooks\precommit-guard.js`. If your Windows username isn't `Asus`,
   edit that path in `settings.json`. (If it's wrong the guard just no-ops — it never blocks you.)
4. Run `claude` and **log in** — credentials are NOT in this bundle (security); re-authenticate.
5. Restart Claude so skills + hooks load. Verify with `/help` and `/hooks`.

---

## The skills

| Skill | Invoke | What it does |
|---|---|---|
| **spec** | `/spec` | Creates/updates one lean, committed spec file per feature (goal, decisions, plan/checklist, risks, running log) for work that spans multiple sessions. Manual-only. |
| **braintrust** | `/braintrust <question>` | Convenes 3–5 independent Claude advisors (Pragmatist, Architect, Skeptic, Performance, Product) who each argue their own lens, then I synthesize **one decisive recommendation** with attribution. Claude-only — no external models/keys. Effort dial `low→max` scales advisors (2→5) and depth; advisors run Sonnet at low/medium, Opus at high/max. |
| **gate** | `/gate` | Runs my Definition-of-Done + security gate from CLAUDE.md against the current change — builds, tests, red-teams, security-checks — with **real quoted command output**. The automated proof. |
| **qa** | `/qa` | The **human-QA gate** after `/gate`: stop being the author, become a skeptical tester in front of the running change. Exploratory user testing, acceptance-criteria check, usability/UX feel, regression by feel — degrades to API/job/data QA when there's no UI. Ends in a **Ship / Don't ship** verdict. Gate proves the code is *correct*; qa judges whether the fix is *actually good*. |
| **ship** | `/ship` | Teach-back brief (what changed + why + proof + blast radius), then push to **staging** and open a **DRAFT PR**. Never main/master/prod. Stops for my approval before pushing. |
| **full-output-enforcement** | (applied to a task) | Forces complete, unabridged code output — bans `// ...`, `TODO`, placeholder elisions; handles token-limit splits cleanly. Use when I need exhaustive, copy-paste-ready output. |
| **impeccable** | (frontend tasks) | Frontend UI work: design, redesign, audit, critique, polish — layout, typography, color, motion, accessibility, responsive, RTL, design systems. Fits my Tailwind/Alpine/Razor frontend. |

---

## The workflow (how they fit together)

1. **Plan** multi-session feature work → `/spec` (durable spec committed with the code).
2. **Decide** a hard design/architecture fork → `/braintrust` (advisor panel → one call).
3. **Build** to the senior backend bar in `CLAUDE.md` (correctness, concurrency, security, EF/migrations).
4. **Frontend polish** when a view needs it → `impeccable`; need complete code → `full-output-enforcement`.
5. **Verify** the code is correct → `/gate` (proof, not claims).
6. **QA as a human** the fix is actually good → `/qa` (Ship / Don't ship; a green gate with a failing qa still doesn't ship).
7. **Ship** → `/ship` (teach-back, then DRAFT PR to **staging** — never prod; I approve the push).

`CLAUDE.md` is the always-on rulebook; the skills are the on-demand steps of the loop. The chain — and the Stop-hook nudge — reads:
`/spec (plan) · /braintrust (decide) · /gate (verify) · /qa (human test) · /ship (push)`.

---

## Deliberately NOT included

- `.credentials.json` — auth token (a secret; never copy it around — re-login instead)
- `settings.local.json` — removed (machine-local permission overrides; not needed)
- caches, `history.jsonl`, `sessions/`, `projects/`, `telemetry/`, `daemon/`, `shell-snapshots/`
- third-party plugins (none enabled — this setup is plugin-free)
- per-project `memory/` (lives under each project, tied to that project's path)

---

## Hooks

- **`hooks\precommit-guard.js`** (PreToolUse) — a deterministic, fail-open guard. It only inspects `git commit` / `git push` and **blocks** the command if the change carries a hardcoded secret (private key, AWS key, connection-string password, a long quoted secret/API key), a staged `.env` file, or AI attribution (`Co-Authored-By: Claude` / "Generated with Claude Code"). Anything else → it does nothing. No LLM calls, so it adds no latency tax and can't wrongly block your shell (any error → it allows).
- **Stop hook** — prints the end-of-turn reminder: `Done? /spec (plan) | /braintrust (decide) | /gate (verify) | /qa (human test) | /ship (push)`.

> History note: earlier this config had LLM prompt-hooks that fired a review on *every* Bash/Edit command (an `if`-scoping quirk). They were replaced by the single deterministic guard above — same protection that matters most, none of the over-firing. Deep reviews stay on-demand via `/gate`, `/code-review`, `/security-review`.
