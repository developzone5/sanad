# Engineering bar — the detail behind CLAUDE.md

Loaded by the `sanad-implementation` stage (Step 3) and by `/gate`. CLAUDE.md keeps one-line rules; this file keeps the reasons, the ladders and the checklists. Stack-neutral: the examples are .NET/MySQL, map them to your stack.

## Backend bar — how a senior writes it

- **Correctness over happy path.** Handle nulls, empties, failures and concurrency. The bug is usually bad data, not bad logic — check the data.
- **Data discipline.** Read-only queries: no tracking, select only needed columns, no N+1. Lists: always paginated with a stable, unique `OrderBy`. Multi-step writes: atomic. Concurrency: optimistic. Migrations: expand-contract, never edit an applied one.
- **Storage reality.** Unicode-safe charset (`utf8mb4`) for international text and emoji; know the default collation's case sensitivity (it can break unique checks) and pick deliberately. Store time as UTC.
- **Money is `decimal`. Time is UTC.** Convert to local only at the UI edge.
- **Errors:** handle in one central place, return the right HTTP status, log once, never leak internals (`Reference: {id}` instead).
- **Fit the codebase.** Read how it is already done and match it; do not invent a parallel pattern. Replacing old code means deleting it in the same change.
- **No new dependencies, major upgrades or destructive/shared-state actions without asking.** When unsure of a current API, read the live docs for the pinned version.
- **Ship finished code.** Never hand-edit generated or applied artifacts (designer files, model snapshots, applied migrations, lockfiles, build output, vendored libraries). Change the source of truth and re-run the tool: edit the model and add a NEW migration; edit the manifest and re-restore. No `TODO`/`FIXME`/`HACK` without a tracked id, no `NotImplementedException`, no stub returning fake data, no `// ... rest unchanged` elisions. If something cannot be done now, stop and say what blocks it.

Multi-instance concurrency, query and transaction scaling, crash-loop-safe migrations, exports and workers: [backend-scaling.md](backend-scaling.md). Load it before touching DB writes, migrations, transactions, background workers or exports.

## Verify fast — the ladder

Default: verify on the host — tests on an in-memory/SQLite provider, the app under a watcher. Seconds, not minutes. Rebuild a container ONLY when deps, lockfile, Dockerfile, compose or env changed — never to check a code or logic fix.

1. Docs/comments only → reason, do not build.
2. Logic / mapping / validation / authz → unit or integration tests on the host, no containers. This is the default "does it work" check.
3. App behavior → run the app under a watcher (`dotnet watch`, `vite`, `nodemon`) or a debugger; a saved edit hot-reloads.
4. Bigger/structural change → incremental build (never `clean` or `--no-incremental`) + restart the ONE service.
5. Rebuild the container image / full stack → ONLY when deps, lockfile, Dockerfile, compose or env changed.

- Never rebuild a container to run unit tests.
- Bind-mounted dev containers: never let a host build and the container's watcher write the same `bin/obj`. Isolate host output (`dotnet test --artifacts-path <repo>/bin/hosttest` — a gitignored folder INSIDE the repo; a path outside it breaks tests that find the repo root by walking up) or stop the container first.
- Filter to what you touched (`--filter "FullyQualifiedName~X"`). Run the FULL suite exactly once per task (user rule 2026-10-06), on the final source, through the evidence helper so the same run is the push receipt. If it fails only for an environment reason, rerun just the failed tests, never the whole suite again.
- Discover once, remember: the first time in a repo, find the fast commands (test runner, watch script, filter flag, which deps are containerized) and record them in the project's `memory/`.

## Mechanical checks — the simple classes a script catches

Run these before the first review and after every fix round; they never get tired. The project's `memory/` lists its commands; when a project has no script for a class yet, do the check by grep and say so in the review request.

- A removed `{{placeholder}}` or format argument while a caller still passes it (i18n strings, log templates).
- A backend DTO or enum changed without its hand-synced frontend type (the comment names the backend file).
- A new or changed state-changing endpoint without negative tests (anonymous → 401, wrong role → 403, not-owner → 404/403).
- A comment or doc naming a number, list or limit the change made stale.
- An i18n key present in one locale and missing in the other.
- Formatting (CSharpier, ESLint on changed files) and the type check actually covering source.

## Proof by change type

- **Endpoint:** the real request + status + body, plus one negative case (401/403/400/404).
- **DB/query:** the generated SQL + row counts before/after.
- **UI:** the user's reported actions and observed result for the affected roles/locales, tied to the checked branch/diff. A screenshot only to resolve a visual ambiguity. This is manual evidence, not an automated run.
- **Job/migration:** log lines start → finish + affected-row count.

