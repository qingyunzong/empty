"""posidx: a positional inverted index library with persistence."""

from .index import IndexCorruptError, PositionalIndex, tokenize
from .query import QuerySyntaxError, evaluate, parse_query, search

__all__ = [
    "IndexCorruptError",
    "PositionalIndex",
    "QuerySyntaxError",
    "evaluate",
    "parse_query",
    "search",
    "tokenize",
]

__version__ = "1.0.0"
