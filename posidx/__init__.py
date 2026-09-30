"""posidx: positional inverted index library."""

from .core import (
    CorruptIndexError,
    PositionalIndex,
    QuerySyntaxError,
    parse_query,
    tokenize,
)

__all__ = [
    "CorruptIndexError",
    "PositionalIndex",
    "QuerySyntaxError",
    "parse_query",
    "tokenize",
]
__version__ = "1.0.0"