No invented evidence: every "builds clean / tests pass / it works" claim is backed by the actual command and its real output quoted in the reply. Never predict a pass, narrate what a test "would" print, or summarize a run you skipped. A command failed or could not run → name the exact step and stop. Reused output counts only if nothing relevant changed.

## Self-review the staged diff

Read the actual staged diff end to end as a hostile reviewer before the hand-off:
- Leftover debug: stray prints, log spam, commented-out blocks, temporary anonymous-access attributes, hardcoded test data.
- Secrets in any tracked file, including config and migrations. A later removal does NOT scrub a committed secret from history; it must be rotated.
- Scope creep: restate the agreed task in one line; the diff does that and ONLY that. No drive-by renames, reformatting or package bumps. A real bug found mid-task is a one-line follow-up note, not an inline fix.
- Orphaned old code, dead imports, the missing test the change requires.

## Conflicts and one-way doors — the full list

An ask that fights a rule (skip the test, log a token, target prod, `git add .`, force-push a shared branch, bypass a failing hook): name the rule and the risk in one line, offer the safe alternative, ask for confirmation of the override. An explicit "yes, do it anyway" wins; note the override in the end-of-task report.

Stop for explicit confirmation even inside a green-lit task: dropping or truncating tables or columns, down/remove on applied migrations, deleting branches, force-push, rewriting pushed history, mass file deletes, secret rotation, anything against a prod or shared DB, volume prunes. State exactly what gets destroyed and whether it is recoverable, then wait. One "yes" is not blanket approval for the next action.

## Agents and effort

Follow the selected task engine in [engines.md](engines.md). Every Codex role uses xhigh. The table below describes the unchanged **Claude-only** assignments.

| Agent type | Model / effort | Job |
|---|---|---|
| `routing-boss` | Fable 5.1 / xhigh, read-only | route uncertain or sensitive work; review expert reports; final design call |
| `independent-reviewer` | Opus 5.5 / xhigh, read-only | Pass A review of risk files with a trace list |
| `routine-reviewer` | Sonnet 5.5 / xhigh, read-only | Pass B whole-diff review and every re-check after fixes |
| `braintrust-expert` | Opus 5.5 / xhigh, read-only | deep-risk seats (Architect, Skeptic, Database, Security, Authenticity, added domain) |
| `braintrust-expert-sonnet` | Sonnet 5.5 / xhigh, read-only | practical seats (Pragmatist, Performance, Product) |
| `sonnet-worker` | Sonnet 5.5 / medium | `direct`-route mechanical edits; evidence chores (run named tests, condense output, read logs) |

The Agent tool sets a model but not effort; the pinned agent files carry the effort. Verify actual run metadata; a settings edit does not switch a running session. Spawn a helper only when delegation saves work, never one per command; use direct local reads for small lookups.

## Hooks — what each one enforces

All under `~/.claude/hooks/`. When one fires, fix the cause; never bypass, disable or edit a hook to get past a block.

- `policy-guard.js` (Bash/PowerShell): branch, destructive-action and publishing controls. A push/PR needs completed passing verification with no unresolved failure, a source-bound evidence receipt, a completed reviewer run after the last change, then `REVIEW: PASS` and `GATE: PASS` — also in a new session. Git merges, resets, switches and stash pops count as changes, except when HEAD is clean and identical to the tree the last passing evidence check verified. Prose-only pushes need no code proof. A clone with `git config sanad.lane workflow` (Sanad's own hooks/skills) skips the reviewer but still needs the evidence receipt and `GATE: PASS`; the human sets `sanad.*` keys, never Claude.
- `precommit-guard.js`: denies a commit/push carrying secrets (new files included), a credential file or AI attribution. A denial means remove or rotate the secret, not reword the command.
- `csharpier-guard.js`: denies a commit/push with unformatted or partly staged `.cs` files. Format changed C# once before the final checks (Sanad Step 3).
- `stop-gate.js`: after a code change, missing/failed/pending verification blocks once, then warns honestly. A git-only change that leaves the clean tree identical to the last passing evidence check is accepted without a rerun. A background run counts when its completion is collected; a dev server or arbitrary script is not verification. A PR-review probe test that fails on purpose is declared once with `PROBE EXPECTED: {"command":…,"reason":…}` after its red run; the push guard still refuses while it fails.
- `session-start.js`: prints branch, upstream/integration ahead-behind (labelled stale when fetch fails), uncommitted count and PR state.

Workflow changes (`~/.claude`, `~/.agents`, Sanad Codex config/agents) ship through `~/.claude/scripts/workflow-install.sh` (scratch copy, suites, drift guard, backup); see Sanad Step 0.
