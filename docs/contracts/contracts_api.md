# API Contract

## Standard Error
All services return the same error envelope:

```json
{
  "code": "INVALID_INPUT",
  "message": "Human-readable summary",
  "details": {}
}
```

Valid codes: `UNAUTHORIZED`, `FORBIDDEN`, `INVALID_INPUT`, `INVALID_EXPLAIN_JSON`, `SQL_NOT_READ_ONLY`, `RATE_LIMITED`, `PLAN_LIMIT_EXCEEDED`, `ANALYZER_TIMEOUT`, `ANALYZER_ERROR`.

Additional codes used by Sprint 1 pricing/quota enforcement:
- `RATE_LIMITED` (HTTP 429)
- `PLAN_LIMIT_EXCEEDED` (HTTP 402)

## Health Endpoints
- Web: `GET /api/health` -> `{ "ok": true, "service": "web" }`
- API: `GET /health` -> `{ "ok": true, "service": "api" }`
- Analyzer: `GET /health` -> `{ "ok": true, "service": "analyzer" }`

## API Service (`apps/api`)

### Auth
- `POST /api/v1/auth/signup` (body: `email`, `password`, `name?`)
- `POST /api/v1/auth/login` (body: `email`, `password`)
- `POST /api/v1/auth/logout`

Session cookie is httpOnly and required for browser auth.

### GET `/api/v1/me`
Returns current principal and org memberships.

### Organizations
- `GET /api/v1/orgs`
- `POST /api/v1/orgs` (body: `name`)
- `POST /api/v1/orgs/:orgId/invites` (body: `email`, `role?`)
- `POST /api/v1/invites/accept` (body: `token`)

### Projects
- `GET /api/v1/projects`
- `POST /api/v1/projects` (body: `name`, `org_id?`)

### API Tokens
- `GET /api/v1/tokens`
- `POST /api/v1/tokens` (body: `scope`, `org_id?`, `project_id?`, `label?`)
- `POST /api/v1/tokens/:id/revoke`
Tokens authenticate via `Authorization: Bearer <token>`.

### POST `/api/v1/analyses`
- Request body:
  - `sql` (string, required)
  - `explain_json` (object|array, required)
  - `project_id` (uuid, optional)
- Validates read-only SQL (only `SELECT` / `EXPLAIN SELECT`), plan quotas, and explain JSON size.
- Invokes analyzer service, persists result JSONB + status (`queued` → `completed|error`).
- Success: `201 { "analysis": AnalysisResource }` (includes `org_id` attribution)
- Errors: `400 INVALID_INPUT` / `INVALID_EXPLAIN_JSON` / `SQL_NOT_READ_ONLY`, `504 ANALYZER_TIMEOUT`, `402 PLAN_LIMIT_EXCEEDED`

### GET `/api/v1/analyses`
- Query: `project_id` (uuid, required), `limit?` (default 50, max 200)
- Returns history list for the project respecting plan retention windows.
- Success: `200 { "analyses": AnalysisResource[] }`
- Errors: `400 INVALID_INPUT`, `403 FORBIDDEN`

### GET `/api/v1/analyses/:id`
- Success: `200 { "analysis": AnalysisResource }`
- Errors: `404 INVALID_INPUT` when not found

### POST `/api/v1/query/execute`
- Request body:
  - `projectId` (uuid, required)
  - `sql` (string, required)
  - `source` (string, required, use `vscode`)
  - `client` (object, required: `extensionVersion`, `vscodeVersion`)
- Executes a read-only query with server-side timeout and row limit.
- Success: `200 { "queryId", "executionTimeMs", "rowsReturned", "columns", "rows", "error" }`
- Errors: `400 INVALID_INPUT` / `SQL_NOT_READ_ONLY`, `504 ANALYZER_TIMEOUT`

### POST `/api/intelligence/score`
- Request body:
  - `mode` (`fast` | `plan`, required)
  - `sql` (string, required)
  - `project_id` (uuid, required)
  - `connection_id` (uuid, required when `mode=plan`)
- Behavior:
  - `fast`: AST/heuristics scoring only.
  - `plan`: executes `EXPLAIN (FORMAT JSON)` with read-only safeguards and timeout.
- Success: `200 IntelligenceScoreResponse` including:
  - `performance_score`, `performance_label`, `cost_bucket`, `risk_level`, `complexity_rating`
  - `reasons[]`, `recommendations[]`
  - `risk_reasons[]`, `risk_gate`
  - `plan_summary` (when `mode=plan`)
