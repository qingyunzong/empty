"""fdsolver: finite-domain solver with table and allDifferent constraints."""

from .core import Solver, TableConstraint
from .alldiff import AllDifferentConstraint, alldiff_removals
from .errors import Conflict, SolverError
from .search import Searcher, all_solutions, verify_unsat_certificate
from .spec import build_solver, normalize_spec, select_var

__all__ = [
    "Solver", "TableConstraint", "AllDifferentConstraint", "alldiff_removals",
    "Conflict", "SolverError", "Searcher", "all_solutions",
    "verify_unsat_certificate", "build_solver", "normalize_spec", "select_var",
]

__version__ = "0.1.0"
