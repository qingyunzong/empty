"""Exception types for the budget gate."""


class GateError(Exception):
    """Base class for all budget-gate errors."""


class UnknownNode(GateError):
    """Subject or quota node is not present in the configuration."""


class UnknownWindow(GateError):
    """Referenced window does not exist on the given node."""


class UnknownRequest(GateError):
    """No hold record exists for the given idempotency id."""


class IdempotencyConflict(GateError):
    """Same idempotency id was reused with a different payload while active."""


class GateInternalError(GateError):
    """An internal step failed after partial application; state was rolled back."""
