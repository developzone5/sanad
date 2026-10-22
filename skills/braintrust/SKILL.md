---
name: braintrust
effort: xhigh
description: Convene independent specialists and a separate boss using the task's selected Claude or Codex engine. Use for a Sanad-selected panel or an explicit braintrust request. All Codex roles and panel advisors use xhigh; the deliberation dial selects seat count and risk coverage, not runtime effort.
argument-hint: "<question> [engine=claude|codex] [effort=low|medium|high|xhigh|max] [advisors=N]"
---

<!-- Author: Eng. Mohammed Almutairi - Developzone.net -->

# /braintrust — independent deliberation

Reuse the saved task engine; for a standalone task, ask once using [engines.md](../sanad/reference/engines.md), recommending the current chat engine. Convene N independent specialists on that engine, each arguing from a distinct lens, then a separate boss reviews every report and produces the recommendation. Specialists and boss use xhigh. Use native agents and the existing signed-in host; no new API keys or `.env` files. The braintrust is *input*; your synthesis is the *product*.

## Step 1 — Parse the effort dial + the question

Everything after `/braintrust` (or the topic of "ask the braintrust about…") is the QUESTION. Look for an effort directive — accept either an explicit token (`effort=high`) or a natural word — and **strip it (and any `engine=`/`advisors=`/`model=` override) from the question**. An explicit directive always wins.

**Automatic invocation (user choice 2026-09-21):** Sanad first uses a brief selected-engine boss assessment under [boss-routing.md](../sanad/reference/boss-routing.md). Convene this panel only for its `braintrust` route: complex, substantial, uncertain or sensitive implementation. `direct` and `review` routes skip the panel. Explicit requests for braintrust still run. Reuse the routing boss, its assessment and evidence, and completed decisions for unchanged continuations. New evidence invalidates only affected conclusions. Teaching, explanations, checks without implementation, standalone reviews and docs do not automatically convene a panel. Size the panel with the seat rules below.

**Boss-only decision (user choice 2026-10-12):** when the routing assessment names exactly one open question and no sensitive boundary (no auth/tenant, DB/migration/concurrency, money, file/URL trust, dependency or data-loss risk), the same selected-engine boss answers it alone from the evidence pack — `PANEL: boss-only`, no specialist seats, the same "What the user reads" block and decision record. Seats are convened only for named open questions that a seat's lens answers better than the boss can; a sensitive boundary always seats its auditor.

**No directive (when convening) → YOU pick the effort from risk, and state the pick + reason in one line** (`effort: high — live-table migration, hard to reverse`). The rubric:
- `medium` (baseline) — an ordinary reversible fix or new feature, including a settled approach. Check the proposed approach and its failure cases in the standard single round.
- `high` — ANY one-way-door or high-blast-radius signal: schema migration on a live table, auth/session/role changes, money paths, mass deletes or data-loss potential, a new dependency or infra piece, a cross-cutting refactor.
- `xhigh`/`max` — explicit user request for this larger deliberation only (user update 2026-09-21). System-level one-way doors use the high dial by default; retain the relevant database/security auditors, concrete evidence and rollback analysis. Xhigh model effort alone does not request extra seats or rounds.
- `low` — reserved for when the caller explicitly asks for a quick take; never auto-picked (trivial work shouldn't convene a braintrust at all).

After the boss selects a panel, choose the medium deliberation size for non-sensitive design uncertainty and high for material risk. Resolve uncertainty with a concrete fact check; xhigh/max remain explicit choices.

**Seat for the open questions, not a fixed bench (user choice 2026-09-28).** List the unresolved questions first; seat the one expert whose lens answers each. The dial caps the room:

| Dial | Specialists (plus 1 boss) | Specialist model / effort | Rounds |
|---|---|---|---|
| `low` / "quick" | 2 | per seat (below) / xhigh | 1 specialist round + boss review |
| `medium` (default) | 2–3 | per seat (below) / xhigh | 1 specialist round + boss review |
| `high` / "deep" | up to 4 | per seat (below) / xhigh | 1 specialist round + boss review |
| `xhigh` / `max` | up to 6 (explicit request only) | per seat (below) / xhigh | 1 specialist round + boss review |

Add a seat above the cap only for a named coverage gap, stated in one line.

**Installed effort preference (2026-09-21):** this deliberation skill uses xhigh effort through its frontmatter; set each advisor model using the expert choices below, with xhigh effort. Claude teaching/explanation uses medium outside this skill; Codex remains xhigh. There is no global forced-max environment variable. The dial controls specialist count and risk coverage, not extra review rounds or the session default; xhigh model effort alone never requests extra seats or rounds.

### Expert model choices

Use [engines.md](../sanad/reference/engines.md) as the single role/model map. Deep-risk seats: Architect, Skeptic, Database, Security, Authenticity and added domain specialists. Practical seats: Pragmatist, Performance and Product. Every panel role uses xhigh. Panel size never changes model assignments. A seated auditor never replaces the design voice the question needs.

An explicit `model=` override affects specialists only and must remain within the selected engine; the boss changes only on an explicit boss-model instruction. Verify the requested model and effort in runtime metadata; never silently substitute or lower effort. The separate boss reviews every report after the specialists, reusing its routing assessment. Standalone braintrust creates one separate boss. `advisors=N` changes only the specialist count. If the question is missing or too vague, ask one clarifying question before convening.

## Step 2 — Pick the advisors (genuinely distinct lenses)

Every seat is a **production-level expert** — a staff+ engineer who has owned this domain in production at scale — not a debate persona. They argue from operational reality: real data volume, live traffic, the 3am failure, the migration on a hot table. Choose advisors so perspectives diverge — redundancy wastes the braintrust. Each linked guide is the single source of that expert's responsibilities and validated, explicitly scoped instruction improvements; the summaries here are for routing. Load only the guides of seated experts. Roster (pick by the open questions, within the dial's cap):

