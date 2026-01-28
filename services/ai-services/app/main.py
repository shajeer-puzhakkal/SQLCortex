from fastapi import FastAPI

from .ai_routes import router as ai_router
from .insights_routes import router as insights_router
from .query_chat_routes import router as query_chat_router

app = FastAPI(title="SQLCortex AI Services")
app.include_router(ai_router)
app.include_router(insights_router)
app.include_router(query_chat_router)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/version")
def version():
    return {"service": "ai-services", "version": "0.1.0"}
