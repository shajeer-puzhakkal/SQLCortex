import type { StatementType } from "../types";

export type SqlTokenKind = "word" | "identifier" | "string" | "number" | "symbol";

export type SqlToken = {
  kind: SqlTokenKind;
  value: string;
  upper?: string;
  start: number;
  end: number;
};

export type SqlClauseName =
  | "WITH"
  | "SELECT"
  | "FROM"
  | "WHERE"
  | "GROUP BY"
  | "HAVING"
  | "WINDOW"
  | "ORDER BY"
  | "LIMIT"
  | "OFFSET"
  | "FETCH"
  | "UPDATE"
  | "SET"
  | "INSERT INTO"
  | "VALUES"
  | "ON CONFLICT"
  | "DELETE FROM"
  | "USING"
  | "RETURNING"
  | "UNION"
  | "INTERSECT"
  | "EXCEPT";

export type SqlClause = {
  name: SqlClauseName;
  text: string;
  start: number;
  end: number;
};

export type SqlJoinNode = {
  kind: string;
  table: string | null;
  condition: string;
  columns: string[];
  hasConstraint: boolean;
  isCartesianRisk: boolean;
};

export type ParsedSqlAst = {
  kind: "statement";
  sql: string;
  normalizedSql: string;
  statementType: StatementType;
  parseConfidence: "high";
  cteNames: string[];
  clauses: Partial<Record<SqlClauseName, SqlClause>>;
  tables: string[];
  joins: SqlJoinNode[];
  whereColumns: string[];
  joinColumns: string[];
  functions: string[];
  selectStar: boolean;
  hasAggregation: boolean;
  hasWindowFunctions: boolean;
  subqueries: ParsedSqlAst[];
  subqueryDepth: number;
};

export type SqlParseError = {
  kind: "parse_error";
  message: string;
  position?: number;
};

type TokenizeResult =
  | { ok: true; tokens: SqlToken[] }
  | { ok: false; error: SqlParseError };

type ClauseDefinition = {
  name: SqlClauseName;
  keywords: string[];
};

type ClauseBoundary = {
  name: SqlClauseName;
  tokenIndex: number;
  keywordLength: number;
};

type LeadingCteResult = {
  cteNames: string[];
  nextIndex: number;
};

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

const FUNCTION_KEYWORD_EXCLUSIONS = new Set([
  "ALL",
  "AND",
  "AS",
  "CASE",
  "CAST",
  "DISTINCT",
  "ELSE",
  "END",
  "EXISTS",
  "FILTER",
  "FROM",
  "GROUP",
  "IN",
  "INTO",
  "JOIN",
  "LIMIT",
  "NOT",
  "ON",
  "OR",
  "ORDER",
  "OVER",
  "PARTITION",
  "SELECT",
  "THEN",
  "USING",
  "VALUES",
  "WHEN",
  "WHERE",
  "WITH",
]);

const JOIN_MODIFIER_WORDS = new Set(["INNER", "LEFT", "RIGHT", "FULL", "OUTER", "CROSS", "NATURAL"]);

const OPERATORS = new Set(["=", "<", ">", "<=", ">=", "<>", "!=", "LIKE", "ILIKE", "IN", "IS", "BETWEEN"]);

function createParseError(message: string, position?: number): SqlParseError {
  if (position === undefined) {
    return { kind: "parse_error", message };
  }

  return { kind: "parse_error", message, position };
}

function isParseFailure(value: LeadingCteResult | SqlParseError): value is SqlParseError {
  return "kind" in value;
}

function isWordLikeToken(token: SqlToken | undefined): token is SqlToken {
  return token?.kind === "word" || token?.kind === "identifier";
}

function normalizedIdentifier(token: SqlToken): string {
  return token.kind === "word" ? token.value.toLowerCase() : token.value;
}

