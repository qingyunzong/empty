"""schedsolve: integer difference constraints + disjunctive interval scheduling.

Public API:
    DifferenceConstraints  - incremental difference-constraint engine
    Solver                 - branch-and-check solver over disjunctive pairs
    Budget                 - separate relax/branch budgets
    Result                 - solve() outcome (sat / unsat / unknown)
    InputError, InconsistentStateError
"""

from .errors import InputError, InconsistentStateError, SchedSolveError
from .diffcon import DifferenceConstraints, NegativeCycle, RelaxBudgetExhausted
from .solver import Budget, Result, Solver

__all__ = [
    "Budget",
    "DifferenceConstraints",
    "InputError",
    "InconsistentStateError",
    "NegativeCycle",
    "RelaxBudgetExhausted",
    "Result",
    "SchedSolveError",
    "Solver",
]

__version__ = "1.0.0"
