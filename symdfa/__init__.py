"""Symbolic DFA equivalence and inclusion checking.

Alphabet: integers 0..65535.  Transitions are disjoint closed intervals;
missing transitions lead to an implicit reject sink.
"""

from .dfa import DFA, DFAError, CHAR_MIN, CHAR_MAX
from .product import (
    check, check_equivalence, check_inclusion, partition_segments,
    CheckResult, SearchState,
    MODE_EQUIVALENCE, MODE_INCLUSION,
    EQUIVALENT, NOT_EQUIVALENT, INCLUDED, NOT_INCLUDED, UNKNOWN,
)
from .proof import Proof, RelationItem, build_proof, revalidate
from .verify import verify_proof, verify_witness

__all__ = [
    "DFA", "DFAError", "CHAR_MIN", "CHAR_MAX",
    "check", "check_equivalence", "check_inclusion", "partition_segments",
    "CheckResult", "SearchState",
    "MODE_EQUIVALENCE", "MODE_INCLUSION",
    "EQUIVALENT", "NOT_EQUIVALENT", "INCLUDED", "NOT_INCLUDED", "UNKNOWN",
    "Proof", "RelationItem", "build_proof", "revalidate",
    "verify_proof", "verify_witness",
]