function readDollarQuoteDelimiter(sql: string, start: number): string | null {
  if (sql[start] !== "$") {
    return null;
  }

  let index = start + 1;

  while (index < sql.length && /[A-Za-z0-9_]/.test(sql[index]!)) {
    index += 1;
  }

  if (index >= sql.length || sql[index] !== "$") {
    return null;
  }

  return sql.slice(start, index + 1);
}

function skipLineComment(sql: string, start: number): number {
  let index = start + 2;

  while (index < sql.length && sql[index] !== "\n") {
    index += 1;
  }

  return index;
}

function skipBlockComment(sql: string, start: number): number {
  let depth = 1;
  let index = start + 2;

  while (index < sql.length) {
    const current = sql[index];
    const next = sql[index + 1];

    if (current === "/" && next === "*") {
      depth += 1;
      index += 2;
      continue;
    }

    if (current === "*" && next === "/") {
      depth -= 1;
      index += 2;

      if (depth === 0) {
        return index;
      }

      continue;
    }

    index += 1;
  }

  return -1;
}

function readQuotedLiteral(sql: string, start: number, quote: "'" | '"'): number {
  let index = start + 1;

  while (index < sql.length) {
    if (sql[index] === quote) {
      if (sql[index + 1] === quote) {
        index += 2;
        continue;
      }

      return index + 1;
    }

    index += 1;
  }

  return -1;
}

function readDollarQuotedLiteral(sql: string, start: number, delimiter: string): number {
  const closeIndex = sql.indexOf(delimiter, start + delimiter.length);

  if (closeIndex === -1) {
    return -1;
  }

  return closeIndex + delimiter.length;
}

function tokenizeWord(sql: string, start: number): SqlToken {
  let end = start + 1;

  while (end < sql.length && /[A-Za-z0-9_$]/.test(sql[end]!)) {
    end += 1;
  }

  const value = sql.slice(start, end);

  return {
    kind: "word",
    value,
    upper: value.toUpperCase(),
    start,
    end,
  };
}

function tokenizeIdentifier(sql: string, start: number): SqlToken | SqlParseError {
  const end = readQuotedLiteral(sql, start, '"');

  if (end === -1) {
    return createParseError("Unterminated quoted identifier.", start);
  }

  return {
    kind: "identifier",
    value: sql.slice(start + 1, end - 1).replace(/""/g, '"'),
    start,
    end,
  };
}

function tokenizeNumber(sql: string, start: number): SqlToken {
  let end = start + 1;

  while (end < sql.length && /[0-9._]/.test(sql[end]!)) {
    end += 1;
  }

  return {
    kind: "number",
    value: sql.slice(start, end),
    start,
    end,
  };
}

function tokenizeSymbol(sql: string, start: number): SqlToken {
  const twoCharSymbol = sql.slice(start, start + 2);

  if (["<=", ">=", "<>", "!=", "::"].includes(twoCharSymbol)) {
    return {
      kind: "symbol",
      value: twoCharSymbol,
      start,
      end: start + 2,
    };
  }

  return {
    kind: "symbol",
    value: sql[start]!,
    start,
    end: start + 1,
  };
}

