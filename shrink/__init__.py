"""shrink: budget-limited failing-test-case minimizer."""

from .case import CaseError, parse_case
from .minimize import Result, minimize
from .predicates import build_predicate

__version__ = "0.1.0"
__all__ = ["CaseError", "Result", "build_predicate", "minimize", "parse_case"]
