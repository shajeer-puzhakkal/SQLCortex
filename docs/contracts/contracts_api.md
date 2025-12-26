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

## Analyzer Service (`services/analyzer`)

### POST `/analyze`
- Request: `sql`, `explain_json`, `project_id?`, `user_id?`, `org_id?`
- Response: `{ "analysis": AnalysisResource }` (structured JSON result)

### GET `/health`
- Success: `{ "ok": true, "service": "analyzer" }`