export function tokenizeSql(sql: string): TokenizeResult {
  const tokens: SqlToken[] = [];
  let index = 0;

  while (index < sql.length) {
    const current = sql[index];
    const next = sql[index + 1];

    if (!current) {
      break;
    }

    if (/\s/.test(current)) {
      index += 1;
      continue;
    }

    if (current === "-" && next === "-") {
      index = skipLineComment(sql, index);
      continue;
    }

    if (current === "/" && next === "*") {
      const end = skipBlockComment(sql, index);

      if (end === -1) {
        return { ok: false, error: createParseError("Unterminated block comment.", index) };
      }

      index = end;
      continue;
    }

    if (current === "'") {
      const end = readQuotedLiteral(sql, index, "'");

      if (end === -1) {
        return { ok: false, error: createParseError("Unterminated string literal.", index) };
      }

      tokens.push({
        kind: "string",
        value: sql.slice(index, end),
        start: index,
        end,
      });
      index = end;
      continue;
    }

    if (current === '"') {
      const identifier = tokenizeIdentifier(sql, index);

      if ("kind" in identifier && identifier.kind === "parse_error") {
        return { ok: false, error: identifier };
      }

      tokens.push(identifier);
      index = identifier.end;
      continue;
    }

    if (current === "$") {
      const delimiter = readDollarQuoteDelimiter(sql, index);

      if (delimiter) {
        const end = readDollarQuotedLiteral(sql, index, delimiter);

        if (end === -1) {
          return { ok: false, error: createParseError("Unterminated dollar-quoted string.", index) };
        }

        tokens.push({
          kind: "string",
          value: sql.slice(index, end),
          start: index,
          end,
        });
        index = end;
        continue;
      }
    }

    if (/[A-Za-z_]/.test(current)) {
      const token = tokenizeWord(sql, index);
      tokens.push(token);
      index = token.end;
      continue;
    }

    if (/[0-9]/.test(current)) {
      const token = tokenizeNumber(sql, index);
      tokens.push(token);
      index = token.end;
      continue;
    }

    const symbol = tokenizeSymbol(sql, index);
    tokens.push(symbol);
    index = symbol.end;
  }

  return { ok: true, tokens };
}

function validateBalancedParentheses(tokens: SqlToken[]): SqlParseError | null {
  let depth = 0;

  for (const token of tokens) {
    if (token.kind !== "symbol") {
      continue;
    }

    if (token.value === "(") {
      depth += 1;
      continue;
    }

    if (token.value === ")") {
      depth -= 1;

      if (depth < 0) {
        return createParseError("Unexpected closing parenthesis.", token.start);
      }
    }
  }

  if (depth > 0) {
    return createParseError("Unterminated parenthesis group.");
  }

  return null;
}

function matchesKeywordSequence(tokens: SqlToken[], index: number, keywords: string[]): boolean {
  for (let offset = 0; offset < keywords.length; offset += 1) {
    const token = tokens[index + offset];

    if (token?.kind !== "word" || token.upper !== keywords[offset]) {
      return false;
    }
  }

  return true;
}

