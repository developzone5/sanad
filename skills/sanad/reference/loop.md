# Sanad implementation loop — Steps 1–5

Loaded by the `sanad-implementation` stage for substantive implementation. "Sanad Step N" anywhere refers to the step of that number here. Resolve relative links against this directory. Load the other references only at the step that names them.

Use the saved engine and the actual runtime assignments in [engines.md](engines.md) throughout; child assignments inherit that choice.

## Step 1 — Impact triage

Reuse the routing assessment from [boss-routing.md](boss-routing.md) (self-route or boss), its evidence and open facts; do not repeat the scan. Two one-liners scope the DB and security checks and, when a panel is convened, decide the auditor seats (Database optimizer when DB impact is not `no`, Security auditor when security impact is `yes`). Relevant checks stay required when no advisors sit:
- **DB impact** — schema/migrations, EF/LINQ or raw SQL, indexes, transactions, pagination, data volume/growth. `DB impact: yes — new column + hot-path query`; `DB impact: reuse-only — reused queries verified at the new scale`; or `no`.
- **Security impact** — auth, data access, money, file/URL handling, user input. `Security impact: yes — new owned-resource endpoint`; or `no`.

Draft `Done means`: 3–8 checkable results in the user's words, including what must NOT change, each with its proof type (test / request + status / user browser check). Read what the code does today before listing it. Unclear → one question.

## Step 1.5 — Check the facts

List every fact the design depends on that lives outside the code being changed: another system's contract (what an identity provider really sends, a provider's response shape, a webhook payload), real data (rows written before this change, nulls, blanks, duplicates, volume), environment or configuration. For each:
- **Look before you sample.** Search the repo, specs and project memory; a recorded observation of the target environment outranks a vendor default, a local fixture or a guess.
- **Prove it with a real, dated sample from the target environment** — the normal case AND the missing/empty/false case. One positive sample proves no universal guarantee.
- **Handle the sample safely.** Decode locally; never paste a token or credential anywhere external; keep only the minimum non-identifying shape with environment and date.
- **Cannot prove it now → an open assumption**, written into `Done means` by name for the user to accept. Never silently true, never a reason to loosen a check.

Exit: `▸ checked: <n> facts confirmed, <m> not sure yet`. Proven and open facts go verbatim into the evidence pack (Step 2) and both review prompts (Step 3.5).

## Step 2 — Design

**`review` route:** record the bounded approach, `Done means` and the touch list, then go to Step 3. No panel.

**`braintrust` route (or explicit request):** convene `/braintrust` before coding, sized by its seat rules — experts for the actual open questions, stated in one line; one specialist round, then the same selected-engine routing boss reviews every report and decides. Specialists run at xhigh on their engine's deep-risk or practical seat model. The design stage needs the boss's complete verdict; material gaps stay incomplete. Resolve findings affecting this task now; defer expert coaching to [expert-learning.md](../../braintrust/reference/expert-learning.md) after the PR is open. Reuse unaffected reports.
- **Database optimizer** (DB impact not `no`): its `DB SWEEP` is the authoritative DB verdict; on reuse-only tasks it verifies the reused queries (indexed, no N+1, sane pagination) at the new scale.
- **Security auditor** (security impact `yes`): its `SEC SWEEP` is the authoritative security verdict.
- An unseated domain still gets its standing checks at the gate. Every `→ finding` from either sweep becomes a mandatory proof at the gate; every `? unchecked` is a debt named at the gate, never dropped.

The decision record is the plan for Step 3. It carries a **touch list** — every other caller, writer, role, screen, locale and background path the change reaches, each covered by a `Done means` line or named out of scope — and ends with the final `Done means` (the contract: Step 3.5 checks coverage per line, `/gate` ticks each line with evidence). Prefer the narrowest change that satisfies the ask; a cross-cutting change needs a stated reason and proof for every writer it affects. Write `Done means` into the spec's `## Done means` section when a spec exists.

Routing replaces the every-bug panel rule (user choice 2026-09-21): small understood changes use `review`; cosmetic/mechanical edits use `direct`; complex, substantial, uncertain or sensitive work uses `braintrust`. Teaching, questions, checks, standalone reviews and docs never convene a panel.

## Step 3 — Build and prove

Load [engineering-bar.md](engineering-bar.md) (backend bar, verify-fast ladder, mechanical checks, proof by change type, self-review). **Touching DB writes, migrations, transactions, background workers or exports → load [backend-scaling.md](backend-scaling.md) first.** The recorded route and approach are the plan: deviating means saying so and why in one line. A new fact that invalidates the route → the same boss reassesses that fact before you continue.

Build in slices: each slice is code plus its test plus the mechanical checks, committed before the next. One PR per behavior; split backend and frontend when both change substantially.

**Prove the change where it can fail.** Tests go through the public entry point (the real request pipeline with validation, binding and authorization), one test per lifecycle state of the record a new rule touches, and for every new or changed failure handler one failure it was NOT written for, asserting no success side effect after a failed write. Bug fixes: red before green, the failing assertion quoted. Data writes: the real provider.

