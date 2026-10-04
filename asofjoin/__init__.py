"""asofjoin: as-of join of fact and dimension streams with watermarks."""

from .core import (
    REASON_NO_DIM,
    REASON_STALE,
    Dim,
    DimTable,
    Fact,
    Result,
    join,
)

__version__ = "0.1.0"
__all__ = [
    "REASON_NO_DIM",
    "REASON_STALE",
    "Dim",
    "DimTable",
    "Fact",
    "Result",
    "join",
    "__version__",
]