function findMatchingParen(tokens: SqlToken[], openIndex: number, endIndex: number): number {
  let depth = 0;

  for (let index = openIndex; index < endIndex; index += 1) {
    const token = tokens[index];

    if (token?.kind !== "symbol") {
      continue;
    }

    if (token.value === "(") {
      depth += 1;
      continue;
    }

    if (token.value === ")") {
      depth -= 1;

      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function readLeadingCtes(tokens: SqlToken[], sql: string): LeadingCteResult | SqlParseError {
  if (tokens[0]?.kind !== "word" || tokens[0].upper !== "WITH") {
    return { cteNames: [], nextIndex: 0 };
  }

  const cteNames: string[] = [];
  let index = 1;
  const recursiveToken = tokens[index];

  if (recursiveToken?.kind === "word" && recursiveToken.upper === "RECURSIVE") {
    index += 1;
  }

  while (index < tokens.length) {
    const nameToken = tokens[index];
    const nameTokenStart = tokens[index]?.start;

    if (!isWordLikeToken(nameToken)) {
      return createParseError("Expected CTE name after WITH.", nameTokenStart);
    }

    cteNames.push(normalizedIdentifier(nameToken));
    index += 1;
    const cteColumnsToken = tokens[index];

    if (cteColumnsToken?.kind === "symbol" && cteColumnsToken.value === "(") {
      const endColumns = findMatchingParen(tokens, index, tokens.length);

      if (endColumns === -1) {
        return createParseError("Unterminated CTE column list.", cteColumnsToken.start);
      }

      index = endColumns + 1;
    }
    const asToken = tokens[index];

    if (asToken?.kind !== "word" || asToken.upper !== "AS") {
      return createParseError("Expected AS for CTE definition.", asToken ? asToken.start : undefined);
    }

    index += 1;
    const openToken = tokens[index];

    if (openToken?.kind !== "symbol" || openToken.value !== "(") {
      return createParseError("Expected opening parenthesis for CTE body.", openToken ? openToken.start : undefined);
    }

    const endBody = findMatchingParen(tokens, index, tokens.length);

    if (endBody === -1) {
      return createParseError("Unterminated CTE body.", sql.length);
    }

    index = endBody + 1;
    const separatorToken = tokens[index];

    if (separatorToken?.kind === "symbol" && separatorToken.value === ",") {
      index += 1;
      continue;
    }

    return { cteNames, nextIndex: index };
  }

  return { cteNames, nextIndex: index };
}

function resolveStatementType(tokens: SqlToken[], startIndex: number): StatementType {
  const token = tokens[startIndex];

  if (!token || token.kind !== "word") {
    return "UNKNOWN";
  }

  switch (token.upper) {
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

function clauseDefinitionsFor(statementType: StatementType): ClauseDefinition[] {
  switch (statementType) {
    case "SELECT":
      return [
        { name: "SELECT", keywords: ["SELECT"] },
        { name: "FROM", keywords: ["FROM"] },
        { name: "WHERE", keywords: ["WHERE"] },
        { name: "GROUP BY", keywords: ["GROUP", "BY"] },
        { name: "HAVING", keywords: ["HAVING"] },
        { name: "WINDOW", keywords: ["WINDOW"] },
        { name: "ORDER BY", keywords: ["ORDER", "BY"] },
        { name: "LIMIT", keywords: ["LIMIT"] },
        { name: "OFFSET", keywords: ["OFFSET"] },
        { name: "FETCH", keywords: ["FETCH"] },
        { name: "UNION", keywords: ["UNION"] },
        { name: "INTERSECT", keywords: ["INTERSECT"] },
        { name: "EXCEPT", keywords: ["EXCEPT"] },
      ];
    case "UPDATE":
      return [
        { name: "UPDATE", keywords: ["UPDATE"] },
        { name: "SET", keywords: ["SET"] },
        { name: "FROM", keywords: ["FROM"] },
        { name: "WHERE", keywords: ["WHERE"] },
        { name: "RETURNING", keywords: ["RETURNING"] },
      ];
    case "INSERT":
      return [
        { name: "INSERT INTO", keywords: ["INSERT", "INTO"] },
        { name: "SELECT", keywords: ["SELECT"] },
        { name: "VALUES", keywords: ["VALUES"] },
        { name: "ON CONFLICT", keywords: ["ON", "CONFLICT"] },
        { name: "RETURNING", keywords: ["RETURNING"] },
      ];
    case "DELETE":
      return [
        { name: "DELETE FROM", keywords: ["DELETE", "FROM"] },
        { name: "USING", keywords: ["USING"] },
        { name: "WHERE", keywords: ["WHERE"] },
        { name: "RETURNING", keywords: ["RETURNING"] },
      ];
    default:
      return [];
  }
}

function collectClauseBoundaries(
  tokens: SqlToken[],
  startIndex: number,
  definitions: ClauseDefinition[],
): ClauseBoundary[] {
  const boundaries: ClauseBoundary[] = [];
  let depth = 0;

  for (let index = startIndex; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token?.kind === "symbol") {
      if (token.value === "(") {
        depth += 1;
      } else if (token.value === ")") {
        depth = Math.max(0, depth - 1);
      }
      continue;
    }

    if (depth !== 0 || token?.kind !== "word") {
      continue;
    }

    const match = definitions.find((definition) => matchesKeywordSequence(tokens, index, definition.keywords));

    if (!match) {
      continue;
    }

    boundaries.push({
      name: match.name,
      tokenIndex: index,
      keywordLength: match.keywords.length,
    });
  }

  return boundaries;
}

function buildClauses(
  sql: string,
  tokens: SqlToken[],
  boundaries: ClauseBoundary[],
): Partial<Record<SqlClauseName, SqlClause>> {
  const clauses: Partial<Record<SqlClauseName, SqlClause>> = {};

  for (let index = 0; index < boundaries.length; index += 1) {
    const boundary = boundaries[index]!;
    const lastKeywordToken = tokens[boundary.tokenIndex + boundary.keywordLength - 1]!;
    const contentStart = lastKeywordToken.end;
    const nextBoundary = boundaries[index + 1];
    const contentEnd = nextBoundary ? tokens[nextBoundary.tokenIndex]!.start : sql.length;

    clauses[boundary.name] = {
      name: boundary.name,
      text: sql.slice(contentStart, contentEnd).trim(),
      start: contentStart,
      end: contentEnd,
    };
  }

  return clauses;
}

function findTokenIndexAtOrAfter(tokens: SqlToken[], offset: number): number {
  const index = tokens.findIndex((token) => token.start >= offset);
  return index === -1 ? tokens.length : index;
}

function collectClauseTokens(
  tokens: SqlToken[],
  clause: SqlClause | undefined,
): SqlToken[] {
  if (!clause) {
    return [];
  }

  const startIndex = findTokenIndexAtOrAfter(tokens, clause.start);
  const endIndex = findTokenIndexAtOrAfter(tokens, clause.end);
  return tokens.slice(startIndex, endIndex);
}

function readQualifiedIdentifier(
  tokens: SqlToken[],
  startIndex: number,
  endIndex: number,
): { name: string; nextIndex: number } | null {
  const first = tokens[startIndex];

  if (!isWordLikeToken(first)) {
    return null;
  }

  const parts = [normalizedIdentifier(first)];
  let index = startIndex + 1;

  while (
    index + 1 < endIndex &&
    tokens[index]?.kind === "symbol" &&
    tokens[index]?.value === "." &&
    isWordLikeToken(tokens[index + 1])
  ) {
    parts.push(normalizedIdentifier(tokens[index + 1]!));
    index += 2;
  }

  return {
    name: parts.join("."),
    nextIndex: index,
  };
}

function pushUnique(target: string[], values: string[]): void {
  for (const value of values) {
    if (!target.includes(value)) {
      target.push(value);
    }
  }
}

function sliceTokens(tokens: SqlToken[], startIndex: number, endIndex: number): SqlToken[] {
  return tokens.slice(Math.max(0, startIndex), Math.max(startIndex, endIndex));
}

function collectIdentifierReferences(tokens: SqlToken[]): string[] {
  const references: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (!isWordLikeToken(token)) {
      continue;
    }

    const next = tokens[index + 1];

    if (next?.kind === "symbol" && next.value === "(") {
      continue;
    }

    const previous = tokens[index - 1];

    if (previous?.kind === "symbol" && previous.value === ".") {
      continue;
    }

    const currentName = normalizedIdentifier(token);
    const nextDot = tokens[index + 1];
    const nextName = tokens[index + 2];

    if (nextDot?.kind === "symbol" && nextDot.value === "." && isWordLikeToken(nextName)) {
      references.push(normalizedIdentifier(nextName));
      continue;
    }

    references.push(currentName);
  }

  return Array.from(new Set(references));
}

function extractColumnsFromPredicateTokens(tokens: SqlToken[]): string[] {
  const columns: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (!token) {
      continue;
    }

    const operator =
      token.kind === "symbol"
        ? token.value
        : token.kind === "word"
          ? token.upper
          : undefined;

    if (!operator || !OPERATORS.has(operator)) {
      continue;
    }

    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const candidate = tokens[cursor];

      if (!candidate) {
        continue;
      }

      if (candidate.kind === "symbol" && ["(", ")", ",", "="].includes(candidate.value)) {
        continue;
      }

      const qualified = readQualifiedIdentifier(tokens, cursor, index);

      if (qualified) {
        const parts = qualified.name.split(".");
        columns.push(parts[parts.length - 1]!);
        break;
      }

      if (candidate.kind === "word" && ["TRUE", "FALSE", "NULL"].includes(candidate.upper ?? "")) {
        break;
      }
    }
  }

  return Array.from(new Set(columns));
}

function collectFunctions(tokens: SqlToken[]): {
  functions: string[];
  hasAggregation: boolean;
  hasWindowFunctions: boolean;
} {
  const functions: string[] = [];
  let hasAggregation = false;
  let hasWindowFunctions = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = tokens[index + 1];

    if (!isWordLikeToken(token) || next?.kind !== "symbol" || next.value !== "(") {
      continue;
    }

    const upper = token.kind === "word" ? token.upper ?? "" : "";

    if (upper && FUNCTION_KEYWORD_EXCLUSIONS.has(upper)) {
      continue;
    }

    const name = normalizedIdentifier(token);

    if (!functions.includes(name)) {
      functions.push(name);
    }

    if (AGGREGATE_FUNCTIONS.has(name)) {
      hasAggregation = true;
    }

    const closeIndex = findMatchingParen(tokens, index + 1, tokens.length);

    if (closeIndex !== -1 && tokens[closeIndex + 1]?.kind === "word" && tokens[closeIndex + 1]!.upper === "OVER") {
      hasWindowFunctions = true;
    }
  }

  return {
    functions,
    hasAggregation,
    hasWindowFunctions,
  };
}