1. **[Pragmatist](experts/pragmatist.md)** — Minimum scope, reuse and simpler alternatives. Load this role's guide when seating the expert.
2. **[Architect](experts/architect.md)** — Boundaries, shared contracts and maintainability. Load this role's guide when seating the expert.
3. **[Skeptic / red-teamer](experts/skeptic.md)** — Hidden assumptions and concrete failure scenarios. Load this role's guide when seating the expert.
4. **[Performance & scale](experts/performance.md)** — Resource budgets, bottlenecks and scale. Load this role's guide when seating the expert.
5. **[User / product advocate](experts/product.md)** — User journeys, roles, locales and unhappy paths. Load this role's guide when seating the expert.
6. **[Database optimizer](experts/database.md)** — Queries, indexes, transactions and migrations. Load this role's guide when seating the expert.
7. **[Security auditor](experts/security.md)** — Trust boundaries, authorization and abuse cases. Load this role's guide when seating the expert.
8. **[Authenticity reviewer](experts/authenticity.md)** — Product-specific visual, code and copy quality. Load this role's guide when seating the expert.
9. **Boss / final reviewer** — the selected engine's boss reviews every seated specialist's report against the original request and evidence, checks weak claims and disagreements, and makes the final recommendation. It works after the specialists; it is not another blind first-round opinion. Reuse its initial Sanad routing assessment when present. Its required review and decision format is in Step 6.

**Seat rules:**
- The **Database optimizer** sits when the task touches the database (schema/migration, EF/LINQ or raw SQL, indexes, transactions, pagination, data volume — including reused queries at a new scale). The **Security auditor** sits when it touches auth, tenant data access, money, file/URL handling or user input. Inside `/sanad`, the Step 1 impact triage decides both; an unseated domain still gets its standing checks at the gate.
- The **Pragmatist** (the seat that argues what NOT to build) is in every room. Seat the Skeptic when failure cases are the open question, the Architect for shared contracts/boundaries, Performance for scale, the Product advocate for roles/locales/journeys, Authenticity for product-specific quality. `advisors=N` sets the specialist count directly. Keep at least one design voice: a room of only auditors produces an audit, not a design decision.

**Expert sweep (each seated auditor):** a seated auditor is an auditor as well as an advocate. It sweeps EVERY dimension its domain touches and adds one field to its return template:
- **Database optimizer → `DB SWEEP:`** — schema & migration cost on a live table, migration crash-loop safety (idempotent under startup AutoMigrate), column types/charset fit the data (utf8mb4, decimal money, UTC time), an index for every WHERE/JOIN/ORDER BY, query shape (`EXPLAIN`, N+1), transaction scope & locking, concurrency/idempotency of writes, pagination, data growth, rollback path.
- **Security auditor → `SEC SWEEP:`** — authorization (authn + every verb, ownership/IDOR, tenant isolation), session/token lifecycle, input validation & injection sinks, secret handling, abuse/replay/enumeration, legit-feature abuse at volume (rate limit / quota / cost cap per surface), response over-exposure (returns only what the screen needs), and the negative tests the change must ship (anon→401, wrong-role→403, not-owner→404).

