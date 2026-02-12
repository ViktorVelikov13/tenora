import { Command } from "commander";
import { registerCliCommands } from "./commands";

export const createTenoraProgram = (): Command => {
  const program = new Command();
  registerCliCommands(program);
  return program;
};

export const runTenoraCli = (argv: string[] = process.argv): void => {
  const program = createTenoraProgram();
  program.parse(argv);
};
