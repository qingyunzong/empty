"""rknni -- exact top-K branch-and-bound index for rational vectors.

Features: point insert/delete/versioned upsert, boolean tag filters,
exact squared Euclidean distances (fractions.Fraction), safe bounding-box
and tag-summary pruning, node-visit budgets with partial results,
lower-bound certificates for unvisited subtrees, an independent verifier,
snapshots, save/restore, and version-bound query cursors.
"""

from .errors import (
    DimensionError,
    DuplicateIdError,
    RKNIError,
    StaleCursorError,
    StaleVersionError,
    VerificationError,
)
from .exact import dist2, frac_str, parse_vector, to_fraction
from .filters import match_tags, may_match, validate_filter
from .query import Cursor, QueryResult, run_query
from .tree import Index, Point
from .verify import brute_force_topk, verify

__version__ = "1.0.0"

__all__ = [
    "Cursor",
    "DimensionError",
    "DuplicateIdError",
    "Index",
    "Point",
    "QueryResult",
    "RKNIError",
    "StaleCursorError",
    "StaleVersionError",
    "VerificationError",
    "brute_force_topk",
    "dist2",
    "frac_str",
    "match_tags",
    "may_match",
    "parse_vector",
    "run_query",
    "to_fraction",
    "validate_filter",
    "verify",
]
