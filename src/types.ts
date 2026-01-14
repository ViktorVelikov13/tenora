import { Knex } from "knex";

export type BaseConnectionConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl?: Knex.StaticConnectionConfig['ssl'];
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
  /** custom pool settings for tenant connections */
  pool?: Knex.PoolConfig;
  /** override ssl option for tenant connections */
  ssl?: Knex.StaticConnectionConfig['ssl'];
};

export type MultiTenantOptions = {
  base: BaseConnectionConfig;
  tenant?: TenantConfig;
  knexOptions?: Omit<Knex.Config, "client" | "connection">;
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

export type CliConfig = MultiTenantOptions & {
  listTenants: () => Promise<TenantRecord[]> | TenantRecord[];
  decryptPassword?: (encrypted: string) => string;
};
