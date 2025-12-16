SQLCortex Analyzer
==================

- Source of truth for the analyzer service now lives here under `services/analyzer`.
- `docker-compose.yml` builds the analyzer image from this directory.
- Use `uvicorn main:app --host 0.0.0.0 --port 8000` for local runs outside Docker.
- If you add dependencies, update `requirements.txt` here (no other analyzer copy exists).
