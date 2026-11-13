# Review checklist

What a reviewer checks in Sanad Step 3.5 ([loop.md](loop.md)). The whole-diff and the fresh-eyes reviewer fill every line; the risk reviewer fills the lines its files touch. Scenarios come from the user's words and the ticket, never from the author's tests ([behavior-proof.md](../../gate/reference/behavior-proof.md)). Read the pinned base yourself (`git show <base>:<path>`) for every changed rule.

## Report

1. `RECOMMEND: PASS|FAIL`
2. Findings, most severe first, one line each: `Blocker|Bug|Gap|Question — file:line — <input> → <wrong result> — <one-line fix>`. A confirmed defect, a rare one included, is a Blocker or a Bug. A `Question` is only for what the quoted ticket lines leave open, and it quotes that line.
3. A test the ticket does not name but this change needs: `EXTRA TEST: <the product change the tests would let through> — <the test that should fail>`.
4. The checklist below, one short line each: `✓`, `✗ <what>` or `– n/a <why>`.
5. `NOT VERIFIED:` one line. `OUTSIDE PR:` defects on paths the change neither touches, shows nor makes reachable, one line each. A defect on a path the change adds, changes, shows or makes reachable is a finding in item 2, even when the line is older than the branch.

Every line of items 2 and 3 is a note. The author must fix it or bring the user's own words; the author cannot close it alone. No praise, no restating the diff. Caps: 60 tool uses, 600 words.

## Every change

- `COVERAGE:` one line per check line (`Done means`) — `✓ implemented + tested (<test name>)` / `~ implemented, NO test` / `✗ missing`.
- `USERS FOUND BY SEARCH:` read the author's places list. For each `none:` line, open that place and check the reason; a place that needs the change and has none is a Bug. Then run the searches yourself (imports, callers, readers, copies, sibling screens, other roles' routes, and every user of an older piece a new one sits beside); a place the list misses is a Bug.
- `MISSED:` what the ask implies that nothing in the diff addresses — the other call site, the other locale, the other role, the raw-SQL twin of a query change, the screen that shows a new field.
- `HALF-DONE:` stubs, TODOs without an id, unhandled null, empty or failure branches, fields an update endpoint silently drops, helpers defined and never called.
- `CALLERS:` for every changed or newly-parameterized method — each caller (`file:line`), what it passes, and whether it runs under a request or a background service. A service that starts reading the current user must be built on an acting user by every non-request caller.
- `ENTRY POINTS:` every user-facing way to trigger the changed behavior — button, link, card or row click, keyboard path, tour or demo path, other API callers, background jobs — each `tested` / `user checklist` / `out of scope: <why>`. A sibling control that reaches the same feature by another route is its own entry point.
- `REMOVED:` every test or assertion deleted or weakened, with the rule change that justifies it as stated in the PR text. No stated rule change = FAIL.
- `HYGIENE:` literals that copy an existing constant or default, one rule hand-copied in two places, comments naming numbers or lists the change made stale, test resources not released on a failure path.
- `SPEC WORDS:` each ticket line → the test that proves it; a line tying two things together ("same as", "matches") → an equality test of both sides. No test = Gap.
- `EXISTING PATTERN:` the same problem already solved in the repo (a helper, a guard, a component); a second, different solution or a sibling left on the old one is a Gap.
- `TESTS CAN FAIL:` each new or changed test was shown red on the old code (quoted in the proof), or you name the line of the change that makes it fail without the fix. A test that passes on the old code is a Gap.
- `TYPES:` a new literal (status, code, kind, file extension list) used in more than one place has one shared constant, union or enum; two hand-copied lists are a Gap.

## Only for this type of change

The trigger is in brackets. When it does not apply, write `– n/a <why>`.

- `WRITERS:` [a shared entity, model or concurrency change] every writer, including other features, login updates, jobs and bulk or raw SQL, and whether the new rule changes its success or failure path.
- `MEANING:` [a user-visible number, ranking or threshold changes] `one unit = <before> → <after>`, and the test where one actor repeats the action N times beside N actors doing it once. A label that no longer names the unit is a finding.
- `FAILURES / LOCALES:` [a new failure path, error code or text] non-matching exceptions, zero-row writes, null, empty and whitespace, a failure inside a retry, side effects after a failed write; each new API error code resolved in every locale and traced to its consumer; a removed `{{placeholder}}` while a caller still passes it; when a rule gets wider or narrower, its server message and every locale's text say the new rule.
- `OLD DATA:` [a new or stricter rule on a field with rows, or a limit that can change later] the count of rows that break it, and two tests: an older row that breaks the rule still saves when a different field is edited; changing that field itself meets the new rule. Every exemption in a check is tested against EVERY clause of that check. Missing → Bug.
- `ACCESS PAIRS:` [a read or write of another person's data] the caller is checked against THAT record or person (caller × student, caller × section), not two separate truths; every list inside a response is filtered by the caller's own scope. Probe: two staff with different sections on one shared record.
- `CLIENT STATE:` [a page that edits or shows server state] what it shows before the fresh read (a cache never seeds an editor), after a refusal, after another tab or user changes the same record, and which clock decides a deadline (the server's).
- `NEW BLOCKS:` [a new disabled button, guard or refusal] each way out of it listed and tested (clear, retry, reload, another tab, the data changing underneath). A block with no tested way out is a Bug.
- `DATABASE:` [a method that reads or writes the database] never skipped:
  - **Round trips:** the statements it sends on the base and on the change. More statements, one aggregate split into several reads, or a clamp, cap or comment that explains a race between two reads is a Bug: two reads of one fact are one statement.
  - **Query shape:** no query per row or inside a loop. No EXISTS or correlated subquery inside an aggregate over a large table without a reason (table sizes from the project's database catalog, when it has one).
  - **Indexes:** every new or changed WHERE, JOIN or ORDER BY column has an index, added in the same migration (check the schema catalog first). A composite index serves only a filter on its leading column; a unique index on a table with soft deletes leaves the deleted rows out.
  - **Lists:** a stable unique order and a bounded page size.
  - **Writes:** no I/O inside a transaction; a concurrent or replayed write is safe (unique constraint, guarded UPDATE, idempotency key); a total built from older rows still fits its column.
  - **Readers:** a new reader reads a table that production really writes.
  - **Clocks in SQL:** a current-time call inside a query runs on the database's clock, not the app's.
  - **Real provider:** every new or changed query shape runs on the real database. When the statement count is the claim, a command-counting test that fails on the old code. Missing → Gap.
- `TIME:` [a rule that compares times] tests at the precision the screen shows (the first and last second of the shown minute or day, and the next one); both sides of each compare on the same clock; one clock read per method; local time only at the UI edge; a state that depends on time (open, overdue, closed) is computed from the clock, never only from a stored status.
- `API FIELDS:` [a changed rule] every DTO or API field that carries the same fact (a late flag, a status, a count) reads the one shared rule, whether or not a page reads it today. Search the DTOs and their projections, not only the frontend callers. A field left on the old rule is a Bug.
- `UI:` [a changed screen] every CSS class, token or icon it uses exists in this repo; the layout holds at phone width, in RTL and with long text; focus stays in place when part of the screen swaps; every control works by keyboard and has a screen-reader name; contrast meets WCAG 2.1 AA; a file or media type the screen opens works in the target browsers. Proof: the code, plus a line in the user's browser checklist.
- `CI-SKIPPED:` [proof that lives only in a test CI skips] the local command run after the last edit with its quoted result (a skip is not a pass), and the note in the PR text. Missing → open.
