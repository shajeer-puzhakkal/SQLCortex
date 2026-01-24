import type { SchemaMetadataResponse, TableInfo } from "../api/types";

export type SchemaAnalysis = {
  findings: string[];
  suggestions: string[];
  warnings: string[];
  assumptions: string[];
  explanation: string | null;
  stats: {
    tableCount: number;
    viewCount: number;
    columnCount: number;
    foreignKeyCount: number;
    indexCount: number;
  };
};

type MermaidDiagram = {
  diagram: string;
  relationshipCount: number;
  excludedRelationships: number;
  sanitizedEntities: number;
  sanitizedFields: number;
};

const FK_SUFFIXES = ["_id", "_uuid"];
const AUDIT_CREATED = new Set(["createdat", "createdon"]);
const AUDIT_UPDATED = new Set(["updatedat", "updatedon"]);
const AUDIT_DELETED = new Set(["deletedat", "deletedon"]);

export function analyzeSchemaMetadata(metadata: SchemaMetadataResponse): SchemaAnalysis {
  const tables = metadata.tables.filter((table) => table.type === "table");
  const views = metadata.tables.filter((table) => table.type === "view");
  const columnCount = tables.reduce((sum, table) => sum + table.columns.length, 0);
  const foreignKeyCount = tables.reduce((sum, table) => sum + table.foreignKeys.length, 0);
  const indexCount = tables.reduce((sum, table) => sum + table.indexes.length, 0);

  const missingForeignKeys = findMissingForeignKeys(tables);
  const missingIndexes = findMissingIndexesOnForeignKeys(tables);
  const joinTableIssues = findJoinTableIssues(tables);
  const namingIssues = findNamingIssues(tables);
  const auditIssues = findAuditIssues(tables);

  const warnings: string[] = [];
  if (tables.length === 0) {
    warnings.push("No tables found in schema.");
  }
  if (views.length > 0) {
    warnings.push(`Views excluded from analysis (${views.length}).`);
  }

  const assumptions = [
    "Missing foreign keys inferred from *_id and *_uuid columns within the same schema.",
    "Foreign key index checks require an index whose leading columns match the FK columns.",
    "Join table heuristic targets tables with 2+ foreign keys and few non-FK columns.",
  ];

  const explanation = `Analyzed schema ${metadata.schema} with ${tables.length} tables, ${columnCount} columns, ${foreignKeyCount} foreign keys, and ${indexCount} indexes.`;

  return {
    findings: [...missingForeignKeys, ...missingIndexes, ...joinTableIssues],
    suggestions: [...namingIssues, ...auditIssues],
    warnings,
    assumptions,
    explanation,
    stats: {
      tableCount: tables.length,
      viewCount: views.length,
      columnCount,
      foreignKeyCount,
      indexCount,
    },
  };
}

export function buildSchemaErdMarkdown(
  metadata: SchemaMetadataResponse,
  analysis: SchemaAnalysis
): string {
  const diagram = buildMermaidDiagram(metadata);
  const improvements = dedupeList([...analysis.findings, ...analysis.suggestions]);
  if (improvements.length === 0) {
    improvements.push("No immediate improvements detected based on current heuristics.");
  }

  const explanationLines = [
    `Tables: ${analysis.stats.tableCount}`,
    `Views: ${analysis.stats.viewCount}`,
    `Columns: ${analysis.stats.columnCount}`,
    `Foreign keys: ${analysis.stats.foreignKeyCount}`,
    `Indexes: ${analysis.stats.indexCount}`,
    `Relationships in diagram: ${diagram.relationshipCount}`,
  ];
  if (diagram.excludedRelationships > 0) {
    explanationLines.push(
      `Relationships excluded (cross-schema): ${diagram.excludedRelationships}`
    );
  }
  if (diagram.sanitizedEntities > 0 || diagram.sanitizedFields > 0) {
    explanationLines.push("Entity and field names sanitized for Mermaid compatibility.");
  }

  const advantages = [
    "Clarifies ownership and join paths for faster query design.",
    "Highlights constraint gaps and indexing opportunities.",
    "Creates a shared model for onboarding and review discussions.",
  ];

  return [
    `# Schema ERD: ${metadata.schema}`,
    "",
    "## Diagram",
    "```mermaid",
    diagram.diagram,
    "```",
    "",
    "## Schema Explanation",
    ...explanationLines.map((line) => `- ${line}`),
    "",
    "## Recommended Improvements",
    ...improvements.map((item) => `- ${item}`),
    "",
    "## Advantages",
    ...advantages.map((item) => `- ${item}`),
    "",
  ].join("\n");
}

