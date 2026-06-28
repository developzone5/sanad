---
name: ship
description: Walk the change through the teach-back brief, then push to staging and open a DRAFT PR — never main/master/prod. Use when the user types /ship or asks to push, open a PR, or ship the change. Stops for explicit approval before pushing.
---

<!-- Author: Eng. Mohammed Almutairi - Developzone.net -->

# /ship — teach-back, then push to staging

Execute your shipping flow from CLAUDE.md — the **"Self-review your diff first"**, **"Teach before you push"**, **"Push only to the integration branch"**, and **"Draft until proven"** sections — for the current change. Don't restate them here; follow the ones in CLAUDE.md.

**Pushing and opening a PR are explicit-approval steps. Brief first, ask, then push. Never automatic.**

Specifics for this setup:

- **Gate first.** If the Definition of Done hasn't been verified this session, run `/gate`. A change that can't pass ships as a **DRAFT** PR only.
- **Integration branch is `staging`.** Push feature branches and base every PR against `staging`. **Never** `main` / `master` / `prod` / `production` / `release/*` — even if checked out on one. If `staging` is missing, STOP and ask.
- State the target out loud: `Pushing <branch> → PR base staging`.
- Open as **DRAFT**; mark ready only after the gate is green. Never merge, tag a release, or deploy to prod — the human's call.
