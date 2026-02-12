import type { MultiTenantOptions, TenantManager } from "./types";
import { buildTenoraFactory } from "./factory/build";
import { loadDefaultConfig, loadDefaultConfigAsync } from "./factory/config";

export { loadDefaultConfigAsync };

export const createTenoraFactory = (
  options?: MultiTenantOptions
): TenantManager => {
  const resolved = options ?? loadDefaultConfig();
  return buildTenoraFactory(resolved);
};

export const createTenoraFactoryAsync = async (
  options?: MultiTenantOptions
): Promise<TenantManager> => {
  const resolved = options ?? await loadDefaultConfigAsync();
  return buildTenoraFactory(resolved);
};

// Backwards-compatible alias
export const createKnexFactory = createTenoraFactory;
