import path from "node:path";
import { type Connection, withoutTransaction } from "../connection";
import { type ContextFactory, contextFor, toSeed } from "./definitions";
import { SeedError } from "./errors";
import { importFile, listFiles, resolveDirectories, type SourceFile } from "./files";

export type SeederOptions = {
  /** the directory of seed files, relative to the working directory */
  directory?: string;
  /** several directories, run as one list sorted by file name */
  directories?: readonly string[];
  /** adds to what seeds receive besides `db`; called once for each seed, inside its transaction */
  context?: ContextFactory;
};

export type SeedRunOptions = {
  /** run only these seeds, by name, with or without the extension */
  only?: string | readonly string[];
};

export type SeedRunResult = {
  /** the names of the seeds that ran, in order */
  seeds: string[];
};

/** Runs seed files against one database, in file name order. Seeds are not recorded; each run runs them again. */
export class Seeder {
  readonly directories: readonly string[];
  readonly #context: ContextFactory | undefined;

  constructor(
    readonly db: Connection,
    options: SeederOptions
  ) {
    this.directories = resolveDirectories(options, "createSeeder");
    this.#context = options.context;
  }

  /**
   * Runs every seed, or the ones in `only`, each in its own transaction (seeds change data, which every database
   * can roll back). A seed that throws stops the run; the ones before it stay committed.
   */
  run(options: SeedRunOptions = {}): Promise<SeedRunResult> {
    return withoutTransaction(async () => {
      const all = await listFiles(this.directories, "seed");
      const only = typeof options.only === "string" ? [options.only] : options.only;
      const named = (wanted: string, { name, file }: SourceFile) => name === wanted || path.basename(file) === wanted;
      const unknown = only?.filter((wanted) => !all.some((file) => named(wanted, file))) ?? [];
      if (unknown.length) {
        throw new Error(`Tenora: no seed named ${unknown.join(", ")} in ${this.directories.join(", ")}.`);
      }
      const files = only ? all.filter((file) => only.some((wanted) => named(wanted, file))) : all;

      // Every file loads before the first one runs, so a broken file stops the run before it changes anything.
      const loaded = [];
      for (const source of files) {
        loaded.push({ ...source, seed: toSeed(await importFile(source.file, "seed"), source.file) });
      }

      const { db } = this;
      const seeds: string[] = [];
      for (const entry of loaded) {
        const step = async () => {
          const context = { ...contextFor(db, undefined), ...(await this.#context?.(db)) };
          await entry.seed.seed(context);
        };
        try {
          if (entry.seed.transaction === false) await step();
          else await db.transaction(step);
        } catch (error) {
          throw new SeedError(entry.name, entry.file, error);
        }
        seeds.push(entry.name);
      }
      return { seeds };
    });
  }
}

/** A seeder for one database: `createSeeder(db, { directory: "seeds" })`. */
export const createSeeder = (db: Connection, options: SeederOptions): Seeder => new Seeder(db, options);
