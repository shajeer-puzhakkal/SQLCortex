# Result Schema (Shared)

Field names are snake_case and identical between the API (TypeScript) and Analyzer (Python).

## AnalysisResource
- `id`: uuid
- `status`: string (e.g., `queued`, `completed`, `failed`)
- `sql`: string
- `explain_json`: object|array
- `result`: object|array|null (structured analyzer output)
- `project_id`: uuid|null
- `user_id`: uuid|null
- `created_at`: ISO datetime string
- `updated_at`: ISO datetime string

## Create Request
`AnalysisCreateRequest`
- `sql`: string
- `explain_json`: object|array
- `project_id`: uuid|null (optional)
- `user_id`: uuid|null (optional)

### API Responses
- `AnalysisCreateResponse`: `{ "analysis": AnalysisResource }`
- `AnalysisGetResponse`: `{ "analysis": AnalysisResource }`

### Analyzer Response
- `AnalysisResponse`: `{ "analysis": AnalysisResource }`
