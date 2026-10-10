# Promote a reviewed PR without repeating its review

Use for a requested cherry-pick/promotion of an already-reviewed PR, including a human-authorized promotion toward main. This is a transfer of reviewed changes: do not restart braintrust, implementation or the independent Claude review merely because the session, branch or commit hashes differ. Production, push/PR approval and no-merge controls still apply; this reference grants no publication permission.

1. Read the source PR and its completed review record (the original `REVIEW:` verdict and its report). Record source PR URL, full source base/head hashes, reviewed scope and finding dispositions. Confirm all required original reviews actually completed and cover the promoted changes. A clean PR status, title or cherry-pick trailer alone is insufficient. Retrieve existing evidence before considering a replacement review.
2. Fetch the intended target and pin its base hash. Prepare the promotion on its own branch/worktree within the existing authorization. Keep the requested PR scope. Resolve conflicts explicitly and commit the result. Never use the shared production branch as a scratch checkout.
3. Prove the promoted patch equals the reviewed patch with one standalone read-only Git call, using full commit hashes:

```powershell
git range-diff <source-base-sha>..<reviewed-source-head-sha> <target-base-sha>..HEAD
```

   Every commit pair must be `=` (identical), or `!` with only context/line-number changes. Any `!` pair that changes added or removed lines, and any unmatched `<`/`>` commit, is an uncovered delta.
4. Check the context: `git diff --name-only <source-base-sha> <target-base-sha>` lists files that differ between the two baselines. Check whether relevant callers, contracts, dependencies, configuration or migration state change the behavior of the promoted patch. Matching patches prove transfer equivalence, not compatibility of the entire target. Author inspection and focused integration checks normally cover this step. Material unresolved behavior/security/DB risk warrants independent review of that context only.
5. Quote the range-diff result in the gate, then emit `REVIEW: PASS` only after confirming original coverage, resolved findings and target compatibility; cite the original PR/review and target SHA, and put the word `reused` on the `REVIEW:` line (the push guard accepts a reused verdict only after a `git range-diff` run following the last change). Run the required affected build/tests and smoke/provider checks against the target result. Required CI must pass on the promotion PR's actual head. Reuse unaffected evidence with its original command/output; do not repeat unrelated frontend/backend checks or rebuild containers without changed inputs. Apply migration-order/partial-apply proof only when the promoted change or target state makes it relevant.
6. Run `/gate` using that evidence and give the normal ship brief. A later code edit or changed target HEAD invalidates reuse: recheck equivalence and affected checks. Approval to cherry-pick/reuse review does not approve a push, a production target or a merge.

An uncovered delta (a conflict resolution, additional edit, missing prerequisite or changed behavior) needs a focused Sanad Step 3.5 review of that delta only; preserve the original review of unchanged code. Do not automatically commission another full-branch review to repair missing evidence. An unavailable or unresolved original review cannot be called passed.

Legacy Codex reviews (before 2026-09-28) stay valid reuse sources: their reports remain in `~/.claude/codex-reviews/<run-id>/`. Match them by the same range-diff rule; do not invent coverage a report does not show.
