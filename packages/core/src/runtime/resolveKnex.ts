import path from "path";
import { createRequire } from "module";
import type knexImport from "knex";

type KnexModule = typeof knexImport;

const packageRequire = createRequire(import.meta.url);
const projectNodeModules = path.join(process.cwd(), "node_modules");

type NodeModuleRuntime = {
  Module?: {
    _initPaths?: () => void;
  };
  _initPaths?: () => void;
};

const ensureProjectNodeModulesOnNodePath = () => {
  const entries = (process.env.NODE_PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean);

  if (entries.includes(projectNodeModules)) {
    return;
  }

  process.env.NODE_PATH = [projectNodeModules, ...entries].join(path.delimiter);
  const moduleRuntime = packageRequire("module") as NodeModuleRuntime;
  const initPaths = moduleRuntime.Module?._initPaths ?? moduleRuntime._initPaths;
  initPaths?.();
};

const resolveProjectRequire = () => {
  try {
    return createRequire(path.join(process.cwd(), "package.json"));
  } catch {
    return packageRequire;
  }
};

const normalizeKnexModule = (value: unknown): KnexModule => {
  const moduleValue = value as { default?: KnexModule };
  return moduleValue.default ?? (value as KnexModule);
};

export const resolveKnex = (): KnexModule => {
  ensureProjectNodeModulesOnNodePath();
  const projectRequire = resolveProjectRequire();

  try {
    return normalizeKnexModule(projectRequire("knex"));
  } catch {
    return normalizeKnexModule(packageRequire("knex"));
  }
};