- Errors: `400 INVALID_INPUT` / `SQL_NOT_READ_ONLY` / `INVALID_EXPLAIN_JSON`, `504 ANALYZER_TIMEOUT`, `502 ANALYZER_ERROR`

### GET `/api/intelligence/history`
- Query:
  - `project_id` (uuid, required)
  - `page` (number, optional, default `1`)
  - `limit` (number, optional, default `25`, max `100`)
- Returns paginated intelligence events with score/risk/cost/complexity plus `reasons_json`.
- Success: `200 IntelligenceHistoryResponse`
- Errors: `400 INVALID_INPUT`, `403 FORBIDDEN`, `429 RATE_LIMITED`

### GET `/api/intelligence/top-risky`
- Query:
  - `project_id` (uuid, required)
  - `range` (`7d` | `30d`, optional, default `7d`)
  - `limit` (number, optional, default `10`, max `25`)
- Returns top risky query fingerprints (no raw SQL) ranked by severity and score.
- Success: `200 IntelligenceTopRiskyResponse`
- Errors: `400 INVALID_INPUT`, `403 FORBIDDEN`, `429 RATE_LIMITED`

### GET `/api/intelligence/trends`
- Query:
  - `project_id` (uuid, required)
  - `range` (`7d` | `30d`, optional, default `7d`)
- Returns daily score trends, risk/cost distributions, and heatmap data.
- Success: `200 IntelligenceTrendsResponse`
- Errors: `400 INVALID_INPUT`, `403 FORBIDDEN`, `429 RATE_LIMITED`

### POST `/api/intelligence/observability/collect`
- Request body:
  - `project_id` (uuid, required)
  - `connection_id` (uuid, required)
- Behavior:
  - Resolves the project DB connection and collects metrics from:
    - `pg_stat_user_tables`
    - `pg_stat_user_indexes`
    - `pg_stat_statements` (gracefully marks unavailable when extension is not enabled)
  - Persists one snapshot row per metric type into `observability_snapshots`.
  - Intended to be triggered by a scheduler every 15 minutes per active connection.
- Success: `200 ObservabilityCollectResponse`
  - `snapshot_time`
  - `inserted_count` (typically `3`)
  - `metrics[]` with `metric_type`, `source`, `rows_collected`, optional `unavailable`
- Errors: `400 INVALID_INPUT`, `401 UNAUTHORIZED`, `403 FORBIDDEN`, `429 RATE_LIMITED`, `502 ANALYZER_ERROR`

### POST `/api/intelligence/schema/snapshots/capture`
- Request body:
  - `project_id` (uuid, required)
  - `connection_id` (uuid, required)
- Behavior:
  - Resolves the project DB connection and captures schema objects:
    - tables
    - columns
    - indexes
    - constraints
    - foreign keys
  - Builds a deterministic `schema_hash` (sha256) from normalized `schema_json`.
  - Persists one row into `schema_snapshots`.
  - Compares against the previous snapshot and logs detected changes into `schema_changes`:
    - `table_added`, `table_dropped`
    - `column_added`, `column_removed`
    - `index_created`, `index_dropped`
  - Intended to be triggered by a scheduler every 15 minutes per active connection.
- Success: `200 SchemaSnapshotCaptureResponse`
  - `snapshot_time`
  - `schema_hash`
  - `inserted_count` (typically `1`)
  - `object_counts` (`tables`, `columns`, `indexes`, `constraints`, `foreign_keys`)
- Errors: `400 INVALID_INPUT`, `401 UNAUTHORIZED`, `403 FORBIDDEN`, `429 RATE_LIMITED`, `502 ANALYZER_ERROR`

### GET `/api/intelligence/schema/timeline`
- Query:
  - `project_id` (uuid, required)
  - `range` (`7d` | `30d`, optional, default `7d`)
- Behavior:
  - Returns schema evolution timeline points for the selected range.
  - Includes:
    - schema change events (from `schema_changes`)
    - index change events (subset of schema changes)
    - table growth deltas derived from `observability_snapshots.metric_data.tables`
- Success: `200 SchemaTimelineResponse`
  - `points[]` (`date`, `schema_changes`, `index_changes`, `table_growth_rows`)
  - `schema_changes[]` (`change_type`, `object_name`, `detected_at`, `risk_level`, `recommendation`)
  - `index_changes[]` (same shape as above, filtered to index events)
  - `table_growth[]` (`snapshot_time`, `table_name`, `rows_inserted_delta`, `rows_updated_delta`, `rows_deleted_delta`, `net_growth_rows`)
