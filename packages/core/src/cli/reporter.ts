import { createTaskTree } from "./taskTree";

export type RunKind = "migrate" | "rollback" | "seed";

export type StepEvents = {
  plan(names: string[]): void;
  started(name: string): void;
  finished(name: string): void;
  failed(name: string, error: unknown): void;
  /** Finished steps the database undid again when a later step failed. */
  undone(names: string[]): void;
};

/** How a command shows its work: a live task tree in a terminal, plain lines everywhere else. */
export type Reporter = {
  expectTenants(count: number): void;
  /** Runs one database. `steps` is only passed when something will show them. */
  target(
    label: string,
    kind: RunKind,
    work: (steps?: StepEvents) => Promise<string[]>,
    summary: (files: string[]) => string
  ): Promise<void>;
  task<T>(label: string, work: () => Promise<T>): Promise<T>;
  line(text: string): void;
  /** A failure the command reports itself, which sets the exit code. */
  problem(text: string): void;
  finish(): void;
  fail(error: unknown): void;
};

const plainReporter: Reporter = {
  expectTenants() {},
  target: async (_label, _kind, work, summary) => {
    console.log(summary(await work()));
  },
  task: (_label, work) => work(),
  line: (text) => console.log(text),
  problem: (text) => {
    console.error(text);
    process.exitCode = 1;
  },
  finish() {},
  fail: (error) => {
    throw error;
  },
};

// Scripts and CI read this output, so the task tree only appears when a person is watching both streams.
const isLiveTerminal = (): boolean =>
  Boolean(process.stdout.isTTY && process.stderr.isTTY) && !process.env.CI && process.env.TERM !== "dumb";

export const createReporter = (command: string): Reporter =>
  isLiveTerminal() ? createTaskTree(command) : plainReporter;
