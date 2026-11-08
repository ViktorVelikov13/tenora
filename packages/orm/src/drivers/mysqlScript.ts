/**
 * Splits a mysqldump script into statements. The pools never allow several statements in one query, and DELIMITER is
 * a mysql client command rather than SQL, so it is handled here.
 */
export const splitMysqlScript = (script: string): string[] => {
  const statements: string[] = [];
  let delimiter = ";";
  let buffer: string[] = [];
  const flush = () => {
    const statement = buffer.join("\n").trim();
    buffer = [];
    const onlyComments = statement.split("\n").every((line) => !line.trim() || line.trim().startsWith("--"));
    if (!onlyComments) statements.push(statement);
  };
  for (const line of script.split("\n")) {
    const change = /^DELIMITER\s+(\S+)$/i.exec(line.trim());
    if (change) {
      flush();
      delimiter = change[1];
      continue;
    }
    const trimmed = line.trimEnd();
    if (trimmed.endsWith(delimiter)) {
      buffer.push(trimmed.slice(0, -delimiter.length));
      flush();
    } else {
      buffer.push(line);
    }
  }
  flush();
  return statements;
};
