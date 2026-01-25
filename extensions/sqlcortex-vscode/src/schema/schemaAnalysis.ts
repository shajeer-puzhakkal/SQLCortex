import type { SchemaMetadataResponse, TableInfo } from "../api/types";
import * as dagre from "dagre";

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
const ERD_STYLE = {
  headerHeight: 60,
  rowHeight: 40,
  headerFontSize: 16,
  rowFontSize: 14,
  badgeSize: 28,
  badgePadding: 16,
  bodyPadding: 12,
  minWidth: 300,
  basePadding: 32,
  averageCharWidth: 8,
} as const;

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
  const diagram = buildSchemaDiagramSvg(metadata);
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
    diagram.diagram,
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

export function buildSchemaErdHtml(
  metadata: SchemaMetadataResponse,
  analysis: SchemaAnalysis,
  nonce: string
): string {
  const diagram = buildSchemaDiagramSvg(metadata);
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

  const warnings = analysis.warnings.length ? analysis.warnings : [];
  const assumptions = analysis.assumptions.length ? analysis.assumptions : [];
  const suggestionNote =
    analysis.stats.tableCount > 80
      ? "Large schema detected. Consider filtering tables for a clearer view."
      : null;

  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
    "img-src data:",
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Schema ERD: ${escapeText(metadata.schema)}</title>
    <style>
      :root {
        color-scheme: light dark;
        --page-bg: #0f1115;
        --page-fg: #e6e9ef;
        --muted: #9aa4b2;
        --card-bg: #141821;
        --card-border: #2a3240;
        --toolbar-bg: #161b22;
        --toolbar-border: #2a3240;
        --toolbar-button-bg: #1b2230;
        --toolbar-button-hover: #273246;
        --diagram-bg: #0f1115;
        --diagram-border: #2a3240;
      }
      body {
        margin: 0;
        font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
        background: var(--page-bg);
        color: var(--page-fg);
      }
      .page {
        padding: 28px 32px 40px;
      }
      h1 {
        margin: 0 0 12px;
        font-size: 24px;
        font-weight: 600;
      }
      h2 {
        margin: 28px 0 12px;
        font-size: 14px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--muted);
      }
      .card {
        background: var(--card-bg);
        border: 1px solid var(--card-border);
        border-radius: 10px;
        padding: 16px;
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.04);
      }
      .toolbar {
        position: sticky;
        top: 0;
        z-index: 2;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 12px;
        padding: 10px 12px;
        background: var(--toolbar-bg);
        border: 1px solid var(--toolbar-border);
        border-radius: 10px;
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.04);
      }
      .toolbar button {
        border: 1px solid var(--toolbar-border);
        background: var(--toolbar-button-bg);
        color: var(--page-fg);
        padding: 6px 10px;
        border-radius: 6px;
        font-size: 12px;
        cursor: pointer;
      }
      .toolbar button:hover {
        background: var(--toolbar-button-hover);
      }
      .toolbar input[type="range"] {
        width: 160px;
      }
      .toolbar .zoom-value {
        font-size: 12px;
        color: var(--muted);
        min-width: 48px;
      }
      .diagram-shell {
        background: var(--diagram-bg);
        border-radius: 10px;
        border: 1px solid var(--diagram-border);
        padding: 12px;
        overflow: auto;
        max-height: 70vh;
      }
      .diagram-zoom {
        transform-origin: top left;
      }
      .diagram-svg {
        width: 100%;
        height: auto;
        min-width: 900px;
      }
      ul {
        margin: 0;
        padding-left: 18px;
        line-height: 1.6;
      }
      .muted {
        color: var(--muted);
        font-size: 12px;
      }
    </style>
  </head>
  <body>
    <div class="page">
      <h1>Schema ERD: ${escapeText(metadata.schema)}</h1>
      ${suggestionNote ? `<p class="muted">${escapeText(suggestionNote)}</p>` : ""}

      <h2>Diagram</h2>
      <div class="toolbar">
        <button id="zoomOut" type="button">-</button>
        <input id="zoomRange" type="range" min="40" max="220" value="140" />
        <button id="zoomIn" type="button">+</button>
        <button id="zoomReset" type="button">Reset</button>
        <button id="zoomFit" type="button">Fit Width</button>
        <span id="zoomValue" class="zoom-value">140%</span>
      </div>
      ${diagram.diagram}

      <h2>Schema Explanation</h2>
      <div class="card">
        <ul>
          ${explanationLines.map((line) => `<li>${escapeText(line)}</li>`).join("")}
        </ul>
      </div>

      <h2>Recommended Improvements</h2>
      <div class="card">
        <ul>
          ${improvements.map((item) => `<li>${escapeText(item)}</li>`).join("")}
        </ul>
      </div>

      <h2>Advantages</h2>
      <div class="card">
        <ul>
          <li>Clarifies ownership and join paths for faster query design.</li>
          <li>Highlights constraint gaps and indexing opportunities.</li>
          <li>Creates a shared model for onboarding and review discussions.</li>
        </ul>
      </div>

      ${
        warnings.length
          ? `<h2>Warnings</h2><div class="card"><ul>${warnings
              .map((item) => `<li>${escapeText(item)}</li>`)
              .join("")}</ul></div>`
          : ""
      }

      ${
        assumptions.length
          ? `<h2>Assumptions</h2><div class="card"><ul>${assumptions
              .map((item) => `<li>${escapeText(item)}</li>`)
              .join("")}</ul></div>`
          : ""
      }
    </div>
    <script nonce="${nonce}">
      const zoomRange = document.getElementById("zoomRange");
      const zoomValue = document.getElementById("zoomValue");
      const zoomOut = document.getElementById("zoomOut");
      const zoomIn = document.getElementById("zoomIn");
      const zoomReset = document.getElementById("zoomReset");
      const zoomFit = document.getElementById("zoomFit");
      const zoomTarget = document.querySelector(".diagram-zoom");
      const svg = document.getElementById("erdSvg");
      const shell = document.querySelector(".diagram-shell");

      function setZoom(value) {
        const clamped = Math.min(220, Math.max(40, value));
        if (zoomRange) {
          zoomRange.value = String(clamped);
        }
        if (zoomValue) {
          zoomValue.textContent = clamped + "%";
        }
        if (zoomTarget) {
          zoomTarget.style.transform = "scale(" + clamped / 100 + ")";
        }
      }

      function parseViewBoxWidth() {
        if (!svg) {
          return null;
        }
        const viewBox = svg.getAttribute("viewBox");
        if (!viewBox) {
          return null;
        }
        const parts = viewBox.split(" ").map(Number);
        if (parts.length < 4 || Number.isNaN(parts[2])) {
          return null;
        }
        return parts[2];
      }

      if (zoomRange) {
        zoomRange.addEventListener("input", () => {
          setZoom(Number(zoomRange.value));
        });
      }
      if (zoomOut) {
        zoomOut.addEventListener("click", () => {
          const current = Number(zoomRange ? zoomRange.value : 90);
          setZoom(current - 10);
        });
      }
      if (zoomIn) {
        zoomIn.addEventListener("click", () => {
          const current = Number(zoomRange ? zoomRange.value : 90);
          setZoom(current + 10);
        });
      }
      if (zoomReset) {
        zoomReset.addEventListener("click", () => setZoom(140));
      }
      if (zoomFit) {
        zoomFit.addEventListener("click", () => {
          if (!shell || !svg) {
            return;
          }
          const viewBoxWidth = parseViewBoxWidth();
          if (!viewBoxWidth) {
            return;
          }
          const available = shell.clientWidth - 24;
          const scale = Math.floor((available / viewBoxWidth) * 100);
          setZoom(scale);
        });
      }

      setZoom(140);
    </script>
  </body>
