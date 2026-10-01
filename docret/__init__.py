"""docret: multi-field document retrieval with a positional index."""

from .index import AliasError, BatchError, Index, QueryResult, Snapshot
from .query import QueryError, parse

__all__ = [
    "Index", "QueryResult", "Snapshot",
    "QueryError", "BatchError", "AliasError", "parse",
]

__version__ = "0.1.0"
