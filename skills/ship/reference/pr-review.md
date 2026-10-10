# Reviewing a PR

Moved from the global CLAUDE.md (2026-09-28); this file is the single source.

When handed a PR to review, the human's job is to approve and merge — so end in a decision they can act on, as short points: what it does, what to fix, why.

- **Lead with the verdict** — "Merge it" / "Don't merge — fix X first." One line, up top.
- **Don't review the diff alone.** First pull approval state + CI (review decision, reviews, mergeability, checks), then read the surrounding source — callers, helpers, the whole method — not just the changed hunks. Trace each new branch with concrete inputs.
- **Red-team it** — null/empty/huge/malformed input, edge values, concurrency/duplicate, off-by-one. Findings come from attacking it, not reading it.
- **Each issue = problem + fix + why**, one bullet.
- **Separate blockers from low-severity/follow-up notes** — a non-blocker must not read like a blocker.
- **Distinguish introduced-by-this-PR from pre-existing/out-of-scope** — don't block a merge on debt the PR didn't create; mention it separately.
- **State what you did NOT verify** (e.g. "didn't compile locally, relying on green CI").
- Offer the next action (approve now, or open a follow-up) — don't do it unasked, and never perform the merge yourself (see Push only to the integration branch).

## Walking the user through the findings (user choice 2026-09-30)

The user reviews to understand every problem well enough to discuss it with the PR's authors, and posts the comments themselves.

- **One problem per message**, in the same fixed layout (user rule 2026-10-01): `## 🔴|🟡|🔵 Problem N — title` (🔴 Blocker, 🟡 Bug, 🔵 Question) · **What happens** (2–3 bullets, ≤ ~20 words each, plain words — no method/class names) · **Where** (file + line + that line's code, a line that is inside the PR diff; if the real cause is outside the diff, say so and anchor on the nearest changed line) · **Proof** (the real result in one line, or "code only") · **See it** (numbered steps, only when the user should run it) · **Comment** (code block, same plain words). Wait for the user's result before the next problem. No multi-problem checklists.
- **Run every repro step yourself before giving it** (browser-console snippet, API call, SQL, UI path). Quote the real result you got. Never write "Reproduced locally" or "Tested" in a comment until that check actually ran; a claim from a helper agent is a lead until you confirm it in the source or live. If a step needs data or an account you don't have, say "code only" and why.
- **Comment template — same words every time, no `**` bold, plain English a teammate reads in 10 seconds:**

  ```
  Blocker|Bug|Question: <short title — a Question is phrased as a real question ending in "?">

  Problem: <one or two sentences, at most 1–2 code refs, optional "(tested: …)" with the real result>

  Fix: <one sentence>
  ```

  Blocker = must fix before merge; Bug = wrong behavior, should fix; Question = the author must decide. Pre-existing issues not introduced by the PR get no comment unless the PR newly exposes them to more users, and then only a Question.
- **Submit** as one GitHub review ("Start a review" per comment, then "Finish your review" → Request changes when any Blocker exists) with a short summary: blockers numbered, counts of bugs/gaps/questions, one design suggestion if any. Posting stays the user's action unless they ask you to post.

## Testing a PR locally

- EduQuest: `bash ~/.claude/scripts/eduquest/review-local.sh start <PR#> [--account email:Role[:campusId]]...` then `... done` to return. It refuses a dirty tree, checks out `pr-<N>`, restarts the bind-mounted API (the PR's migrations apply to the local DB) and creates test accounts with password `Review@1234` without reading any secret out of the containers. **It switches the branch and restarts the shared API — run it only after the user says go, never as a dry run, and check `git status` and the current branch first: another session may be working in the same repo.**
- Probe tests written to prove the PR's bugs are expected to fail. After the red run, declare each one on its own line in plain text (not inside a code block): `PROBE EXPECTED: {"command":"<the exact test command>","reason":"<the PR bug it proves>"}`. The stop hook then stops blocking on it; the push guard still refuses while it fails, so a probe never ships. Keep probe files untracked and delete them when the review ends.
