"""Path-pattern policy engine.

Implements a path pattern language (segment literals, single-segment ``*``,
single-character ``?``, cross-segment ``**``, character classes) with rule
sets combined by union and difference.  Patterns compile to symbolic
automata over a finite minterm alphabet, giving exact inclusion,
equivalence and shortest-difference queries with independently verifiable
proofs.
"""

from .chars import ANY_CHAR, OTHER, SEPARATOR, CharClass
from .normalize import PathError, normalize_path, path_segments
from .pattern import PatternError, parse_pattern
from .ruleset import (
    Minus,
    Pattern,
    RulesetError,
    Union,
    expr_from_json,
    expr_match,
    expr_to_json,
)
from .interpreter import interp_match
from .proof import (
    check_equivalence,
    check_inclusion,
    find_difference,
    verify_inclusion_proof,
    verify_witness,
)
from .enumerate import cross_check, legal_paths

__all__ = [
    "ANY_CHAR",
    "OTHER",
    "SEPARATOR",
    "CharClass",
    "PathError",
    "PatternError",
    "RulesetError",
    "Pattern",
    "Union",
    "Minus",
    "normalize_path",
    "path_segments",
    "parse_pattern",
    "expr_from_json",
    "expr_to_json",
    "expr_match",
    "interp_match",
    "check_inclusion",
    "check_equivalence",
    "find_difference",
    "verify_inclusion_proof",
    "verify_witness",
    "cross_check",
    "legal_paths",
]
