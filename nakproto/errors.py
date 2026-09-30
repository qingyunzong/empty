"""Error types for nakproto."""


class ConfigError(Exception):
    """Raised when a loss script is invalid (e.g. non-increasing seq list)."""