</html>`;
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

function buildSchemaDiagramSvg(metadata: SchemaMetadataResponse): MermaidDiagram {
  const tables = metadata.tables.filter((table) => table.type === "table");
  const entityNames = new Map<string, string>();
  const sanitizedEntities = 0;
  const sanitizedFields = 0;

  for (const table of tables) {
    entityNames.set(table.name, table.name);
    entityNames.set(table.name.toLowerCase(), table.name);
  }

  const layout = layoutTablesWithDagre(metadata, tables, entityNames);
  const lines: string[] = [];

  for (const edge of layout.edges) {
    lines.push(buildEdgePathSvg(edge));
  }

  for (const table of tables) {
    const primaryKeys = collectPrimaryKeyColumns(table);
    const foreignKeys = collectForeignKeyColumns(table);
    const title = resolveEntityName(entityNames, table.name) ?? table.name;
    const box = layout.nodes.get(title);
    if (!box) {
      continue;
    }
    const nodeLines = buildTableSvg(table, box, primaryKeys, foreignKeys);
    lines.push(...nodeLines);
  }

  const svg = wrapSvg(layout, lines.join("\n"));
  return {
    diagram: svg,
    relationshipCount: layout.edges.length,
    excludedRelationships: 0,
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

type LayoutNode = {
  id: string;
  title: string;
  columnIndex: number;
  rowIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  headerHeight: number;
  rowHeight: number;
};

type LayoutEdge = {
  path: string;
  cardinality: string;
  label?: string | null;
};

type LayoutResult = {
  nodes: Map<string, LayoutNode>;
  edges: LayoutEdge[];
  width: number;
  height: number;
  columnGap: number;
  columnChannels: number[];
};

function layoutTables(
  tables: TableInfo[],
  entityNames: Map<string, string>
): LayoutResult {
  const nodes = new Map<string, LayoutNode>();
  const tableCount = tables.length;
  const maxDepth = Math.max(tableCount - 1, 0);
  const levels = assignLevels(tables, entityNames, maxDepth);
  const levelKeys = Array.from(levels.keys()).sort((a, b) => a - b);
  const margin = 80;
  const columnGap = 260;
  const rowGap = 70;
  const rowGroupGap = 260;
  const headerHeight = 48;
  const rowHeight = 32;

  const levelWidths: number[] = [];
  const levelHeights: number[] = [];
  for (const level of levelKeys) {
    const tablesAtLevel = levels.get(level) ?? [];
    let maxWidth = 180;
    let totalHeight = margin;
    for (const table of tablesAtLevel) {
      const width = estimateTableWidth(table);
      if (width > maxWidth) {
        maxWidth = width;
      }
      totalHeight += headerHeight + rowHeight * table.columns.length + 12 + rowGap;
    }
    totalHeight = Math.max(totalHeight - rowGap + margin, margin + headerHeight + 12);
    levelWidths.push(maxWidth);
    levelHeights.push(totalHeight);
  }

  const columnsPerRow = resolveColumnsPerRow(tableCount, levelKeys.length);
  const columnSlots = Math.min(columnsPerRow, levelKeys.length);
  const slotWidths = new Array(columnSlots).fill(180);
  for (let index = 0; index < levelKeys.length; index += 1) {
    const slot = index % columnSlots;
    slotWidths[slot] = Math.max(slotWidths[slot], levelWidths[index] ?? 180);
  }

  const columnStarts: number[] = [];
  let x = margin;
  for (let slot = 0; slot < columnSlots; slot += 1) {
    columnStarts.push(x);
    x += slotWidths[slot] + columnGap;
  }
  const columnChannels = columnStarts.map(
    (start, slot) => start + slotWidths[slot] + columnGap / 2
  );

  const rowCount = Math.ceil(levelKeys.length / columnSlots);
  const rowHeights = new Array(rowCount).fill(0);
  for (let index = 0; index < levelKeys.length; index += 1) {
    const rowIndex = Math.floor(index / columnSlots);
    rowHeights[rowIndex] = Math.max(rowHeights[rowIndex], levelHeights[index] ?? 0);
  }
  const rowOffsets: number[] = [];
  let currentOffset = 0;
  for (let row = 0; row < rowCount; row += 1) {
    rowOffsets[row] = currentOffset;
    currentOffset += rowHeights[row] + rowGroupGap;
  }

  let overallHeight = margin;
  for (let index = 0; index < levelKeys.length; index += 1) {
    const level = levelKeys[index];
    const tablesAtLevel = levels.get(level) ?? [];
    const slot = index % columnSlots;
    const rowIndex = Math.floor(index / columnSlots);
    const columnWidth = slotWidths[slot] ?? 180;
    const stagger = slot % 2 === 1 ? rowHeight * 1.2 : 0;
    let y = margin + rowOffsets[rowIndex] + stagger;
    const sorted = [...tablesAtLevel].sort((a, b) => a.name.localeCompare(b.name));
    for (const table of sorted) {
      const title = resolveEntityName(entityNames, table.name) ?? table.name;
      const height = headerHeight + rowHeight * table.columns.length + 12;
      nodes.set(title, {
        id: table.name,
        title,
        columnIndex: slot,
        rowIndex,
        x: columnStarts[slot],
        y,
        width: columnWidth,
        height,
        headerHeight,
        rowHeight,
      });
      y += height + rowGap;
    }
    overallHeight = Math.max(overallHeight, y + margin);
  }

  const width = x + margin - columnGap;
  return { nodes, edges: [], width, height: overallHeight, columnGap, columnChannels };
}

function buildOrthogonalPath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) {
    return "";
  }
  const pathPoints: Array<{ x: number; y: number }> = [];
  const pushPoint = (point: { x: number; y: number }) => {
    const last = pathPoints[pathPoints.length - 1];
    if (!last || last.x !== point.x || last.y !== point.y) {
      pathPoints.push(point);
    }
  };

  pushPoint(points[0]);
  for (let index = 1; index < points.length; index += 1) {
    const current = points[index];
    const previous = pathPoints[pathPoints.length - 1];
    if (!previous) {
      pushPoint(current);
      continue;
    }
    if (previous.x === current.x || previous.y === current.y) {
      pushPoint(current);
      continue;
    }
    pushPoint({ x: current.x, y: previous.y });
    pushPoint(current);
  }

  return pathPoints
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");
}

function layoutTablesWithDagre(
  metadata: SchemaMetadataResponse,
  tables: TableInfo[],
  entityNames: Map<string, string>
): LayoutResult {
  const { headerHeight, rowHeight, bodyPadding } = ERD_STYLE;
  const graph = new dagre.graphlib.Graph({ multigraph: true });
  graph.setGraph({
    rankdir: "LR",
    nodesep: 180,
    ranksep: 360,
    edgesep: 60,
    marginx: 180,
    marginy: 180,
    ranker: "network-simplex",
  });
  graph.setDefaultEdgeLabel(() => ({}));

  const schemaName = metadata.schema.replace(/"/g, "").toLowerCase();
  const nodes = new Map<string, LayoutNode>();
  const edges: LayoutEdge[] = [];
  const edgeCounts = new Map<string, number>();

  for (const table of tables) {
    const title = resolveEntityName(entityNames, table.name) ?? table.name;
    const width = estimateTableWidth(table);
    const height = headerHeight + rowHeight * table.columns.length + bodyPadding * 2;
    graph.setNode(title, { width, height });
  }

  for (const table of tables) {
    for (const foreignKey of table.foreignKeys) {
      const foreignSchema = foreignKey.foreignSchema
        ? foreignKey.foreignSchema.replace(/"/g, "").toLowerCase()
        : "";
      if (foreignSchema && foreignSchema !== schemaName) {
        continue;
      }
      const from = resolveEntityName(entityNames, foreignKey.foreignTable);
      const to = resolveEntityName(entityNames, table.name);
      if (!from || !to || from === to) {
        continue;
      }
      const fkColumns = foreignKey.columns;
      const isNullable = isForeignKeyNullable(table, fkColumns);
      const isUnique = isForeignKeyUnique(table, fkColumns);
      const childCardinality = resolveChildCardinality(isNullable, isUnique);
      const keyBase = `${from}:${to}`;
      const count = (edgeCounts.get(keyBase) ?? 0) + 1;
      edgeCounts.set(keyBase, count);
      graph.setEdge(
        { v: from, w: to, name: `${keyBase}:${count}` },
        { cardinality: childCardinality, label: foreignKey.name ?? null }
      );
    }
  }

  dagre.layout(graph);

  let maxX = 0;
  let maxY = 0;
  graph.nodes().forEach((nodeId: string) => {
    const node = graph.node(nodeId) as { x: number; y: number; width: number; height: number };
    const x = node.x - node.width / 2;
    const y = node.y - node.height / 2;
    nodes.set(nodeId, {
      id: nodeId,
      title: nodeId,
      columnIndex: 0,
      rowIndex: 0,
      x,
      y,
      width: node.width,
      height: node.height,
      headerHeight,
      rowHeight,
    });
    maxX = Math.max(maxX, x + node.width);
    maxY = Math.max(maxY, y + node.height);
  });

  graph.edges().forEach((edgeObj: { v: string; w: string; name?: string }) => {
    const edge = graph.edge(edgeObj) as {
      points: Array<{ x: number; y: number }>;
      cardinality?: string;
      label?: string | null;
    };
    if (!edge?.points || edge.points.length === 0) {
      return;
    }
    const path = buildOrthogonalPath(edge.points);
    if (!path) {
      return;
    }
    edges.push({
      path,
      cardinality: edge.cardinality ?? "o{",
      label: edge.label ?? null,
    });
    for (const point of edge.points) {
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  });

  return {
    nodes,
    edges,
    width: maxX + 200,
    height: maxY + 200,
    columnGap: 0,
    columnChannels: [],
  };
}

function assignLevels(
  tables: TableInfo[],
  entityNames: Map<string, string>,
  maxDepth: number
): Map<number, TableInfo[]> {
  const tableMap = new Map<string, TableInfo>();
  for (const table of tables) {
    const key = resolveEntityName(entityNames, table.name) ?? table.name;
    tableMap.set(key, table);
  }

  const levels = new Map<string, number>();
  for (const table of tables) {
    const key = resolveEntityName(entityNames, table.name) ?? table.name;
    levels.set(key, 0);
  }

  for (let iteration = 0; iteration < tables.length; iteration += 1) {
    let changed = false;
    for (const table of tables) {
      const childKey = resolveEntityName(entityNames, table.name) ?? table.name;
      const childLevel = levels.get(childKey) ?? 0;
      for (const foreignKey of table.foreignKeys) {
        const parentKey = resolveEntityName(entityNames, foreignKey.foreignTable);
        if (!parentKey) {
          continue;
        }
        const parentLevel = levels.get(parentKey) ?? 0;
        const nextLevel = Math.min(parentLevel + 1, maxDepth);
        if (nextLevel > childLevel) {
          levels.set(childKey, nextLevel);
          changed = true;
        }
      }
    }
    if (!changed) {
      break;
    }
  }

  const grouped = new Map<number, TableInfo[]>();
  for (const table of tables) {
    const key = resolveEntityName(entityNames, table.name) ?? table.name;
    const level = levels.get(key) ?? 0;
    if (!grouped.has(level)) {
      grouped.set(level, []);
    }
    grouped.get(level)?.push(table);
  }

  return grouped;
}

function resolveColumnsPerRow(tableCount: number, levelCount: number): number {
  if (levelCount <= 3) {
    return levelCount;
  }
  if (tableCount > 90) {
    return Math.min(levelCount, 3);
  }
  if (tableCount > 50) {
    return Math.min(levelCount, 4);
  }
  return Math.min(levelCount, 5);
}

function estimateTableWidth(table: TableInfo): number {
  const { basePadding, badgeSize, minWidth } = ERD_STYLE;
  const badgeGap = 12;
  let max = estimateTextWidth(table.name) + basePadding * 2;
  for (const column of table.columns) {
    const labelWidth = estimateTextWidth(column.name);
    const width = basePadding + badgeSize + badgeGap + labelWidth + basePadding;
    if (width > max) {
      max = width;
    }
  }
  return Math.max(minWidth, Math.ceil(max));
}

function estimateTextWidth(text: string, averageCharWidth = ERD_STYLE.averageCharWidth): number {
  return text.length * averageCharWidth;
}

function buildTableSvg(
  table: TableInfo,
  node: LayoutNode,
  primaryKeys: Set<string>,
  foreignKeys: Set<string>
): string[] {
  const lines: string[] = [];
  const borderRadius = 10;
  const headerFill = "#2b313a";
  const headerText = "#f5f7fb";
  const bodyFill = "#171b23";
  const border = "#323a46";
  const rowText = "#e6e9ef";
  const badgeFill = "#232a36";
  const badgeText = "#e6e9ef";
  const badgeStroke = "#3a4656";
  const { badgeSize, badgePadding, bodyPadding, headerFontSize, rowFontSize } =
    ERD_STYLE;

  const headerTextY = node.y + node.headerHeight / 2;
  lines.push(
    `<g data-table="${escapeAttribute(node.title)}">`,
    `<rect x="${node.x}" y="${node.y}" rx="${borderRadius}" ry="${borderRadius}" width="${node.width}" height="${node.height}" fill="${bodyFill}" stroke="${border}" stroke-width="1.2" />`,
    `<rect x="${node.x}" y="${node.y}" rx="${borderRadius}" ry="${borderRadius}" width="${node.width}" height="${node.headerHeight}" fill="${headerFill}" />`,
    `<text x="${node.x + 14}" y="${headerTextY}" font-size="${headerFontSize}" font-weight="600" fill="${headerText}" dominant-baseline="middle">${escapeText(
      node.title
    )}</text>`
  );

  const startY = node.y + node.headerHeight + bodyPadding;
  let rowIndex = 0;
  for (const column of table.columns) {
    const rowTop = startY + rowIndex * node.rowHeight;
    const textY = rowTop + node.rowHeight / 2;
    const badge = resolveAttributeMeta(column.name, primaryKeys, foreignKeys).trim();
    if (badge) {
      const badgeX = node.x + badgePadding;
      const badgeY = rowTop + Math.round((node.rowHeight - badgeSize) / 2);
      lines.push(
        `<rect x="${badgeX}" y="${badgeY}" width="${badgeSize}" height="${badgeSize}" rx="4" ry="4" fill="${badgeFill}" stroke="${badgeStroke}" />`,
        ...buildBadgeIcon(badge, badgeX, badgeY, badgeSize, badgeText)
      );
    }
    const textX = node.x + badgePadding + badgeSize + 12;
    lines.push(
      `<text x="${textX}" y="${textY}" font-size="${rowFontSize}" fill="${rowText}" dominant-baseline="middle">${escapeText(
        column.name
      )}</text>`
    );
    rowIndex += 1;
  }

  lines.push("</g>");
  return lines;
}

function buildEdgePathSvg(edge: LayoutEdge): string {
  const childMarker = resolveChildMarker(edge.cardinality);
  const title = edge.label ? `title="${escapeAttribute(edge.label)}"` : "";
  return `<path d="${edge.path}" fill="none" stroke="#7c8594" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" marker-start="url(#marker-one)" marker-end="url(#${childMarker})" ${title} />`;
}

