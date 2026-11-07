---
"@tenora/core": minor
"@tenora/cli": minor
"@tenora/multi-tenant": minor
---

Add `dropTenantDb()` and `tenora drop:tenant <id> --force`, which permanently delete a tenant database, its user and its registry entry.

Fixes:

- Postgres 15+: tenants with a password can now create tables.
- SQL Server: `createTenantDb` no longer fails at the registry step, `--create-base` works when the database exists, and the `sqlserver` client alias works.
- `tenant.databaseName` is now used when creating server databases, not only when connecting.
- The generated registry migration now works in `"type": "commonjs"` projects.
- Migration templates keep multi-word table names, and `add_x_to_y_table` now alters the table instead of creating it.
- The CLI now honours `TENORA_CONFIG`, as documented.
