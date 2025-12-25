from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class ErrorResponse(BaseModel):
    code: str
    message: str
    details: Optional[Dict[str, Any]] = None


class AnalysisRequest(BaseModel):
    sql: str
    explain_json: Any
    project_id: Optional[str] = None
    user_id: Optional[str] = None
    org_id: Optional[str] = None


class Finding(BaseModel):
    code: str
    title: str
    severity: str
    score: float
    impact: Optional[str] = None
    remediation: Optional[str] = None
    evidence: Optional[Dict[str, Any]] = None


class IndexSuggestion(BaseModel):
    table: str
    columns: List[str]
    sql: str
    reason: str


class RewriteSuggestion(BaseModel):
    title: str
    sql: Optional[str] = None
    rationale: Optional[str] = None


class Confidence(BaseModel):
    overall: float = Field(ge=0.0, le=1.0)
    missing_data: List[str] = Field(default_factory=list)


class AnalyzerOutput(BaseModel):
    primary_bottleneck: Optional[str]
    findings: List[Finding] = Field(default_factory=list)
    suggested_indexes: List[IndexSuggestion] = Field(default_factory=list)
    suggested_rewrite: Optional[RewriteSuggestion] = None
    anti_patterns: List[str] = Field(default_factory=list)
    confidence: Confidence = Field(default_factory=lambda: Confidence(overall=0.6))


class AnalysisResource(BaseModel):
    id: str
    status: str
    sql: str
    explain_json: Any
    result: Optional[AnalyzerOutput] = None
    project_id: Optional[str] = None
    user_id: Optional[str] = None
    org_id: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class AnalysisResponse(BaseModel):
    analysis: AnalysisResource
