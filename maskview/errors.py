"""Error types for maskview."""


class PolicyError(Exception):
    """Raised for any policy, schema, or evaluation failure.

    Carries a stable machine-readable ``code`` (e.g. ``E_SCHEMA``).
    The CLI reports these and exits with status 2.
    """

    def __init__(self, code, message):
        super().__init__("%s: %s" % (code, message))
        self.code = code
        self.message = message
