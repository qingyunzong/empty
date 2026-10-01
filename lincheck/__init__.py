"""lincheck: a small linearizability checker for concurrent histories."""

from .history import HistoryError, Operation, load_history_text
from .models import get_model, ModelError
from .checker import (
    Verdict,
    CheckResult,
    ResourceLimitExceeded,
    check_history,
)

__all__ = [
    "HistoryError",
    "Operation",
    "load_history_text",
    "get_model",
    "ModelError",
    "Verdict",
    "CheckResult",
    "ResourceLimitExceeded",
    "check_history",
]

__version__ = "0.1.0"
