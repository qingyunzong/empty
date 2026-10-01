"""shrink: budget-aware minimization of failing op sequences."""

from .case import validate_case
from .errors import BudgetExhausted, CaseError
from .minimize import minimize_case, order_key
from .predicate import case_fails

__all__ = [
    "BudgetExhausted",
    "CaseError",
    "case_fails",
    "minimize_case",
    "order_key",
    "validate_case",
]
__version__ = "0.1.0"