Each sweep is one line per dimension, marked `✓ cleared`, `→ finding`, or `? unchecked` (named, never silently skipped). The sweep is the authoritative verdict on its domain; downstream verification (`/gate`) must prove every `→ finding` addressed AND resolve every `? unchecked` — check it at the gate or justify in the verdict why it stays unchecked. An unchecked line is a debt, never a waiver.

Domain swaps (non-mandatory, pick to fit): pure-UX question → add a **Designer**; infra/ops → an **SRE**; data modeling → a **Data modeler**. **Task creates new UI, new pages/components, or user-facing copy → the Authenticity reviewer joins** as one more additional seat — it never evicts an advocate or an auditor either.

### One owner per concern (user-approved 2026-09-21)

Give every seated expert a distinct scope with the shared evidence pack. Pragmatist owns minimum scope and reuse; Architect owns boundaries and shared contracts; Skeptic owns adversarial scenarios and hidden assumptions; Database owns SQL/index/transaction analysis; Security owns trust-boundary and authorization analysis; Performance owns resource budgets and scaling; Product owns user journeys; Authenticity owns visual/copy fit. An expert may flag a cross-domain concern but routes it to its owner instead of repeating that owner's full analysis.

The executor gathers common facts once. Specialists read the evidence pack and only the additional source their assigned concern needs; they do not each scan the whole repository or recreate the same setup. The boss reviews all reports for support, coverage and contradictions, inspecting a cited source only to resolve a specific doubt. It does not repeat each specialist's audit. One concern has one finding record, one owner and one disposition, with supporting observations from other experts attached.

Keep the same experts and boss for focused follow-ups. Preserve reports and source/evidence identity across continuations. Changed facts invalidate only affected conclusions; an unchanged report is reused. This design-stage decision does not replace the later independent review of the implemented code or its required tests.

## Step 3 — Build the evidence pack (before convening)

Advisors argue well only about facts. Before spawning anyone, spend a short pass collecting the ground truth the question depends on and distill it into a compact **evidence pack** (≤ ~40 lines) given verbatim to every advisor:

- **The actual code** the decision touches — read the real files/methods, don't paraphrase from memory. Quote the load-bearing lines.
- **Hard constraints** — stack + versions, scale, existing patterns in the repo, deadlines stated in chat. Where the question touches data, scale means real NUMBERS: row counts of the touched tables, expected traffic/growth — the Performance and DB seats argue from these. A number you can't get goes under known unknowns; advisors must never invent one.
- **Deploy reality** — how this actually ships: instance count, deploy mechanism (containers, startup AutoMigrate, health checks), what keeps serving during a rollout, backup/restore posture. Production advice is impossible without it; unknown → a known unknown, never a guess.
- **Prior art** — decisions already recorded in `specs/*.md` or memory. A braintrust must not relitigate a recorded decision without naming it and saying why it's back on the table.
- **Expert learning** — load each seated expert's current linked skill guidance file, including saved corrections. Expert instruction improvements live in that file; do not use project memory as their destination. Give the boss the same guidance so it can distinguish an absent rule from a rule the expert overlooked.
- **Missed-bug history** — the project's `memory/missed-bugs.md`, if present: the classes of bugs that slipped past earlier reviews and were found after the PR. Quote the CLASS + CATCH lines. Every advisor checks the proposal against them; the Skeptic's ranked failures must say which of these classes this change could repeat.
- **Known unknowns** — what you could not verify. Unknowns are advisor input too; hiding them produces confident nonsense.

If the question is abstract (no repo involved), the pack is just constraints + chat context. Skip the pack only for pure-preference questions with no facts to gather — and say you skipped it.

## Step 4 — Convene (parallel, single round)

Spawn the K advisors **concurrently** — one native subagent call per advisor (per engines.md), all in **one message**, so they run in parallel. Round 1 is blind: no advisor sees another's position. Give each advisor:

