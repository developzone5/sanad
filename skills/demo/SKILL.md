---
name: demo
description: Interactive, screen-shareable walkthrough of the Sanad framework. Shows a numbered menu of the skills; the user picks one and you render a short description plus a realistic example of what running it looks like, one card at a time. Presentation only — never create files, spawn agents, run git, or open PRs. Use when the user types /demo or wants to show/explain Sanad to a group.
disable-model-invocation: true
---

<!-- Author: Eng. Mohammed Almutairi - Developzone.net -->

# /demo — guided Sanad walkthrough (for screen-share)

A paced, interactive tour to **show people what Sanad is and what each skill looks like**. The user drives it: print the menu, they pick a card, you render that card, then offer the next.

**This is a presentation, NOT a run.** Do not create files, spawn subagents, run git, or open PRs. Every "How it looks" block below is an illustration — render it verbatim. Never claim a real build/test/PR happened; if asked to run something for real, point them at the actual skill (`/spec`, `/gate`, …) instead.

## How to run it

1. Print the **Intro + menu** (below). Keep it tight.
2. **Wait** for the user to pick a number or skill name. Do not dump all cards at once.
3. Render the matching **card** exactly as scripted — box, short description, "How it looks", one-line takeaway (`→`).
4. After each card, offer the next step in one line: `next` (next link in loop order), a number/name to jump, or `menu`.
5. **One card per message** — screen-share friendly. Hold the *delete-your-own-comment* example as the through-line across the five loop cards so it tells one continuous story.
6. `/demo all` → render cards 1→5 in order, then the outro. `/demo <n>` or `/demo <name>` → jump straight to that card.
7. After card 5 (`/ship`), show the **Outro**.

Loop order: **spec → braintrust → gate → qa → ship**. Helpers: **impeccable**, **full-output-enforcement**.

---

## Intro + menu

```
  سند SANAD — the loop. each card = one link in the chain.
  nothing ships until every link is checked.

   1  /spec        plan it → one saved file
   2  /braintrust  many helpers → one answer
   3  /gate        prove it builds and passes
   4  /qa          test it like a real user
   5  /ship        explain it → draft PR (staging only)
   ─ helpers ─
   6  impeccable               make the UI look good
   7  full-output-enforcement  full code, no “…/TODO”
```

Then ask: *“Pick a number (or say `all`).”*

---

## Cards

### 1 · /spec — plan

```
┌─ 1 · /spec — plan ──────────────────────────────┐
│ Save the plan and choices in ONE file,           │
│ kept with the code. Next time you don't          │
│ have to remember any of it.                       │
└──────────────────────────────────────────────────┘
```

**How it looks** — you type: `/spec let users delete their own comment`

```
  ✎ specs/delete-comment.md  created

    # Delete own comment
    Status: In progress   Branch: feat/delete-comment

    ## Goal
    Let a signed-in user delete a comment they authored.

    ## Decisions
    • Soft-delete (hide) + tombstone — not a hard remove.
    • Ownership checked server-side — never trust the id.

    ## Plan
    [ ] M1  migration: add DeletedAt to comments
    [ ] M2  endpoint: DELETE /comments/{id}
    [ ] M3  tests + "[deleted]" UI tombstone

    ## Risks
    Delete someone else's comment (IDOR) → check owner server-side.
    Rollback → drop column.
```

→ one saved plan that lasts between sessions, ticked off as you go.

---

### 2 · /braintrust — decide

```
┌─ 2 · /braintrust — decide ──────────────────────┐
│ A few Claude helpers argue, each from a          │
│ different view. Then ONE clear answer.           │
└──────────────────────────────────────────────────┘
```

**How it looks** — you type: `/braintrust soft-delete or hard-delete a comment?`

```
  Pragmatist  Hard delete is one statement. Ship it.
  Architect   Soft-delete keeps threads intact + the filter clean.
  Skeptic     Hard loses the audit trail — and check owner (IDOR).
  Data/scale  Deleted rows pile up; index the filter or lists rot.
  Product     "Delete" should vanish — show "[deleted]", not text.
  ───────────────────────────────────────────────────────────
  Decision    Soft-delete + tombstone; enforce ownership server-side
              (404 if not owner), index the filter column. (Architect
              + Product lead; Skeptic's IDOR + audit points fold in.)
```

