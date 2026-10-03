"""schcount: budget-bounded exact counting over finite integer domains.

Counts the number of solutions of a problem with finite integer variable
domains and allowed-tuple table constraints, under a strict budget of
value-support checks.  At any pause the solver reports a confirmed lower
bound and a certified upper bound, and can serialize a checkpoint that a
new process can resume from.
"""

from .cache import Cache
from .checker import verify_certificate
from .problem import Constraint, Problem
from .solver import Solver

__all__ = ["Cache", "Constraint", "Problem", "Solver", "verify_certificate"]
__version__ = "1.0.0"
