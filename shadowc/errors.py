"""Error types for shadowc."""


class PolicyError(Exception):
    """Raised for any policy error (parse / resolution).

    Carries a stable machine-readable ``code`` plus 1-based ``line``/``col``
    of the offending source position.
    """

    def __init__(self, code: str, message: str, line: int = 0, col: int = 0):
        super().__init__(message)
        self.code = code
        self.message = message
        self.line = line
        self.col = col

    def __str__(self) -> str:
        if self.line:
            return f"{self.line}:{self.col}: {self.code}: {self.message}"
        return f"{self.code}: {self.message}"
