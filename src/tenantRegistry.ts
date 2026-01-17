import fs from "fs";
import path from "path";
import type { Knex } from "knex";
import type { MultiTenantOptions, TenantRecord, TenantRegistryOptions } from "./types";
import { decryptPassword as defaultDecrypt, encryptPassword as defaultEncrypt } from "./password";

const REGISTRY_MARKER = "tenora:registry";

const DEFAULT_REGISTRY: Required<TenantRegistryOptions> = {
  table: "tenora_tenants",
  idColumn: "id",
  passwordColumn: "password",
  encryptedPasswordColumn: "encrypted_password",
  createdAtColumn: "created_at",
  updatedAtColumn: "updated_at",
};

export const resolveRegistry = (
  options: MultiTenantOptions
): Required<TenantRegistryOptions> => ({
  ...DEFAULT_REGISTRY,
  ...(options.registry ?? {}),
});

const resolveEncrypt = (options: MultiTenantOptions) => {
  if (options.encryptPassword) return options.encryptPassword;
  const key = process.env.TENORA_KEY;
  if (key) {
    return (plain: string) => defaultEncrypt(plain, key);
  }
  return undefined;
};

export const resolveDecrypt = (options: MultiTenantOptions) => {
  if (options.decryptPassword) return options.decryptPassword;
  const key = process.env.TENORA_KEY;
  if (key) {
    return (encrypted: string) => defaultDecrypt(encrypted, key);
  }
  return undefined;
};

const listMigrationFiles = (dir: string): string[] => {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".js") || name.endsWith(".ts"))
    .map((name) => path.join(dir, name));
};

export const ensureRegistryMigration = (
  options: MultiTenantOptions
): { created: boolean; filePath?: string } => {
  const configuredDir = options.base.migrationsDir;
  const migrationsDir = configuredDir
    ? (path.isAbsolute(configuredDir)
        ? configuredDir
        : path.join(process.cwd(), configuredDir))
    : undefined;
  if (!migrationsDir) {
    throw new Error(
      "Tenora: base.migrationsDir is required to create the tenant registry migration."
    );
  }

  const registry = resolveRegistry(options);
  const files = listMigrationFiles(migrationsDir);
  const hasRegistry = files.some((file) => {
    try {
      return fs.readFileSync(file, "utf8").includes(REGISTRY_MARKER);
    } catch {
      return false;
    }
  });

  if (hasRegistry) {
    return { created: false };
  }

  fs.mkdirSync(migrationsDir, { recursive: true });
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:T.Z]/g, "")
    .slice(0, 14);
  const fileName = `${timestamp}_create_tenant_registry.js`;
  const filePath = path.join(migrationsDir, fileName);

  const migration = `// ${REGISTRY_MARKER}
export const up = (knex) =>
  knex.schema.createTable("${registry.table}", (t) => {
    t.string("${registry.idColumn}").primary();
    t.string("${registry.passwordColumn}");
    t.string("${registry.encryptedPasswordColumn}");
    t.timestamp("${registry.createdAtColumn}", { useTz: true }).defaultTo(knex.fn.now());
    t.timestamp("${registry.updatedAtColumn}", { useTz: true }).defaultTo(knex.fn.now());
  });

export const down = (knex) => knex.schema.dropTableIfExists("${registry.table}");
`;

  fs.writeFileSync(filePath, migration);
  return { created: true, filePath };
};

export const ensureRegistryTable = async (
  base: Knex,
  options: MultiTenantOptions
) => {
  const registry = resolveRegistry(options);
  const exists = await base.schema.hasTable(registry.table);
  if (!exists) {
    throw new Error(
      `Tenora: tenant registry table "${registry.table}" not found. Run 'tenora migrate' to create it.`
    );
  }
};

export const listTenantsFromRegistry = async (
  base: Knex,
  options: MultiTenantOptions
): Promise<TenantRecord[]> => {
  const registry = resolveRegistry(options);
  await ensureRegistryTable(base, options);
  const rows = await base(registry.table).select({
    id: registry.idColumn,
    password: registry.passwordColumn,
    encryptedPassword: registry.encryptedPasswordColumn,
  });
  return rows as TenantRecord[];
};

export const upsertTenantInRegistry = async (
  base: Knex,
  options: MultiTenantOptions,
  tenantId: string,
  password?: string
) => {
  const registry = resolveRegistry(options);
  await ensureRegistryTable(base, options);

  const encrypt = resolveEncrypt(options);
  const encrypted = password && encrypt ? encrypt(password) : undefined;

  const record: Record<string, string> = {
    [registry.idColumn]: tenantId,
  };

  if (encrypted) {
    record[registry.encryptedPasswordColumn] = encrypted;
  } else if (password) {
    record[registry.passwordColumn] = password;
  }

  await base(registry.table)
    .insert(record)
    .onConflict(registry.idColumn)
    .merge(record);
};
