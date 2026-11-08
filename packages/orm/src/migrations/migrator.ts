import { type Connection, withoutTransaction } from "../connection";
import { sql } from "../sql";
import { type ContextFactory, contextFor, type Migration, toMigration } from "./definitions";
import { MigrationError, MigrationLockError } from "./errors";
import { importFile, listFiles, resolveDirectories, type SourceFile } from "./files";
import { ensureTables, type MigrationRow, transactionalDdl } from "./tables";

export type MigratorOptions = {
  /** the directory of migration files, relative to the working directory */
  directory?: string;
  /** several directories, run as one list sorted by file name */
  directories?: readonly string[];
  /** the bookkeeping table (default "tenora_migrations"); its lock table gets the same name with "_lock" */
  table?: string;
  /** adds to what `up` and `down` receive besides `db`; called once for each migration, inside its transaction */
  context?: ContextFactory;
  /**
   * Migrations whose files are gone because a schema dump contains them. A database that never ran one cannot catch
   * up, so `latest()` refuses instead of skipping it.
   */
  pruned?: { readonly migrations: readonly string[]; readonly into: string };
};

export type LatestResult = {
  /** the batch the migrations were recorded in; when nothing was pending, the last batch (0 if none ran yet) */
  batch: number;
  /** the names of the migrations that ran, in order */
  migrations: string[];
};

export type RollbackOptions = {
  /** roll back this many migrations, the most recent first, across batches */
  step?: number;
  /** roll back every migration */
  all?: boolean;
};

export type RollbackResult = {
  /** the batches the rolled back migrations belonged to, newest first */
  batches: number[];
  /** the names of the migrations rolled back, in the order they were rolled back */
  migrations: string[];
};

export type RanMigration = {
  name: string;
  batch: number;
  migratedAt: Date;
  /** who recorded it: "tenora", or "knex" for history copied by `tenora upgrade` */
  source: string;
  /** its file, or undefined when no directory has it any more (for example, pruned into a schema dump) */
  file: string | undefined;
};

export type MigrationStatus = {
  /** every recorded migration, in the order they ran */
  ran: RanMigration[];
  /** files not run yet, in the order `latest()` would run them */
  pending: SourceFile[];
};

type Loaded = SourceFile & { migration: Migration<any> };

// SQLite stores dates as milliseconds since the epoch; the other drivers return Date objects.
const toDate = (value: unknown): Date =>
  value instanceof Date
    ? value
    : new Date(typeof value === "string" && /^\d+$/.test(value) ? Number(value) : (value as number | string));

const brokenForeignKeys = async (db: Connection) =>
  Number((await db.raw<{ n: number }>(sql`select count(*) as n from pragma_foreign_key_check`))[0].n);

/**
 * A migration's transaction on SQLite. Foreign keys go off before it starts, because SQLite ignores that switch inside
 * a transaction, and a change that rebuilds a table others reference needs them off: dropping the old table would
 * otherwise delete through ON DELETE CASCADE. Django does the same.
 *
 * So nothing cascades and nothing is checked while the migration runs, and the database is checked before it commits.
 * Rows that were already broken do not count: 0.x's sqlite3 driver never enforced foreign keys.
 */
const sqliteTransaction = async (db: Connection, step: () => Promise<void>): Promise<void> => {
  const [{ foreign_keys: enforced }] = await db.raw<{ foreign_keys: number }>(sql`pragma foreign_keys`);
  if (!enforced) return db.transaction(step);
  return db.schema.withoutForeignKeyConstraints(() =>
    db.transaction(async () => {
      const before = await brokenForeignKeys(db);
      await step();
      const added = (await brokenForeignKeys(db)) - before;
      if (added > 0) {
        throw new Error(
          `Tenora: this migration left ${added} row(s) pointing at rows that do not exist. On SQLite, foreign keys are off while a migration runs, so ON DELETE CASCADE does not fire: delete those rows in the migration.`
        );
      }
    })
  );
};

/**
 * Runs migration files against one database and records them in its bookkeeping table. Every method runs outside
 * any transaction open around the call: the lock and each migration's transaction are the migrator's own.
 */