- the full question + the **evidence pack** verbatim,
- their current linked expert skill guidance file, alongside their distinct scope; do not load every other expert's guide,
- their lens by name, framed as a **production-level expert** — "you are a staff+ engineer who has run this domain in production at scale" — and a charge to **argue it hard and independently, do not hedge toward consensus**; recommendations must be production-grade — assume live users and irreplaceable data are on the line, so every recommendation must survive deploy day (near-zero downtime, a crash mid-rollout), the 3am incident (how it's detected, mitigated, and rolled back), and 10× growth — never textbook generalities,
- an explicit boundary: **advise only — read anything, change nothing** (no file edits, no state-changing commands, no commits),
- a required return template — these six fields for every seat (seated auditors add their sweep field, below). Every field is short: one line per point, no paragraphs — the boss reads the facts, not prose. **Whole report ≤ 300 words** (the sweep field excepted); a longer report is off-template:
  - `POSITION:` 1–2 lines.
  - `RECOMMENDATIONS:` 2–3 concrete ones, each carrying an `evidence:` line naming the pack fact or file it rests on — or an explicit `assumption:` tag when it rests on none. Never an untagged claim.
  - `RISK:` the biggest failure mode they see.
  - `TRAPS:` options that look right but fail here (hidden cost, will not scale, breaks a rule of this codebase) — one line each with the reason, or `none`.
  - `DISSENT:` where they disagree with the naive/default answer.
  - `CONFIDENCE:` high / medium / low, with the one fact that would change their mind.
  - **Seated auditors add their sweep field** — the Database optimizer appends `DB SWEEP:`, the Security auditor appends `SEC SWEEP:` (per Step 2), one line per dimension marked `✓ cleared` / `→ finding` / `? unchecked`. This field is required for those two seats and must not be dropped for brevity.

Launch each advisor with its engine-mapped deep-risk or practical agent type, xhigh and read-only. Name the seat and its role guide in the prompt. Use the host's real runtime controls for a supported explicit user model override. After collecting the specialist reports, resume the separate selected-engine boss for Step 6 at every panel size.

Every specialist's linked guide defines its **signature deliverable** (the Skeptic's ranked failure list, the Architect's one-way door, Performance's numbers, the DB optimizer's exact indexes, the Security auditor's written attack…). A return missing its signature deliverable — or delivering it as vague generalities — is off-template.

**If an advisor fails or returns off-template:** re-ask that one seat once, quoting the missing requirement. Record that follow-up so the boss does not ask the same question again. Still broken → give the boss the available evidence and name the missing report; never fabricate it. Material missing expertise keeps its final verdict incomplete.

> If the braintrust is large (`high` and above) and Workflow orchestration is available, you MAY run it as a Workflow instead: fan-out specialists once → collect reports → one boss review. The skill invocation is itself the opt-in. Either path is fine; parallel subagent calls are the simple default.

## Step 5 — Collect once

Collect each specialist's completed report and preserve its evidence. Pass the full reports to the boss. Do not launch an all-to-all cross-review round, another chair or an extra synthesis critic. Only the boss may request a targeted clarification for a material unresolved issue from the responsible expert.

## Step 6 — Boss reviews each expert and decides

Resume the existing separate Sanad routing **Boss** (the engine-mapped boss at xhigh, verified in run metadata). If standalone braintrust has no routing boss, spawn ONE separate boss, even when the main session already uses the boss model. If the original agent cannot resume, report that limitation and transfer its saved assessment/evidence to one replacement; do not redo routing or leave duplicate bosses active. Give it the original request verbatim, the evidence pack, the seated-role list, every specialist's full report, the guidance each expert received and any existing targeted follow-up answers. The boss is read-only: it may inspect cited source to validate claims, but cannot edit, implement or publish.

The boss must review each seated expert, including every seated auditor:
- Return one `EXPERT REVIEW: <role> — accepted | correction needed | unresolved — <evidence and reason>` line per role. Check factual support, scope, missing failure cases, contradictions and the role's required deliverable. Name missing reports explicitly; agreement is not evidence.
- **Queue expert coaching:** for a supported gap, record the specific omission, evidence, why it matters, and the future check in the existing decision/evidence record. Resolve any finding that affects this task now; defer coaching and skill-file improvement until the PR is open and the task handoff is delivered, following [expert-learning.md](reference/expert-learning.md). Do not request an extra follow-up solely to improve guidance before that point. The expert may challenge an incorrect correction with evidence; boss feedback is not automatically fact.
- For a material correction, use any existing follow-up answer first. If still needed, request one focused follow-up from the responsible expert for that issue; do not repeat an already answered or exhausted request. The executor relays it to the same expert and returns the answer to the same boss. Update only the affected decision. Do not restart the panel or re-review cleared reports; an unresolved issue remains visible as incomplete.
- Resolve disagreements from the request and verified evidence. Preserve every DB/security finding and unchecked item with its disposition; do not silently drop an auditor's concern or expand the requested feature.
- Produce the recommendation below and `BOSS VERDICT: complete | incomplete`, naming any missing required expertise or unresolved material issue. A missing/failed boss or a material gap means incomplete; never fabricate its review or replace it with an unlabelled main-agent synthesis. Existing Sanad fact-acceptance and publishing rules still apply.