function buildBadgeIcon(
  badge: string,
  x: number,
  y: number,
  size: number,
  color: string
): string[] {
  const padding = Math.max(2, Math.floor(size * 0.2));
  const iconX = x + padding;
  const iconY = y + padding;
  const iconSize = size - padding * 2;
  if (badge === "PK") {
    return buildKeyIcon(iconX, iconY, iconSize, color);
  }
  if (badge === "FK") {
    return buildLinkIcon(iconX, iconY, iconSize, color);
  }
  return [];
}

function buildKeyIcon(x: number, y: number, size: number, color: string): string[] {
  const radius = Math.max(2, Math.floor(size * 0.25));
  const cx = x + radius + 1;
  const cy = y + size / 2;
  const shaftX = cx + radius + 1;
  const shaftY = cy - 1;
  const shaftLength = Math.max(4, Math.floor(size * 0.45));
  const toothX = shaftX + shaftLength - 2;
  const toothY = shaftY - 2;
  return [
    `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${color}" stroke-width="1.4" />`,
    `<rect x="${shaftX}" y="${shaftY}" width="${shaftLength}" height="2" fill="${color}" />`,
    `<rect x="${toothX}" y="${toothY}" width="2" height="4" fill="${color}" />`,
  ];
}

function buildLinkIcon(x: number, y: number, size: number, color: string): string[] {
  const radius = Math.max(2, Math.floor(size * 0.25));
  const cy = y + size / 2;
  const leftCx = x + radius + 1;
  const rightCx = x + size - radius - 1;
  return [
    `<circle cx="${leftCx}" cy="${cy}" r="${radius}" fill="none" stroke="${color}" stroke-width="1.4" />`,
    `<circle cx="${rightCx}" cy="${cy}" r="${radius}" fill="none" stroke="${color}" stroke-width="1.4" />`,
    `<line x1="${leftCx + radius}" y1="${cy}" x2="${rightCx - radius}" y2="${cy}" stroke="${color}" stroke-width="1.4" />`,
  ];
}

