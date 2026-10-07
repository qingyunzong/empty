"""logfilter: wildcard + edit-distance filtering over a compressed term automaton."""

from .align import align, validate_alignment
from .bruteforce import bf_distance, bf_matches
from .fst import Automaton
from .index import Index
from .normalize import CURRENT_NORMALIZATION_VERSION, normalize
from .pattern import (
    MAX_EDIT_DISTANCE,
    AnyChar,
    CharClass,
    CompiledPattern,
    Lit,
    PatternError,
    Star,
    parse_pattern,
)
from .search import (
    CursorError,
    NormalizationVersionError,
    SearchResult,
    search,
)

__all__ = [
    "AnyChar",
    "Automaton",
    "CURRENT_NORMALIZATION_VERSION",
    "CharClass",
    "CompiledPattern",
    "CursorError",
    "Index",
    "Lit",
    "MAX_EDIT_DISTANCE",
    "NormalizationVersionError",
    "PatternError",
    "SearchResult",
    "Star",
    "align",
    "bf_distance",
    "bf_matches",
    "normalize",
    "parse_pattern",
    "search",
    "validate_alignment",
]
