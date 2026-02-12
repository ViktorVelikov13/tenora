import path from "path";
import type { MultiTenantOptions } from "../types";
import {
  loadConfigModuleAsync,
  loadConfigModuleSync,
  resolveConfigPath,
  unwrapConfig,
} from "../configLoader";

export const loadDefaultConfig = (): MultiTenantOptions => {
  const explicit = process.env.TENORA_CONFIG;
  const fullPath = resolveConfigPath(explicit ?? undefined);
  const module = loadConfigModuleSync(fullPath);
  const cfg = unwrapConfig(module);
  if (!cfg) {
    throw new Error(
      `Tenora: config file ${path.basename(fullPath)} did not export a config object.`
    );
  }
  return cfg as MultiTenantOptions;
};

export const loadDefaultConfigAsync = async (): Promise<MultiTenantOptions> => {
  const explicit = process.env.TENORA_CONFIG;
  const fullPath = resolveConfigPath(explicit ?? undefined);
  const module = await loadConfigModuleAsync(fullPath);
  const cfg = unwrapConfig(module);
  if (!cfg) {
    throw new Error(
      `Tenora: config file ${path.basename(fullPath)} did not export a config object.`
    );
  }
  return cfg as MultiTenantOptions;
};
