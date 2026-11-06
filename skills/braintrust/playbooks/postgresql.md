# Playbook — PostgreSQL

Load when the stack line names PostgreSQL. Tags as in [dotnet.md](dotnet.md); *(version)* lines depend on the server version.

- [DB] The database encoding is UTF8, and `text` costs nothing extra. Comparisons are case-sensitive by default: unique emails need a unique index on `lower(email)` (or `citext`), and `lower()` / `ILIKE` searches need a matching expression index.
- [DB] DDL is transactional, so a failed migration rolls back. But `CREATE INDEX CONCURRENTLY` cannot run in a transaction: in EF use `migrationBuilder.Sql(…, suppressTransaction: true)`. A failed concurrent build leaves an INVALID index; drop it before retrying.
- [DB] `ALTER TABLE` takes an ACCESS EXCLUSIVE lock and waits behind long queries while blocking everyone after it. Set `lock_timeout` in migrations.
- [DB] Adding a column with a constant default is fast *(11+)*; a volatile default or `ALTER COLUMN TYPE` rewrites the table. Add `NOT NULL` safely: a `CHECK … NOT VALID` constraint, then `VALIDATE CONSTRAINT`.
- [DB] Upsert is `INSERT … ON CONFLICT (cols) DO UPDATE`; the conflict target must match a unique index.
- [DB] Job queues: `SELECT … FOR UPDATE SKIP LOCKED`.
- [DB] Long or idle-in-transaction sessions stop vacuum and bloat tables: keep transactions short.
- [DB] Check plans with `EXPLAIN (ANALYZE, BUFFERS)`. A sequential scan on a big table usually means a missing index. Deep `OFFSET` reads every skipped row: use keyset paging.
- [DB] Moments are `timestamptz` (stored as UTC). With Npgsql, a `DateTime` written to `timestamptz` must have Kind UTC, or it throws *(Npgsql 6+)*.
- [DB] `jsonb` with GIN indexes for JSON that is searched.
- [PERF] Pool size × instances stays under `max_connections`. PgBouncer in transaction mode breaks session features (prepared statements, `SET`, advisory locks held across statements).
