# Evidence that catches bugs after a green build

Use this reference for a behavior change, and read the project's relevant
`memory/missed-bugs.md` entries. More reviewers do not replace a missing check.

## Define the outcome before implementing

Write 3–8 `Done means` items from the user's request. Each names a concrete
input or state, the expected observable result, and how it will be checked.
Include the sibling operations, roles, locales, and boundaries the change
actually affects. The independent reviewer derives adversarial scenarios from
the request and surrounding code before reading the author's test list.

## Choose proof for the failure mechanism

- **Query, schema, collation, uniqueness, locking or migration:** use the actual
  database provider for the affected behavior. InMemory/SQLite unit tests remain
  useful but cannot prove MySQL SQL or DDL. Search raw SQL siblings after a schema
  change; execute the affected queries. Test delete→recreate for soft-deleted
  unique keys, and partial-apply→retry for startup migrations when applicable.
- **API/DTO/state change:** send the real request and read the result back.
  Exercise affected create/edit/delete/bulk/substitute paths, omitted optional
  parameters, and owned-resource denial. A test must observe the business result,
  not merely a 200 response. Use duplicate/concurrent requests where relevant.
- **List, aggregate, overlay or export:** test with more rows than the relevant
  page-size clamp, plus an empty result. Compare the displayed/returned count with
  its authoritative source. Record the data size used; small fixtures cannot
  establish behavior beyond their range.
- **Metric, ranking or threshold:** write `one unit = …` before and after the
  change. Test one actor repeating the action N times beside N actors doing it
  once; the ranking or threshold must follow the stated unit. Compare seed/demo
  data with what production now writes — a number proven on seed rows can count
  something else on real ones. The on-screen label must name the unit.
- **Entry points:** list every control and path that triggers the behavior —
  button, link/anchor, card or row click, keyboard, tour/demo, other API or job
  callers. Each gets a test, a user-checklist step or an out-of-scope reason;
  proof through one control does not cover a sibling control.
- **Opt-in real-provider tests:** when a changed path is proven only by an
  environment-gated test that CI skips, run it after the last edit with the
  variable set and quote its result (a skip is not a pass). Say in the PR body
  that CI does not run it.
- **UI:** the user renders the changed control and completes the supplied flow.
  Include affected roles and EN/AR/RTL or empty/error/loading cases when relevant.
  Record their observed result; a typecheck or API response is separate evidence.
- **Logging/deployment:** check expected failures do not become incident noise;
  smoke the deployed change after deployment and inspect new errors. Record the
  commit/image being exercised; local success does not verify a deployed build.

Run only applicable scenarios, with a reason for non-applicable categories.
If the user supplies manual evidence, label it as human-provided. If a necessary
environment or tool is unavailable, record the unverified criterion and report
FAIL; do not invent a request, screenshot, SQL result or passing review.

## User-owned browser acceptance (2026-09-21)

The user chose to perform browser acceptance. Prepare the verified local URL,
test account/role and a short action → expected-result checklist. Reuse known
local setup. Keep credentials out of committed evidence and reviewer requests.
Record the user's actual response, tested branch/diff, role, locale and flow;
label it human-provided. An existing bug report can supply the before-state,
labelled user-reported; request post-fix confirmation without inventing a red run.
Pending manual acceptance does not block independent static review or other
checks, but it prevents a full GATE: PASS. A failed case returns to fixing.
Recheck only cases affected by later UI/environment changes.

Do not create or run browser automation solely for this acceptance unless asked.
For a browser-only navigation/layout/wiring fix, this manual before/after evidence
can satisfy UI reproduction and acceptance without a new executable browser test.
State that no automated browser regression was added. Existing applicable tests
stay in place; changed non-UI logic, API/auth/tenant boundaries, data writes and
provider behavior retain their required automated/runtime proof. Manual UI
acceptance is not an exemption for those checks or for defects in retained code.

## Review and ship the code that was checked

The existing bug hunter and requirements auditor own these checks; add a new
specialist only for an uncovered domain. Preserve their independent context.
Every blocking finding is reproduced, fixed, and checked again. Add a regression
test for a reported bug that fails before the fix and passes afterward, except
for browser-only acceptance covered by the explicit user-owned rule above.
Use [command-evidence.md](command-evidence.md) for executable smoke assertions and
native command logs. Keep setup/restoration separate from the identical red and
green test command; never repeat state-changing setup to clear an old hook marker.

For each applicable automated escaped-bug CLASS/CATCH (with browser-only cases
handled under the user-owned rule above), record the regression's file/name,
triggering state and observable assertion, plus the actual failing and passing
commands/results. Retain the test with the fix. Do not count prose in a memory
file, a test name without its assertion, or a passing total as a regression guard.
Read the fake/mock implementation: absence of cache/search side effects needs a
recording fake or explicit mock verification; a no-op dependency cannot prove it.
Missing required reproduction/proof remains open; explain non-applicability for
unrelated classes instead of adding unrelated tests.

For shared model/concurrency changes, check every writer of the entity, including
login/profile updates, bulk SQL and jobs outside the feature. Exercise a
non-matching exception as well as the intended conflict, zero-row writes and
retry failures; verify no success side effect follows a failed write. Resolve
every new API error code in both EN and AR and inspect its frontend consumer.
Relational behavior needs the real-provider proof above.

Follow the review scope in Sanad Step 3.5, preserving completed coverage
for unchanged source. Verify changed paths, affected consumers and interactions
on every follow-up. Expand to the full branch when boundaries or requirements
change or prior coverage is insufficient; a fix-round count alone does not
restart review. Incomplete prior evidence never certifies omitted scope.

Before pushing, inspect the actual staged diff and record branch/HEAD plus the
files checked. After pushing, inspect required CI and review findings on that
exact PR head. Never mark ready while a required check is pending or failing.
Another commit requires new CI; a code change requires affected local checks and
review again. Green checks establish the tested criteria, not absence of all bugs.
