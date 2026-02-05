SQLCortex AI Services
=====================

- Source of truth for the AI services now lives under `services/ai-services/app`.
- `docker-compose.yml` builds the ai-services image from this directory.
- Use `uvicorn app.main:app --host 0.0.0.0 --port 8000` for local runs outside Docker.
- Shared models live in `services/ai-services/app/models.py` and mirror `apps/api/src/contracts.ts`.
- If you add dependencies, update `requirements.txt` here.

Local IDE note (Docker)
-----------------------
- If you run ai-services in Docker, Pylance may show `Import "fastapi" could not be resolved`.
- Fix by either:
  - Attaching VS Code to the running container, or
  - Creating a local venv for linting:
    - `python -m venv .venv`
    - `.\.venv\Scripts\activate`
    - `pip install -r services/ai-services/requirements.txt`
