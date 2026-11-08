# @tenora/orm

## 1.0.0-canary.0

### Major Changes

- 2d61231: Add `@tenora/orm`, the database layer of Tenora 1.0, on Postgres, MySQL, MariaDB, SQLite and SQL Server:
  
  - a query builder in Laravel's style, with joins, subqueries, grouping, unions, upserts and row locks;
  - transactions that every query inside `db.transaction()` joins without a handle being passed around: nested ones are
    savepoints, `Promise.all` inside one is safe, queries that outlive their transaction are rejected instead of running
    outside it, a COMMIT that Postgres turns into a rollback is reported, and `afterCommit`, `withoutTransaction` and
    deadlock retries are built in;
  - a schema builder in Laravel's style, and a Knex-compatible one that writes exactly the DDL Knex wrote, for
    migrations converted from 0.x;
  - a migrator and seeder with Tenora's own `tenora_migrations` bookkeeping, batches and locks;
  - catalog introspection: `hasTable`, `hasColumn`, `describeTable`, and schema comparison;
  - Eloquent-style models: casts, mass assignment, dirty tracking, events and observers, scopes, soft deletes and
    pagination.
  
  All Tenora packages now require Node.js 24.15 or newer.
