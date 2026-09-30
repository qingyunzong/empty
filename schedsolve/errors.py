"""Exception types for schedsolve."""


class SchedSolveError(Exception):
    """Base class for all schedsolve errors."""


class InputError(SchedSolveError, ValueError):
    """Malformed user input. The receiving object is left unchanged."""


class InconsistentStateError(SchedSolveError, RuntimeError):
    """Operation attempted while the constraint store is inconsistent."""
