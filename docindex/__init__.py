"""docindex: multi-field positional document retrieval library."""
from .errors import (
    AliasError,
    BatchError,
    DocIndexError,
    FieldPathError,
    QueryError,
    SnapshotError,
)
from .index import Index
from .query import parse_query
from .verify import cross_check, interpreter_search

__version__ = "0.1.0"
__all__ = [
    "Index",
    "parse_query",
    "interpreter_search",
    "cross_check",
    "DocIndexError",
    "QueryError",
    "AliasError",
    "BatchError",
    "FieldPathError",
    "SnapshotError",
]
