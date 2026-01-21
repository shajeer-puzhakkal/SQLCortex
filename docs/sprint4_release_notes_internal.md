# SQLCortex Sprint 4 Internal Release Notes

## What works
- VS Code extension login, project/connection selection, and query execution.
- Query analysis with EXPLAIN JSON, rule findings, and optional AI insights.
- Usage dashboard with action counts, timeline, and value meter.
- Metering events recorded with SQL hashing.

## Known limitations
- AI insights depend on analyzer service availability and plan limits.
- EXPLAIN JSON parsing expects Postgres-compatible output (FORMAT JSON).
- Analysis history retention follows plan limits and may prune older items.

## Safety guidance for EXPLAIN ANALYZE
- EXPLAIN ANALYZE can execute queries; use only on safe environments.
- Keep `sqlcortex.explain.allowAnalyze` disabled by default.
- Prefer plain EXPLAIN for production data checks unless explicitly approved.
