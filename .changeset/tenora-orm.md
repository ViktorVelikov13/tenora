---
"@tenora/orm": major
---

Add `@tenora/orm`, the database layer of Tenora 1.0: connections for Postgres, MySQL and SQLite, a query builder in
Laravel's style, and transactions that every query inside `db.transaction()` joins without a handle being passed
around. Nested transactions are savepoints, `Promise.all` inside a transaction is safe, queries that outlive their
transaction are rejected instead of running outside it, a COMMIT that Postgres turns into a rollback is reported, and
`afterCommit`, `withoutTransaction` and deadlock retries are built in.

All Tenora packages now require Node.js 24.15 or newer.
