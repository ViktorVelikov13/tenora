import fs from "fs";
import path from "path";
import type { Connection } from "@tenora/orm";
import type { MultiTenantOptions, TenantRecord, TenantRegistryOptions } from "./types";
import { resolveTemplateModuleType } from "./cli/templates";
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
  const moduleType = resolveTemplateModuleType({});
  const exportUp = moduleType === "esm" ? "export const up" : "exports.up";
  const exportDown = moduleType === "esm" ? "export const down" : "exports.down";

  const migration = `// ${REGISTRY_MARKER}
${exportUp} = ({ schema }) =>
  schema.create("${registry.table}", (t) => {
    t.string("${registry.idColumn}").primary();
    t.string("${registry.passwordColumn}").nullable();
    t.string("${registry.encryptedPasswordColumn}").nullable();
    t.timestamp("${registry.createdAtColumn}").nullable().useCurrent();
    t.timestamp("${registry.updatedAtColumn}").nullable().useCurrent();
  });

${exportDown} = ({ schema }) => schema.dropIfExists("${registry.table}");
`;

  fs.writeFileSync(filePath, migration);
  return { created: true, filePath };
};

export const ensureRegistryTable = async (
  base: Connection,
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
  base: Connection,
  options: MultiTenantOptions
): Promise<TenantRecord[]> => {
  const registry = resolveRegistry(options);
  await ensureRegistryTable(base, options);
  const rows = await base
    .table(registry.table)
    .select(
      `${registry.idColumn} as id`,
      `${registry.passwordColumn} as password`,
      `${registry.encryptedPasswordColumn} as encryptedPassword`
    )
    .get();
  return rows as TenantRecord[];
};

export const upsertTenantInRegistry = async (
  base: Connection,
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

  await base.table(registry.table).upsert(record, registry.idColumn);
};

export const removeTenantFromRegistry = async (
  base: Connection,
  options: MultiTenantOptions,
  tenantId: string
) => {
  const registry = resolveRegistry(options);
  await ensureRegistryTable(base, options);
  await base.table(registry.table).where(registry.idColumn, tenantId).delete();
};
