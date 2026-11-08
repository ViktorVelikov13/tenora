import { format, styleText } from "util";
import type { Reporter, RunKind, StepEvents } from "./reporter";

type StepStatus = "pending" | "running" | "done" | "failed" | "undone" | "skipped";
type Step = { name: string; status: StepStatus; startedAt?: number; ms?: number; error?: string };
type Target = { label: string; kind: RunKind; startedAt: number; steps: Step[] };

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const TICK_MS = 80;
const BAR_WIDTH = 24;
const CONSOLE_METHODS = ["log", "info", "debug", "warn", "error"] as const;

const WORDS: Record<RunKind, { unit: string; done: string; none: string; noneCount: string; noneBase: string }> = {
  migrate: {
    unit: "migration",
    done: "migrated",
    none: "up to date",
    noneCount: "up to date",
    noneBase: "Base is up to date.",
  },
  rollback: {
    unit: "migration",
    done: "rolled back",
    none: "nothing to roll back",
    noneCount: "with nothing to roll back",
    noneBase: "Base has nothing to roll back.",
  },
  seed: {
    unit: "seed",
    done: "seeded",
    none: "no seeds",
    noneCount: "with no seeds",
    noneBase: "Base has no seeds to run.",
  },
};

const time = (ms: number): string => {
  if (ms < 1) return "<1ms";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
};
const count = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? "" : "s"}`;
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Finished lines are printed once and the frame under them is redrawn in place, so the terminal's
 * scrollback stays a clean record however long the run is.
 */
export const createTaskTree = (command: string): Reporter => {
  const out = process.stdout;
  const startedAt = Date.now();
  const useColor = out.hasColors();

  const paint = (style: Parameters<typeof styleText>[0], text: string): string =>
    useColor ? styleText(style, text, { validateStream: false }) : text;
  const dim = (text: string) => paint("dim", text);
  const bold = (text: string) => paint("bold", text);
  const tick = paint("green", "✔");
  const cross = paint("red", "✖");

  let drawnLines = 0;
  let frameNumber = 0;
  let timer: NodeJS.Timeout | undefined;
  let headerShown = false;
  let current: Target | undefined;
  let lastKind: RunKind = "migrate";
  let taskLabel: string | undefined;
  let taskStartedAt = 0;
  let expected: number | undefined;
  let changed = 0;
  let unchanged = 0;
  let closed = false;
  let reportedError: unknown;
  let stoppedOn: string | undefined;

  const spinner = () => paint("cyan", SPINNER[frameNumber % SPINNER.length]);
  const rows = () => out.rows || 24;

  const stepLine = (step: Step): string => {
    switch (step.status) {
      case "done":
        return `  ${tick} ${step.name}  ${dim(time(step.ms ?? 0))}`;
      case "running":
        return `  ${spinner()} ${bold(step.name)}  ${dim(time(Date.now() - (step.startedAt ?? Date.now())))}`;
      case "failed":
        return `  ${cross} ${paint("red", step.name)}`;
      case "undone":
        return `  ${paint("yellow", "↩")} ${step.name}  ${dim("rolled back")}`;
      case "skipped":
        return `  ${dim(`○ ${step.name}  not run`)}`;
      default:
        return `  ${dim(`○ ${step.name}`)}`;
    }
  };

  // A frame taller than the terminal cannot be redrawn, so long lists show the part around the running step.
  const visibleSteps = (steps: Step[], room: number): string[] => {
    if (steps.length <= room) return steps.map(stepLine);
    const shown = Math.max(room - 2, 1);
    const running = Math.max(steps.findIndex((step) => step.status === "running"), 0);
    const first = Math.min(Math.max(running - 1, 0), steps.length - shown);
    const rest = steps.length - first - shown;
    return [
      ...(first ? [dim(`  … ${first} finished`)] : []),
      ...steps.slice(first, first + shown).map(stepLine),
      ...(rest ? [dim(`  … ${rest} more`)] : []),
    ];
  };

  const bar = (done: number, total: number): string => {
    const filled = total ? Math.round((done / total) * BAR_WIDTH) : 0;
    return paint("green", "█".repeat(filled)) + dim("░".repeat(BAR_WIDTH - filled));
  };

  const frame = (): string[] => {
    if (closed) return [];
    const lines: string[] = [];
    if (taskLabel) lines.push(`${spinner()} ${taskLabel}  ${dim(time(Date.now() - taskStartedAt))}`);
    if (current) {
      const { label, steps } = current;
      const done = steps.filter((step) => step.status === "done").length;
      lines.push(`${spinner()} ${bold(label)}${steps.length ? `  ${dim(`${done}/${steps.length}`)}` : ""}`);
      lines.push(...visibleSteps(steps, rows() - 5));
    }
    if (expected) {
      const finished = changed + unchanged;
      lines.push("", `${bar(finished, expected)}  ${finished}/${expected} tenants  ${dim(time(Date.now() - startedAt))}`);
    }
    return lines;
  };

  const draw = (permanent: string[] = []) => {
    const lines = frame().slice(-Math.max(rows() - 1, 1));
    const erase = drawnLines ? `\x1b[${drawnLines}A\x1b[0J` : "";
    const above = permanent.map((line) => `${line}\n`).join("");
    // Wrapping is off for the frame: a wrapped line would throw off the count of lines to erase next time.
    const below = lines.length ? `\x1b[?7l${lines.map((line) => `${line}\n`).join("")}\x1b[?7h` : "";
    // Terminals that know mode 2026 paint the whole update at once, the others ignore it.
    out.write(`\x1b[?2026h${erase}${above}${below}\x1b[?2026l`);
    drawnLines = lines.length;
  };

  // Migrations can log too, and anything written mid-frame would be erased by the next redraw.
  const originalConsole = CONSOLE_METHODS.map((method) => [method, console[method]] as const);
  for (const method of CONSOLE_METHODS) {
    console[method] = (...args: unknown[]) => draw(format(...args).split("\n"));
  }

  const showCursor = () => out.write("\x1b[?25h");
  const onSignal = (signal: NodeJS.Signals) => {
    showCursor();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };

  const animate = () => {
    if (timer) return;
    out.write("\x1b[?25l");
    timer = setInterval(() => {
      frameNumber += 1;
      draw();
    }, TICK_MS);
    timer.unref();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    process.once("exit", showCursor);
  };

  const close = (lines: string[]) => {
    closed = true;
    draw(lines);
    if (timer) {
      clearInterval(timer);
      showCursor();
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      process.off("exit", showCursor);
    }
    for (const [method, original] of originalConsole) console[method] = original;
  };

  const showHeader = () => {
    if (headerShown) return;
    headerShown = true;
    draw(["", `${bold("tenora")} ${dim(command)}`, ""]);
  };

  const tally = (): string => {
    const words = WORDS[lastKind];
    return [
      ...(changed ? [`${count(changed, "tenant")} ${words.done}`] : []),
      ...(unchanged ? [`${changed ? unchanged : count(unchanged, "tenant")} ${words.noneCount}`] : []),
    ].join(", ");
  };

  const stepEvents = (target: Target): StepEvents => {
    const stepNamed = (name: string): Step => {
      let step = target.steps.find((candidate) => candidate.name === name);
      if (!step) {
        // A rollback only learns its steps as knex reaches them.
        step = { name, status: "pending" };
        target.steps.push(step);
      }
      return step;
    };
    const settle = (name: string, status: StepStatus, error?: unknown) => {
      const step = stepNamed(name);
      step.status = status;
      step.ms = Date.now() - (step.startedAt ?? Date.now());
      if (error !== undefined) step.error = messageOf(error);
    };
    return {
      plan: (names) => {
        target.steps = names.map((name) => ({ name, status: "pending" }));
      },
      started: (name) => {
        const step = stepNamed(name);
        step.status = "running";
        step.startedAt = Date.now();
      },
      finished: (name) => settle(name, "done"),
      failed: (name, error) => settle(name, "failed", error),
      undone: (names) => {
        for (const name of names) stepNamed(name).status = "undone";
      },
    };
  };

  const finishedTarget = (target: Target, files: string[]): string[] => {
    const words = WORDS[target.kind];
    if (expected === undefined) {
      if (!files.length) return [`${tick} ${words.noneBase}`];
      const summary = `Base ${words.done}: ${count(files.length, words.unit)} in ${time(Date.now() - target.startedAt)}.`;
      return [...target.steps.map(stepLine), "", `${tick} ${summary}`];
    }
    return files.length
      ? [`${tick} ${target.label}  ${dim(`${count(files.length, words.unit)} · ${time(Date.now() - target.startedAt)}`)}`]
      : [`${dim("–")} ${target.label}  ${dim(words.none)}`];
  };

  const failedTarget = (target: Target, error: unknown): string[] => {
    for (const step of target.steps) {
      if (step.status === "pending") step.status = "skipped";
    }
    const lines = [`${cross} ${bold(target.label)}`];
    for (const step of target.steps) {
      lines.push(stepLine(step));
      if (step.error) lines.push(`    ${paint("red", step.error)}`);
    }
    if (!target.steps.some((step) => step.error)) lines.push(`  ${paint("red", messageOf(error))}`);
    return lines;
  };

  return {
    expectTenants: (total) => {
      expected = total;
      showHeader();
      animate();
    },
    target: async (label, kind, work) => {
      const target: Target = { label, kind, startedAt: Date.now(), steps: [] };
      current = target;
      lastKind = kind;
      showHeader();
      animate();
      try {
        const files = await work(stepEvents(target));
        current = undefined;
        if (files.length) changed += 1;
        else unchanged += 1;
        draw(finishedTarget(target, files));
      } catch (error) {
        current = undefined;
        reportedError = error;
        stoppedOn = label;
        draw(failedTarget(target, error));
        throw error;
      }
    },
    task: async (label, work) => {
      taskLabel = label;
      taskStartedAt = Date.now();
      animate();
      try {
        return await work();
      } finally {
        taskLabel = undefined;
      }
    },
    line: (text) => draw([`${tick} ${text}`]),
    problem: (text) => {
      draw([`${cross} ${text}`]);
      process.exitCode = 1;
    },
    finish: () => {
      if (expected === undefined) {
        close(headerShown ? [""] : []);
        return;
      }
      const finished = expected
        ? `${tick} ${tally()} in ${time(Date.now() - startedAt)}.`
        : `${dim("–")} No tenants.`;
      close(["", finished, ""]);
    },
    fail: (error) => {
      const lines = error === reportedError ? [] : [`${cross} ${messageOf(error)}`];
      if (stoppedOn !== undefined && expected !== undefined) {
        const notStarted = expected - changed - unchanged - 1;
        const progress = [tally(), ...(notStarted ? [`${notStarted} not started`] : [])].filter(Boolean).join(", ");
        lines.push("", `${cross} Stopped on ${stoppedOn}.${progress ? ` ${progress}.` : ""}`);
      }
      close(headerShown ? [...lines, ""] : lines);
      process.exitCode = 1;
    },
  };
};
