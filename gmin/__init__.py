"""gmin: line/character based test-case minimizer."""

from .core import (
    DEFAULT_REPLACEMENTS,
    DEFAULT_TIMEOUT,
    STATUS_BUDGET_EXCEEDED,
    STATUS_OK,
    TRIGGER_EXIT_CODE,
    BudgetExceeded,
    Oracle,
    ReductionResult,
    reduce_text,
)

__all__ = [
    "DEFAULT_REPLACEMENTS",
    "DEFAULT_TIMEOUT",
    "STATUS_BUDGET_EXCEEDED",
    "STATUS_OK",
    "TRIGGER_EXIT_CODE",
    "BudgetExceeded",
    "Oracle",
    "ReductionResult",
    "reduce_text",
]
