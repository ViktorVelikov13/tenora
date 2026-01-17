import knex, { Knex } from "knex";
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import type { MultiTenantOptions, TenantManager } from "./types";
import { ensureRegistryTable, upsertTenantInRegistry } from "./tenantRegistry.js";

const require = createRequire(import.meta.url);

const normalizePassword = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  return String(value);
};

const loadDefaultConfig = (): MultiTenantOptions => {
  const configFile =
    process.env.TENORA_CONFIG || "tenora.config.js";
  const fullPath = path.resolve(process.cwd(), configFile);
  if (!fs.existsSync(fullPath)) {
    throw new Error(
      `Tenora: no config provided and default file not found at ${fullPath}. Set TENORA_CONFIG or pass options explicitly.`
    );
  }
  const module = require(fullPath);
  const cfg = module.default ?? module.config ?? module;
  if (!cfg) {
    throw new Error(
      `Tenora: config file ${fullPath} did not export a config object.`
    );
  }
  return cfg as MultiTenantOptions;
};

const defaultPool: Knex.PoolConfig = { min: 2, max: 10, acquireTimeoutMillis: 60_000, idleTimeoutMillis: 60_000 };

export const createTenoraFactory = (
  options?: MultiTenantOptions
): TenantManager => {
  const resolved = options ?? loadDefaultConfig();
  const { base, tenant = {}, knexOptions = {} } = resolved;
  const cache = new Map<string, Knex>();
  const basePassword = normalizePassword(base.password);

  const buildBaseConnection = (database: string): Knex.StaticConnectionConfig => ({
    host: base.host,
    port: base.port,
    user: base.user,
    ...(basePassword !== undefined ? { password: basePassword } : {}),
    database,
    ssl: base.ssl ?? false,
  });

  const baseKnexConfig: Knex.Config = {
    client: "pg",
    useNullAsDefault: true,
    connection: buildBaseConnection(base.database),
    pool: base.pool ?? defaultPool,
    migrations: base.migrationsDir ? { directory: base.migrationsDir } : undefined,
    seeds: base.seedsDir ? { directory: base.seedsDir } : undefined,
    ...knexOptions,
  } as Knex.Config;

  const baseClient = knex(baseKnexConfig);

  const buildTenantConfig = (tenantId: string, password?: string): Knex.Config => {
    const tenantPassword = normalizePassword(password ?? basePassword);
    return ({
    client: "pg",
    useNullAsDefault: true,
    connection: {
      host: base.host,
      port: base.port,
      user: password ? `${tenant.userPrefix ?? "user_"}${tenantId}` : base.user,
      ...(tenantPassword !== undefined ? { password: tenantPassword } : {}),
      database: tenantId,
      ssl: tenant.ssl ?? base.ssl ?? false,
    },
    pool: tenant.pool ?? base.pool ?? defaultPool,
    migrations: tenant.migrationsDir ? { directory: tenant.migrationsDir } : undefined,
    seeds: tenant.seedsDir ? { directory: tenant.seedsDir } : undefined,
    ...knexOptions,
    });
  };

  /**
   * Get (or create+cache) a Knex client for the tenant.
   * Password is optional; if omitted, the base user is used.
   */
  const getTenant = (tenantId: string, password?: string): Knex => {
    const cached = cache.get(tenantId);
    if (cached) return cached;

    const client = knex(buildTenantConfig(tenantId, password));
    cache.set(tenantId, client);
    return client;
  };

  const destroyTenant = async (tenantId: string) => {
    const client = cache.get(tenantId);
    if (client) {
      await client.destroy();
      cache.delete(tenantId);
    }
  };

  const destroyAll = async () => {
    await Promise.all([...cache.values()].map((k) => k.destroy()));
    cache.clear();
    await baseClient.destroy();
  };

  /**
   * Create tenant DB, optional user, then run migrations/seeds.
   * Mirrors createDB.ts from the reference project.
   */
  const createTenantDb = async (tenantId: string, password?: string) => {
    await ensureRegistryTable(baseClient, resolved);
    const tenantPassword = normalizePassword(password);
    // Reuse a short-lived connection to base db so we can create the tenant DB/user
    const admin = knex({
      ...baseKnexConfig,
      // ensure we run against the "postgres" maintenance DB to create others
      connection: buildBaseConnection("postgres"),
    });

    try {
      const result = await admin.raw(`SELECT 1 FROM pg_database WHERE datname = ?`, [tenantId]);
      if (result?.rows?.length) {
        throw new Error(`Database "${tenantId}" already exists`);
      }

      await admin.raw(`CREATE DATABASE "${tenantId}"`);

      if (tenantPassword) {
        const userName = `${tenant.userPrefix ?? "user_"}${tenantId}`;
        await admin.raw(`CREATE USER "${userName}" WITH PASSWORD '${tenantPassword}'`);
        await admin.raw(`GRANT ALL PRIVILEGES ON DATABASE "${tenantId}" TO "${userName}"`);
      }
    } finally {
      await admin.destroy();
    }

    // Run tenant migrations if configured
    const client = knex(buildTenantConfig(tenantId, tenantPassword));
    try {
      if (tenant.migrationsDir) {
        await client.migrate.latest();
      }
      if (tenant.seedsDir) {
        await client.seed.run();
      }
    } finally {
      await client.destroy();
      cache.delete(tenantId);
    }

    await upsertTenantInRegistry(baseClient, resolved, tenantId, password);
  };

  return {
    getBase: () => baseClient,
    getTenant,
    createTenantDb,
    destroyTenant,
    destroyAll,
  };
};

// Backwards-compatible alias
export const createKnexFactory = createTenoraFactory;
