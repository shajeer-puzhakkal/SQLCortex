# SQLCortex Monorepo (Sprint 1)

Services:
- `apps/web`: Next.js frontend (App Router)
- `apps/api`: Express + Prisma API service (`/api/v1/*`)
- `services/analyzer`: FastAPI analyzer (`/analyze`)
- `docker-compose.yml`: local runtime with Postgres, API, Web, Analyzer

## Quick Start
1) Configure env: edit `.env` directly and adjust if needed.
2) Install API deps + Prisma client (once): `cd apps/api && npm install && npm run prisma:generate`.
3) Start stack: from repo root run `docker compose up --build`.
4) Apply DB schema (first run): `docker compose run --rm api npx prisma migrate deploy`.

## Health Checks
- Web: `GET http://localhost:3000/api/health` → `{ ok: true, service: "web" }`
- API: `GET http://localhost:4000/health` → `{ ok: true, service: "api" }`
- Analyzer: `GET http://localhost:8000/health` → `{ ok: true, service: "analyzer" }`

## API Surface (v1)
- `POST /api/v1/auth/signup` — create user + session
- `POST /api/v1/auth/login` — start session
- `POST /api/v1/auth/logout` — end session
- `GET /api/v1/me` — current principal + memberships
- `POST /api/v1/analyses` — create analysis job (body: `sql`, `explain_json`, `project_id?`)
- `GET /api/v1/analyses/:id` — fetch analysis by id
Error contract is standardized: `{ code, message, details? }`.

## Database
Postgres with tables: users, organizations, org_members, projects, analyses (jsonb result), api_tokens, plans, subscriptions, usage_counters. See `docs/contracts/contracts_db_schema.md` for details.

## Query Execution (read-only)
The API executes SQL via the connection in `QUERY_DATABASE_URL` (if set) or `DATABASE_URL` (fallback). For safety, point `QUERY_DATABASE_URL` at a read-only Postgres user so writes are blocked even if a query slips past validation.

## Contracts
Shared contracts live in:
- TypeScript: `apps/api/src/contracts.ts`
- Python: `services/analyzer/app/models.py`
- Docs: `docs/contracts/`
