export type ApiError = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export type {
  AnalyzeRequest,
  AnalyzeResponse,
  AiInsight,
  AiSuggestion,
  BillingCreditsResponse,
  DashboardMetricsResponse,
  DashboardUsageResponse,
  ExplainMode,
  MeterEvent,
  PlanUsageSummary,
  RuleFinding,
} from "../../../../packages/shared/src/contracts";

export type Org = {
  id: string;
  name: string;
  role?: string | null;
};

export type Project = {
  id: string;
  name: string;
  org_id: string | null;
  owner_user_id?: string | null;
};

export type ConnectionResource = {
  id: string;
  project_id: string;
  type: string;
  name: string;
  ssl_mode: string;
  host: string | null;
  port: number | null;
  database: string | null;
  username: string | null;
  uses_url: boolean;
  has_password: boolean;
  created_at: string;
  updated_at: string;
};

export type SchemaResource = {
  name: string;
};

export type SchemaTableResource = {
  name: string;
  type: "table" | "view";
};

export type SchemaColumnResource = {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
};

export type ForeignKeyInfo = {
  name: string;
  columns: string[];
  foreignSchema: string;
  foreignTable: string;
  foreignColumns: string[];
  onUpdate: string;
  onDelete: string;
};

export type IndexInfo = {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
  method: string;
  predicate: string | null;
};

export type TableInfo = {
  schema: string;
  name: string;
  type: "table" | "view";
  columns: SchemaColumnResource[];
  foreignKeys: ForeignKeyInfo[];
  indexes: IndexInfo[];
};

export type SchemaMetadataResponse = {
  schema: string;
  tables: TableInfo[];
};

export type ExecuteQueryRequest = {
  projectId: string;
  connectionId?: string | null;
  sql: string;
  source: "vscode";
  client: {
    extensionVersion: string;
    vscodeVersion: string;
  };
};

export type ExecuteQueryResponse = {
  queryId: string;
  executionTimeMs: number;
  rowsReturned: number;
  columns: Array<{ name: string; type: string }>;
  rows: Array<Array<unknown>>;
  error: ApiError | null;
};
