# SQLCortex Sprint 4 Security Review Checklist

## SQL text persistence
- Meter events store only `sql_hash` (apps/api/src/metering.ts).
- Analysis history stores SQL and EXPLAIN JSON for project visibility (apps/api/src/index.ts).
- Query execution history stores SQL for audit/debugging (apps/api/src/index.ts).
- API error logging uses `redactError` and avoids SQL payloads (apps/api/src/index.ts, packages/shared/src).

## EXPLAIN ANALYZE opt-in
- Extension requires `sqlcortex.explain.allowAnalyze` and confirms before running (extensions/sqlcortex-vscode/src/extension.ts).
- API rejects EXPLAIN ANALYZE unless `allowAnalyze` is true (apps/api/src/index.ts).

## Least-privilege DB access
- Schema and query paths set `default_transaction_read_only` to on (apps/api/src/index.ts).
- Statement timeouts applied to schema, query, and explain paths (apps/api/src/index.ts).
