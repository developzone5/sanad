---
name: demo
description: Interactive, screen-shareable walkthrough of the Sanad framework. Shows a numbered menu of the skills; the user picks one and you render a short description plus a realistic example of what running it looks like, one card at a time. Presentation only — never create files, spawn agents, run git, or open PRs. Use when the user types /demo or wants to show/explain Sanad to a group.
disable-model-invocation: true
argument-hint: "[all | card number or skill name]"
---

<!-- Author: Eng. Mohammed Almutairi - Developzone.net -->

# /demo — guided Sanad walkthrough (for screen-share)

A paced, interactive tour to **show people what Sanad is and what each skill looks like**. The user drives it: print the menu, they pick a card, you render that card, then offer the next.

**This is a presentation, NOT a run.** Make no tool calls: do not create files, spawn subagents, run git or shell commands, or open PRs. Every "How it looks" block below is a scripted illustration — render it verbatim. Never claim a real build/test/PR happened; if asked to run something for real, point them at the actual skill (`/spec`, `/gate`, …) instead.

Loop order: **spec → braintrust → gate → ship**. **`/sanad`** (card 0) runs the whole loop on one task in a single command.

## How to run it

1. Print the **Intro + menu** (below). Keep it tight.
2. **Wait** for the user to pick a number or skill name. Never dump all cards at once.
3. Render the matching **card** exactly as scripted — box, "How it looks", one-line takeaway (`→`).
4. After each card, offer the next step in one line: `next`, a number/name to jump, or `menu`.
   - `next` after cards 0–3 → the next card in loop order.
   - `next` after card 4 (`/ship`) → the **Outro**.
5. Always close the tour on the **Outro** — it is the call to action, whether they walked 1→4 or jumped around.

Arguments:

- `/demo` → intro + menu, then wait.
- `/demo all` → the full deck in one response: cards 0→4 in order, then the Outro. This is the one exception to one-card-per-message — use it for a handout or scroll-through, not a live tour.
- `/demo <n>` or `/demo <name>` → jump straight to that card. Partial names count: `brain` → card 2.
- Anything unrecognized → one line ("Didn't catch that — pick a number.") and reprint the menu.

## Presentation rules

- **One card per message** (except `/demo all`) — screen-share friendly; the audience reads at talking pace.
- **Cards render inside a fenced code block, byte-for-byte.** The boxes are hand-aligned for a monospace font — never reflow, translate, or decorate them; add no emoji or commentary inside the fence.
- The **delete-your-own-comment** example is the through-line of the four loop cards — one continuous story: card 1 specs it, 2 decides it, 3 proves it, 4 ships it. Point that out as you go.
- Questions mid-tour: answer in one or two lines, then re-offer `next | menu`.
- Narrate around the cards in the audience's language (Arabic or English); the cards themselves stay verbatim.
- Never fake a "live" run to impress the room — an invented pass is exactly what Sanad exists to prevent. If someone asks whether the output is real, say it is a scripted illustration and point them at the real skill to try afterwards.

---

## Intro + menu

```
  سند SANAD — the loop. each card = one link in the chain.
  nothing ships until every link is checked.

   0  /sanad       one task → the whole loop
   1  /spec        plan it → one saved file
   2  /braintrust  many helpers → one answer
   3  /gate        prove it builds and passes
   4  /ship        explain it → draft PR (never prod)
```

Then ask: *“Pick a number (or say `all`).”*

---

## Cards

### 0 · /sanad — run the loop

```
┌─ 0 · /sanad — run the loop ──────────────────────┐
│ Hand it one task. It runs the whole chain:       │
│ decide → build → prove → ask before the push.    │
└──────────────────────────────────────────────────┘
```

**How it looks** — you type: `/sanad let users delete their own comment`

```
  ▸ db impact?    yes — new column + hot query    (DB optimizer seated)
  ▸ /braintrust   → soft-delete + tombstone; index the filter column
  ▸ build         → migration + endpoint + tests
  ▸ /gate         → build clean · 5/5 tests · IDOR 404 · index proven
  ▸ ship?         → brief printed…  Approve the push?  ▌
```

→ one command runs every link — and the push still waits for you.

---

### 1 · /spec — plan

```
┌─ 1 · /spec — plan ───────────────────────────────┐
│ Save the plan and choices in ONE file,           │
│ kept with the code. Next time you don't          │
│ have to remember any of it.                      │
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
┌─ 2 · /braintrust — decide ───────────────────────┐
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
┌─ 3 · /gate — verify ─────────────────────────────┐
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

### 4 · /ship — push

```
┌─ 4 · /ship — push ───────────────────────────────┐
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

## Outro

```
  That's the chain:  plan → decide → check → push.
  every link checked → it ships.  one bad link → it stops.

  try it on your own change:
    /sanad       one task → the whole loop, end to end
    /spec        plan a feature that spans sessions
    /braintrust  "<your hard design question>"
    /gate        prove the change works
    /ship        explain it → DRAFT PR to staging

  under it all: CLAUDE.md — the always-on senior-engineer rulebook.
```
