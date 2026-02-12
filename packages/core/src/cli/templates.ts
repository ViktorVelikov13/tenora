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

export const normalizeCreatedPath = (created: string | string[]): string =>
  Array.isArray(created) ? created[0] : created;

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
  const tableIdx = tokens.indexOf("table");
  if (tableIdx > 0) return tokens[tableIdx - 1];
  const createIdx = tokens.indexOf("create");
  if (createIdx >= 0 && tokens[createIdx + 1]) return tokens[createIdx + 1];
  return undefined;
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

const buildCreateTableTemplate = (table: string, moduleType: "esm" | "cjs") =>
  moduleType === "esm"
    ? `export const up = (knex) =>\n  knex.schema.createTable(\"${table}\", (t) => {\n    t.increments(\"id\").primary();\n    t.timestamps(true, true);\n  });\n\nexport const down = (knex) => knex.schema.dropTableIfExists(\"${table}\");\n`
    : `exports.up = (knex) =>\n  knex.schema.createTable(\"${table}\", (t) => {\n    t.increments(\"id\").primary();\n    t.timestamps(true, true);\n  });\n\nexports.down = (knex) => knex.schema.dropTableIfExists(\"${table}\");\n`;

const buildAlterAddTemplate = (table: string, columns: string[], moduleType: "esm" | "cjs") => {
  const addLines = columns.map((c) => `    t.string(\"${c}\");`).join("\n");
  const dropLines = columns.map((c) => `    t.dropColumn(\"${c}\");`).join("\n");
  return moduleType === "esm"
    ? `export const up = (knex) =>\n  knex.schema.alterTable(\"${table}\", (t) => {\n${addLines}\n  });\n\nexport const down = (knex) =>\n  knex.schema.alterTable(\"${table}\", (t) => {\n${dropLines}\n  });\n`
    : `exports.up = (knex) =>\n  knex.schema.alterTable(\"${table}\", (t) => {\n${addLines}\n  });\n\nexports.down = (knex) =>\n  knex.schema.alterTable(\"${table}\", (t) => {\n${dropLines}\n  });\n`;
};

const buildAlterRemoveTemplate = (table: string, columns: string[], moduleType: "esm" | "cjs") => {
  const dropLines = columns.map((c) => `    t.dropColumn(\"${c}\");`).join("\n");
  const addLines = columns.map((c) => `    t.string(\"${c}\");`).join("\n");
  return moduleType === "esm"
    ? `export const up = (knex) =>\n  knex.schema.alterTable(\"${table}\", (t) => {\n${dropLines}\n  });\n\nexport const down = (knex) =>\n  knex.schema.alterTable(\"${table}\", (t) => {\n${addLines}\n  });\n`
    : `exports.up = (knex) =>\n  knex.schema.alterTable(\"${table}\", (t) => {\n${dropLines}\n  });\n\nexports.down = (knex) =>\n  knex.schema.alterTable(\"${table}\", (t) => {\n${addLines}\n  });\n`;
};

const buildDefaultMigrationTemplate = (moduleType: "esm" | "cjs") =>
  moduleType === "esm"
    ? `export const up = (knex) => {\n  // TODO\n};\n\nexport const down = (knex) => {\n  // TODO\n};\n`
    : `exports.up = (knex) => {\n  // TODO\n};\n\nexports.down = (knex) => {\n  // TODO\n};\n`;

export const writeMigrationTemplate = (filePath: string, moduleType: "esm" | "cjs", name: string) => {
  const tokens = tokenizeName(name);
  const createTable = inferCreateTable(tokens);
  const addPlan = inferAlterAdd(tokens);
  const removePlan = inferAlterRemove(tokens);
  const body = createTable
    ? buildCreateTableTemplate(createTable, moduleType)
    : addPlan
      ? buildAlterAddTemplate(addPlan.table, addPlan.columns, moduleType)
      : removePlan
        ? buildAlterRemoveTemplate(removePlan.table, removePlan.columns, moduleType)
        : buildDefaultMigrationTemplate(moduleType);
  fs.writeFileSync(filePath, body);
};

export const writeSeedTemplate = (filePath: string, moduleType: "esm" | "cjs") => {
  const body =
    moduleType === "esm"
      ? `export const seed = async (knex) => {\n  // TODO\n};\n`
      : `exports.seed = async (knex) => {\n  // TODO\n};\n`;
  fs.writeFileSync(filePath, body);
};