function detectSelectStar(tokens: SqlToken[]): boolean {
  let depth = 0;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token?.kind === "symbol") {
      if (token.value === "(") {
        depth += 1;
        continue;
      }

      if (token.value === ")") {
        depth = Math.max(0, depth - 1);
        continue;
      }
    }

    if (depth !== 0) {
      continue;
    }

    if (token?.kind === "symbol" && token.value === "*") {
      return true;
    }

    if (
      isWordLikeToken(token) &&
      tokens[index + 1]?.kind === "symbol" &&
      tokens[index + 1]!.value === "." &&
      tokens[index + 2]?.kind === "symbol" &&
      tokens[index + 2]!.value === "*"
    ) {
      return true;
    }
  }

  return false;
}

function normalizeJoinKind(tokens: SqlToken[], joinIndex: number): string {
  const parts: string[] = [];
  let cursor = joinIndex - 1;

  while (cursor >= 0) {
    const token = tokens[cursor];

    if (token?.kind !== "word" || !JOIN_MODIFIER_WORDS.has(token.upper ?? "")) {
      break;
    }

    parts.unshift(token.upper!.toLowerCase());
    cursor -= 1;
  }

  parts.push("join");
  return parts.join(" ");
}

function extractTopLevelTablesAndJoins(fromTokens: SqlToken[]): {
  tables: string[];
  joins: SqlJoinNode[];
  joinColumns: string[];
  hasCartesianJoinRisk: boolean;
} {
  const tables: string[] = [];
  const joins: SqlJoinNode[] = [];
  const joinColumns: string[] = [];
  let hasCartesianJoinRisk = false;
  let depth = 0;
  let expectTable = true;

  for (let index = 0; index < fromTokens.length; index += 1) {
    const token = fromTokens[index];

    if (!token) {
      continue;
    }

    if (token.kind === "symbol") {
      if (token.value === "(") {
        depth += 1;
      } else if (token.value === ")") {
        depth = Math.max(0, depth - 1);
      } else if (depth === 0 && token.value === ",") {
        expectTable = true;
      }

      continue;
    }

    if (depth !== 0) {
      continue;
    }

    if (token.kind === "word" && token.upper === "JOIN") {
      const joinKind = normalizeJoinKind(fromTokens, index);
      let cursor = index + 1;

      while (
        cursor < fromTokens.length &&
        fromTokens[cursor]?.kind === "word" &&
        ["LATERAL", "ONLY"].includes(fromTokens[cursor]!.upper ?? "")
      ) {
        cursor += 1;
      }

      const table = readQualifiedIdentifier(fromTokens, cursor, fromTokens.length);
      const tableName = table?.name ?? null;

      if (tableName && !tables.includes(tableName)) {
        tables.push(tableName);
      }

      const conditionStart = table?.nextIndex ?? cursor;
      let conditionEnd = fromTokens.length;
      let nestedDepth = 0;

      for (let scan = conditionStart; scan < fromTokens.length; scan += 1) {
        const candidate = fromTokens[scan];

        if (candidate?.kind === "symbol") {
          if (candidate.value === "(") {
            nestedDepth += 1;
          } else if (candidate.value === ")") {
            nestedDepth = Math.max(0, nestedDepth - 1);
          }
          continue;
        }

        if (
          nestedDepth === 0 &&
          candidate?.kind === "word" &&
          (candidate.upper === "JOIN" || candidate.upper === "WHERE" || candidate.upper === "GROUP" || candidate.upper === "ORDER")
        ) {
          conditionEnd = scan;
          break;
        }
      }

      let hasConstraint = false;
      let conditionTokens: SqlToken[] = [];

      for (let scan = conditionStart; scan < conditionEnd; scan += 1) {
        const candidate = fromTokens[scan];

        if (candidate?.kind === "word" && (candidate.upper === "ON" || candidate.upper === "USING")) {
          hasConstraint = true;
          conditionTokens = sliceTokens(fromTokens, scan + 1, conditionEnd);
          break;
        }
      }

      const columns = hasConstraint ? collectIdentifierReferences(conditionTokens) : [];
      pushUnique(joinColumns, columns);

      const isCartesianRisk =
        !hasConstraint || joinKind.includes("cross");

      if (isCartesianRisk) {
        hasCartesianJoinRisk = true;
      }

      joins.push({
        kind: joinKind,
        table: tableName,
        condition:
          hasConstraint && conditionTokens.length > 0
            ? conditionTokens.map((part) => part.value).join(" ")
            : "",
        columns,
        hasConstraint,
        isCartesianRisk,
      });

      expectTable = false;
      continue;
    }

    if (!expectTable) {
      continue;
    }

    if (token.kind === "word" && ["LATERAL", "ONLY"].includes(token.upper ?? "")) {
      continue;
    }

    const table = readQualifiedIdentifier(fromTokens, index, fromTokens.length);

    if (!table) {
      continue;
    }

    if (!tables.includes(table.name)) {
      tables.push(table.name);
    }

    index = table.nextIndex - 1;
    expectTable = false;
  }

  return {
    tables,
    joins,
    joinColumns,
    hasCartesianJoinRisk,
  };
}

