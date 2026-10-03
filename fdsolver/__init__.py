"""fdsolver: a finite-domain CSP solver with JSON CLI and library API.

- Variables: finite sets of integers.
- Constraints: allowed-tuple tables (GAC via valid-tuple supports) and
  allDifferent (GAC via bipartite matching + alternating paths / SCCs).
- Nested push/pop with full trail-based undo (domains AND tuple supports).
- Pausable, serialisable search: sat + witness, unsat + replayable conflict
  tree, or unknown when the node budget is exhausted.
"""

from .core import ConsistencyError, Solver, SpecError
from .search import (
    Searcher,
    check_witness,
    enumerate_solutions,
    solve,
    verify_unsat,
)

__all__ = [
    "ConsistencyError",
    "Searcher",
    "Solver",
    "SpecError",
    "check_witness",
    "enumerate_solutions",
    "solve",
    "verify_unsat",
]

__version__ = "1.0.0"
