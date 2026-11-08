---
"@tenora/core": major
"@tenora/cli": major
"@tenora/multi-tenant": major
---

Run on `@tenora/orm`. Knex and Objection are gone from every Tenora package:

- `getBase()` and `getTenant()` return a Tenora `Connection` instead of a Knex instance, and `createTenantResolver`
  attaches it as `req.db` instead of `req.knex`. `createKnexFactory` is removed; use `createTenoraFactory`.
- the manager gets `baseMigrator()`, `tenantMigrator()`, `baseSeeder()` and `tenantSeeder()`, in place of
  `knex.migrate` and `knex.seed`.
- every database records its migrations in `tenora_migrations`, without the file extension, and schema dumps do too.
  `migrations.table` renames it.
- `make:migration` and `make:seed` write the new format, and the registry migration uses it.
- the `sqlite3` driver is no longer supported; install `better-sqlite3`. The database files stay the same.
- `knexOptions` still applies its `pool`, `migrations.directory` and `seeds.directory`, and warns about anything else.
- `connection.charset` and `connection.collate` still reach every new MySQL and MariaDB table.
- the registry migration a new project gets uses `timestamp` rather than `timestamptz` on Postgres; existing registries
  are untouched.
