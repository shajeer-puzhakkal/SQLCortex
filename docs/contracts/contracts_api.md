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

Valid codes: `UNAUTHORIZED`, `FORBIDDEN`, `INVALID_INPUT`, `INVALID_EXPLAIN_JSON`, `SQL_NOT_READ_ONLY`, `PLAN_LIMIT_EXCEEDED`, `ANALYZER_TIMEOUT`, `ANALYZER_ERROR`.

## Health Endpoints
- Web: `GET /api/health` → `{ "ok": true, "service": "web" }`
- API: `GET /health` → `{ "ok": true, "service": "api" }`
- Analyzer: `GET /health` → `{ "ok": true, "service": "analyzer" }`

## API Service (`apps/api`)

### POST `/api/v1/analyses`
- Request body:
  - `sql` (string, required)
  - `explain_json` (object|array, required)
  - `project_id` (uuid, optional)
  - `user_id` (uuid, optional)
- Success: `201 { "analysis": AnalysisResource }`
- Errors: `400 INVALID_INPUT` or `INVALID_EXPLAIN_JSON`

### GET `/api/v1/analyses/:id`
- Success: `200 { "analysis": AnalysisResource }`
- Errors: `404 INVALID_INPUT` when not found

## Analyzer Service (`services/analyzer`)

### POST `/analyze`
- Request: same payload as API create (`sql`, `explain_json`, `project_id?`, `user_id?`)
- Response: `{ "analysis": AnalysisResource }` (structured JSON result)

### GET `/health`
- Success: `{ "ok": true, "service": "analyzer" }`
