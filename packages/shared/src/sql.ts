import { createHash } from "crypto";

export function normalizeSql(sql: string): string {
  const withoutLineComments = sql.replace(/--.*?$/gm, " ");
  const withoutBlockComments = withoutLineComments.replace(/\/\*[\s\S]*?\*\//g, " ");
  return withoutBlockComments.replace(/\s+/g, " ").trim();
}

export function hashSql(normalizedSql: string): string {
  return createHash("sha256").update(normalizedSql, "utf8").digest("hex");
}
