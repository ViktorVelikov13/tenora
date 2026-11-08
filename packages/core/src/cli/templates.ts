import fs from "fs";
import path from "path";

const findNearestPackageJson = (startDir: string): string | undefined => {
  let current = startDir;
  while (true) {
    const candidate = path.join(current, "package.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
};

const detectModuleType = (): "esm" | "cjs" => {
  const pkgPath = findNearestPackageJson(process.cwd());
  if (!pkgPath) return "cjs";
  try {
    const raw = fs.readFileSync(pkgPath, "utf8");
    const json = JSON.parse(raw);
    return json.type === "module" ? "esm" : "cjs";
  } catch {
    return "cjs";
  }
};

export const resolveTemplateModuleType = (opts: { esm?: boolean; cjs?: boolean }): "esm" | "cjs" => {
  if (opts.esm && opts.cjs) {
    throw new Error("Tenora: choose only one of --esm or --cjs.");
  }
  if (opts.esm) return "esm";
  if (opts.cjs) return "cjs";
  return detectModuleType();
};

const timestamp = () =>
  new Date()
    .toISOString()
    .replace(/[-:T.Z]/g, "")
    .slice(0, 14);

/** The path of a new migration file, whose timestamp makes it sort after the ones before it. */
export const newMigrationPath = (directory: string, name: string): string =>
  path.resolve(directory, `${timestamp()}_${name}.js`);

export const newSeedPath = (directory: string, name: string): string => path.resolve(directory, `${name}.js`);

const writeNewFile = (filePath: string, body: string) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body);
};

const tokenizeName = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const joinTokens = (tokens: string[]): string => tokens.join("_");

const splitColumns = (tokens: string[]): string[] => {
  const columns: string[] = [];
  let current: string[] = [];
  for (const token of tokens) {
    if (token === "and") {
      if (current.length) {
        columns.push(joinTokens(current));
        current = [];
      }
      continue;
    }
    current.push(token);
  }
  if (current.length) columns.push(joinTokens(current));
  return columns.filter(Boolean);
};

const inferCreateTable = (tokens: string[]): string | undefined => {
  const createIdx = tokens.indexOf("create");
  if (createIdx === -1) return undefined;
  const tableTokens = tokens.slice(createIdx + 1);
  const table = tableTokens[tableTokens.length - 1] === "table"
    ? joinTokens(tableTokens.slice(0, -1))
    : joinTokens(tableTokens);
  return table || undefined;
};

const inferAlterAdd = (tokens: string[]) => {
  const addIdx = tokens.indexOf("add");
  const toIdx = tokens.indexOf("to");
  if (addIdx === -1 || toIdx === -1 || toIdx <= addIdx + 1) return undefined;
  const cols = splitColumns(tokens.slice(addIdx + 1, toIdx));
  const tableTokens = tokens.slice(toIdx + 1);
  if (!cols.length || !tableTokens.length) return undefined;
  const table = tableTokens[tableTokens.length - 1] === "table"
    ? joinTokens(tableTokens.slice(0, -1))
    : joinTokens(tableTokens);
  if (!table) return undefined;
  return { table, columns: cols };
};

const inferAlterRemove = (tokens: string[]) => {
  const removeIdx = tokens.indexOf("remove");
  const dropIdx = tokens.indexOf("drop");
  const fromIdx = tokens.indexOf("from");
  const startIdx = removeIdx !== -1 ? removeIdx : dropIdx;
  if (startIdx === -1 || fromIdx === -1 || fromIdx <= startIdx + 1) return undefined;
  const cols = splitColumns(tokens.slice(startIdx + 1, fromIdx));
  const tableTokens = tokens.slice(fromIdx + 1);
  if (!cols.length || !tableTokens.length) return undefined;
  const table = tableTokens[tableTokens.length - 1] === "table"
    ? joinTokens(tableTokens.slice(0, -1))
    : joinTokens(tableTokens);
  if (!table) return undefined;
  return { table, columns: cols };
};

const moduleExport = (name: "up" | "down" | "seed", moduleType: "esm" | "cjs") =>
  moduleType === "esm" ? `export const ${name}` : `exports.${name}`;

const buildCreateTableTemplate = (table: string, moduleType: "esm" | "cjs") =>
  `${moduleExport("up", moduleType)} = ({ schema }) =>\n  schema.create("${table}", (t) => {\n    t.id();\n    t.timestamps();\n  });\n\n${moduleExport("down", moduleType)} = ({ schema }) => schema.dropIfExists("${table}");\n`;

const alterTable = (table: string, lines: string[]) =>
  `({ schema }) =>\n  schema.table("${table}", (t) => {\n${lines.join("\n")}\n  });\n`;

// Nullable, because a table that already has rows cannot take a new required column without a default.
const addColumnLines = (columns: string[]) => columns.map((c) => `    t.string("${c}").nullable();`);
const dropColumnLines = (columns: string[]) => columns.map((c) => `    t.dropColumn("${c}");`);

const buildAlterAddTemplate = (table: string, columns: string[], moduleType: "esm" | "cjs") =>
  `${moduleExport("up", moduleType)} = ${alterTable(table, addColumnLines(columns))}\n${moduleExport("down", moduleType)} = ${alterTable(table, dropColumnLines(columns))}`;

const buildAlterRemoveTemplate = (table: string, columns: string[], moduleType: "esm" | "cjs") =>
  `${moduleExport("up", moduleType)} = ${alterTable(table, dropColumnLines(columns))}\n${moduleExport("down", moduleType)} = ${alterTable(table, addColumnLines(columns))}`;

const buildDefaultMigrationTemplate = (moduleType: "esm" | "cjs") =>
  `${moduleExport("up", moduleType)} = ({ db, schema }) => {\n  // TODO\n};\n\n${moduleExport("down", moduleType)} = ({ db, schema }) => {\n  // TODO\n};\n`;

export const writeMigrationTemplate = (filePath: string, moduleType: "esm" | "cjs", name: string) => {
  const tokens = tokenizeName(name);
  const createTable = inferCreateTable(tokens);
  const addPlan = inferAlterAdd(tokens);
  const removePlan = inferAlterRemove(tokens);
  const body = addPlan
    ? buildAlterAddTemplate(addPlan.table, addPlan.columns, moduleType)
    : removePlan
      ? buildAlterRemoveTemplate(removePlan.table, removePlan.columns, moduleType)
      : createTable
        ? buildCreateTableTemplate(createTable, moduleType)
        : buildDefaultMigrationTemplate(moduleType);
  writeNewFile(filePath, body);
};

export const writeSeedTemplate = (filePath: string, moduleType: "esm" | "cjs") => {
  writeNewFile(filePath, `${moduleExport("seed", moduleType)} = async ({ db }) => {\n  // TODO\n};\n`);
};
