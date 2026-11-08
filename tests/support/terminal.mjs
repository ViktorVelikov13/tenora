import { spawnSync } from "node:child_process";
import { CLI_BIN } from "./project.mjs";

// Not pty.spawn: on macOS it can hang after the command exits on Python 3.9, which Xcode installs.
const SPAWN_IN_TERMINAL = `
import os, pty, sys
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
while True:
    try:
        data = os.read(fd, 65536)
    except OSError:
        break
    if not data:
        break
    os.write(1, data)
sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))
`;

// In CI a missing tool must fail the run, never quietly skip the tests.
export const terminalMissing =
  spawnSync("python3", ["--version"]).error && !process.env.CI ? "needs python3 for a pseudo terminal" : false;

/** Replays what the CLI wrote the way a terminal would, leaving only what stays on the screen. */
const finalScreen = (raw) => {
  const text = raw.replaceAll("\r\n", "\n").replace(/\x1b\[\?\d+[hl]/g, "").replace(/\x1b\[[\d;]*m/g, "");
  const lines = [];
  for (const piece of text.split(/(\x1b\[\d+A\x1b\[0J)/)) {
    const erase = piece.match(/^\x1b\[(\d+)A\x1b\[0J$/);
    if (erase) {
      lines.length -= Number(erase[1]);
    } else if (piece) {
      lines.push(...piece.replace(/\n$/, "").split("\n"));
    }
  }
  return lines.join("\n");
};

const withoutTimes = (screen) => screen.replace(/<?(?<![\w.])\d+(?:\.\d+)?(?:ms|s)\b/g, "<t>");

/** Runs the CLI in a pseudo terminal, so it sees what it would see with a person watching. */
export const runInTerminal = (
  project,
  args,
  { bin = CLI_BIN, env = {}, columns = 120, rows = 40, redirect = "" } = {}
) => {
  const result = spawnSync(
    "python3",
    [
      "-c",
      SPAWN_IN_TERMINAL,
      "sh",
      "-c",
      `stty cols ${columns} rows ${rows}; exec "$0" "$@" ${redirect}`,
      process.execPath,
      bin,
      ...args,
    ],
    {
      cwd: project.dir,
      encoding: "utf8",
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "", TERM: "xterm-256color", ...env },
    }
  );
  return {
    status: result.status,
    raw: result.stdout,
    screen: withoutTimes(finalScreen(result.stdout)),
    plain: result.stdout.replaceAll("\r\n", "\n"),
  };
};
