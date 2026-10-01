"""rostersolve: exact discrete-time job rostering with resources, deps, tags, deadlines."""

from .model import InputError, Problem, parse_problem, subproblem
from .solver import Solver, build_plan, minimal_conflict
from .brute import brute_feasible

__all__ = [
    "InputError",
    "Problem",
    "parse_problem",
    "subproblem",
    "Solver",
    "build_plan",
    "minimal_conflict",
    "brute_feasible",
]
