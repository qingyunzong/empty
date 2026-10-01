"""Exception types for the arrangement package."""


class ArrangementError(ValueError):
    """Raised when input segments are invalid.

    Raising this error never mutates an existing Arrangement: updates are
    validated and rebuilt transactionally before being committed.
    """