function findMissingForeignKeys(tables: TableInfo[]): string[] {
  const tableNames = new Map<string, string>();
  for (const table of tables) {
    tableNames.set(table.name.toLowerCase(), table.name);
  }

  const results: string[] = [];
  const seen = new Set<string>();

  for (const table of tables) {
    const fkColumns = new Set<string>();
    for (const foreignKey of table.foreignKeys) {
      for (const column of foreignKey.columns) {
        fkColumns.add(column);
      }
    }

    for (const column of table.columns) {
      if (fkColumns.has(column.name)) {
        continue;
      }

      const base = inferForeignKeyBase(column.name);
      if (!base) {
        continue;
      }

      const target = matchTargetTable(base, tableNames);
      if (!target) {
        continue;
      }

      const key = `${table.name}.${column.name}->${target}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      results.push(`Possible missing FK: ${table.name}.${column.name} -> ${target}`);
    }
  }

  return results;
}

function findMissingIndexesOnForeignKeys(tables: TableInfo[]): string[] {
  const results: string[] = [];

  for (const table of tables) {
    if (table.foreignKeys.length === 0) {
      continue;
    }

    for (const foreignKey of table.foreignKeys) {
      if (foreignKey.columns.length === 0) {
        continue;
      }

      const hasIndex = table.indexes.some((index) =>
        indexCoversColumns(index.columns, foreignKey.columns)
      );
      if (!hasIndex) {
        const target = `${foreignKey.foreignSchema}.${foreignKey.foreignTable}`;
        results.push(
          `Missing index on FK columns: ${table.name} (${foreignKey.columns.join(
            ", "
          )}) -> ${target}`
        );
      }
    }
  }

  return results;
}

function findJoinTableIssues(tables: TableInfo[]): string[] {
  const results: string[] = [];

  for (const table of tables) {
    if (table.foreignKeys.length < 2) {
      continue;
    }

    const fkColumns = dedupeList(
      table.foreignKeys.flatMap((foreignKey) => foreignKey.columns)
    );
    if (fkColumns.length < 2) {
      continue;
    }

    const fkColumnSet = new Set(fkColumns);
    const nonFkColumns = table.columns.filter(
      (column) => !fkColumnSet.has(column.name) && !isAuditColumn(column.name)
    );

    if (nonFkColumns.length > 1) {
      continue;
    }

    const hasCompositeKey = table.indexes.some(
      (index) =>
        (index.primary || index.unique) && indexIncludesAll(index.columns, fkColumns)
    );
    if (!hasCompositeKey) {
      results.push(
        `Join table candidate ${table.name} lacks composite primary/unique key on (${fkColumns.join(
          ", "
        )}).`
      );
    }
  }

  return results;
}

function findNamingIssues(tables: TableInfo[]): string[] {
  const results: string[] = [];
  const snakeCase = /^[a-z0-9_]+$/;

  for (const table of tables) {
    if (!snakeCase.test(table.name)) {
      results.push(`Table name "${table.name}" is not snake_case.`);
    }
  }

  return results;
}

function findAuditIssues(tables: TableInfo[]): string[] {
  const results: string[] = [];

  for (const table of tables) {
    const normalized = new Set(
      table.columns.map((column) => normalizeName(column.name))
    );

    const hasCreated = hasAudit(normalized, AUDIT_CREATED);
    const hasUpdated = hasAudit(normalized, AUDIT_UPDATED);
    if (hasCreated && hasUpdated) {
      continue;
    }

    const missing: string[] = [];
    if (!hasCreated) {
      missing.push("created_at");
    }
    if (!hasUpdated) {
      missing.push("updated_at");
    }

    results.push(`Table ${table.name} missing audit columns: ${missing.join(", ")}.`);
  }

  return results;
}

function buildMermaidDiagram(metadata: SchemaMetadataResponse): MermaidDiagram {
  const tables = metadata.tables.filter((table) => table.type === "table");
  const entityNames = new Map<string, string>();
  let sanitizedEntities = 0;
  let sanitizedFields = 0;

  for (const table of tables) {
    const sanitized = sanitizeMermaidIdentifier(table.name);
    if (sanitized !== table.name) {
      sanitizedEntities += 1;
    }
    entityNames.set(table.name, sanitized);
    entityNames.set(table.name.toLowerCase(), sanitized);
  }

  const lines: string[] = [
    "%%{init: {'er': {'layoutDirection': 'LR'}}}%%",
    "erDiagram",
  ];

  for (const table of tables) {
    const entityName = resolveEntityName(entityNames, table.name) ?? table.name;
    const primaryKeys = collectPrimaryKeyColumns(table);
    const foreignKeys = collectForeignKeyColumns(table);
    lines.push(`  ${entityName} {`);
    for (const column of table.columns) {
      const type = sanitizeMermaidType(column.type);
      const field = sanitizeMermaidField(column.name);
      if (field !== column.name) {
        sanitizedFields += 1;
      }
      const attributeMeta = resolveAttributeMeta(column.name, primaryKeys, foreignKeys);
      lines.push(`    ${type} ${field}${attributeMeta}`);
    }
    lines.push("  }");
  }

  let relationshipCount = 0;
  let excludedRelationships = 0;

  const schemaName = metadata.schema.replace(/"/g, "").toLowerCase();
  for (const table of tables) {
    for (const foreignKey of table.foreignKeys) {
      const foreignSchema = foreignKey.foreignSchema
        ? foreignKey.foreignSchema.replace(/"/g, "").toLowerCase()
        : "";
      if (foreignSchema && foreignSchema !== schemaName) {
        excludedRelationships += 1;
        continue;
      }

      const from = resolveEntityName(entityNames, foreignKey.foreignTable);
      const to = resolveEntityName(entityNames, table.name);
      if (!from || !to) {
        excludedRelationships += 1;
        continue;
      }

      const fkColumns = foreignKey.columns;
      const isNullable = isForeignKeyNullable(table, fkColumns);
      const isUnique = isForeignKeyUnique(table, fkColumns);
      const childCardinality = resolveChildCardinality(isNullable, isUnique);

      const label = foreignKey.name ? sanitizeMermaidLabel(foreignKey.name) : "";
      const suffix = label ? ` : "${label}"` : "";
      lines.push(`  ${from} ||--${childCardinality} ${to}${suffix}`);
      relationshipCount += 1;
    }
  }

  return {
    diagram: lines.join("\n"),
    relationshipCount,
    excludedRelationships,
    sanitizedEntities,
    sanitizedFields,
  };
}

function isForeignKeyNullable(table: TableInfo, fkColumns: string[]): boolean {
  if (fkColumns.length === 0) {
    return true;
  }
  const columnMap = new Map<string, boolean>();
  for (const column of table.columns) {
    columnMap.set(column.name, column.nullable);
  }
  return fkColumns.some((column) => columnMap.get(column) !== false);
}

function isForeignKeyUnique(table: TableInfo, fkColumns: string[]): boolean {
  if (fkColumns.length === 0) {
    return false;
  }
  return table.indexes.some((index) => {
    if (!index.primary && !index.unique) {
      return false;
    }
    const normalized = normalizeIndexColumns(index.columns);
    return sameColumns(normalized, fkColumns);
  });
}

function resolveChildCardinality(isNullable: boolean, isUnique: boolean): string {
  if (isUnique) {
    return isNullable ? "o|" : "||";
  }
  return isNullable ? "o{" : "|{";
}

function sameColumns(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const set = new Set(left);
  for (const column of right) {
    if (!set.has(column)) {
      return false;
    }
  }
  return true;
}

function normalizeIndexColumns(columns: string[]): string[] {
  const normalized: string[] = [];
  for (const column of columns) {
    const value = normalizeIndexColumn(column);
    if (value) {
      normalized.push(value);
    }
  }
  return normalized;
}

function normalizeIndexColumn(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const withoutCast = trimmed.split("::")[0].trim();
  const raw = withoutCast.replace(/^\(+|\)+$/g, "").trim();
  return extractIdentifier(raw);
}

function extractIdentifier(value: string): string | null {
  const unquoted = value.replace(/"/g, "");
  const parts = unquoted.split(".");
  const tail = parts[parts.length - 1]?.trim() ?? "";
  if (!tail) {
    return null;
  }
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(tail) ? tail : null;
}

function inferForeignKeyBase(columnName: string): string | null {
  const normalized = columnName.toLowerCase();
  for (const suffix of FK_SUFFIXES) {
    if (normalized.endsWith(suffix)) {
      const base = normalized.slice(0, -suffix.length);
      return base || null;
    }
  }
  return null;
}

function matchTargetTable(
  base: string,
  tableNames: Map<string, string>
): string | null {
  const candidates = new Set<string>();
  candidates.add(base);
  candidates.add(`${base}s`);
  candidates.add(`${base}es`);
  if (base.endsWith("y") && base.length > 1) {
    candidates.add(`${base.slice(0, -1)}ies`);
  }

  for (const candidate of candidates) {
    const match = tableNames.get(candidate);
    if (match) {
      return match;
    }
  }
  return null;
}

function indexCoversColumns(indexColumns: string[], targetColumns: string[]): boolean {
  const normalized = normalizeIndexColumns(indexColumns);
  if (normalized.length < targetColumns.length) {
    return false;
  }
  for (let index = 0; index < targetColumns.length; index += 1) {
    if (normalized[index] !== targetColumns[index]) {
      return false;
    }
  }
  return true;
}

function indexIncludesAll(indexColumns: string[], targetColumns: string[]): boolean {
  const normalized = normalizeIndexColumns(indexColumns);
  return targetColumns.every((column) => normalized.includes(column));
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function hasAudit(normalized: Set<string>, options: Set<string>): boolean {
  for (const entry of options) {
    if (normalized.has(entry)) {
      return true;
    }
  }
  return false;
}

function isAuditColumn(columnName: string): boolean {
  const normalized = normalizeName(columnName);
  return (
    AUDIT_CREATED.has(normalized) ||
    AUDIT_UPDATED.has(normalized) ||
    AUDIT_DELETED.has(normalized)
  );
}

function sanitizeMermaidIdentifier(value: string): string {
  const trimmed = value.trim();
  const safe = /^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed);
  if (safe) {
    return trimmed;
  }
  const sanitized = trimmed.replace(/[^A-Za-z0-9_]/g, "_");
  if (!sanitized) {
    return "entity";
  }
  if (/^[A-Za-z_]/.test(sanitized)) {
    return sanitized;
  }
  return `_${sanitized}`;
}

function sanitizeMermaidField(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "field";
  }
  const safe = /^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed);
  if (safe) {
    return trimmed;
  }
  const sanitized = trimmed.replace(/[^A-Za-z0-9_]/g, "_");
  if (/^[A-Za-z_]/.test(sanitized)) {
    return sanitized;
  }
  return `_${sanitized}`;
}

function sanitizeMermaidType(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "text";
  }
  const sanitized = trimmed.replace(/[^A-Za-z0-9_]/g, "_");
  return sanitized || "text";
}

function sanitizeMermaidLabel(value: string): string {
  return value.replace(/"/g, "'").trim();
}

function resolveEntityName(map: Map<string, string>, name: string): string | null {
  const sanitized = name.replace(/"/g, "");
  const direct = map.get(sanitized);
  if (direct) {
    return direct;
  }
  const lower = sanitized.toLowerCase();
  const normalized = map.get(lower);
  if (normalized) {
    return normalized;
  }
  const parts = sanitized.split(".");
  const tail = parts[parts.length - 1]?.trim();
  if (!tail) {
    return null;
  }
  return map.get(tail) ?? map.get(tail.toLowerCase()) ?? null;
}

function collectPrimaryKeyColumns(table: TableInfo): Set<string> {
  const columns = new Set<string>();
  for (const index of table.indexes) {
    if (!index.primary) {
      continue;
    }
    for (const column of index.columns) {
      const normalized = normalizeIndexColumn(column);
      if (normalized) {
        columns.add(normalized);
        columns.add(normalized.toLowerCase());
      }
    }
  }
  if (columns.size === 0) {
    for (const inferred of inferPrimaryKeyCandidates(table)) {
      columns.add(inferred);
    }
  }
  return columns;
}

function collectForeignKeyColumns(table: TableInfo): Set<string> {
  const columns = new Set<string>();
  for (const foreignKey of table.foreignKeys) {
    for (const column of foreignKey.columns) {
      columns.add(column);
      columns.add(column.toLowerCase());
    }
  }
  return columns;
}

function resolveAttributeMeta(
  columnName: string,
  primaryKeys: Set<string>,
  foreignKeys: Set<string>
): string {
  const normalized = columnName.toLowerCase();
  if (primaryKeys.has(columnName) || primaryKeys.has(normalized)) {
    return " PK";
  }
  if (foreignKeys.has(columnName) || foreignKeys.has(normalized)) {
    return " FK";
  }
  return "";
}

function inferPrimaryKeyCandidates(table: TableInfo): string[] {
  const columnNames = new Set(table.columns.map((column) => column.name.toLowerCase()));
  const tableName = table.name.toLowerCase();
  const candidates = buildPrimaryKeyCandidates(tableName);
  const inferred: string[] = [];

  for (const candidate of candidates) {
    if (columnNames.has(candidate)) {
      inferred.push(candidate);
    }
  }

  if (inferred.length > 0) {
    return inferred;
  }

  const foreignKeys = collectForeignKeyColumns(table);
  if (foreignKeys.size >= 2) {
    const nonFkColumns = table.columns.filter(
      (column) => !foreignKeys.has(column.name) && !foreignKeys.has(column.name.toLowerCase())
    );
    if (nonFkColumns.length <= 1) {
      return Array.from(foreignKeys);
    }
  }

  return [];
}

function buildPrimaryKeyCandidates(tableName: string): string[] {
  const candidates: string[] = [];
  candidates.push("id");
  candidates.push(`${tableName}_id`);
  if (tableName.endsWith("ies") && tableName.length > 3) {
    candidates.push(`${tableName.slice(0, -3)}y_id`);
  }
  if (tableName.endsWith("es") && tableName.length > 2) {
    candidates.push(`${tableName.slice(0, -2)}_id`);
  }
  if (tableName.endsWith("s") && tableName.length > 1) {
    candidates.push(`${tableName.slice(0, -1)}_id`);
  }
  return candidates;
}

function dedupeList(items: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of items) {
    if (!item || seen.has(item)) {
      continue;
    }
    seen.add(item);
    output.push(item);
  }
  return output;
}
