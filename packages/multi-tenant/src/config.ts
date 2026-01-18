import type { MultiTenantOptions } from "./types";

/**
 * Helper to get full config type hints in JS/TS config files.
 */
export const defineTenoraConfig = <T extends MultiTenantOptions>(config: T): T => config;

// Backwards-friendly alias
export const createTenoraConfig = defineTenoraConfig;
