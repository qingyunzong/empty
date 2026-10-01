"""Error types for shrink."""


class CaseError(ValueError):
    """Raised when the input case is invalid."""


class BudgetExhausted(Exception):
    """Raised when no predicate checks remain in the budget."""
