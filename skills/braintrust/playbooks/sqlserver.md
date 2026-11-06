# Playbook — SQL Server

Load when the stack line names SQL Server. Tags as in [dotnet.md](dotnet.md); *(edition)* and *(version)* lines depend on the server in use.

- [DB] Unicode text is `nvarchar`. `varchar` holds the collation's code page only, unless a UTF-8 collation is set *(2019+)*. The common default `SQL_Latin1_General_CP1_CI_AS` ignores case, so unique indexes and `WHERE` do too.
- [DB] Most DDL is transactional, so a failed migration in a transaction rolls back. Long DDL still holds schema locks that block every reader of the table.
- [DB] `WITH (ONLINE = ON)` index builds exist only on Enterprise, Developer and Azure SQL *(edition)*. On Standard, an index build locks the table: plan a window or a smaller table.
- [DB] Adding a `NOT NULL` column with a default is metadata-only on Enterprise *(2012+, edition)*; elsewhere it rewrites every row.
- [DB] Under READ COMMITTED without `READ_COMMITTED_SNAPSHOT`, readers and writers block each other. Check `is_read_committed_snapshot_on` (on by default in Azure SQL).
- [DB] `NOLOCK` reads dirty, doubled or missing rows: never use it where the result must be right.
- [DB] Deadlock victims get error 1205: retry the unit of work. A retrying EF execution strategy needs `strategy.ExecuteAsync` around your own transaction.
- [DB] "Unique when not deleted" is a filtered unique index: `CREATE UNIQUE INDEX … WHERE IsDeleted = 0`.
- [DB] `OFFSET … FETCH` needs an `ORDER BY` and reads all skipped rows; use keyset paging for deep pages.
- [DB] Skewed data makes plans sensitive to the first parameter (parameter sniffing). Check with the actual plan, `SET STATISTICS IO, TIME` and Query Store before adding hints.
- [DB] Time: `datetime2` over `datetime`; `datetimeoffset` when the zone matters; `SYSUTCDATETIME()` for now.
- [DB] Optimistic concurrency: a `rowversion` column as the EF concurrency token.
