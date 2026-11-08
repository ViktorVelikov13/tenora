import type { Client, Connection, Dialect, Migrator, PoolOptions, Seeder } from "@tenora/orm";

export type TenoraClient = Client;

export type BaseConnectionConfig = {
  /** the driver: "pg", "mysql2", "mariadb", "better-sqlite3" or "mssql". Defaults to "pg". */
  client?: TenoraClient;
  /** the SQL dialect, when the driver's default is not right, e.g. "mariadb" for a MariaDB server reached through mysql2 */
  dialect?: Dialect;
  /** Full driver connection config override. */
  connection?: Record<string, unknown>;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  /** admin database name (defaults to "postgres" for pg and "mysql" for mysql) */
  adminDatabase?: string;
  // Optional SSL/TLS configuration forwarded to the underlying driver (pg/mysql/etc.)
  ssl?: boolean | Record<string, unknown>;
  pool?: PoolOptions;
  migrationsDir?: string;
  seedsDir?: string;
};

export type TenantConfig = {
  /** prefix used when creating per-tenant users, defaults to `user_` */
  userPrefix?: string;
  /** directory with tenant migrations */
  migrationsDir?: string;
  /** directory with tenant seeds */
  seedsDir?: string;
  /** SQLite tenant DB directory (default: base DB dir or cwd) */
  databaseDir?: string;
  /** SQLite tenant DB filename suffix (default: ".sqlite") */
  databaseSuffix?: string;
  /** Optional tenant database name/filename resolver */
  databaseName?: (tenantId: string) => string;
  /**
   * Schema dump that new tenant databases load before their migrations run, written by
   * `tenora schema:dump:tenants`. Defaults to `schema/tenant-<dialect>.sql` next to the migrations
   * directory; `false` turns loading it off.
   */
  schemaFile?: string | false;
  /** custom pool settings for tenant connections */
  pool?: PoolOptions;
  /** override ssl option for tenant connections */
  ssl?: boolean | Record<string, unknown>;
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
  migrations?: {
    /** the table that records which migrations ran, in every database (default: tenora_migrations) */
    table?: string;
  };
  /**
   * @deprecated The 0.x Knex settings. Only `pool`, `migrations.directory` and `seeds.directory` still apply; anything
   * else is ignored with a warning.
   */
  knexOptions?: Record<string, unknown>;
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
  getBase(): Connection;
  getTenant(tenantId: string, password?: string): Connection;
  /** the migrator for the base database; needs `base.migrationsDir` */
  baseMigrator(): Migrator;
  /** the migrator for one tenant's database; needs `tenant.migrationsDir` */
  tenantMigrator(tenantId: string, password?: string): Migrator;
  /** the seeder for the base database; needs `base.seedsDir` */
  baseSeeder(): Seeder;
  /** the seeder for one tenant's database; needs `tenant.seedsDir` */
  tenantSeeder(tenantId: string, password?: string): Seeder;
  createTenantDb(tenantId: string, password?: string): Promise<void>;
  /** permanently deletes the tenant database, its user and its registry entry */
  dropTenantDb(tenantId: string, options?: DropTenantOptions): Promise<void>;
  /** writes the structure every tenant migration produces to `tenant.schemaFile` */
  dumpTenantSchema(options?: SchemaDumpOptions): Promise<SchemaDumpResult>;
  /** closes the cached connection pool; the database itself is untouched */
  destroyTenant(tenantId: string): Promise<void>;
  destroyAll(): Promise<void>;
}

export type DropTenantOptions = {
  /** also drop a tenant that is missing from the registry, such as a half-created one */
  allowUnregistered?: boolean;
};

export type SchemaDumpOptions = {
  /** delete the migration files the dump now contains */
  prune?: boolean;
};

export type SchemaDumpResult = {
  /** path of the dump file */
  file: string;
  /** names of the migrations the dump contains, oldest first */
  migrations: string[];
  /** paths of the migration files deleted by `prune` */
  pruned: string[];
};

export type SchemaDumpStatus = {
  /** path of the dump file */
  file: string;
  exists: boolean;
  /** migrations with a file on disk that the dump does not contain */
  missing: string[];
};

export type TenantResolverOptions<Req extends { [k: string]: any } = any> = {
  manager: TenantManager;
  tenantId: TenantIdResolver<Req>;
  passwordProvider?: TenantPasswordProvider;
  authorizer?: TenantAuthorizer<Req>;
  attach?: (req: Req, tenantId: string, db: Connection) => void;
};

export type TenantResolver<Req> = (req: Req) => Promise<{ tenantId?: string; db?: Connection }>;

export type TenantRecord = {
  id: string;
  password?: string;
  encryptedPassword?: string;
};

export type CliConfig = MultiTenantOptions;
