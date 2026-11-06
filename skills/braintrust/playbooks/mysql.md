# Playbook — MySQL

Load when the stack line names MySQL. Tags as in [dotnet.md](dotnet.md); *(version)* lines depend on the server version in the stack line.

- [DB] Text is `utf8mb4` with a chosen collation. The 8.0 default `utf8mb4_0900_ai_ci` ignores case AND accents: a unique index treats `Ali`, `ali` and `Alì` as one value, and `WHERE` compares the same way. *(8.0+)*
- [DB] DDL is not transactional: every DDL statement commits on its own. A migration that dies halfway leaves part of the change. Guard each statement with an `information_schema` check, so a rerun converges.
- [DB] Prefer online DDL (`ALGORITHM=INSTANT` or `INPLACE`, `LOCK=NONE`). Adding a column is INSTANT at the end of the table *(8.0.12+)* or anywhere *(8.0.29+)*. Changing a column's type usually copies the table and blocks writes. Building an index takes time in proportion to the rows.
- [DB] An index key holds at most 3072 bytes (InnoDB, DYNAMIC rows). In `utf8mb4` that is 768 characters, so a longer `varchar` needs a prefix index or a hash column.
- [DB] The default isolation is REPEATABLE READ: range updates and deletes take gap locks and can deadlock. `SELECT … FOR UPDATE` on an unindexed column locks far more rows than it reads. Retry on deadlock (error 1213).
- [DB] Uniqueness under concurrency comes from a unique index plus handling duplicate key (error 1062), never from "check, then insert".
- [DB] Deep `LIMIT offset` pages read and drop `offset` rows: use keyset paging.
- [DB] Check plans with `EXPLAIN` (`type: ALL` = full scan) or `EXPLAIN ANALYZE` *(8.0.18+)*. A JSON field is indexed through a generated column.
- [DB] `DATETIME` has no time zone (store UTC); `TIMESTAMP` converts with the session time zone and ends in 2038.
- [DB] Pomelo EF provider: the configured `ServerVersion` must match the server, or the generated SQL can differ.
- [PERF] Connection pool size × instances stays under `max_connections`.
