from __future__ import annotations

import os
import re
from datetime import datetime
from typing import Any
from uuid import uuid4

import anyio
from fastapi import FastAPI, status
from fastapi.responses import JSONResponse

from .analyzer import analyze
from .models import AnalysisRequest, AnalysisResource, AnalysisResponse, ErrorResponse

MAX_SQL_LENGTH = int(os.getenv("MAX_SQL_LENGTH", "20000"))
MAX_EXPLAIN_JSON_BYTES = int(os.getenv("MAX_EXPLAIN_JSON_BYTES", "1048576"))  # 1 MiB
REQUEST_TIMEOUT_SECONDS = float(os.getenv("ANALYZER_TIMEOUT_SECONDS", "8"))

app = FastAPI(title="SQLCortex Analyzer")


def _make_error(code: str, message: str, details: Any = None, http_status: int = 400):
    payload = ErrorResponse(
        code=code,
        message=message,
        details=details if details is not None else None,
    )
    return JSONResponse(status_code=http_status, content=payload.model_dump())


def _is_read_only_sql(sql: str) -> bool:
    text = sql.strip()
    text = re.sub(r"--.*?$", "", text, flags=re.MULTILINE)
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)
    normalized = text.strip().lower()
    # Reject multiple statements
    if ";" in normalized[:-1]:
        return False
    if normalized.startswith("select"):
        return True
    if normalized.startswith("explain"):
        # allow explain (format json) select ...
        after_explain = normalized[len("explain") :].strip()
        # Remove optional options parens
        if after_explain.startswith("("):
            depth = 0
            idx = 0
            for idx, ch in enumerate(after_explain):
                if ch == "(":
                    depth += 1
                elif ch == ")":
                    depth -= 1
                    if depth == 0:
                        break
            after_explain = after_explain[idx + 1 :].strip()
        return after_explain.startswith("select")
    return False


def _estimate_json_bytes(obj: Any, cap: int) -> int:
    """
    Roughly estimate serialized byte size without fully materializing huge strings.
    Stops early once the cap is exceeded.
    """
    size = 0
    stack = [obj]
    while stack:
        item = stack.pop()
        if isinstance(item, (str, bytes)):
            size += len(item.encode("utf-8") if isinstance(item, str) else item)
        elif item is None or isinstance(item, (bool, int, float)):
            size += 8
        elif isinstance(item, dict):
            size += 2
            stack.extend(item.values())
            stack.extend(item.keys())
        elif isinstance(item, (list, tuple, set)):
            size += len(item)
            stack.extend(list(item))
        else:
            size += len(str(item))
        if size > cap:
            return size
    return size


@app.get("/health")
def health():
    return {"ok": True, "service": "analyzer"}


@app.post(
    "/analyze",
    response_model=AnalysisResponse,
    responses={400: {"model": ErrorResponse}, 402: {"model": ErrorResponse}},
)
async def analyze_endpoint(payload: AnalysisRequest):
    if not payload.sql or len(payload.sql.strip()) == 0:
        return _make_error("INVALID_INPUT", "`sql` is required", http_status=400)

    if len(payload.sql) > MAX_SQL_LENGTH:
        return _make_error(
            "PLAN_LIMIT_EXCEEDED",
            f"SQL length exceeds limit ({MAX_SQL_LENGTH} bytes)",
            http_status=status.HTTP_400_BAD_REQUEST,
        )

    if not _is_read_only_sql(payload.sql):
        return _make_error(
            "SQL_NOT_READ_ONLY", "Only SELECT or EXPLAIN SELECT are permitted", http_status=400
        )

    if payload.explain_json is None:
        return _make_error(
            "INVALID_EXPLAIN_JSON",
            "`explain_json` must be provided as object or array",
            http_status=400,
        )

    approx_size = _estimate_json_bytes(payload.explain_json, MAX_EXPLAIN_JSON_BYTES + 1024)
    if approx_size > MAX_EXPLAIN_JSON_BYTES:
        return _make_error(
            "PLAN_LIMIT_EXCEEDED",
            f"`explain_json` exceeds max size of {MAX_EXPLAIN_JSON_BYTES} bytes",
            http_status=status.HTTP_400_BAD_REQUEST,
        )

    try:
        async with anyio.fail_after(REQUEST_TIMEOUT_SECONDS):
            output = await anyio.to_thread.run_sync(
                analyze, payload.sql, payload.explain_json, bool(payload.llm_enabled)
            )
    except ValueError as exc:
        msg = str(exc)
        code = "PLAN_LIMIT_EXCEEDED" if "limit" in msg.lower() else "INVALID_EXPLAIN_JSON"
        return _make_error(
            code,
            msg,
            http_status=status.HTTP_400_BAD_REQUEST,
        )
    except Exception as exc:  # pragma: no cover - defensive
        if exc.__class__.__name__ == "TimeoutError":
            return _make_error(
                "ANALYZER_TIMEOUT",
                "Analysis timed out",
                {"timeout_seconds": REQUEST_TIMEOUT_SECONDS},
                http_status=status.HTTP_504_GATEWAY_TIMEOUT,
            )
        return _make_error(
            "ANALYZER_ERROR",
            "Unexpected analyzer error",
            {"reason": str(exc)},
            http_status=status.HTTP_500_INTERNAL_SERVER_ERROR,
        )

    now = datetime.utcnow()
    resource = AnalysisResource(
        id=str(uuid4()),
        status="completed",
        sql=payload.sql,
        explain_json=payload.explain_json,
        result=output,
        project_id=payload.project_id,
        user_id=payload.user_id,
        org_id=payload.org_id,
        created_at=now,
        updated_at=now,
    )
    return AnalysisResponse(analysis=resource)
