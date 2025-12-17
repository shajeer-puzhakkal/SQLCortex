from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel


class ErrorResponse(BaseModel):
    code: str
    message: str
    details: Optional[dict[str, Any]] = None


class AnalysisRequest(BaseModel):
    sql: str
    explain_json: Any
    project_id: Optional[str] = None
    user_id: Optional[str] = None


class AnalysisResult(BaseModel):
    id: str
    status: str
    result: Optional[Any] = None
    explain_json: Any
    project_id: Optional[str] = None
    user_id: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class AnalysisResponse(BaseModel):
    analysis: AnalysisResult