- Errors: `400 INVALID_INPUT`, `401 UNAUTHORIZED`, `403 FORBIDDEN`, `429 RATE_LIMITED`

### POST `/api/intelligence/schema/migration-risk/score`
- Request body:
  - `project_id` (uuid, required)
  - `connection_id` (uuid, required)
  - `lookback_days` (number, optional, default `7`, max `90`)
- Behavior:
  - Scores migration risk on a `0-10` scale using:
    - table size (`pg_stat_user_tables`)
    - active connections (`pg_stat_activity`)
    - indexes affected recently (`schema_changes`)
    - observed lock wait duration (`pg_stat_activity`)
  - Returns risk level buckets (`low`, `medium`, `high`, `critical`) with operational recommendations.
- Success: `200 MigrationRiskScoreResponse`
  - `risk_score` (e.g. `8.5`)
  - `risk_level`
  - `factors` (`table_size_rows`, `active_connections`, `indexes_affected`, `lock_duration_seconds`)
  - `recommendations[]`
- Errors: `400 INVALID_INPUT`, `401 UNAUTHORIZED`, `403 FORBIDDEN`, `429 RATE_LIMITED`, `502 ANALYZER_ERROR`

### POST `/api/intelligence/index-health/analyze`
- Request body:
  - `project_id` (uuid, required)
  - `connection_id` (uuid, required)
- Behavior:
  - Resolves the project DB connection and analyzes index efficiency.
  - Detects `unused_index` when `idx_scan = 0` and stats reset is older than 30 days.
  - Detects `missing_index` for high sequential-scan tables with frequent `WHERE` predicates on non-indexed columns.
  - Replaces current project rows in `index_health` with latest findings.
- Success: `200 IndexHealthAnalyzeResponse`
  - `analyzed_at`
  - `inserted_count`
  - `findings[]` (`index_name`, `status`, `recommendation`)
- Errors: `400 INVALID_INPUT`, `401 UNAUTHORIZED`, `403 FORBIDDEN`, `429 RATE_LIMITED`, `502 ANALYZER_ERROR`

### POST `/api/intelligence/health-report/generate`
- Request body:
  - `project_id` (uuid, required)
  - `connection_id` (uuid, required)
- Behavior:
  - Builds a weekly health report window (last 7 days, UTC).
  - Computes `health_score` from:
    - query performance
    - schema quality
    - index efficiency
    - lock contention
  - Includes report sections:
    - `top_slow_queries`
    - `missing_indexes`
    - `unused_indexes`
    - `schema_risks`
  - Persists/upserts one row per project + week in `database_health_reports`.
  - Intended to be triggered by a weekly scheduler per active connection.
- Success: `200 DatabaseHealthReportGenerateResponse`
  - `report_week_start`
  - `generated_at`
  - `inserted_count` (upsert result, `1`)
  - `health_score`
  - `score_breakdown` (`query_performance`, `schema_quality`, `index_efficiency`, `lock_contention`)
  - report sections listed above plus `ai_summary`
- Errors: `400 INVALID_INPUT`, `401 UNAUTHORIZED`, `403 FORBIDDEN`, `429 RATE_LIMITED`, `502 ANALYZER_ERROR`

### POST `/api/intelligence/health-report/export-pdf`
- Request body:
  - `project_id` (uuid, required)
  - `connection_id` (uuid, required)
- Behavior:
  - Rebuilds the current weekly database health report using the same scoring/data pipeline as `/api/intelligence/health-report/generate`.
  - Renders report sections into a PDF document (Puppeteer renderer with built-in fallback).
  - Returns a downloadable attachment named like `SQLCortex_Health_Report_ProjectA.pdf`.
- Success: `200 application/pdf`
  - Headers:
    - `Content-Type: application/pdf`
    - `Content-Disposition: attachment; filename="SQLCortex_Health_Report_<Project>.pdf"`
- Errors: `400 INVALID_INPUT`, `401 UNAUTHORIZED`, `403 FORBIDDEN`, `429 RATE_LIMITED`, `502 ANALYZER_ERROR`

Security defaults for intelligence history:
- Raw SQL text is not stored unless `INTELLIGENCE_STORE_QUERY_TEXT=true`.
- Default storage is fingerprint + extracted feature JSON + scoring metadata.

## Analyzer Service (`services/analyzer`)

### POST `/analyze`
- Request: `sql`, `explain_json`, `project_id?`, `user_id?`, `org_id?`
- Response: `{ "analysis": AnalysisResource }` (structured JSON result)

### GET `/health`
- Success: `{ "ok": true, "service": "analyzer" }`
