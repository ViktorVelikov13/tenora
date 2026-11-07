import { createRequire } from "node:module";
import path from "node:path";

const packageRequire = createRequire(import.meta.url);

/**
 * Loads a database driver from the project first, then from next to Tenora, so a globally installed CLI uses the
 * driver the project installed (as 0.x does for Knex).
 */
export const requireDriver = <T>(name: string, install = name.split("/")[0]): T => {
  let projectRequire: NodeJS.Require | undefined;
  try {
    projectRequire = createRequire(path.join(process.cwd(), "package.json"));
  } catch {
    projectRequire = undefined;
  }
  for (const load of [projectRequire, packageRequire]) {
    if (!load) continue;
    try {
      return load(name) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
    }
  }
  throw new Error(`Tenora: the "${install}" driver is not installed. Run: npm install ${install}`);
};
