---
name: qa
description: Act as a human QA tester on the change you just shipped past the gate. Use when the user types /qa, asks to "QA this", "test it like a user", "do quality testing", or after /gate passes and before /ship. Distinct from /gate — gate proves the code is correct; qa judges whether the fix is actually good.
---

<!-- Author: Eng. Mohammed Almutairi - Developzone.net -->

# /qa — be the human QA, not the build

`/gate` already proved the code **builds, tests green, and passes the security checklist**. `/qa` is the next gate: stop being the author, become a skeptical human QA tester sitting in front of the running change. Your job is to decide whether the fix is *actually good* — not whether the compiler is happy.

**First, orient — don't QA blind.** Read the actual change (the diff) and the original bug/requirement it was meant to satisfy. If the acceptance criteria aren't written down anywhere, derive them from the request and state them explicitly — you can't judge "good" against a target you never named.

Run against the real running change (the endpoint, the page, the command — hit it for real). If you genuinely can't run it here, say so and write the exact manual QA steps a human would follow; do not fake a pass.

**Match the lenses to the change.** A UI change gets all four below. A backend-only change (query, job, webhook, migration) has no "page" — QA it through its real surface instead: call the endpoint and read the response, inspect the rows it wrote, tail the job log start→finish, replay the webhook. "Usability" there means the contract, the error shape, and the data left behind — not pixels. Don't force UI lenses onto headless work, and don't skip QA because there's no screen.

Cover the lenses that apply:

- **Exploratory user testing.** Walk the actual flow as a real end user, not the test fixture. Try the unhappy paths a user stumbles into: back button, double-submit, empty form, huge input, wrong order of steps, refresh mid-flow. Does the fix solve the *reported* problem, or just the line of code?
- **Acceptance criteria.** Restate the original bug/requirement in one line. List each acceptance criterion and verify it the way a user sees it — observed behavior, not "the test asserts it."
- **Usability & UX feel.** Judge clarity: are error messages human and actionable (not `Reference: {id}` to the user's face with no recourse)? Edge-case UX, empty/loading/failure states, and — where content is bilingual — each locale renders correctly (no truncation, no mojibake, RTL/LTR intact).
- **Regression by feel.** Probe the neighbours the fix could have dented — the feature next to it, the shared component, the thing that reads the same data. Automated tests guard what they assert; you hunt what they don't.

Report as a QA verdict a human can act on:

- **Ship / Don't ship** — one line up top.
- **What I tested** — the real steps you ran and what you saw (the user-visible proof, not build output — that was `/gate`'s job).
- **Defects found** — each as: what a user does → what happens → what should happen. **Blocker** = wrong result, data loss, broken acceptance criterion, security/UX dead-end with no recourse. **Polish** = annoyance that doesn't block the goal. Keep the two lists separate and never let a polish note read like a blocker.
- **Not tested** — what you couldn't exercise here and the manual steps to cover it.

A green `/gate` with a failing `/qa` still doesn't ship. If the verdict is **Don't ship**, stop — fix the blockers, re-run `/gate`, then `/qa` again; do not hand off to `/ship`. Only a clean Ship verdict proceeds to `/ship`.
