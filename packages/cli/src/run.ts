import { runTenoraCli } from "@tenora/core";

export const runCli = (): void => {
  runTenoraCli(process.argv);
};
