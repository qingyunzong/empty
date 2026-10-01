"""Exception types shared across the solver."""


class SolverError(Exception):
    """Invalid input: bad references, duplicates, malformed specifications."""


class Conflict(Exception):
    """Internal signal raised when propagation empties a domain."""

    def __init__(self, variable=None, constraint=None):
        super().__init__(f"domain of {variable!r} emptied")
        self.variable = variable
        self.constraint = constraint
