import type { QueryFeatures } from "../types";
import {
  isSqlParseError,
  parseSqlToAst,
  type ParsedSqlAst,
} from "../parse/pgParser";
import { extractFallbackFeatures } from "./tokenizerFallback";

function createFeaturesFromAst(ast: ParsedSqlAst): QueryFeatures {
  const childFeatures = ast.subqueries.map((subquery) => createFeaturesFromAst(subquery));
  const joinColumns = [...ast.joinColumns];
  const whereColumns = [...ast.whereColumns];
  const functionNames = [...ast.functions];
  let tableCount = ast.tables.length;
  let joinCount = ast.joins.length;
  let cteCount = ast.cteNames.length;
  let hasAggregation = ast.hasAggregation;
  let hasWindowFunctions = ast.hasWindowFunctions;
  let hasCartesianJoinRisk = ast.joins.some((join) => join.isCartesianRisk);

  for (const child of childFeatures) {
    tableCount += child.table_count;
    joinCount += child.join_count;
    cteCount += child.cte_count;
    hasAggregation = hasAggregation || child.has_aggregation;
    hasWindowFunctions = hasWindowFunctions || child.has_window_functions;
    hasCartesianJoinRisk = hasCartesianJoinRisk || child.has_cartesian_join_risk;

    for (const name of child.where_columns) {
      if (!whereColumns.includes(name)) {
        whereColumns.push(name);
      }
    }

    for (const name of child.join_columns) {
      if (!joinColumns.includes(name)) {
        joinColumns.push(name);
      }
    }

    for (const name of child.uses_functions) {
      if (!functionNames.includes(name)) {
        functionNames.push(name);
      }
    }
  }

  return {
    statement_type: ast.statementType,
    select_star: ast.selectStar,
    tables: ast.tables,
    table_count: tableCount,
    join_count: joinCount,
    where_present: Boolean(ast.clauses.WHERE),
    limit_present: Boolean(ast.clauses.LIMIT),
    order_by_present: Boolean(ast.clauses["ORDER BY"]),
    group_by_present: Boolean(ast.clauses["GROUP BY"]),
    cte_count: cteCount,
    subquery_depth: ast.subqueryDepth,
    has_cartesian_join_risk: hasCartesianJoinRisk,
    where_columns: whereColumns,
    join_columns: joinColumns,
    uses_functions: functionNames,
    has_aggregation: hasAggregation,
    has_window_functions: hasWindowFunctions,
    parse_confidence: ast.parseConfidence,
  };
}

export function extractQueryFeaturesFromAst(ast: ParsedSqlAst): QueryFeatures {
  return createFeaturesFromAst(ast);
}

export function extractQueryFeatures(sql: string): QueryFeatures {
  const parsed = parseSqlToAst(sql);

  if (isSqlParseError(parsed)) {
    return extractFallbackFeatures(sql);
  }

  return createFeaturesFromAst(parsed);
}
