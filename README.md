# Tenora

A framework-agnostic multi-tenant toolkit for Node.js with a standalone CLI and shared core internals.

This repository is the **Tenora monorepo**. It contains the runtime package, the CLI package, and a shared core package used by both.

## Why a monorepo?
- Keeps runtime and CLI behavior in sync.
- Allows cross-package refactors without breaking public APIs.
- Makes release/versioning simpler with Changesets.

## Packages
- **`@tenora/multi-tenant`**: runtime toolkit for your app code (tenant resolver, factory, password helpers).
- **`@tenora/cli`**: standalone `tenora` command for migrations/seeds and tenant-wide operations.
- **`@tenora/core`**: shared internals used by the two public packages.

## Which package should I install?
- Building an application/service: install `@tenora/multi-tenant`.
- Running CLI globally: install `@tenora/cli` globally.
- Running CLI locally in a project: install `@tenora/cli` in the project.
- Most users should not depend on `@tenora/core` directly.

## Installation examples
Runtime package:

```bash
npm install @tenora/multi-tenant
```

Standalone CLI globally:

```bash
npm install -g @tenora/cli
```

Standalone CLI in a project:

```bash
npm install -D @tenora/cli
npx tenora list
```

## Package docs
- Runtime docs: `packages/multi-tenant/README.md`
- CLI docs: `packages/cli/README.md`
- Core docs: `packages/core/README.md`

## Repository structure
```text
packages/
  core/          # shared internals (factory internals, config loading, registry helpers, CLI modules)
  multi-tenant/  # runtime API package
  cli/           # standalone tenora CLI package
```

## Local development
Install dependencies:

```bash
npm install
```

Build all packages:

```bash
npm run build
```

Create local tarballs for all packages:

```bash
npm run pack
```

## Release workflow
Tenora uses Changesets.

Create a changeset:

```bash
npm run changeset
```

Apply versions:

```bash
npm run version
```

Publish:

```bash
npm run release
```

In CI, publish is triggered on `main` via GitHub Actions.

## Compatibility notes
- `@tenora/multi-tenant` still exposes a `tenora` binary in the current release line for backwards compatibility.
- New projects should install CLI from `@tenora/cli`.
