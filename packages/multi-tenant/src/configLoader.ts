import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

export const DEFAULT_CONFIG_FILES = [
  "tenora.config.js",
  "tenora.config.mjs",
  "tenora.config.ts",
];

export const resolveConfigPath = (explicitPath?: string): string => {
  const cwd = process.cwd();
  if (explicitPath) {
    return path.isAbsolute(explicitPath)
      ? explicitPath
      : path.join(cwd, explicitPath);
  }

  for (const file of DEFAULT_CONFIG_FILES) {
    const full = path.join(cwd, file);
    if (fs.existsSync(full)) return full;
  }

  throw new Error(
    `Tenora: no config found. Looked for ${DEFAULT_CONFIG_FILES.join(", ")} in ${cwd}.`
  );
};

export const loadConfigModuleSync = (fullPath: string) => {
  const ext = path.extname(fullPath);
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(fullPath);
    return mod;
  } catch (err: any) {
    if (ext === ".mjs" || err?.code === "ERR_REQUIRE_ESM") {
      throw new Error(
        `Tenora: ${path.basename(fullPath)} is ESM. Use createTenoraFactoryAsync() or pass the config directly.`
      );
    }
    if (ext === ".ts" || err?.code === "ERR_UNKNOWN_FILE_EXTENSION") {
      throw new Error(
        `Tenora: ${path.basename(fullPath)} is TypeScript. Use createTenoraFactoryAsync() with a TS loader (tsx/ts-node), or pass the config directly.`
      );
    }
    throw err;
  }
};

export const loadConfigModuleAsync = async (fullPath: string) => {
  const href = pathToFileURL(fullPath).href;
  return import(href);
};

export const unwrapConfig = (mod: any) => mod.default ?? mod.config ?? mod;
