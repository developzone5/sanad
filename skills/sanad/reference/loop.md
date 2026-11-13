# Sanad loop — one page

Loaded by the `sanad-implementation` stage. "Sanad Step N" anywhere means the step of that number here. Engine and roles: [engines.md](engines.md). This page is the whole loop for a normal task. Two files hold the rest, and this page wins when they differ:

- [review-checklist.md](review-checklist.md) — what a reviewer checks.
- [loop-rare-cases.md](loop-rare-cases.md) — work split in parts, several PRs, the expert panel, machine load, the timer, what each tool answer means.

`<notes>` is the task's notes folder (scratch, outside the repository). `<gate>` is `~/.claude/skills/gate/scripts`.

## The six rules — every task, every size

1. **Places first.** Before code, list every place that uses the rule or data the change touches. The list comes from a search, never from memory or from the ticket. 🔒
2. **A test for every ticket line and every place.** A place with no test has a written reason. 🔒
3. **Every new test fails on the old code.** A test that cannot fail proves nothing.
4. **Tests, lint, types and the suite pass on the final code.** 🔒
5. **A second AI reviews. Every note it writes is fixed, or the user decides it.** The author never closes a note alone. 🔒
6. **The user checks in the browser and pushes.** The author never pushes or merges.

🔒 = a program refuses the next step: `pre-review.mjs` and `review-brief.mjs` (rules 1 and 2), the evidence receipt (rule 4), the stop and push guards (rules 4 and 5). Fix the cause. Never reword a line to pass a lock.

## Size — the size check picks it

Before code: `node <gate>/size-check.mjs --repo <repo> --files <planned files, comma-separated>`. It runs again on the real change inside `pre-review`. Size up freely; size down only on the user's verbatim words. `SIZE GREW` means: add what the larger size needs, now.

- **Small** — one side (page or server) and no risk signal. No experts, no waiting. One quick review, started right after the proof, so it runs while the user checks the browser. A slow suite is left to CI and the PR text says so. Target: 5–10 minutes.
- **Medium** — both sides, a database query, the shared API contract, or another medium signal. A changed query is read by one Database seat before code. The proof, one full review, the full suite. Target: 20–30 minutes.
- **Big** — access, money, a migration, concurrency, files or URLs, a dependency, a function with more than 10 callers, or more than 400 logic lines. The boss routes ([boss-routing.md](boss-routing.md)); experts plan first (`/braintrust`); then the full review round.
- **Text only** (the check says tiny) — Small without rules 1 to 3: no list and no test. Lint, a look at the screen, one review.

The size changes the depth only. The six rules are the same in every size.

## Step 1 — Understand

1. **Test machine.** With `git config sanad.remoteHost` set, start `bash ~/.claude/scripts/remote/remote-preflight.sh` in the background (`--db` for real-database tests, `--app` for a browser check). `REMOTE-DOWN` → ask the user once, now. A server change: also warm the proof copies in the background ([loop-rare-cases.md](loop-rare-cases.md), Warm copies).
2. **Lines file.** Save the ticket text as it is (steps, Expected, Actual, the rows of a linked ticket), then `node <gate>/lines.mjs --from <ticket text file> --out <notes>/lines.md`: every line becomes T1..Tn, and the text is kept as `<notes>/ticket.md`. No ticket → the user's own words are the lines, plus `--no-ticket --repo <repo>`: the commit check then asks for no ticket ID on this branch. When chat words differ from the ticket, quote both and ask which one holds.
3. **Read the code.** The method or component, its callers and what it calls.
4. **Places list (rule 1).** Name what the change touches: each function, rule, helper, constant, error code, text key and field. Then:
   `node <gate>/places.mjs --repo <repo> --names <name1,name2,...> --out <notes>/places.md`
   The list has one place per function that uses a name, and one per file for texts and data. The search is exact: give both spellings of a field (`DueAt,dueAt`). A name used in more than 40 files is too wide: name the rule, not the word.
   Open every place it lists. Ask of each one: is this another way to reach the same rule (create, edit, publish, import, a background job), another role, another screen, an API field, an export or a report? A new name that turns up joins `--names`, and the command runs again; it keeps what is written.
5. **Check lines.** `<notes>/check.md`: one line per result the change must prove. Each line starts with its source: `[T2]` (a ticket line), `[change]` (what the change itself touches, a place included) or `[rule: <project rule>]`. The lines are numbered C1, C2, ... in order. They are the task's `Done means`. Nothing else becomes a check line.
6. **Close every place.** In `places.md` each place ends with `→ C<n>` (the check line that tests it) or `→ none: <why this place needs no change and no test>`. A place that holds two rules (two lines far apart in one function) gets a check line for each: `→ C2, C3`. One outcome for many places: `node <gate>/places.mjs --close <notes>/places.md --set "file:<path>=none: <reason>"` (or `P3,P7=C1`, `name:<name>=…`), never a hand-made script.
7. **Size line.** `▸ size: small | medium | big — <reason> · places: <n>`. Small adds `· 1 PR` and goes on. Medium and Big show the PR plan (one line per PR: order, tickets, content, rough size, base) and wait for the user's OK.

## Step 1.5 — Check the facts

