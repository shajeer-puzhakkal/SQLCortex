import type { QueryFeatures, StatementType } from "../types";

type FallbackScanState = "code" | "line_comment" | "block_comment" | "single_quote" | "double_quote" | "dollar_quote";

const AGGREGATE_FUNCTIONS = new Set([
  "array_agg",
  "avg",
  "bool_and",
  "bool_or",
  "count",
  "every",
  "json_agg",
  "jsonb_agg",
  "max",
  "min",
  "string_agg",
  "sum",
]);

function inferStatementType(sql: string): StatementType {
  const head = sql.match(/^\s*(with\s+recursive\s+|with\s+)?([a-z_]+)/i)?.[2]?.toUpperCase();

  switch (head) {
    case "SELECT":
      return "SELECT";
    case "INSERT":
      return "INSERT";
    case "UPDATE":
      return "UPDATE";
    case "DELETE":
      return "DELETE";
    case "TRUNCATE":
      return "TRUNCATE";
    case "ALTER":
    case "COMMENT":
    case "CREATE":
    case "DROP":
    case "GRANT":
    case "RENAME":
    case "REVOKE":
      return "DDL";
    default:
      return "UNKNOWN";
  }
}

function sanitizeSql(sql: string): string {
  let result = "";
  let index = 0;
  let state: FallbackScanState = "code";
  let blockDepth = 0;
  let dollarDelimiter = "";

  while (index < sql.length) {
    const current = sql[index]!;
    const next = sql[index + 1];

    switch (state) {
      case "code":
        if (current === "-" && next === "-") {
          state = "line_comment";
          result += "  ";
          index += 2;
          continue;
        }

        if (current === "/" && next === "*") {
          state = "block_comment";
          blockDepth = 1;
          result += "  ";
          index += 2;
          continue;
        }

        if (current === "'") {
          state = "single_quote";
          result += " ";
          index += 1;
          continue;
        }

        if (current === '"') {
          state = "double_quote";
          result += " ";
          index += 1;
          continue;
        }

        if (current === "$") {
          const delimiterMatch = sql.slice(index).match(/^\$[A-Za-z0-9_]*\$/);

          if (delimiterMatch) {
            state = "dollar_quote";
            dollarDelimiter = delimiterMatch[0];
            result += " ".repeat(dollarDelimiter.length);
            index += dollarDelimiter.length;
            continue;
          }
        }

        result += current;
        index += 1;
        continue;
      case "line_comment":
        if (current === "\n") {
          state = "code";
          result += "\n";
        } else {
          result += " ";
        }
        index += 1;
        continue;
      case "block_comment":
        if (current === "/" && next === "*") {
          blockDepth += 1;
          result += "  ";
          index += 2;
          continue;
        }

        if (current === "*" && next === "/") {
          blockDepth -= 1;
          result += "  ";
          index += 2;

          if (blockDepth === 0) {
            state = "code";
          }

          continue;
        }

        result += current === "\n" ? "\n" : " ";
        index += 1;
        continue;
      case "single_quote":
        if (current === "'" && next === "'") {
          result += "  ";
          index += 2;
          continue;
        }

        if (current === "'") {
          state = "code";
        }

        result += current === "\n" ? "\n" : " ";
        index += 1;
        continue;
      case "double_quote":
        if (current === '"' && next === '"') {
          result += "  ";
          index += 2;
          continue;
        }

        if (current === '"') {
          state = "code";
        }

        result += current === "\n" ? "\n" : " ";
        index += 1;
        continue;
      case "dollar_quote":
        if (sql.startsWith(dollarDelimiter, index)) {
          state = "code";
          result += " ".repeat(dollarDelimiter.length);
          index += dollarDelimiter.length;
          continue;
        }

        result += current === "\n" ? "\n" : " ";
        index += 1;
        continue;
    }
  }

  return result;
}

