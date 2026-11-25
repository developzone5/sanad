# Sanad loop — one page

Loaded by the `sanad-implementation` stage. "Sanad Step N" anywhere means the step of that number here. Engine and roles: [engines.md](engines.md). Two files hold the rest, and this page wins when they differ:

- [review-checklist.md](review-checklist.md) — what a reviewer checks.
- [loop-rare-cases.md](loop-rare-cases.md) — the rare cases, and what each tool answer means.

`<notes>` is the task's notes folder (scratch, outside the repository). `<gate>` is `~/.claude/skills/gate/scripts`. After `node <gate>/sanad.mjs start --repo <repo> --notes <notes>`, `sanad.mjs next` prints every step that is due as a whole command: take the exact line from it.

## The six rules — every task, every size

1. **Places first.** Before code, list every place that uses the rule or data the change touches, and how the repo already does the same kind of job (reused, or why not). The list comes from a search, never from memory or from the ticket. 🔒
2. **A test for every ticket line and every place.** A place with no test has a written reason. 🔒
3. **Every new test fails on the old code.** A test that cannot fail proves nothing.
4. **Tests, lint, types and the suite pass on the final code.** 🔒
5. **A second AI reviews. Every note it writes is fixed, or the user decides it.** The author never closes a note alone. 🔒
6. **The user checks in the browser and pushes.** The author never pushes or merges.

🔒 = a program refuses the next step: `pre-review.mjs` and `review-brief.mjs` (rules 1 and 2), the evidence receipt (rule 4), the stop and push guards (rules 4 and 5). Never reword a line to pass a lock.

## Size — the size check picks it

Before code: `node <gate>/size-check.mjs --repo <repo> --files <planned files> --names <the places list names>`. It runs again on the real change inside `pre-review`. `SIZE GREW` means: add what the larger size needs, now.