function buildEdgeSvg(
  layout: LayoutResult,
  from: string,
  to: string,
  childCardinality: string,
  label?: string | null
): string | null {
  const fromNode = layout.nodes.get(from);
  const toNode = layout.nodes.get(to);
  if (!fromNode || !toNode) {
    return null;
  }

  const fromCol = fromNode.columnIndex;
  const toCol = toNode.columnIndex;
  let startX = fromNode.x + fromNode.width;
  let endX = toNode.x;
  let channelX = layout.columnChannels[Math.min(fromCol, toCol)] ?? startX;

  if (fromCol > toCol) {
    startX = fromNode.x;
    endX = toNode.x + toNode.width;
  } else if (fromCol === toCol) {
    startX = fromNode.x + fromNode.width;
    endX = toNode.x + toNode.width;
    channelX = Math.max(startX, endX) + layout.columnGap / 2;
  }

  const startY = fromNode.y + fromNode.height / 2;
  const endY = toNode.y + toNode.height / 2;
  const path = `M ${startX} ${startY} L ${channelX} ${startY} L ${channelX} ${endY} L ${endX} ${endY}`;

  const childMarker = resolveChildMarker(childCardinality);
  const title = label ? `title="${escapeAttribute(label)}"` : "";
  return `<path d="${path}" fill="none" stroke="#7c8594" stroke-width="1.2" marker-start="url(#marker-one)" marker-end="url(#${childMarker})" ${title} />`;
}

