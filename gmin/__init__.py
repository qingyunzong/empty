"""gmin: budgeted test-case minimization driven by an exit-code oracle."""

from .core import (
    DEFAULT_REPLACEMENT_TABLE,
    DEFAULT_TIMEOUT,
    OracleError,
    ReductionResult,
    STATUS_BUDGET_EXCEEDED,
    STATUS_MINIMAL,
    STATUS_NOT_TRIGGERED,
    SubprocessOracle,
    reduce_text,
)

__all__ = [
    "DEFAULT_REPLACEMENT_TABLE",
    "DEFAULT_TIMEOUT",
    "OracleError",
    "ReductionResult",
    "STATUS_BUDGET_EXCEEDED",
    "STATUS_MINIMAL",
    "STATUS_NOT_TRIGGERED",
    "SubprocessOracle",
    "reduce_text",
]
