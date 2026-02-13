export type SchemaTargetRef = {
  projectId?: string | null;
  envId?: string | null;
  targetId?: string | null;
};

export type SchemaSnapshot = {
  projectId?: string;
  envId?: string;
  targetId?: string;
  capturedAt?: string;
  schemas: SchemaSnapshotSchema[];
};

export type SchemaSnapshotSchema = {
  name: string;
  tables: SchemaSnapshotTable[];
  views: SchemaSnapshotView[];
  routines: SchemaSnapshotRoutine[];
  functions: SchemaSnapshotRoutine[];
  procedures: SchemaSnapshotRoutine[];
};

export type SchemaSnapshotTable = {
  name: string;
  columns: SchemaSnapshotColumn[];
  constraints: SchemaSnapshotConstraint[];
  foreignKeys: SchemaSnapshotForeignKey[];
  indexes: SchemaSnapshotIndex[];
};

export type SchemaSnapshotColumn = {
  name: string;
  dataType: string;
  nullable: boolean;
  default: string | null;
};

export type SchemaSnapshotConstraint = {
  name: string;
  type: string;
  columns: string[];
  definition: string | null;
};

export type SchemaSnapshotForeignKey = {
  name: string;
  columns: string[];
  referencedSchema: string;
  referencedTable: string;
  referencedColumns: string[];
  onUpdate: string | null;
  onDelete: string | null;
};

export type SchemaSnapshotIndex = {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
  method: string | null;
  predicate: string | null;
};

export type SchemaSnapshotView = {
  name: string;
  definition: string | null;
};

export type SchemaSnapshotRoutine = {
  name: string;
  kind: "function" | "procedure" | string;
  signature: string | null;
  returnType: string | null;
  language: string | null;
  definition: string | null;
};

export type SchemaRefreshResponse = {
  ok: boolean;
  status: string | null;
  refreshedAt: string | null;
  snapshot: SchemaSnapshot | null;
};

export function parseSchemaSnapshot(payload: unknown): SchemaSnapshot {
  const envelope = asRecord(payload);
  const rawSnapshot =
    envelope && asRecord(envelope.snapshot) ? envelope.snapshot : payload;
  const snapshot = asRecord(rawSnapshot);
  if (!snapshot) {
    throw new Error("Schema snapshot response is invalid.");
  }

  const rawSchemas = asArray(snapshot.schemas);
  if (!rawSchemas) {
    throw new Error("Schema snapshot is missing `schemas`.");
  }

  return {
    projectId: firstNonEmptyString(snapshot.projectId, envelope?.projectId),
    envId: firstNonEmptyString(snapshot.envId, envelope?.envId),
    targetId: firstNonEmptyString(snapshot.targetId, envelope?.targetId),
    capturedAt: firstNonEmptyString(
      snapshot.capturedAt,
      snapshot.generatedAt,
      envelope?.capturedAt,
      envelope?.generatedAt
    ),
    schemas: rawSchemas.map(parseSchema),
  };
}

export function parseSchemaRefreshResponse(payload: unknown): SchemaRefreshResponse {
  const snapshot = tryParseSnapshot(payload);
  const record = asRecord(payload);

  return {
    ok: record ? record.ok !== false : snapshot !== null,
    status: record ? stringOrNull(record.status) : null,
    refreshedAt: record
      ? stringOrNull(record.refreshedAt ?? record.capturedAt ?? record.generatedAt)
      : null,
    snapshot,
  };
}

function parseSchema(value: unknown): SchemaSnapshotSchema {
  const record = asRecord(value);
  if (!record) {
    throw new Error("Schema snapshot contains an invalid schema node.");
  }

  const name = requiredString(record.name, "Schema name is missing.");
  const tables = asArray(record.tables)?.map(parseTable) ?? [];
  const views = asArray(record.views)?.map(parseView) ?? [];
  const routines = asArray(record.routines)?.map((entry) => parseRoutine(entry, null)) ?? [];
  const functions = asArray(record.functions)?.map((entry) =>
    parseRoutine(entry, "function")
  ) ?? [];
  const procedures = asArray(record.procedures)?.map((entry) =>
    parseRoutine(entry, "procedure")
  ) ?? [];

  return {
    name,
    tables,
    views,
    routines: mergeRoutines(routines, functions, procedures),
    functions,
    procedures,
  };
}

