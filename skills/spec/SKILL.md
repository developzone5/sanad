---
name: spec
description: Create or update a durable, version-controllable spec file for a feature that spans multiple sessions — goal, decisions, plan/checklist, risks, and a running log. Invoked manually with /spec when starting or updating multi-session feature work. One lean file per feature, committed with the code.
disable-model-invocation: true
argument-hint: "<feature name or description>"
---

<!-- Author: Eng. Mohammed Almutairi - Developzone.net -->

# /spec — durable feature spec

A spec is a single Markdown file that survives across sessions and is committed alongside the code. It holds the plan and the **decisions** so neither you nor the user reloads them from memory. **One file per feature. Lean — a working plan, not documentation theatre.**

## Location
- Write to `specs/<feature-slug>.md` under the repo root (create `specs/` if missing). Slug = kebab-case of the feature name.
- If the repo already has a docs/planning convention (`docs/specs/`, `planning/`, ADRs), match it instead — check before creating `specs/`.
- Not a git repo → say so and ask where the spec should live; don't scatter spec files in arbitrary directories.

## On invocation
Resolve the target first: glob the specs directory and match the argument (feature name or description) against filenames and titles.
- **No argument** → infer the feature from the current conversation; nothing fits → ask.
- **Several plausible matches** → list them and ask; don't guess.
- **New feature** → create the file from the template, filling Goal + Decisions + Plan from the discussion. Ask the 2-3 questions you genuinely need before the plan is sound; don't guess scope.
- **Existing spec** → read it in full first, then make targeted edits — tick checklist items, append to the Log, record new decisions. Never regenerate it from scratch. Past entries stand: a reversed decision gets a NEW Decisions line noting what it supersedes, not an edit of the old one.

## Template
~~~md
# <Feature name>

**Status:** Planning | In progress | In review | Shipped
**Branch:** <feature branch>  •  **Updated:** <UTC date>

## Goal
What we're building and why, in 2-4 sentences. The user-visible outcome.
Out of scope: <what this feature deliberately does NOT do>

## Done means
Checkable lines that define finished (from `/braintrust`'s synthesis, or written before the first commit). `/sanad` Step 3.5 audits coverage per line; `/gate` ticks each with evidence.
- [ ] <observable outcome> — verified by: <test name | request + status | rendered screen>

## Decisions
Decisions made + the option rejected, one line each. (This is what memory can't hold — write decisions down the moment they're made, not at session end.)
- <decision> — chose X over Y because …

## Open questions
Unresolved calls that block or shape the plan. Move to Decisions once answered.
- <question> — waiting on <who/what>

## Plan
Milestones, each a small shippable slice. Tick as done.
- [ ] M1 — <slice> (migration / endpoint / UI / test)
- [ ] M2 — …

## Risks / rollback
- <risk> → <mitigation>
- Rollback: <how to undo; for an applied migration, the expand-contract path>

## Log
One line per session — what moved, what's next.
- <UTC date> — <what happened>; next: <what>
~~~

## Discipline
- **The spec is the loop's ledger.** `/braintrust` records decisions; implementation records milestones and actual verification evidence before independent review, with status `In review`. The final review/gate/approval results live in the conversation, saved evidence and PR body. Do not edit tracked bookkeeping after review; a necessary later edit requires review again. Keep log entries to outcomes, not transcripts.
- Plan to the house rules, don't relitigate them: money = decimal, time = UTC, lists paginated with a stable order, writes atomic, migrations expand-contract.
- Each milestone should be small enough to pass `/gate` and `/ship` on its own.
- Bump `Updated:` on every edit. Keep `Status:` honest — it changes when the work changes state, not when someone remembers.
- **Never put secrets, credentials, tokens, or personal data in a spec** — it is committed with the code.
- The spec rides with the feature's commits: stage it alongside the related code change when the user asks for a commit; don't commit it on its own unasked.
- Empty section → delete it. If the spec outgrows ~2 screens, prune: collapse shipped milestones, keep the Log to verdicts.
- Feature shipped → set Status: Shipped and leave the file in place as the record.
