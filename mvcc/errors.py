class MvccError(Exception):
    """Domain error carrying a stable machine-readable code."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message
