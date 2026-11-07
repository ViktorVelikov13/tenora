---
"@tenora/core": minor
"@tenora/cli": minor
"@tenora/multi-tenant": minor
---

Add tenant schema dumps, so creating a tenant no longer runs every migration one by one.

- `tenora schema:dump:tenants` builds the tenant schema in a throwaway database and writes its structure, with no data, to `schema/tenant-<dialect>.sql` next to the tenant migrations. `createTenantDb` then loads that file into the new database and runs only the migrations newer than it.
- `--check` fails when a migration file is missing from the dump, without needing a database, for use in CI.
- `--prune` deletes the migration files the dump contains. Existing tenants keep migrating; rolling back into a pruned migration, or migrating a tenant that never ran one, fails with an explanation.
- Supported on Postgres, MySQL, MariaDB and SQLite. Dumping needs `pg_dump`, `mysqldump` or `mariadb-dump` (override with `TENORA_PG_DUMP`, `TENORA_MYSQLDUMP`, `TENORA_MARIADB_DUMP`); loading needs no tools.
- New: `TenantManager.dumpTenantSchema()`, `checkTenantSchemaDump()`, and the `tenant.schemaFile` option. Custom `TenantManager` implementations need the new method.

Projects without a dump file behave exactly as before.
