import type { Connection } from "../connection";
import type { SchemaBuilder } from "../schema/builder";
import type { KnexSchemaBuilder } from "../schema/knex/builder";

/**
 * What `up`, `down` and seeds receive. Queries on `db` and changes made with `schema` join the migration's transaction
 * on their own. `context` options add to it at runtime.
 */
export interface MigrationContext {
  db: Connection;
  /** the schema builder: `schema.create("orders", (t) => …)` */
  schema: SchemaBuilder;
}

/** What a migration converted from 0.x receives: `schema` is the Knex-compatible builder, `schema.createTable(…)`. */
export interface KnexMigrationContext {
  db: Connection;
  schema: KnexSchemaBuilder;
}

/** Builds what migrations and seeds receive besides `db`, once for each file. */
export type ContextFactory = (db: Connection) => object | Promise<object>;

export interface MigrationDefinition<C extends object = MigrationContext> {
  up(context: C): unknown;
  down?(context: C): unknown;
  /**
   * `false` runs the migration outside a transaction, for statements a database refuses inside one (Postgres's
   * `CREATE INDEX CONCURRENTLY`, SQL Server's full-text indexes). MySQL and MariaDB never get one: they commit DDL
   * as they run it.
   */
  transaction?: boolean;
  /** "knex" gives `schema` Knex's method names and DDL, for migrations converted from 0.x */
  compat?: "knex";
}

export type Migration<C extends object = MigrationContext> = Readonly<MigrationDefinition<C>>;

export type SeedFunction<C extends object = MigrationContext> = (context: C) => unknown;

export type SeedOptions = {
  /** `false` runs the seed outside a transaction; by default each seed runs in its own, on every database */
  transaction?: boolean;
};

export type Seed<C extends object = MigrationContext> = {
  readonly seed: SeedFunction<C>;
  readonly transaction?: boolean;
};

/**
 * A migration: `export default migration({ async up({ schema }) { … }, async down({ schema }) { … } })`. With
 * `compat: "knex"`, `schema` is the Knex-compatible builder.
 */
export function migration<C extends object = KnexMigrationContext>(
  definition: MigrationDefinition<C> & { compat: "knex" }
): Migration<C>;
export function migration<C extends object = MigrationContext>(definition: MigrationDefinition<C>): Migration<C>;
export function migration<C extends object>(definition: MigrationDefinition<C>): Migration<C> {
  if (typeof definition?.up !== "function") throw new Error("Tenora: migration() needs an up function.");
  if (definition.down !== undefined && typeof definition.down !== "function") {
    throw new Error("Tenora: a migration's down must be a function.");
  }
  if (definition.transaction !== undefined && typeof definition.transaction !== "boolean") {
    throw new Error("Tenora: a migration's transaction option must be true or false.");
  }
  if (definition.compat !== undefined && definition.compat !== "knex") {
    throw new Error('Tenora: a migration\'s compat option can only be "knex".');
  }
  return Object.freeze({
    up: definition.up,
    down: definition.down,
    transaction: definition.transaction,
    compat: definition.compat,
  });
}

/** What a migration or seed receives: the Knex-compatible schema builder for `compat: "knex"`. */
export const contextFor = (db: Connection, compat: "knex" | undefined) => ({
  db,
  schema: compat === "knex" ? db.schema.knex : db.schema,
});

/** A seed: `export default seed(async ({ db }) => { … })`. */
export const seed = <C extends object = MigrationContext>(run: SeedFunction<C>, options: SeedOptions = {}): Seed<C> => {
  if (typeof run !== "function") throw new Error("Tenora: seed() needs a function.");
  if (options.transaction !== undefined && typeof options.transaction !== "boolean") {
    throw new Error("Tenora: a seed's transaction option must be true or false.");
  }
  return Object.freeze({ seed: run, transaction: options.transaction });
};

type Exports = Record<string, unknown> | undefined;

/**
 * Where a module keeps its definition: `export default migration(…)` and CommonJS `module.exports` both arrive as
 * `default` (CommonJS named exports appear twice, there and at the top level); TypeScript compiled to CommonJS puts
 * it one level deeper; ESM named exports sit at the top level.
 */
const candidates = (module: Record<string, unknown>): Exports[] => {
  const fallback = module.default as Exports;
  return [fallback, fallback?.default as Exports, module];
};

/** Knex's `exports.config = { transaction: false }` works too. */
const transactionOption = (exports: Record<string, unknown>, file: string): boolean | undefined => {
  const value = exports.transaction ?? (exports.config as Exports)?.transaction;
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error(`Tenora: the transaction option in ${file} must be true or false.`);
  }
  return value;
};

/** The migration a loaded module exports, or a clear error when it exports none. */
export const toMigration = (module: Record<string, unknown>, file: string): Migration<any> => {
  const exports = candidates(module).find((candidate) => typeof candidate?.up === "function");
  if (!exports) {
    throw new Error(
      `Tenora: ${file} does not export a migration. Write export default migration({ up, down }) (module.exports = migration(…) in CommonJS), or export up and down functions.`
    );
  }
  if (exports.down !== undefined && typeof exports.down !== "function") {
    throw new Error(`Tenora: down in ${file} must be a function.`);
  }
  // Bound, so a module's functions can still reach each other through `this`, as they could under Knex.
  const { up, down } = exports as { up: Migration["up"]; down?: Migration["down"] };
  const compat = exports.compat;
  if (compat !== undefined && compat !== "knex") throw new Error(`Tenora: compat in ${file} can only be "knex".`);
  return { up: up.bind(exports), down: down?.bind(exports), transaction: transactionOption(exports, file), compat };
};

/** The seed a loaded module exports: `seed(fn)`, a `seed` function, or a default function. */
export const toSeed = (module: Record<string, unknown>, file: string): Seed<any> => {
  if (typeof module.default === "function") return { seed: module.default as SeedFunction };
  const exports = candidates(module).find((candidate) => typeof candidate?.seed === "function");
  if (!exports) {
    throw new Error(
      `Tenora: ${file} does not export a seed. Write export default seed(async ({ db }) => …) (module.exports = seed(…) in CommonJS), or export a seed function.`
    );
  }
  const run = exports.seed as SeedFunction;
  return { seed: run.bind(exports), transaction: transactionOption(exports, file) };
};
