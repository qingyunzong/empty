"""logfilter: exact wildcard + edit-distance log search over a compressed
dictionary automaton with an inverted index."""

from .alignment import align
from .index import Index, VersionMismatchError
from .normalize import DEFAULT_VERSION, NormalizationRules
from .pattern import MAX_EDITS, CompiledPattern, PatternError, parse_pattern
from .search import CursorError, search
from .verify import min_edits, wildcard_match

__all__ = [
    "align",
    "CompiledPattern",
    "CursorError",
    "DEFAULT_VERSION",
    "Index",
    "MAX_EDITS",
    "NormalizationRules",
    "PatternError",
    "VersionMismatchError",
    "min_edits",
    "parse_pattern",
    "search",
    "wildcard_match",
]
