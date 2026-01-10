from __future__ import annotations

from typing import List, Optional, Tuple

from ..models import Finding


def rank_findings(findings: List[Finding]) -> Tuple[List[Finding], Optional[str]]:
    """
    Sort findings by score (desc) and return primary bottleneck title.
    """
    ranked = sorted(findings, key=lambda f: f.score, reverse=True)
    primary = ranked[0].title if ranked else None
    return ranked, primary