Browser acceptance belongs to the user (2026-09-21): apply [behavior-proof.md](../../gate/reference/behavior-proof.md) — URL, account and checklist supplied, their actual result recorded, pending until confirmed. No browser automation solely to satisfy a review.

**Format once, then verify (2026-09-28).** When the edit batch is complete, format the changed C# files once (`dotnet csharpier format <files>` from the directory that owns the manifest), re-read any file you will edit again, then run the focused tests and the mechanical checks. Exit: `▸ built: <n> files changed, <n> tests pass, checks clean` with real output.

## Step 3.5 — Independent review: two passes, then re-check (user choice 2026-10-12)

Freeze the source: synchronize with the integration branch per [execution.md](execution.md), finalize bookkeeping, collect the focused test results. Pause source edits while reviewers run.

**Ready check before launch (2026-09-28):** the verbatim ask, `Done means`, the changed-file list, the focused test commands with their results, the known gaps and open assumptions, the Step 1.5 facts, every sweep `→ finding` / `? unchecked`, and the project's `memory/missed-bugs.md` (each CLASS/CATCH is a standing check). A missing input is collected first; a reviewer started without it comes back incomplete.

**Author-proof inputs.** The ask is the user's own words, quoted. Author decisions go under `Author claims — attack these`; a claim is user-approved only with the user's verbatim message beside it. Do not describe the baseline: tell the reviewer to read the pinned base itself (`git show <base>:<path>`) for every changed rule, validator and handler, and to report any behaviour change the ask did not request.

**Pass A — risk files.** The engine's risk reviewer (Claude `independent-reviewer`, Opus 5.5; Codex `sanad-risk-reviewer`, GPT-6 Astra), xhigh and read-only. Scope: only the changed files on a sensitive boundary — auth/tenant isolation, DB/query/migration/concurrency, money, file/URL trust, security-sensitive dependencies, shared contracts, unresolved cross-component behaviour — plus their callers and writers. Skipped when no changed file is on such a boundary (`routine` risk); run on a boundary Pass B escalates. Its prompt adds a **trace list**: 5–10 concrete inputs the author did not test for — the null/empty/huge/malformed value, the other role, the other tenant, the duplicate or concurrent request, the replay after an ambiguous commit, the missing row, the dependency that fails, the opposite lifecycle state. The reviewer traces each through callers, writers and downstream consumers and reports defects only.

**Pass B — whole diff.** The engine's whole-diff reviewer (Claude `routine-reviewer`, Sonnet 5.5; Codex `sanad-reviewer`, GPT-6.1 Sol), xhigh and read-only. Scope: every changed file — backend, frontend, i18n, tests, comments — checked against `Done means` and the coverage checklist below, reading the pinned base itself. It reports defects and gaps, not narration. When it finds a sensitive boundary Pass A did not cover it starts its report with `ESCALATE: sensitive — <reason>`; Pass A then runs on that scope before any verdict.

Launch A and B in one message so they run in parallel. **Both prompts start with `You are the independent reviewer`** — the push guard credits only such a run, launched after the last change and completed before the `REVIEW:` line. Keep each prompt to the inputs above and the changed files, never the conversation. Use the selected engine's native launch and effort controls from engines.md. The Claude push guard recognizes Claude native runs; Codex collects its own real agent IDs/results and applies the same review ordering explicitly.

**Report contract (both passes):** line 1 `RECOMMEND: PASS|FAIL`; then findings ordered by severity, one line each — `Blocker|Bug|Gap|Question — file:line — <input> → <wrong result> — <one-line fix>`; then the coverage checklist, one short line per item (`✓`, `✗ <what>`, `– n/a <why>`); then `NOT VERIFIED:` one line; then `PRE-EXISTING:` (not introduced by the change, no fix required here). No traced-input essays, no restating the diff, no praise. Hard caps: 60 tool uses and 600 words per pass; stop reading when the verdict is stable.

**Handling.** Collect both reports from their completion notifications, dedupe, and disposition every finding: `fixed` / `accepted by user` (verbatim user words; product or scope trade-offs only) / `follow-up: outside scope` / `rejected: evidence`. **A confirmed correctness bug — including a rare one (retry, race, ambiguous commit) — is `fixed` in the same round, without asking (user rule 2026-10-06);** the author never self-accepts it as "rare" or "info". Grep-check any claim that something is absent before relying on it. A newly reachable dangerous path is in scope even when the line predates the branch. Cheap hygiene is fixed in the same round.

**Re-check after fixes.** Every fix round ends with a **fresh Pass B launch** (a new agent, not a SendMessage continuation) over only the files changed since the last pass plus their callers, carrying the dispositions and the new test results; it reuses earlier coverage. A fix on a sensitive boundary also gets a fresh scoped Pass A. The step ends when the latest pass reports zero open Blocker/Bug/Gap. Fix-round count alone never restarts the full review; changed boundaries, requirements or coverage do. Add a separate reviewer on the selected engine's boss model / xhigh only for a named unresolved issue or expertise gap, scoped to that gap, with the question and scope recorded first.

