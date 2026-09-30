class PolicyError(Exception):
    """Raised for invalid specs, CLI misuse, or policy violations.

    The CLI maps this to exit code 2.
    """
