---
name: braintrust
description: Convene a braintrust of independent Claude advisors, each arguing a distinct lens, then synthesize one decisive recommendation with attribution. Use when the user types /braintrust, says "ask the braintrust" or "consult the braintrust", or wants several independent expert perspectives or a deliberation before committing to a design, plan, or hard decision. Claude-only — no external models, no API keys. Supports an effort dial (low/medium/high/xhigh/max) that scales the number of advisors and reasoning depth.
---

<!-- Author: Eng. Mohammed Almutairi - Developzone.net -->

# /braintrust — Claude-only deliberation

Convene N independent Claude advisors, each arguing from a distinct lens, then synthesize their best ideas into one recommendation. Every advisor is a Claude subagent — no OpenAI/Gemini, no `.env`, no API keys, no network calls. The braintrust is *input*; your synthesis is the *product*.

## Step 1 — Parse the effort dial + the question

Everything after `/braintrust` (or the topic of "ask the braintrust about…") is the QUESTION. Look for an effort directive — accept either an explicit token (`effort=high`) or a natural word — and **strip it from the question**. Default = `medium`.

| Dial | Advisors | Model | Per-advisor effort | Rounds |
|---|---|---|---|---|
| `low` / "quick" | 2 | sonnet | low | 1 |
| `medium` (default) | 3 | sonnet | medium | 1 |
| `high` / "deep" | 4 | opus | high | 1 + cross-examination |
| `xhigh` / "max" / "thorough" | 5 | opus | xhigh→max | 1 + cross-examination + synthesis critic |

The **synthesis (Step 5) always runs on your session model** — the advisors are cheaper Sonnet seats at low/medium, upgraded to Opus when you dial up, but the final call stays at full strength. The user can also override the count directly (e.g. `advisors=4`) or pin a model (e.g. `model=opus`). If the question is missing or too vague to advise on, ask **one** clarifying question before convening.

## Step 2 — Pick the advisors (genuinely distinct lenses)

Choose advisors so perspectives diverge — redundancy wastes the braintrust. Default roster (take the first K for the chosen size; swap to fit the domain):

1. **Pragmatist** — simplest thing that works; ship fast; fewest moving parts; cut scope.
2. **Architect** — long-term design, boundaries, extensibility; what we'll regret in a year.
3. **Skeptic / red-teamer** — how it breaks: edge cases, failure modes, security, wrong assumptions. Must argue *against* the obvious answer.
4. **Performance & scale** — data volume, concurrency, cost, hot paths, operational load.
5. **User / product advocate** — the human outcome; what actually matters to the end user; simplicity over cleverness.

Domain swaps: pure-UX question → add a **Designer**; infra/ops → an **SRE**; data → a **Data modeler**; security-critical → a dedicated **Security** seat.

## Step 3 — Convene (parallel, single round)

Spawn the K advisors **concurrently** — one `Agent` call per advisor, all in **one message**, so they run in parallel. Give each advisor:
- the full question + the relevant context you already have,
- their lens by name, and a charge to **argue it hard and independently — do not hedge toward consensus**,
- a required return shape: **Position** (1–2 lines) · **Top 2–3 concrete recommendations** · **Biggest risk they see** · **Where they'd disagree with the naive/default answer**.

Set each advisor's `model` and `effort` to the dial's row (Sonnet at low/medium, Opus at high/max). Prefer `subagent_type: "Explore"` if an advisor needs to read the codebase first; otherwise the default agent is fine. Do **not** pin a model for the Step 5 synthesis — it inherits your session model.

> If the braintrust is large (`high`/`max`) and Workflow orchestration is available, you MAY run it as a Workflow instead: fan-out advisors → optional critique round → return structured positions. The skill invocation is itself the opt-in. Either path is fine; parallel `Agent` calls are the simple default.

## Step 4 — Cross-examination (high / max only)

One short round: give each advisor the others' positions and ask **"What's the strongest objection to your own take, and which advisor moved you?"** Collect the deltas — they sharpen the synthesis and surface the real fault lines.

## Step 5 — Synthesize (you, the main loop — not a subagent)

Read every advisor's output and deliver **one** answer:
- **The recommendation**, stated decisively. Don't punt the decision back to the user.
- **Why** — the reasoning, weaving in the best point from each advisor **with attribution** ("Architect flagged the migration coupling…", "Skeptic's objection holds…").
- **The key tradeoff** and what you are explicitly choosing *against*.
- **Open risks / what to verify next.**

For `max`, run one final **synthesis critic** pass: "what did the braintrust miss — a lens not represented, a claim unverified?" Fold in anything real.

## Rules

- **Claude-only.** Never call external LLM APIs, never create a `.env` or ask for OpenAI/Gemini keys. If the user wants those, that's a different skill.
- **Diversity is the value.** Don't let advisors converge prematurely or all restate the same take.
- **Attribute honestly.** If advisors agreed, say so plainly; if they split, present the split and still pick a side.
- **Respect brevity.** The synthesis is tight — lead with the recommendation. The braintrust deliberates so the *answer* is better, not so the *reply* is longer.