**Coverage checklist** (Pass B fills it all; Pass A only the lines its scope touches). Apply [behavior-proof.md](../../gate/reference/behavior-proof.md): scenarios come from the original request, not from the author's tests.
- `COVERAGE:` one line per `Done means` item — `✓ implemented + tested (<test name>)` / `~ implemented, NO test` / `✗ missing`.
- `MISSED:` what the ask or decision implies that nothing in the diff addresses — the other call site, the other locale, the other role, the raw-SQL twin of a LINQ change, the FE surface that renders the new field, the paged list reused as a data source.
- `HALF-DONE:` stubs, TODOs without an id, unhandled null/empty/failure branches, fields an update endpoint silently drops, helpers defined but never called.
- `CALLERS:` for every changed or newly-parameterized method — each caller (`file:line`), what it passes, whether it runs under HTTP or a background service. A service that starts reading the current user must be constructed on an acting user by every non-HTTP caller.
- `ENTRY POINTS:` every user-facing way to trigger the changed behavior — button, link, card or row click, keyboard path, tour/demo path, other API callers, background jobs — each `tested` / `user checklist` / `out of scope: <why>`. A sibling control that reaches the same feature by another route is its own entry point.
- `REMOVED:` every test or assertion deleted or weakened, with the rule change that justifies it as stated in the PR body. No stated rule change = FAIL.
- `WRITERS:` for shared entity/model/concurrency changes, every writer including other features, login updates, jobs and bulk/raw SQL, and whether the new rule changes its success or failure path.
- `MEANING:` for every user-visible number, ranking or threshold whose inputs change: `one unit = <before> → <after>`, and the test where one actor repeats the action N times beside N actors doing it once. A label that no longer names the unit is a finding.
- `FAILURES / LOCALES:` non-matching exceptions, zero-row writes, null/empty/whitespace, nested retry failure, side effects after failed writes; each new API error code resolved in both EN and AR and traced to its consumer; a removed `{{placeholder}}` while a caller still passes it.
- `HYGIENE:` literals duplicating an existing constant or default, one rule hand-copied in two places, comments naming numbers or lists the change made stale, test resources not released on a failure path.
- `CI-SKIPPED:` every changed path whose only proof is an opt-in test CI skips: the local command run after the last edit with its quoted result (a skip is not a pass), and the PR-body note. Missing → open.
- `MISSED-BUG CLASSES:` each relevant CLASS/CATCH from `memory/missed-bugs.md` mapped to a named test or the user-owned browser record with its actual result; non-applicability stated for the rest.

Reviewers advise; the selected engine's main executor alone edits behavior code. They do not rerun builds or tests the author ran unless an evidence gap requires it; runtime and provider evidence stay with the author at the gate. An unavailable or unfinished reviewer is reported incomplete, never invented. Preserve reviewer IDs and checked scope in the task handoff.

**Verdict line (mandatory for outgoing code; changed-line count is not a risk measure):** `REVIEW: PASS|FAIL — bugs <found>/<fixed>, goals tested <k>/<k> ✓, untested <n>, open: <none|list>`, after one plain sentence for the user (Reporting contract). FAIL = something open the user must decide on; say what. Emit it at the start of a line, plain (no bold, no backticks), in a text-only message with no tool call — the push guard reads the transcript.

## Step 4 — Gate

Invoke `/gate` — the Definition of Done + security checklist with real quoted output. The sweeps add mandatory proofs:
- **DB impact:** every `DB SWEEP` `→ finding` proven addressed, plus the standing four — index in the SAME migration for every new/changed WHERE/JOIN/ORDER BY column; generated SQL quoted (no N+1); transactions hold no external I/O; pagination has a stable unique order.
- **Security impact:** every `SEC SWEEP` `→ finding` proven addressed, plus the standing negative tests — anonymous→401, wrong-role→403, not-owner→404/403 (IDOR probe), missing anti-forgery→rejected.
- **`? unchecked` lines are debts:** each checked at the gate or named in the verdict with why it could not be.
- **Done means:** every line ticked with its evidence — `goals <k>/<k>`. No evidence = ✗.
- **Independent review:** the `REVIEW:` verdict postdates the last code edit. A gate-time code change goes back through a scoped Step 3.5 re-check before the gate re-runs.

Red gate → back to Step 3, fix, re-gate. Never carry a red gate forward.

## Step 5 — Ask to ship

Present the teach-back brief and ask, per `/ship` — it owns the brief, the draft-PR flow and the integration-branch rule. **Wait for the explicit yes.** No yes → the loop ends with the brief on the table. A "yes" to the task was never a "yes" to the push. After the push, log the task line in `memory/task-metrics.md` (blockers found after push start at 0 and are the quality metric).
