import type { PoolOptions } from "@tenora/orm";
import type { MultiTenantOptions } from "../types";

type Directories = { directory?: string | readonly string[] } & Record<string, unknown>;

export type KnexOptions = {
  pool?: PoolOptions;
  migrationDirectories?: string[];
  seedDirectories?: string[];
};

const toList = (directory: Directories["directory"]) =>
  directory === undefined ? undefined : Array.isArray(directory) ? [...directory] : [directory as string];

let warned = false;

/**
 * What a 0.x config's `knexOptions` still means: Knex spread it over the base and tenant settings, so these three win
 * over them. `useNullAsDefault` only ever told Knex what SQLite needs, so it does not count as ignored.
 */
export const readKnexOptions = ({ knexOptions = {} }: MultiTenantOptions): KnexOptions => {
  const { pool, migrations, seeds, useNullAsDefault: _, ...rest } = knexOptions as {
    pool?: PoolOptions;
    migrations?: Directories;
    seeds?: Directories;
  } & Record<string, unknown>;
  const { directory: migrationDirectory, ...otherMigrationKeys } = migrations ?? {};
  const { directory: seedDirectory, ...otherSeedKeys } = seeds ?? {};
  const ignored = [
    ...Object.keys(rest),
    ...Object.keys(otherMigrationKeys).map((key) => `migrations.${key}`),
    ...Object.keys(otherSeedKeys).map((key) => `seeds.${key}`),
  ];
  if (ignored.length && !warned) {
    warned = true;
    console.warn(`Tenora: knexOptions is a 0.x setting, and Tenora no longer uses Knex. Ignoring ${ignored.join(", ")}.`);
  }
  return { pool, migrationDirectories: toList(migrationDirectory), seedDirectories: toList(seedDirectory) };
};
