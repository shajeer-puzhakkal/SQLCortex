from datetime import datetime
from typing import Any, Dict, List, Optional, Literal

from pydantic import BaseModel, Field


class ErrorResponse(BaseModel):
    code: str
    message: str
    details: Optional[Dict[str, Any]] = None


class AnalysisRequest(BaseModel):
    sql: str
    explain_json: Any
    llm_enabled: Optional[bool] = None
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
    notes: List[str] = Field(default_factory=list)
    confidence: Optional[float] = Field(default=None, ge=0.0, le=1.0)


class Confidence(BaseModel):
    overall: float = Field(ge=0.0, le=1.0)
    missing_data: List[str] = Field(default_factory=list)


class AnalyzerOutput(BaseModel):
    primary_bottleneck: Optional[str]
    findings: List[Finding] = Field(default_factory=list)
    suggested_indexes: List[IndexSuggestion] = Field(default_factory=list)
    suggested_rewrite: Optional[RewriteSuggestion] = None
    suggested_rewrite_explanation: Optional[str] = None
    plain_summary: List[str] = Field(default_factory=list)
    anti_patterns: List[str] = Field(default_factory=list)
    confidence: Confidence = Field(default_factory=lambda: Confidence(overall=0.6))
    llm_used: bool = False


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

class AiSqlRequest(BaseModel):
    sql_text: str
    schema: Dict[str, Any]
    indexes: Dict[str, Any]
    explain_output: str
    db_engine: str
    project_id: str
    user_intent: Optional[str] = None


class AiSqlResponseMeta(BaseModel):
    provider: str
    model: str
    latency_ms: int


class AiSqlResponse(BaseModel):
    summary: str
    findings: List[str]
    recommendations: List[str]
    risk_level: Literal["low", "medium", "high"]
    meta: AiSqlResponseMeta


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class QueryChatRequest(BaseModel):
    sql_text: str
    schema: Dict[str, Any]
    indexes: Dict[str, Any]
    explain_output: str
    db_engine: str
    project_id: str
    messages: List[ChatMessage] = Field(default_factory=list)
    user_intent: Optional[str] = None


class QueryChatResponse(BaseModel):
    answer: str
    meta: AiSqlResponseMeta


class RuleFindingPayload(BaseModel):
    code: str
    severity: Literal["info", "warn", "high"]
    message: str
    recommendation: str
    rationale: str


class AiInsightsRequest(BaseModel):
    plan_summary: Dict[str, Any]
    rule_findings: List[RuleFindingPayload]
    user_intent: Optional[str] = None


class AiInsightSuggestion(BaseModel):
    title: str
    description: str
    confidence: Literal["low", "medium", "high"]
    tradeoffs: List[str] = Field(default_factory=list)


class AiInsightsResponse(BaseModel):
    explanation: str
    suggestions: List[AiInsightSuggestion]
    warnings: List[str]
    assumptions: List[str]
    meta: AiSqlResponseMeta

