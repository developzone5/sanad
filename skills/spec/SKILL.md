---
name: spec
description: Create or update a durable, version-controllable spec file for a feature that spans multiple sessions — goal, decisions, plan/checklist, risks, and a running log. Invoked manually with /spec when starting or updating multi-session feature work. One lean file per feature, committed with the code.
disable-model-invocation: true
---

<!-- Author: Eng. Mohammed Almutairi - Developzone.net -->

# /spec — durable feature spec

A spec is a single Markdown file that survives across sessions and is committed alongside the code. It holds the plan and the **decisions** so neither you nor the user reloads them from memory. **One file per feature. Lean — a working plan, not documentation theatre.**

## Location
Write to `specs/<feature-slug>.md` in the repo root (create `specs/` if missing). If the repo already has a docs/planning convention, match it instead. Slug = kebab-case of the feature name.

## On invocation
- **New feature** → create the file from the template, filling Goal + Decisions + Plan from the discussion. Ask the 2-3 questions you genuinely need before the plan is sound; don't guess scope.
- **Existing spec** → read it first, then make targeted edits — tick checklist items, append to the Log, record new decisions. Never regenerate it from scratch.

## Template
~~~md
# <Feature name>

**Status:** Planning | In progress | In review | Shipped
**Branch:** <feature branch>  •  **Updated:** <UTC date>

## Goal
What we're building and why, in 2-4 sentences. The user-visible outcome.

## Decisions
Decisions made + the option rejected, one line each. (This is what memory can't hold — write decisions down as they happen.)
- <decision> — chose X over Y because …

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
- Plan to the house rules, don't relitigate them: money = decimal, time = UTC, lists paginated with a stable order, writes atomic, migrations expand-contract.
- Each milestone should be small enough to pass `/gate` and `/ship` on its own.
- Empty section → delete it. Feature shipped → set Status: Shipped and leave the file as the record.