The main executor presents the boss's recommendation with attribution and records the decision, retaining pending coaching notes with the existing evidence. Pending expert learning does not make the design verdict incomplete; unresolved findings affecting the task still do. After the PR is open and the task handoff is delivered, the executor performs the deferred coaching and skill-file updates using [expert-learning.md](reference/expert-learning.md). The boss and experts remain read-only; only the executor updates guidance. Report maintenance separately: which expert skill guidance file changed, or why no instruction change was warranted. Project memory is not a substitute for fixing missing expert guidance. Keep per-expert review details available without dumping every report into chat.

The boss reads every specialist report and delivers **one** answer:

- **The recommendation**, stated decisively. Don't punt the decision back to the user.
- **Why** — the reasoning, weaving in the best point from each advisor **with attribution** ("Architect flagged the migration coupling…", "Skeptic's objection holds…").
- **The key tradeoff** and what you are explicitly choosing *against*.
- **Options scored** — every real option the panel raised, one line each: `<option> — works <0-10> · risk low|medium|high · fits our code <0-10>`. "Works" = solves the stated problem; "fits" = matches how this codebase already does it. Scores rest on the reports' evidence, not on taste.
- **Traps** — options that look good but are wrong here, one line each with the reason (from the experts' `TRAPS:` lines and your own review). `none` is a valid answer.
- **Production plan** — the recommendation is incomplete without it: rollout order (e.g. expand-migrate → deploy → contract), the rollback path, the signal that tells us it broke in prod (which log line / alert / metric), and the blast radius + data-loss risk if it dies mid-rollout. An unknown here is an open risk, never silence.
- **Open risks / what to verify next.**
- **Done means** — 3–8 checkable lines that define *finished* for THIS task, each verifiable by a named test, a request + expected status, or a rendered screen. Written from the user's side (what they see, in every locale the product serves) and the operator's side (the log line / metric that proves it ran). Include the negative cases the change touches (anon→401, wrong role→403, not-owner→404) and its unhappy states (empty, error, slow). This list is the contract for the build: `/sanad` Step 3.5's requirements auditor checks coverage per line, `/gate` ticks each line with evidence. Vague lines ("works correctly", "handles errors") are off-template.

Every deliberation size ends with the same boss decision. Larger panels do not automatically add critique rounds. Extra deliberation requires an explicit user request or genuinely new evidence affecting the decision, with its scope stated.

**Weigh evidence over eloquence.** A recommendation backed by an `evidence:` line from the pack outranks a well-argued `assumption:`. If the winning position rests on an assumption, say so in the recommendation and name what to verify before committing.

The synthesis is the only thing the user reads — never paste raw advisor transcripts; quote at most a line per advisor.

### What the user reads (user rule 2026-10-08)

The user reads English as a second language and dislikes long text. The chat shows only this block — at most 6 short lines, simple everyday words, sentences ≤ 15 words, no jargon (if a technical word is needed, add a 2–4 word plain meaning). Everything else (expert reviews, production plan details, Done means) stays in the decision record and spec, shown only on request.

```
Decision: <what we will do, in one plain sentence>
Why: <the main reason, one line>
Options: <A> works 8 · risk low · fits 9 | <B> works 6 · risk high · fits 4
Trap: <the option that looks good but is wrong> — <why, one line>   (or: Trap: none)
Safe rollout: <how it goes live and how we undo it, one line>
Check next: <the one open risk to verify, or "nothing open">
```

End with a **decision record** — one paste-ready line in the spec's Decisions format:

`- <decision> — chose X over Y because <core reason> (braintrust, <UTC date>)`

If a `specs/<feature>.md` exists for the work under discussion, append the line to its Decisions section and say you did; otherwise leave it for `/spec` to pick up.

## Rules

- **One selected engine.** All roles stay on the task's chosen Claude or Codex engine. Do not silently mix providers or fall back after a quota error. Use existing signed-in native tools; never create a `.env` or ask for new API keys.
- **Advisors advise; they never act.** No advisor edits files, runs state-changing commands, or commits. Any action the braintrust recommends happens after the synthesis, by you, under the normal rules.
- **Diversity is the value.** Don't let advisors converge prematurely or all restate the same take; round 1 stays blind.
- **Attribute honestly.** If advisors agreed, say so plainly; if they split, present the split and still pick a side.
- **Simple words for the user.** What the user reads follows "What the user reads" above and CLAUDE.md's simple-English rule; depth lives in the record, not the chat.
- **Respect brevity.** The synthesis is tight — lead with the recommendation. The braintrust deliberates so the *answer* is better, not so the *reply* is longer.
