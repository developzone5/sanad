# Full PR review

Read when the user asks for a review, or before any push that carries code. It is the strongest review Sanad has. Delta re-checks and join checks do not replace it.

## How to run it

- One session per PR, never one session across a series. Run all of them at once: they only read, so they are light. A series also gets one session for work that is not in a PR yet.
- Run it on both engines: this one's reviewers and the other engine (see `engines.md`). The other engine runs where it is signed in, with its report written to a file.
- Scope for one PR: `git diff <OLD> <NEW>`, where OLD is the PR below it in a series, or the merge base with the integration branch for the first or an independent PR. NEW is the revision that will be pushed. Check that NEW is that revision before starting.
- Give each session this brief, with PR name, OLD, NEW and report path in the prompt. Add the project's own stack line, and its specs when it has them. No author framing: never say what the change intends beyond the brief.

## Brief

```text
You are the independent reviewer of one pull request. Read-only: do not edit, commit, push, switch branches, build or run tests.

Read with `git diff <OLD> <NEW>`, `git show <NEW>:<path>` and `git grep ... <NEW>`. The diff OLD..NEW is exactly what this PR adds. Read the callers and callees of changed code at NEW before you judge it.

Check everything in this PR. Give special care to:
- CORRECTNESS: nulls, empties, failures, concurrency and retries; every changed state and error path; server and page agree.
- OLD DATA: rows written before this PR (missing or odd values) still load, edit and display; a new rule does not lock them out; migrations are guarded and safe to re-run.
- ACCESS PAIRS: for each endpoint or query touched, role and owner checks hold on every path, including the sibling endpoint that reaches the same data. Tenant isolation holds.
- CLIENT STATE: cached queries, autosave, offline, retries, two tabs, a stale page after a server refusal; cache keys carry user scope.
- NEW BLOCKS: any new disabled or refused state must not stop a valid action.
- NUMBERS: money-like values use decimal, respect the column limits, with no rounding or overflow.
- DATABASE: no N+1, needed columns only, stable paging, an index in the same migration for each new filter or sort, multi-step writes are atomic, concurrent duplicates are handled by the database.
- UI TEXT: every new text exists in each language, placeholders and plural forms match.
- TESTS: each new behavior has a test that would fail on the old code.
Do not report style or personal taste. Do not report a problem that exists only because of a later PR's unfinished work unless it breaks users at this PR.

Write the report at the path in the prompt: one entry per finding, most severe first, with severity (P0 blocker, P1 bug, P2 minor), file:line at NEW, the concrete input and the wrong result, and the fix idea. If none: "none". The last line is exactly "VERDICT: PASS" or "VERDICT: FIX".
```

## After the reports

1. Check each finding still exists on the top branch; later work may have removed the file.
2. Confirm or dismiss each one by reading the code, and record why. A finding is a lead until then.
3. Fix each real one with a test that fails first, using exact briefs (`loop.md`).
4. Re-check the changed lines. Run the full review again only when the fixes changed a large part of a PR.
5. Report with the required list in `ship/SKILL.md`, pre-flight item 5.