A fact the change depends on that lives outside the changed code (another system's contract, real data, configuration) is proven with a dated sample from the target environment, the normal case and the empty case. A fact that cannot be proven now is an open assumption, named to the user. A new or stricter rule on a field that already has rows: count the rows that break it; those rows become test data.

Exit: `▸ checked: <n> facts confirmed, <m> not sure yet`.

## Step 2 — Design

- **Small:** none. The places list and the check lines are the plan.
- **Medium:** when a query's shape changes, one Database optimizer seat reads the planned query before code; each finding is fixed in the plan or becomes a proof at the gate.
- **Big:** `/braintrust` before code; the boss's complete verdict is the plan.

Open user decisions are asked together, once, each with a recommended answer.

## Step 3 — Build and prove

Load [engineering-bar.md](engineering-bar.md). DB writes, migrations, transactions, workers or exports → [backend-scaling.md](backend-scaling.md) first.

1. **Tests.** One test per check line, tagged `[Cn]` in its title, with the ticket line it proves quoted in a comment above it. A test goes through the public entry point (the real request, the real form). A data write runs on the real database provider. A stricter rule on an old field gets two tests on an old row that breaks it: editing another field still saves; changing that field must meet the new rule.
2. **Fix.** The narrowest change that makes the tests pass, in every place the list says. Format changed C# once (`dotnet csharpier format <files>`). Finish every edit before the proof: a later edit voids it.
3. **Cheap checks first.** Commit, then `node <gate>/pre-review.mjs --before-proof` with the options of Step 3.5 item 1. Fix what it finds now: a label, quote or lint fix after the proof voids the proof.
4. **Breaks.** `<notes>/breaks.json`, written with the Write tool: one break per rule, each naming in `mustFail` only the tests of that rule.
5. **Proof (rule 3).**
   `node <gate>/red-proof.mjs --repo <repo> --old <base> --files <fix files> --breaks <notes>/breaks.json --then-green --log <notes>/proof.log -- <test command for the changed test files>`
   It runs on the test machine by itself. The server proof and the page proof may start together. Never show a red run by hand.
6. **Suite (rule 4).** While fixing, run only the touched test files. A suite of under two minutes runs in full right after the first complete build. A slower suite runs once, on the final tree, after the reviews, with no edit while it runs (Small: CI runs it). Checks run through the evidence helper (`/gate`), plainly, never inside a pipe or straight over ssh: the project's spec script writes the specs (EduQuest: `check-specs.mjs <notes>/specs`, `*-remote.json` for the test machine after `remote-sync.sh`). A failed run prints its totals and failing tests; the full output stays in its log.
7. **Browser check (rule 6).** `bash ~/.claude/scripts/remote/remote-web.sh start`, quote its `READY` line. Create the test data yourself. Give the user a direct link, the account and at most three actions, each with the exact value and the one result to expect. `remote-web.sh stop` when the user reports. The result is the user's; it is pending until they say it.

Exit: `▸ built: <n> files changed, <n> tests pass, checks clean`.

## Step 3.5 — Review

1. **Checks before review**, one command, all green:
   `node <gate>/pre-review.mjs --was <size> --lines <notes>/lines.md --check <notes>/check.md --places <notes>/places.md`
2. **The brief**, always from the tool, never typed or copied:
   `node <gate>/review-brief.mjs --out <notes>/brief.md --ticket <ticket text file> --lines <notes>/lines.md --check <notes>/check.md --places <notes>/places.md --proof-log <notes>/proof.log`
3. **Launch** every line of `<notes>/launch.md` in one message. Small and Medium: one review, fresh eyes, which gets only the user's words, the ticket, the diff and the places list. Big: the risk files, the whole diff, fresh eyes and the other engine, together. Every prompt starts `You are the independent reviewer`. No source edit while they read.
4. **Notes (rule 5).** Every report line that starts with `Blocker`, `Bug`, `Gap`, `Question` or `EXTRA TEST` is a note, and the guards number it. Each note gets one of two answers, on its own line in chat:
   `NOTE <n>: fixed — <what changed and the test that proves it>`
   `NOTE <n>: user — "<the user's exact words>"`
   There is no third answer. Not "rare", not "it was like that before", not "outside the ticket", not "the form cannot send that". A note that looks wrong goes to the user with the evidence, in one line; their words close it. A bug related to the ticket is fixed with a test, on every sibling path, without asking. Ask the open notes together, in one message.
5. **Outside lines.** Each `OUTSIDE PR` line goes to the user at the end of the task, in one list: fix here, separate PR, or leave. Their answer is recorded in the project's outside list.
6. **Fix round.** All fixes in one batch, test first. A changed test repeats the proof. Then a fresh reviewer (a new agent) re-checks the changed lines and their callers; a fix on access, the database or another sensitive boundary also gets the risk reviewer. The step ends when the latest report has no open note.
7. **Verdict.** One plain sentence for the user, then on its own line, plain, in a message with no tool call:
   `REVIEW: PASS|FAIL — bugs <found>/<fixed>, goals tested <k>/<k> ✓, untested <n>, open: <none|list>`
   PASS needs `open: none`. The only allowed open item is the user's browser check, named as pending.

## Step 4 — Gate

Run `/gate`: the Definition of Done and the security checklist, each claim with its real quoted output. Every check line is ticked with its evidence. A code change at the gate goes back through a re-check (Step 3.5, item 6). A red gate goes back to Step 3.

## Step 5 — Ask to ship

Run `node <gate>/check-pr-body.mjs <PR body file>`, then give the ship brief per `/ship`, with the timer report under it, and the one push command for the user. Wait for the explicit yes; a yes to the task was never a yes to the push. After the push, add the task's line to `memory/task-metrics.md`: minutes, and bugs found after the push (starts at 0).