function extractLeadingTable(clauseTokens: SqlToken[]): string[] {
  let index = 0;

  while (
    index < clauseTokens.length &&
    clauseTokens[index]?.kind === "word" &&
    ["LATERAL", "ONLY", "TABLE"].includes(clauseTokens[index]!.upper ?? "")
  ) {
    index += 1;
  }

  const table = readQualifiedIdentifier(clauseTokens, index, clauseTokens.length);

  if (!table) {
    return [];
  }

  return [table.name];
}

function collectSubqueries(sql: string, tokens: SqlToken[]): ParsedSqlAst[] {
  const subqueries: ParsedSqlAst[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token?.kind !== "symbol" || token.value !== "(") {
      continue;
    }

    const closeIndex = findMatchingParen(tokens, index, tokens.length);

    if (closeIndex === -1) {
      break;
    }

    const firstInner = tokens[index + 1];

    if (firstInner?.kind === "word" && (firstInner.upper === "SELECT" || firstInner.upper === "WITH")) {
      const nestedSql = sql.slice(token.end, tokens[closeIndex]!.start).trim();

      if (nestedSql.length > 0) {
        const parsed = parseSqlToAst(nestedSql);

        if (!isSqlParseError(parsed)) {
          subqueries.push(parsed);
        }
      }

      index = closeIndex;
    }
  }

  return subqueries;
}