function resolveChildMarker(cardinality: string): string {
  switch (cardinality) {
    case "||":
      return "marker-one";
    case "o|":
      return "marker-zero-one";
    case "|{":
      return "marker-one-many";
    case "o{":
      return "marker-zero-many";
    default:
      return "marker-one-many";
  }
}

function wrapSvg(layout: LayoutResult, body: string): string {
  const width = Math.max(layout.width, 400);
  const height = Math.max(layout.height, 300);
  return [
    "<div class=\"diagram-shell\">",
    "<div class=\"diagram-zoom\">",
    `<svg id="erdSvg" class="diagram-svg" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="xMinYMin meet" xmlns="http://www.w3.org/2000/svg">`,
    "<defs>",
    `<marker id="marker-one" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="8" markerHeight="8" orient="auto">`,
    `<path d="M10 2 L10 10" stroke="#7c8594" stroke-width="1.2" />`,
    "</marker>",
    `<marker id="marker-zero-one" viewBox="0 0 16 12" refX="14" refY="6" markerWidth="10" markerHeight="10" orient="auto">`,
    `<circle cx="6" cy="6" r="3.2" fill="none" stroke="#7c8594" stroke-width="1.2" />`,
    `<path d="M14 2 L14 10" stroke="#7c8594" stroke-width="1.2" />`,
    "</marker>",
    `<marker id="marker-one-many" viewBox="0 0 16 12" refX="14" refY="6" markerWidth="10" markerHeight="10" orient="auto">`,
    `<path d="M14 2 L14 10" stroke="#7c8594" stroke-width="1.2" />`,
    `<path d="M2 2 L14 6 M2 10 L14 6 M2 6 L14 6" stroke="#7c8594" stroke-width="1.2" />`,
    "</marker>",
    `<marker id="marker-zero-many" viewBox="0 0 18 12" refX="16" refY="6" markerWidth="11" markerHeight="10" orient="auto">`,
    `<circle cx="6" cy="6" r="3.2" fill="none" stroke="#7c8594" stroke-width="1.2" />`,
    `<path d="M4 2 L16 6 M4 10 L16 6 M4 6 L16 6" stroke="#7c8594" stroke-width="1.2" />`,
    "</marker>",
    "</defs>",
    `<rect x="0" y="0" width="${width}" height="${height}" fill="#0f1115" />`,
    body,
    "</svg>",
    "</div>",
    "</div>",
  ].join("\n");
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
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
