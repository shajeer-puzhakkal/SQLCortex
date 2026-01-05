export type ApiError = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

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

export type ExecuteQueryRequest = {
  projectId: string;
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
