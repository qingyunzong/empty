class PolicyError(Exception):
    """Error raised for policy configuration or evaluation failures."""

    def __init__(self, code, message):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
