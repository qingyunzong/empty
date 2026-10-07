"""pathpolicy: path pattern rulesets with exact inclusion proofs.

Public API:
  normalize_path / path_segments   -- canonicalize, reject escaping '..'
  parse_pattern                    -- pattern language parser
  match_pattern / match_policy     -- independent recursive interpreter
  Policy                           -- whitelist minus blacklist rule set
  check_inclusion / check_equivalent / find_difference
                                   -- exact automata-based set operations
  verify_certificate               -- independent proof/witness checker
  enumerate_paths                  -- small-directory-set path enumeration
"""
from .normalize import normalize_path, path_segments, PathError, PathEscapeError
from .pattern import parse_pattern, pattern_to_string, PatternError
from .interpreter import match_pattern, match_policy
from .enumerate import enumerate_paths
from .policy import (Policy, InclusionChecker, check_inclusion,
                     check_equivalent, find_difference, verify_certificate,
                     DEFAULT_BUDGET)

__all__ = [
    "normalize_path", "path_segments", "PathError", "PathEscapeError",
    "parse_pattern", "pattern_to_string", "PatternError",
    "match_pattern", "match_policy", "enumerate_paths",
    "Policy", "InclusionChecker", "check_inclusion", "check_equivalent",
    "find_difference", "verify_certificate", "DEFAULT_BUDGET",
]
