import fs from "fs";
import path from "path";
import type { CliConfig, TenantRecord } from "../types";
import { loadConfigModuleAsync, resolveConfigPath, unwrapConfig } from "../configLoader";
import { ensureRegistryMigration, resolveDecrypt } from "../tenantRegistry";

export const ensureRegistryMigrationIfNeeded = (cfg: CliConfig): boolean => {
  const result = ensureRegistryMigration(cfg);
  if (result.created) {
    console.log(
      `Tenora: created tenant registry migration at ${result.filePath}. Review it (rename if desired), then run 'tenora migrate' again.`
    );
    return true;
  }
  return false;
};

export const loadCliConfig = async (configPath: string): Promise<CliConfig> => {
  const isDefault = configPath === "tenora.config.js";
  let fullPath = path.isAbsolute(configPath)
    ? configPath
    : path.join(process.cwd(), configPath);
  if (isDefault && !fs.existsSync(fullPath)) {
    fullPath = resolveConfigPath();
  }
  const module = await loadConfigModuleAsync(fullPath);
  const cfg = unwrapConfig(module);
  if (!cfg) {
    throw new Error(`No config exported from ${fullPath}`);
  }
  return cfg as CliConfig;
};

export const getTenantPassword = (
  tenant: TenantRecord,
  decryptPassword?: (encrypted: string) => string,
  cfg?: CliConfig
) => {
  if (tenant.password) return tenant.password;
  if (tenant.encryptedPassword) {
    const resolver = decryptPassword ?? (cfg ? resolveDecrypt(cfg) : undefined);
    if (resolver) return resolver(tenant.encryptedPassword);
  }
  return undefined;
};