→ five views settle a tough choice → one answer, not a guess.

---

### 3 · /gate — verify

```
┌─ 3 · /gate — verify ────────────────────────────┐
│ Run the full check. Show the real output —       │
│ never a guessed pass. No output = no claim.      │
└──────────────────────────────────────────────────┘
```

**How it looks** — you type: `/gate`

```
  $ dotnet build   → Build succeeded. 0 Warnings, 0 Errors
  $ dotnet test    → Passed!  5 tests
     ✓ owner deletes own   → 204, hidden
     ✓ not owner           → 404                    (security/IDOR)
     ✓ anonymous           → 401
     ✓ unknown id          → 404
     ✓ double delete       → second is 404
```

→ really correct: it builds, tests pass, and the IDOR test passes.

---

### 4 · /qa — human test

```
┌─ 4 · /qa — human test ──────────────────────────┐
│ Stop being the coder. Be a picky user on         │
│ the live app. Ends in Ship / Don't ship.         │
└──────────────────────────────────────────────────┘
```

**How it looks** — you type: `/qa`

```
  SHIP / DON'T SHIP  →  SHIP ✅

  Tested as a user (not a fixture):
   • Delete my comment → gone, shows “[deleted]”.       ✓
   • Delete it again   → already gone, no error.         ✓
   • Try another user's comment → blocked, 404.          ✓
   • Tamper the id in the request → still 404.           ✓
  Defects: none blocking.   Polish: add an “Undo” toast.
```

→ a real person says it's good. Passing gate + bad QA = no ship.

---

### 5 · /ship — push

```
┌─ 5 · /ship — push ──────────────────────────────┐
│ Explain the change, then open a DRAFT PR         │
│ to staging. Never main/prod. Asks first.         │
└──────────────────────────────────────────────────┘
```

**How it looks** — you type: `/ship`

```
  What    migration (DeletedAt) + DELETE endpoint + 5 tests + tombstone
  Why     soft-delete keeps threads (braintrust call); owner check server-side
  Proof   build clean · 5/5 tests · IDOR + double-delete negatives
  Blast   1 migration (add column) · rollback = drop column
  ──────────────────────────────────────────────────────────
  Pushing  feat/delete-comment  →  PR base: staging   (DRAFT)
  Approve the push?  ▌
```

→ a clear brief + draft PR you approve. Sanad never merges for you.

---

### 6 · impeccable — frontend polish

```
┌─ 6 · impeccable — frontend polish ──────────────┐
│ Check and polish the UI — layout, text,          │
│ color, motion, access, RTL. Looks, not logic.    │
└──────────────────────────────────────────────────┘
```

**How it looks** — pointed at the comment thread:

```
  Audit ▸ 6 findings
   ✗ Delete button + timestamp misaligned (8px drift)
   ✗ “[deleted]” tombstone grey-on-grey — fails contrast (2.9:1)
   ✗ No confirm or undo → accidental deletes are permanent
   ✓ Fix: align baseline, AA contrast, confirm + undo toast
   ↻ RTL checked: action menu mirrors, the timestamp stays LTR
```

→ turns “it works” into “it feels right” — the look-and-feel layer.

---

### 7 · full-output-enforcement — complete code

```
┌─ 7 · full-output-enforcement — complete code ───┐
│ No “… rest unchanged”, no TODO, no half-code.    │
│ Whole file, ready to paste. For big files.       │
└──────────────────────────────────────────────────┘
```

**How it looks** — applied to a long file:

```
  ✗ banned   // ... existing code ...
  ✗ banned   throw new NotImplementedException();
  ✓ emits    the complete method / file, every line
  ✓ too long → clean split: “part 1/2” + the exact resume point
```

→ when you need the real, full code — not an outline you finish.

---

## Outro

```
  That's the chain:  plan → decide → check → user-test → push.
  every link checked → it ships.  one bad link → it stops.

  try it on your own change:
    /spec        plan a feature that spans sessions
    /braintrust  "<your hard design question>"
    /gate        prove the change works
    /qa          test it like a user
    /ship        explain it → DRAFT PR to staging

  under it all: CLAUDE.md — the always-on senior-engineer rulebook.
```
