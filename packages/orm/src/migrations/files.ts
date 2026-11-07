import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** A migration or seed file on disk. `name` is the file name without its extension, as the bookkeeping stores it. */
export type SourceFile = {
  readonly name: string;
  /** absolute path */
  readonly file: string;
};

// Node 24 strips TypeScript types itself, so .ts files load without a build step.
const EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);
// Declaration files sit next to compiled migrations; they are not migrations.
const DECLARATION = /\.d\.[mc]?ts$/;

/** The directories to read, from `directory` or `directories`, resolved against the working directory as Knex does. */
export const resolveDirectories = (
  options: { directory?: string; directories?: readonly string[] },
  caller: string
): string[] => {
  const { directory, directories } = options;
  if (directory !== undefined && directories !== undefined) {
    throw new Error(`Tenora: ${caller}() takes directory or directories, not both.`);
  }
  const list = directories ?? (directory !== undefined ? [directory] : []);
  if (!list.length || list.some((entry) => typeof entry !== "string" || !entry)) {
    throw new Error(`Tenora: ${caller}() needs a directory (or directories) to read its files from.`);
  }
  return list.map((entry) => path.resolve(entry));
};

/**
 * Every migration or seed file in the directories, sorted by file name across all of them, extension included, with
 * the same code-unit comparison Knex uses (lodash's sortBy). Directory order breaks ties.
 */
export const listFiles = async (directories: readonly string[], kind: "migration" | "seed"): Promise<SourceFile[]> => {
  const found: Array<SourceFile & { base: string }> = [];
  for (const directory of directories) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        throw new Error(`Tenora: the ${kind} directory ${directory} does not exist.`, { cause: error });
      }
      throw error;
    }
    for (const entry of entries) {
      const base = entry.name;
      const extension = path.extname(base);
      // Dotfiles include editor lock files such as Emacs's .#name.js.
      if (base.startsWith(".") || !EXTENSIONS.has(extension) || DECLARATION.test(base)) continue;
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      found.push({ name: base.slice(0, -extension.length), file: path.join(directory, base), base });
    }
  }
  // Array#sort is stable, so equal names keep the order of their directories.
  found.sort((a, b) => (a.base < b.base ? -1 : a.base > b.base ? 1 : 0));
  return found.map(({ name, file }) => ({ name, file }));
};

/** Imports a file, ESM or CommonJS, and reports which one failed. */
export const importFile = async (file: string, kind: "migration" | "seed"): Promise<Record<string, unknown>> => {
  try {
    return (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Tenora: could not load the ${kind} ${file}: ${(error as Error)?.message ?? error}`, {
      cause: error,
    });
  }
};
