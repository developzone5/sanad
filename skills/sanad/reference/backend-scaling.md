<!-- Author: Eng. Mohammed Almutairi - Developzone.net -->
<!-- Backend scaling rules — moved out of ~/.claude/CLAUDE.md (2026-09-10) so they load
     only when a change touches DB writes, migrations, transactions, workers, or exports.
     Loaded by: /sanad Step 3 (implement), /gate (DB proofs), and handed to the
     braintrust's Database optimizer in the evidence pack. CLAUDE.md keeps the headlines. -->

# Backend scaling — concurrency, queries, transactions, migrations, workers

Tuned for **.NET / EF Core / MySQL / Docker (multi-instance)**; map the API names to your stack. These are rules, not suggestions — every one of them has a production failure behind it.

## Concurrency & retry safety (multi-instance)

With N replicas, in-process locks and app-side existence checks are worthless across instances. The DB is the only serialization point.

- No check-then-act in app code (`if(!exists) Add`, `if(stock>0) decrement`) — two concurrent requests both pass. Enforce in the DB: UNIQUE/CHECK constraints, a single guarded `UPDATE ... WHERE id=@id AND stock>0` asserting affected-rows==1, or row locks inside the tx. Catch duplicate-key errors and return a domain result, don't 500.
- Any state-mutating handler that can be retried (payment, webhook, message consumer, POST-redirect) MUST be idempotent: a caller-supplied idempotency/event key, persisted with a UNIQUE constraint, duplicates short-circuited inside the same write transaction. Outbound third-party calls pass an idempotency key; treat a timeout as UNKNOWN (verify, don't blindly resend).
- **A retrying execution strategy replays the whole unit — including after an AMBIGUOUS commit** (the server committed, the acknowledgement was lost). Any non-idempotent unit inside it (an INSERT with a generated key, a `count = count + 1`) is then applied twice. Every unit run under a retrying strategy must either be naturally idempotent or verify before replaying (EF: `ExecuteInTransactionAsync(..., verifySucceeded)` checking a row only that attempt could have written, or a persisted idempotency key). Prove it on the real provider with a transaction interceptor that throws once AFTER the commit, plus one that throws BEFORE it (2 tests).
- **Lock order in a unit that writes a parent row and inserts an FK child:** update the parent FIRST. The child's FK check takes a shared lock on the parent; insert-then-update lets two concurrent units deadlock (1213). Prove with N parallel calls on the real provider.
- **Relational-only branches get a real-provider test.** InMemory skips transactions, retries, locks and FK checks. If the repo has opt-in real-DB tests (grep `*MySql*Tests`, an env-var-gated Fact), add one there; never accept "no real-DB harness exists" without grepping for it.

## Query & transaction scaling

- Transactions stay short and CPU-only: no HTTP, file I/O, email, queue publish, or delay while a tx is open — do external work before commit or after, never holding row locks across the network. Expect deadlock / lock-wait-timeout; wrap the unit of work in a bounded retry, lock contended rows in a consistent order.
- Every new/changed query carries an indexing obligation: columns in WHERE/JOIN/ORDER BY on a growing table get an index in the SAME migration (equality cols first, then range/sort). Prefer keyset/seek pagination (`WHERE id > @last ORDER BY id`) over deep OFFSET. Don't wrap indexed columns in functions in WHERE.
- Exports/reports never load an unbounded set into memory — stream it; bulk writes use set-based updates/deletes. CSV/Excel-injection-safe escaping on exports.
- Background workers resolve a fresh scoped DB context per unit of work (no captured singleton), catch per-iteration so one failure doesn't kill the host, honor cancellation tokens, and are safe on every replica (DB claim/lease).

## Migrations under startup AutoMigrate MUST be crash-loop-safe

**MySQL auto-commits every DDL statement, but EF records a migration applied only after ALL its steps finish.** So a migration that fails partway on a live table (a `CREATE INDEX` lock-waiting/timing out at real data volume — invisible on a tiny local DB) leaves its earlier steps committed but is NOT recorded, and every retry re-runs it from the top: the second pass hits `DROP INDEX ... key doesn't exist` (already dropped) or `Duplicate key/column` (already created) → throws → app never reaches "listening" → CrashLoopBackOff → the OLD build keeps serving → new routes 404 across the app.

- Make every step idempotent: guard `DROP INDEX`/`CREATE INDEX`/`ADD COLUMN` with an `information_schema` existence check (prepared-statement pattern), self-dedup before any UNIQUE index on not-already-unique data, and ensure the migration converges when re-run.
- **"Local applies clean" is NOT proof** — local tables are tiny; the failure is data-volume-dependent.
- A migration already crash-looping on staging is the ONE sanctioned reason to edit an applied migration's `Up()` (it was never recorded, so a roll-forward-idempotent rewrite converges) — prove it by simulating the partial-apply state and re-running to green.
- Symptom to recognize instantly: **"local works, staging 404s most pages / features missing" = a mid-chain AutoMigrate crash-loop serving the old build, NOT a code bug.**

## Verify fast — stack notes

- **Bind-mount dev containers** (`.:/app` + a file-watcher): a host build and the container's watcher both write the in-tree `bin/obj` → torn DLLs crash the container. Isolate host output (.NET: `dotnet test --artifacts-path <repo>/bin/hosttest` — gitignored and INSIDE the repo; an outside scratch path breaks tests that walk up from the build folder to find the solution), or `stop` the app container before a host run. Never run the app container and a host `F5` at the same time.
- The CLI test runner has a fixed per-run cost (host boot + assembly load + discovery — ~8s here) that a `--filter` can't remove; an IDE test runner (VS Test Explorer) keeps that host warm across re-runs, so it's the fastest repeated loop for a human. Filtering matters more as the suite grows.
