import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COMPOSE_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../docker-compose.yml");

/**
 * Runs a dump tool inside the `npm run test:docker` container for that server, so the tool's version
 * always matches. Tenora passes the published host and port; inside the container the server
 * listens on its default port.
 */
export const runInContainer = (service, tool, port, envNames) => {
  const args = process.argv
    .slice(2)
    .filter((arg) => !arg.startsWith("--host=") && !arg.startsWith("--port="));
  const isVersion = args.includes("--version");
  const env = envNames
    .filter((name) => process.env[name] !== undefined)
    .flatMap((name) => ["-e", `${name}=${process.env[name]}`]);
  const result = spawnSync(
    "docker",
    [
      "compose",
      "-f",
      COMPOSE_FILE,
      "exec",
      "-T",
      ...env,
      service,
      tool,
      ...(isVersion ? [] : ["--host=127.0.0.1", `--port=${port}`]),
      ...args,
    ],
    { stdio: "inherit" }
  );
  process.exit(result.status ?? 1);
};
