"""ridag: exact rational interval expression DAGs and certified root isolation."""

import sys as _sys

# Exact rational endpoints can have very large numerators; allow printing
# and parsing them without hitting the default 4300-digit guard.
_sys.set_int_max_str_digits(max(_sys.get_int_max_str_digits(), 10_000_000))

from .dag import DAG, Node
from .interval import End, Interval, IntervalUnion, NEG_INF, POS_INF, ZERO, REALS
from .evaluator import Evaluator, EvalResult
from .newton import Isolator, Certificate, Claim, UNIQUE, NONE, UNDECIDED
from .cert import verify_certificate

__all__ = [
    "DAG", "Node", "End", "Interval", "IntervalUnion",
    "NEG_INF", "POS_INF", "ZERO", "REALS",
    "Evaluator", "EvalResult",
    "Isolator", "Certificate", "Claim", "UNIQUE", "NONE", "UNDECIDED",
    "verify_certificate",
]
