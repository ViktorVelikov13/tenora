# @tenora/core

Shared core internals for Tenora packages.

`@tenora/core` is the common implementation layer used by:
- `@tenora/multi-tenant`
- `@tenora/cli`

## Why this package exists
- Removes duplicated logic between runtime and CLI packages.
- Keeps shared behavior consistent (config loading, registry behavior, factory internals).
- Makes refactoring easier while preserving public APIs in higher-level packages.

## What it contains
- Shared types (`MultiTenantOptions`, `TenantManager`, resolver-related types)
- Tenant manager factory internals (`createTenoraFactory`, `createTenoraFactoryAsync`, `createKnexFactory`)
- Password helpers (`generateTenantPassword`, `encryptPassword`, `decryptPassword`)
- Config loading helpers (`resolveConfigPath`, `loadConfigModuleSync`, `loadConfigModuleAsync`, `unwrapConfig`)
- Tenant registry helpers (`ensureRegistryMigration`, `ensureRegistryTable`, `listTenantsFromRegistry`, `upsertTenantInRegistry`, `resolveDecrypt`)
- CLI implementation modules (`runTenoraCli`, command registration, template/database/config helpers)

## Installation
Most users should not install this package directly.

If you are extending Tenora internals:

```bash
npm install @tenora/core
```

## Stability expectations
- This is a public package, but primarily intended for internal composition.
- Runtime and CLI packages (`@tenora/multi-tenant`, `@tenora/cli`) are the preferred public entrypoints.

## Build
```bash
npm -w @tenora/core run build
```
