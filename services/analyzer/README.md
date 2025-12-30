SQLCortex Analyzer
==================

- Source of truth for the analyzer service now lives here under `services/analyzer/app`.
- `docker-compose.yml` builds the analyzer image from this directory.
- Use `uvicorn app.main:app --host 0.0.0.0 --port 8000` for local runs outside Docker.
- Shared models live in `services/analyzer/app/models.py` and mirror `apps/api/src/contracts.ts`.
- If you add dependencies, update `requirements.txt` here (no other analyzer copy exists).
