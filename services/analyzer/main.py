from fastapi import FastAPI

app = FastAPI(title="SQLCortex Analyzer")

@app.get("/health")
def health():
    return {"ok": True, "service": "analyzer"}
