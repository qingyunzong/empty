"""Error type for all clashd policy failures."""


class PolicyError(Exception):
    """Raised for any policy compilation or evaluation error.

    Carries a stable machine-readable ``code`` such as ``E_TIE`` or
    ``E_NO_DEFAULT``. The CLI maps every PolicyError to exit code 2.
    """

    def __init__(self, code, message):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message

    def to_dict(self):
        return {"error": {"code": self.code, "message": self.message}}