export class Migrator {
  readonly table: string;
  readonly lockTable: string;
  readonly directories: readonly string[];
  readonly #context: ContextFactory | undefined;
  readonly #pruned: MigratorOptions["pruned"];
  #ready: Promise<void> | undefined;

  constructor(
    readonly db: Connection,
    options: MigratorOptions
  ) {
    this.directories = resolveDirectories(options, "createMigrator");
    const table = options.table ?? "tenora_migrations";
    if (typeof table !== "string" || !table) throw new Error("Tenora: the migrations table needs a name.");
    this.table = table;
    this.lockTable = `${table}_lock`;
    this.#context = options.context;
    this.#pruned = options.pruned;
  }

  /** Runs every pending migration, in one new batch. */
  latest(): Promise<LatestResult> {
    return withoutTransaction(() =>
      this.#locked(async () => {
        const [files, rows] = await Promise.all([this.#files(), this.#rows()]);
        const ran = new Set(rows.map((row) => row.name));
        const last = rows.reduce((max, row) => Math.max(max, row.batch), 0);
        const onDisk = new Set(files.map((file) => file.name));
        const lost = this.#pruned?.migrations.find((name) => !ran.has(name) && !onDisk.has(name));
        if (lost) {
          throw new Error(
            `Tenora: this database never ran migration "${lost}", and its file was pruned into the schema dump ${this.#pruned!.into}. Restore the file from version control, run the migrations, then prune again.`
          );
        }
        const pending = files.filter((file) => !ran.has(file.name));
        if (!pending.length) return { batch: last, migrations: [] };

        // Every file loads before the first one runs, so a broken file stops the run before it changes anything.
        const loaded = await this.#load(pending);
        const batch = last + 1;
        const migrations: string[] = [];
        for (const entry of loaded) {
          await this.#run(entry, "up", () =>
            this.db.table(this.table).insert({ name: entry.name, batch, migrated_at: new Date(), source: "tenora" })
          );
          migrations.push(entry.name);
        }
        return { batch, migrations };
      })
    );
  }

  /**
   * Rolls back the last batch, the most recent migration first. `step` rolls back that many migrations instead,
   * across batches, and `all` rolls back every one. Nothing runs unless every migration to roll back still has its
   * file and a `down`.
   */
  async rollback(options: RollbackOptions = {}): Promise<RollbackResult> {
    const { step, all = false } = options;
    if (step !== undefined && (!Number.isInteger(step) || step < 1)) {
      throw new Error("Tenora: rollback() needs step to be a whole number above 0.");
    }
    if (step !== undefined && all) throw new Error("Tenora: rollback() takes step or all, not both.");
    return withoutTransaction(() =>
      this.#locked(async () => {
        const [files, rows] = await Promise.all([this.#files(), this.#rows()]);
        const newest = [...rows].reverse();
        const last = newest[0]?.batch;
        const chosen = all
          ? newest
          : step !== undefined
            ? newest.slice(0, step)
            : newest.filter((row) => row.batch === last);
        if (!chosen.length) return { batches: [], migrations: [] };

        const byName = new Map(files.map((file) => [file.name, file]));
        const missing = chosen.filter((row) => !byName.has(row.name)).map((row) => row.name);
        if (missing.length) {
          throw new Error(
            `Tenora: cannot roll back ${missing.join(", ")}: no file with that name in ${this.directories.join(", ")}. A migration pruned into a schema dump cannot be rolled back.`
          );
        }
        const loaded = await this.#load(chosen.map((row) => byName.get(row.name)!));
        const irreversible = loaded.filter((entry) => !entry.migration.down);
        if (irreversible.length) {
          throw new Error(
            `Tenora: cannot roll back ${irreversible.map((entry) => entry.file).join(", ")}: no down function. Add one (it may do nothing) to allow it.`
          );
        }

        const batches: number[] = [];
        const migrations: string[] = [];
        for (const [index, entry] of loaded.entries()) {
          const row = chosen[index];
          await this.#run(entry, "down", () => this.db.table(this.table).where("id", row.id).delete());
          if (!batches.includes(row.batch)) batches.push(row.batch);
          migrations.push(entry.name);
        }
        return { batches, migrations };
      })
    );
  }

  /** The migrations that ran and the ones still pending. Does not take the lock. */
  status(): Promise<MigrationStatus> {
    return withoutTransaction(async () => {
      await this.#ensureTables();
      const [files, rows] = await Promise.all([this.#files(), this.#rows()]);
      const byName = new Map(files.map((file) => [file.name, file]));
      const ran = new Set(rows.map((row) => row.name));
      return {
        ran: rows.map((row) => ({
          name: row.name,
          batch: row.batch,
          migratedAt: toDate(row.migrated_at),
          source: row.source,
          file: byName.get(row.name)?.file,
        })),
        pending: files.filter((file) => !ran.has(file.name)),
      };
    });
  }

  /**
   * Releases the lock, for when a run was killed before it could. Only call it when no migrator is running. Returns
   * whether the lock was held.
   */
  forceUnlock(): Promise<boolean> {
    return withoutTransaction(async () => {
      await this.#ensureTables();
      return (await this.db.table(this.lockTable).where("is_locked", 1).update({ is_locked: 0 })) > 0;
    });
  }

  #ensureTables(): Promise<void> {
    this.#ready ??= ensureTables(this.db, this.table, this.lockTable).catch((error) => {
      this.#ready = undefined;
      throw error;
    });
    return this.#ready;
  }

  /** Takes the lock row in a short transaction of its own, which commits before any migration runs. */
  async #locked<T>(work: () => Promise<T>): Promise<T> {
    await this.#ensureTables();
    await this.db.transaction(async () => {
      const taken = await this.db.table(this.lockTable).where("is_locked", 0).update({ is_locked: 1 });
      if (taken === 0) throw new MigrationLockError(this.lockTable);
    });
    const unlock = () => this.db.table(this.lockTable).update({ is_locked: 0 });
    let result: T;
    try {
      result = await work();
    } catch (error) {
      // The run's own error matters more; a lock left behind is reported by the next run.
      await unlock().catch(() => undefined);
      throw error;
    }
    await unlock();
    return result;
  }

  async #files(): Promise<SourceFile[]> {
    const files = await listFiles(this.directories, "migration");
    const seen = new Map<string, string>();
    for (const { name, file } of files) {
      const other = seen.get(name);
      if (other) {
        throw new Error(
          `Tenora: ${other} and ${file} are both migration "${name}". Names are recorded without their extension, so they must be unique.`
        );
      }
      seen.set(name, file);
    }
    return files;
  }

  async #rows(): Promise<MigrationRow[]> {
    return this.db.table<MigrationRow>(this.table).orderBy("id").get();
  }

  async #load(files: readonly SourceFile[]): Promise<Loaded[]> {
    const loaded: Loaded[] = [];
    for (const source of files) {
      loaded.push({ ...source, migration: toMigration(await importFile(source.file, "migration"), source.file) });
    }
    return loaded;
  }

  /**
   * Runs one direction of a migration and records it. In a transaction where DDL is transactional, so a failure
   * undoes its changes and its record together; MySQL and MariaDB commit DDL as they run it, so there it runs as is.
   */
  async #run(entry: Loaded, direction: "up" | "down", record: () => Promise<unknown>): Promise<void> {
    const { db } = this;
    const inTransaction = entry.migration.transaction !== false && transactionalDdl(db.dialect);
    const step = async () => {
      const context = { ...contextFor(db, entry.migration.compat), ...(await this.#context?.(db)) };
      await entry.migration[direction]!(context);
      await record();
    };
    try {
      if (!inTransaction) await step();
      else if (db.dialect === "sqlite") await sqliteTransaction(db, step);
      else await db.transaction(step);
    } catch (error) {
      const note = inTransaction
        ? ""
        : entry.migration.transaction === false
          ? "It ran without a transaction (transaction: false), so what it changed before failing was not undone."
          : `${db.dialect === "mysql" ? "MySQL" : "MariaDB"} commits schema changes as it runs them, so what it changed before failing was not undone.`;
      throw new MigrationError(entry.name, entry.file, direction, inTransaction, note, error);
    }
  }
}

/** A migrator for one database: `createMigrator(db, { directory: "migrations" })`. */
export const createMigrator = (db: Connection, options: MigratorOptions): Migrator => new Migrator(db, options);