export function isSqlParseError(value: ParsedSqlAst | SqlParseError): value is SqlParseError {
  return value.kind === "parse_error";
}

export function parseSqlToAst(sql: string): ParsedSqlAst | SqlParseError {
  const normalizedSql = sql.replace(/\r\n/g, "\n").trim();

  if (normalizedSql.length === 0) {
    return createParseError("SQL is empty.");
  }

  const tokenized = tokenizeSql(normalizedSql);

  if (!tokenized.ok) {
    return tokenized.error;
  }

  const tokens = tokenized.tokens;
  const parenthesisError = validateBalancedParentheses(tokens);

  if (parenthesisError) {
    return parenthesisError;
  }

  const leadingCtes = readLeadingCtes(tokens, normalizedSql);

  if (isParseFailure(leadingCtes)) {
    return leadingCtes;
  }

  const statementType = resolveStatementType(tokens, leadingCtes.nextIndex);
  const clauses = buildClauses(
    normalizedSql,
    tokens,
    collectClauseBoundaries(tokens, leadingCtes.nextIndex, clauseDefinitionsFor(statementType)),
  );
  const selectTokens = collectClauseTokens(tokens, clauses.SELECT);
  const fromTokens = collectClauseTokens(tokens, clauses.FROM);
  const whereTokens = collectClauseTokens(tokens, clauses.WHERE);
  const updateTokens = collectClauseTokens(tokens, clauses.UPDATE);
  const insertTokens = collectClauseTokens(tokens, clauses["INSERT INTO"]);
  const deleteTokens = collectClauseTokens(tokens, clauses["DELETE FROM"]);
  const usingTokens = collectClauseTokens(tokens, clauses.USING);
  const truncateTokens = statementType === "TRUNCATE" ? tokens.slice(1) : [];
  const relationInfo = extractTopLevelTablesAndJoins(fromTokens);
  const tables = [...relationInfo.tables];

  switch (statementType) {
    case "UPDATE":
      pushUnique(tables, extractLeadingTable(updateTokens));
      break;
    case "INSERT":
      pushUnique(tables, extractLeadingTable(insertTokens));
      break;
    case "DELETE":
      pushUnique(tables, extractLeadingTable(deleteTokens));
      pushUnique(tables, usingTokens.length > 0 ? extractTopLevelTablesAndJoins(usingTokens).tables : []);
      break;
    case "TRUNCATE":
      pushUnique(tables, extractLeadingTable(truncateTokens));
      break;
    default:
      break;
  }

  const functionAnalysis = collectFunctions(tokens);
  const subqueries = collectSubqueries(normalizedSql, tokens);
  const subqueryDepth =
    subqueries.length === 0
      ? 0
      : 1 + Math.max(...subqueries.map((subquery) => subquery.subqueryDepth));

  return {
    kind: "statement",
    sql: normalizedSql,
    normalizedSql,
    statementType,
    parseConfidence: "high",
    cteNames: leadingCtes.cteNames,
    clauses,
    tables,
    joins: relationInfo.joins,
    whereColumns: extractColumnsFromPredicateTokens(whereTokens),
    joinColumns: relationInfo.joinColumns,
    functions: functionAnalysis.functions,
    selectStar: detectSelectStar(selectTokens),
    hasAggregation: functionAnalysis.hasAggregation,
    hasWindowFunctions: functionAnalysis.hasWindowFunctions,
    subqueries,
    subqueryDepth,
  };
}
