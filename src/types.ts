import { Knex } from "knex";

export type BaseConnectionConfig = {
  /** Knex client/driver name (e.g., "pg", "mysql2"). Defaults to "pg". */
  client?: string;
  /** Full Knex connection config override. */
  connection?: Knex.ConnectionConfig;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  /** admin database name (defaults to "postgres" for pg and "mysql" for mysql) */
  adminDatabase?: string;
  // Optional SSL/TLS configuration forwarded to the underlying driver (pg/mysql/etc.)
  ssl?: Knex.PgConnectionConfig['ssl'] | Record<string, unknown>;
  pool?: Knex.PoolConfig;
  migrationsDir?: string;
  seedsDir?: string;
};

export type TenantConfig = {
  /** prefix used when creating per-tenant users, defaults to `user_` */
  userPrefix?: string;
  /** directory with tenant migrations (passed to Knex) */
  migrationsDir?: string;
  /** directory with tenant seeds (passed to Knex) */
  seedsDir?: string;
  /** SQLite tenant DB directory (default: base DB dir or cwd) */
  databaseDir?: string;
  /** SQLite tenant DB filename suffix (default: ".sqlite") */
  databaseSuffix?: string;
  /** Optional tenant database name/filename resolver */
  databaseName?: (tenantId: string) => string;
  /** custom pool settings for tenant connections */
  pool?: Knex.PoolConfig;
  /** override ssl option for tenant connections */
  ssl?: Knex.PgConnectionConfig['ssl'];
};

export type TenantRegistryOptions = {
  /** registry table name (default: tenora_tenants) */
  table?: string;
  /** primary key column for tenant id (default: id) */
  idColumn?: string;
  /** optional column for storing plaintext passwords (default: password) */
  passwordColumn?: string;
  /** optional column for storing encrypted passwords (default: encrypted_password) */
  encryptedPasswordColumn?: string;
  /** created timestamp column (default: created_at) */
  createdAtColumn?: string;
  /** updated timestamp column (default: updated_at) */
  updatedAtColumn?: string;
};

export type MultiTenantOptions = {
  base: BaseConnectionConfig;
  tenant?: TenantConfig;
  knexOptions?: Omit<Knex.Config, "client" | "connection">;
  registry?: TenantRegistryOptions;
  /** optional encrypt hook for storing tenant DB passwords */
  encryptPassword?: (plain: string) => string;
  /** optional decrypt hook for reading encrypted passwords */
  decryptPassword?: (encrypted: string) => string;
};

export type TenantPasswordProvider = (tenantId: string) => Promise<string | undefined> | string | undefined;
export type TenantAuthorizer<Req = any> = (tenantId: string, request: Req) => Promise<void> | void;
export type TenantIdResolver<Req = any> = (request: Req) => Promise<string | undefined> | string | undefined;

export interface TenantManager {
  getBase(): Knex;
  getTenant(tenantId: string, password?: string): Knex;
  createTenantDb(tenantId: string, password?: string): Promise<void>;
  destroyTenant(tenantId: string): Promise<void>;
  destroyAll(): Promise<void>;
}

export type TenantResolverOptions<Req extends { [k: string]: any } = any> = {
  manager: TenantManager;
  tenantId: TenantIdResolver<Req>;
  passwordProvider?: TenantPasswordProvider;
  authorizer?: TenantAuthorizer<Req>;
  attach?: (req: Req, tenantId: string, knex: Knex) => void;
};

export type TenantResolver<Req> = (req: Req) => Promise<{ tenantId?: string; knex?: Knex }>;

export type TenantRecord = {
  id: string;
  password?: string;
  encryptedPassword?: string;
};

export type CliConfig = MultiTenantOptions;