function parseTable(value: unknown): SchemaSnapshotTable {
  const record = asRecord(value);
  if (!record) {
    throw new Error("Schema snapshot contains an invalid table node.");
  }

  const foreignKeys = asArray(record.foreignKeys ?? record.fks)?.map(parseForeignKey) ?? [];

  return {
    name: requiredString(record.name, "Table name is missing."),
    columns: asArray(record.columns)?.map(parseColumn) ?? [],
    constraints: asArray(record.constraints)?.map(parseConstraint) ?? [],
    foreignKeys,
    indexes: asArray(record.indexes)?.map(parseIndex) ?? [],
  };
}

function parseColumn(value: unknown): SchemaSnapshotColumn {
  const record = asRecord(value);
  if (!record) {
    throw new Error("Schema snapshot contains an invalid column node.");
  }

  return {
    name: requiredString(record.name, "Column name is missing."),
    dataType: requiredString(record.dataType ?? record.type, "Column data type is missing."),
    nullable: Boolean(record.nullable),
    default: stringOrNull(record.default),
  };
}

function parseConstraint(value: unknown): SchemaSnapshotConstraint {
  const record = asRecord(value);
  if (!record) {
    throw new Error("Schema snapshot contains an invalid constraint node.");
  }

  return {
    name: requiredString(record.name, "Constraint name is missing."),
    type: requiredString(record.type, "Constraint type is missing."),
    columns: stringArray(record.columns),
    definition: stringOrNull(record.definition),
  };
}

function parseForeignKey(value: unknown): SchemaSnapshotForeignKey {
  const record = asRecord(value);
  if (!record) {
    throw new Error("Schema snapshot contains an invalid foreign key node.");
  }

  return {
    name: requiredString(record.name, "Foreign key name is missing."),
    columns: stringArray(record.columns),
    referencedSchema: requiredString(
      record.referencedSchema ?? record.foreignSchema,
      "Foreign key referenced schema is missing."
    ),
    referencedTable: requiredString(
      record.referencedTable ?? record.foreignTable,
      "Foreign key referenced table is missing."
    ),
    referencedColumns: stringArray(record.referencedColumns ?? record.foreignColumns),
    onUpdate: stringOrNull(record.onUpdate),
    onDelete: stringOrNull(record.onDelete),
  };
}

function parseIndex(value: unknown): SchemaSnapshotIndex {
  const record = asRecord(value);
  if (!record) {
    throw new Error("Schema snapshot contains an invalid index node.");
  }

  return {
    name: requiredString(record.name, "Index name is missing."),
    columns: stringArray(record.columns),
    unique: Boolean(record.unique),
    primary: Boolean(record.primary),
    method: stringOrNull(record.method),
    predicate: stringOrNull(record.predicate),
  };
}

function parseView(value: unknown): SchemaSnapshotView {
  const record = asRecord(value);
  if (!record) {
    throw new Error("Schema snapshot contains an invalid view node.");
  }

  return {
    name: requiredString(record.name, "View name is missing."),
    definition: stringOrNull(record.definition),
  };
}

function parseRoutine(
  value: unknown,
  forcedKind: "function" | "procedure" | null
): SchemaSnapshotRoutine {
  const record = asRecord(value);
  if (!record) {
    throw new Error("Schema snapshot contains an invalid routine node.");
  }

  const rawKind = forcedKind ?? firstNonEmptyString(record.kind, record.type) ?? "function";

  return {
    name: requiredString(record.name, "Routine name is missing."),
    kind: rawKind,
    signature: stringOrNull(record.signature),
    returnType: stringOrNull(record.returnType),
    language: stringOrNull(record.language),
    definition: stringOrNull(record.definition),
  };
}

function mergeRoutines(
  routines: SchemaSnapshotRoutine[],
  functions: SchemaSnapshotRoutine[],
  procedures: SchemaSnapshotRoutine[]
): SchemaSnapshotRoutine[] {
  const merged: SchemaSnapshotRoutine[] = [...routines];
  const seen = new Set(merged.map((entry) => `${entry.kind}:${entry.name}:${entry.signature ?? ""}`));

  for (const entry of [...functions, ...procedures]) {
    const key = `${entry.kind}:${entry.name}:${entry.signature ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(entry);
    }
  }

  return merged;
}

function tryParseSnapshot(payload: unknown): SchemaSnapshot | null {
  try {
    return parseSchemaSnapshot(payload);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(message);
  }
  return value;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}
