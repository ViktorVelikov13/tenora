import type { Knex } from "knex";
import path from "path";
import type { StepEvents } from "./reporter";

/** `oneByOne` gives every migration a batch of its own, so a rollback undoes them one at a time. */
export type MigrationRun = "latest" | "oneByOne" | "rollback";
type Direction = "up" | "down";
type MigrationSource = Knex.MigrationSource<unknown>;
type SeedSource = Knex.SeedSource<unknown>;

// Knex has no progress events, so steps are reported by wrapping the functions it calls. Batches
// and transactions stay entirely its own.
const reportedRun =
  <Args extends unknown[]>(name: string, steps: StepEvents, run: (...args: Args) => unknown) =>
  (...args: Args): unknown => {
    steps.started(name);
    let result: unknown;
    try {
      result = run(...args);
    } catch (error) {
      steps.failed(name, error);
      throw error;
    }
    // Handed back as it is, so knex still warns about a migration that forgot to return its promise.
    if (typeof (result as PromiseLike<unknown> | undefined)?.then !== "function") {
      steps.finished(name);
      return result;
    }
    return Promise.resolve(result).then(
      (value) => {
        steps.finished(name);
        return value;
      },
      (error) => {
        steps.failed(name, error);
        throw error;
      }
    );
  };

// Object.create, because a loaded file can be a module namespace, whose properties can't be overwritten.
const reportedMigrations = (source: MigrationSource, direction: Direction, steps: StepEvents): MigrationSource =>
  Object.create(source, {
    getMigration: {
      value: async (migration: unknown) => {
        const loaded = await source.getMigration(migration);
        if (typeof loaded[direction] !== "function") return loaded;
        const name = source.getMigrationName(migration);
        const run = loaded[direction].bind(loaded);
        return Object.create(loaded, { [direction]: { value: reportedRun(name, steps, run) } });
      },
    },
  });

// Knex logs a failed migration itself, and the reporter already shows it.
const withoutFailureLog = async <T>(db: Knex, run: () => Promise<T>): Promise<T> => {
  const { logger } = db.client as { logger: { warn(message: unknown): void } };
  const warn = logger.warn;
  logger.warn = (message) => {
    if (!/^migration (file .* failed|failed with error)/.test(String(message))) warn.call(logger, message);
  };
  try {
    return await run();
  } finally {
    logger.warn = warn;
  }
};

export const runMigrations = async (db: Knex, mode: MigrationRun, steps?: StepEvents): Promise<string[]> => {
  const migrator = db.migrate;
  const run = async (config?: Knex.MigratorConfig): Promise<string[]> => {
    if (mode === "latest") return (await migrator.latest(config))[1];
    if (mode === "rollback") return (await migrator.rollback(config))[1];
    const files: string[] = [];
    for (;;) {
      const [, applied] = await migrator.up(config);
      if (!applied.length) return files;
      files.push(...applied);
    }
  };
  if (!steps) return run();

  const direction: Direction = mode === "rollback" ? "down" : "up";
  const { migrationSource: source } = (migrator as unknown as { config: { migrationSource: MigrationSource } }).config;
  if (direction === "up") {
    const [, pending] = await migrator.list();
    steps.plan(pending.map((migration: unknown) => source.getMigrationName(migration)));
  }

  const finished: string[] = [];
  const recording: StepEvents = {
    ...steps,
    finished: (name) => {
      finished.push(name);
      steps.finished(name);
    },
  };
  try {
    return await withoutFailureLog(db, () =>
      run({ migrationSource: reportedMigrations(source, direction, recording) })
    );
  } catch (error) {
    if (direction === "up") {
      // A batch normally shares one transaction, but MySQL can't undo table changes. Only the table knows.
      const [completed] = await db.migrate.list().catch(() => [undefined]);
      if (completed) {
        const kept = new Set((completed as { name: string }[]).map((row) => row.name));
        steps.undone(finished.filter((name) => !kept.has(name)));
      }
    }
    throw error;
  }
};

const seedName = (seed: unknown): string => path.basename(String(seed));

const reportedSeeds = (source: SeedSource, steps: StepEvents): SeedSource =>
  Object.create(source, {
    getSeeds: {
      value: async (config: Knex.SeederConfig) => {
        const seeds = await source.getSeeds(config);
        steps.plan(seeds.map(seedName));
        return seeds;
      },
    },
    getSeed: {
      value: async (seed: unknown) => {
        const loaded = await source.getSeed(seed);
        if (typeof loaded.seed !== "function") return loaded;
        const run = reportedRun(seedName(seed), steps, loaded.seed.bind(loaded));
        return Object.create(loaded, { seed: { value: run } });
      },
    },
  });

export const runSeeds = async (db: Knex, steps?: StepEvents): Promise<string[]> => {
  const seeder = db.seed;
  const { seedSource: source } = (seeder as unknown as { config: { seedSource: SeedSource } }).config;
  const result = await seeder.run(steps ? { seedSource: reportedSeeds(source, steps) } : undefined);
  return Array.isArray(result) ? result[0] : [];
};