- **Small** — one side (page or server) and no risk signal. No experts, no waiting. One quick review, started with the proof's first two runs. A slow suite is left to CI and the PR text says so.
- **Medium** — both sides, a database query, the shared API contract, or another medium signal. The proof, one full review, the full suite.
- **Big** — access, money, a migration, concurrency, files or URLs, a dependency, or a function with more than 10 callers. The boss routes ([boss-routing.md](boss-routing.md)); experts plan first (`/braintrust`); then the full review round.
- **Text only** (the check says tiny) — Small without rules 1 to 3: no list and no test. Lint, a look at the screen, one review.
- **Tests only** (owner's yes; switch `sanad.testsOnlyLane`) — only tests change: no places list, no second look; the proof of each new or changed test, one review, the suite once.

**One job per PR.** Over about 400 logic lines or 30 code files, `pre-review` asks the user: split it, or keep it as one job (`one-job.mjs --keep "<their words>"`)?

## Step 1 — Understand

1. **Test machine.** With `git config sanad.remoteHost` set, start `bash ~/.claude/scripts/remote/remote-preflight.sh --connect` in the background (`--db` only for a server proof). The app starts only for the browser check. A server change: also warm the proof copies in the background ([loop-rare-cases.md](loop-rare-cases.md), Warm copies).
2. **Lines file.** Save the ticket text as it is, then `node <gate>/lines.mjs --from <ticket text file> --out <notes>/lines.md`: every line becomes T1..Tn, and the text is kept as `<notes>/ticket.md`. No ticket → the user's own words are the lines, plus `--no-ticket --repo <repo>`. When chat words differ from the ticket, quote both and ask which one holds.
3. **Read the code.** The method or component, its callers and what it calls.
4. **Places list (rule 1).** Name what the change touches: each function, rule, helper, constant, error code, text key and field. Then:
   `node <gate>/places.mjs --repo <repo> --names <name1,name2,...> --out <notes>/places.md`
   The search is exact: give both spellings of a field (`DueAt,dueAt`).
   Open every place it lists and ask: is this another way to reach the same rule, another role, another screen, an API field, an export or a report? A new name joins `--names` and the command runs again.
5. **Check lines.** `<notes>/check.md`: one line per result the change must prove. Each line starts with its source: `[T2]` (a ticket line), `[change]` (what the change itself touches, a place included), `[rule: <project rule>]` or `[design]` (my own choice: reviewers attack it). The lines are numbered C1, C2, ... in order; write no number. They are the task's `Done means`. Nothing else becomes a check line.
6. **Second look (rule 1).** `node <gate>/siblings.mjs --brief --notes <notes> --repo <repo>`, then launch the `LAUNCH` line it prints: a second AI names every other place with the same rule or defect that the list misses. Save its answer as `<notes>/siblings-report.md` and record it: `siblings.mjs --record <notes>/siblings-report.md --notes <notes>`. Each `S<n>` line gets `→ P<n>` (add its name to the places search, then close that place too) or `→ none: <reason>`. Its `OUTSIDE PR` lines wait for the end list. Its `J<n>` lines are hints, never a design pick: `→ reuse` or `→ not: <why>` (the reviewer sees the reason).
7. **Close every place.** In `places.md` each place ends with `→ C<n>` or `→ none: <why this place needs no change and no test>`. A place that holds two rules gets a check line for each: `→ C2, C3`. Many places at once: `node <gate>/places.mjs --close <notes>/places.md --set "file:<path>=none: <reason>"` (or `P3,P7=C1`, `name:<name>=…`, `fn:<function>=…`), never a hand-made script; read the list it prints, and give a place you did not open its own outcome.
8. **Size line.** `▸ size: small | medium | big — <reason> · places: <n>`. Medium and Big show the PR plan and wait for the user's OK.

## Step 1.5 — Check the facts

A fact the change depends on that lives outside the changed code (another system, real data, configuration) is proven with a dated sample from the target environment, the normal case and the empty case. A fact that cannot be proven now is an open assumption, named to the user. A new or stricter rule on a field that already has rows: count the rows that break it; those rows become test data.

Exit: `▸ checked: <n> facts confirmed, <m> not sure yet`.

## Step 2 — Design

Every size starts from the `J<n>` lines.

- **Small:** no seat. The places list, the `J<n>` outcomes and the check lines are the plan.
- **Medium:** when a query's shape changes, one Database optimizer seat reads the planned query before code; each finding is fixed in the plan or becomes a proof at the gate.
- **Big:** `/braintrust` before code; two Architects each propose a design, blind to each other, and the boss picks; its verdict is the plan. By the owner's yes (switch `sanad.designChoice`) the user chooses between the two before code when the picked one adds a table, a migration or a worker, or is about twice the other's size.

Ask the user during the task only for a choice that changes the size or the design, all at once, with my pick. Any other choice takes my pick and joins the end list (Step 3.5, item 5), one line each.

## Step 3 — Build and prove

DB writes, migrations, transactions, workers or exports → [backend-scaling.md](backend-scaling.md) first.

1. **Tests.** One test per check line, tagged `[Cn]` in its title, with the ticket line it proves quoted in a comment above it. A test goes through the public entry point. Its input is valid except for the rule under test, so that rule is the only reason for the result; a test of the first error also has a second error. A data write runs on the real database provider. A stricter rule on an old field gets the two `OLD DATA` tests of [review-checklist.md](review-checklist.md). Every wait in a test has its own bound.
2. **Fix.** The change that fixes the rule in every place that shares it: the list's places and any other place with that rule or data. Finish every edit before the proof: a later edit voids it.
3. **Cheap checks first.** Commit, then `node <gate>/pre-review.mjs --before-proof` with Step 3.5 item 1's options. Fix and commit until it passes: one proof per round, after it.
4. **Breaks.** `<notes>/breaks.json` comes from the tool, never typed: `node <gate>/breaks.mjs add --breaks <notes>/breaks.json --repo <repo> --file <f> --line <n> (--put <text> | --put-file <file>) --must-fail <words>` reads the text to break from the file (`seed` first: an entry per new test). One break per rule; `mustFail` names only that rule's tests.
5. **Proof (rule 3).**
   `node <gate>/red-proof.mjs --repo <repo> --old <base> --files <fix files> --breaks <notes>/breaks.json --then-green --log <notes>/proof.log -- <test command for the changed test files>`
   The server proof and the page proof may start together. Never show a red run by hand.
6. **Suite (rule 4).** While fixing, run only the touched test files. A slower suite runs once, on the final tree, with no edit while it runs. Checks run through the evidence helper (`/gate`), plainly, never in a pipe or straight over ssh.
7. **Browser check (rule 6).** `bash ~/.claude/scripts/remote/remote-web.sh start`, quote its `READY` line. Create the test data yourself; give a direct link, the account and at most three actions, each with its exact value and expected result. `remote-web.sh stop` when the user reports.

Exit: `▸ built: <n> files changed, <n> tests pass, checks clean`.

## Step 3.5 — Review

1. **Checks before review**, one command, all green:
   `node <gate>/pre-review.mjs --was <size> --notes <notes>`
2. **The brief**, always from the tool, never typed or copied:
   `node <gate>/review-brief.mjs --pin --notes <notes> [--proof-log <notes>/proof.log] --engine <claude|codex> --size <size>`
3. **Launch** every line of `<notes>/launch.md` in one message. Big: the risk files with their trace list, the whole diff, fresh eyes and the other engine. No source edit while they read.
4. **Notes (rule 5).** A report line that starts with `Blocker`, `Bug`, `Gap`, `Question` or `EXTRA TEST`, or that leaves a choice to the user ("you decide"), is a note; the guards number it (`notes.mjs list --open`). Each gets one answer through `notes.mjs answer` (`--fixed`, `--refuted`, or `--user` after `notes.mjs decide` saved the user's words). It refuses what the guards would refuse and prints the lines to send, each on its own line, in a message with no tool call:
   `NOTE <n>: fixed — <what changed and the test that proves it>`
   `NOTE <n>: user — "<the user's exact words>"`
   `NOTE <n>: refuted — <the note check's evidence>` (never a Blocker or a Question)
   There is no other answer. Before fixing, a note's fenced test runs on the reviewed code, and the note check ([loop-rare-cases.md](loop-rare-cases.md)) tries to disprove the rest; only a note it refuted may take the third line, and the ship brief lists those. A bug related to the ticket is fixed with a test, on every sibling path, without asking. Ask the open notes in one message (`notes.mjs ask`).
5. **Outside lines.** Each `OUTSIDE PR` line, and each choice I made myself, goes to the user at the end of the task, in one list: fix here, separate PR, or leave. The answer goes in the project's outside list.
6. **Fix round.** First list the round's notes by cause, one line each, and fix each cause once: a test of the reported case and one of another input of its kind. A decision that closes a group, or a Question that covers notes of the round, goes to the user first only when it changes the size or the design (cause, choices, cost of each, my pick); that group waits, the rest goes on. A set-aside note (separate PR, known limit) keeps its cause and file:line; a later fix that calls or copies that code checks the fault there. Answer every note, commit, pass `pre-review.mjs --before-proof`. A fix's proof is partial (`--changed-since <the last reviewed commit>`); the full proof and suite run once, after the last check. The proof and a fresh reviewer (brief: `review-brief.mjs --notes <notes> --recheck`) start in the same message; it re-checks the changed lines and their callers, plus the risk reviewer for a fix on a sensitive boundary. **Stop rule:** from the stop round (round 3 unless the owner sets `sanad.stopRound`), every new note but a blocker, a security hole or a ticket line goes to the user in one list: fix now, or a known limit in the PR text. Past it, a fix gets the short check `--recheck` picks: no round; its Bug or Gap joins the list. The step ends when the latest report has no open note.
7. **Verdict.** One plain sentence for the user, then the line `notes.mjs verdict --review` prints, on its own line, plain, in a message with no tool call:
   `REVIEW: PASS|FAIL — bugs <found>/<fixed>, goals tested <k>/<k> ✓, untested <n>, open: <none|list>`
   PASS needs `open: none`. The only allowed open item is the user's browser check, named as pending.

## Step 4 — Gate

Run `/gate` (`notes.mjs verdict --gate` needs `--tests <passed>/<run> --build --attack --security --ran`: each the real result): the Definition of Done and the security checklist, each claim with its real quoted output. Every check line is ticked with its evidence. A code change at the gate goes back through a re-check (Step 3.5, item 6). A red gate goes back to Step 3.

## Step 5 — Ask to ship

Run `node <gate>/sanad.mjs ready` (the required list), `sanad.mjs pr-body` and `node <gate>/check-pr-body.mjs <PR body file>`, then give the ship brief per `/ship`, with the timer report under it, and the one push command for the user. Wait for the explicit yes; a yes to the task was never a yes to the push. After the push: `sanad.mjs owed`, `pr-watch.mjs` in the background, `review-score.mjs --log`, and the task's line in `memory/task-metrics.md`: minutes, and bugs found after the push.
