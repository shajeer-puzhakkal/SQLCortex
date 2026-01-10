from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class LlmSuggestion:
    summary: List[str] = field(default_factory=list)
    rewrite_sql: Optional[str] = None
    notes: List[str] = field(default_factory=list)
    confidence: float = 0.0
    error: Optional[str] = None
    used: bool = False