function countLeadingCtes(sql: string): number {
  if (!/^\s*with\b/i.test(sql)) {
    return 0;
  }

  const match = sql.match(/\bas\s*\(/gi);
  return match?.length ?? 0;
}

function countSubqueries(sql: string): number {
  const matches = sql.match(/\(\s*(with\b|select\b)/gi);
  return matches?.length ?? 0;
}

function collectFunctions(sql: string): string[] {
  const matches = sql.matchAll(/\b([a-z_][a-z0-9_$]*)\s*\(/gi);
  const names: string[] = [];

  for (const match of matches) {
    const name = match[1]!.toLowerCase();

    if (
      [
        "as",
        "cast",
        "exists",
        "filter",
        "in",
        "into",
        "on",
        "over",
        "select",
        "using",
        "values",
        "where",
      ].includes(name)
    ) {
      continue;
    }

    if (!names.includes(name)) {
      names.push(name);
    }
  }

  return names;
}

function collectColumns(fragment: string): string[] {
  const columns: string[] = [];
  const matches = fragment.matchAll(/\b([a-z_][a-z0-9_$]*)(?:\.)?([a-z_][a-z0-9_$]*)?\s*(=|<>|!=|<=|>=|<|>|like|ilike|in|is|between)\b/gi);

  for (const match of matches) {
    const raw = (match[2] ?? match[1])!.toLowerCase();

    if (!columns.includes(raw)) {
      columns.push(raw);
    }
  }

  return columns;
}

function extractClause(sql: string, clauseName: string): string {
  const matcher = new RegExp(`\\b${clauseName}\\b([\\s\\S]*?)(?=\\b(group\\s+by|order\\s+by|limit|returning|having|window)\\b|$)`, "i");
  return sql.match(matcher)?.[1]?.trim() ?? "";
}

function createEmptyFeatures(statementType: StatementType): QueryFeatures {
  return {
    statement_type: statementType,
    select_star: false,
    table_count: 0,
    join_count: 0,
    where_present: false,
    limit_present: false,
    order_by_present: false,
    group_by_present: false,
    cte_count: 0,
    subquery_depth: 0,
    has_cartesian_join_risk: false,
    where_columns: [],
    join_columns: [],
    uses_functions: [],
    has_aggregation: false,
    has_window_functions: false,
    parse_confidence: "low",
  };
}

export function extractFallbackFeatures(sql: string): QueryFeatures {
  const normalizedSql = sql.replace(/\r\n/g, "\n").trim();
  const sanitized = sanitizeSql(normalizedSql);
  const statementType = inferStatementType(sanitized);
  const features = createEmptyFeatures(statementType);
  const functions = collectFunctions(sanitized);
  const whereClause = extractClause(sanitized, "where");
  const joinClause = extractClause(sanitized, "join");
  const tableMatches = sanitized.match(/\b(from|join|update|into|using|truncate(?:\s+table)?)\s+([a-z_"][a-z0-9_$".]*)/gi);

  features.select_star = /\bselect\s+(distinct\s+)?([a-z_][a-z0-9_$]*\s*\.\s*)?\*/i.test(sanitized);
  features.table_count = tableMatches?.length ?? 0;
  features.join_count = sanitized.match(/\bjoin\b/gi)?.length ?? 0;
  features.where_present = /\bwhere\b/i.test(sanitized);
  features.limit_present = /\blimit\b/i.test(sanitized);
  features.order_by_present = /\border\s+by\b/i.test(sanitized);
  features.group_by_present = /\bgroup\s+by\b/i.test(sanitized);
  features.cte_count = countLeadingCtes(sanitized);
  features.subquery_depth = countSubqueries(sanitized) > 0 ? 1 : 0;
  features.has_cartesian_join_risk =
    features.join_count > 0 &&
    (!/\b(on|using)\b/i.test(sanitized) || /\bcross\s+join\b/i.test(sanitized));
  features.where_columns = collectColumns(whereClause);
  features.join_columns = collectColumns(joinClause);
  features.uses_functions = functions;
  features.has_aggregation = functions.some((name) => AGGREGATE_FUNCTIONS.has(name));
  features.has_window_functions = /\bover\s*\(/i.test(sanitized);

  return features;
}
