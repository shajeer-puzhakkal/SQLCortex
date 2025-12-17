from datetime import datetime
from uuid import uuid4

from fastapi import FastAPI

from .models import AnalysisRequest, AnalysisResponse

app = FastAPI(title="SQLCortex Analyzer")


@app.get("/health")
def health():
    return {"ok": True, "service": "analyzer"}


@app.post("/analyze", response_model=AnalysisResponse)
def analyze(payload: AnalysisRequest):
    # Placeholder implementation until analysis logic is wired to the DB/analyzer engine.
    analysis = AnalysisResponse(
        analysis={
            "id": str(uuid4()),
            "status": "completed",
            "result": {
                "summary": "Analysis placeholder",
                "sql_length": len(payload.sql),
            },
            "explain_json": payload.explain_json,
            "project_id": payload.project_id,
            "user_id": payload.user_id,
            "created_at": datetime.utcnow(),
            "updated_at": datetime.utcnow(),
        }
    )
    return analysis
