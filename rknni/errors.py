"""Exception types for the rknni package."""


class RKNIError(Exception):
    """Base class for all rknni errors."""


class DuplicateIdError(RKNIError):
    """Raised when inserting a point whose id already exists."""


class StaleVersionError(RKNIError):
    """Raised when an upsert carries a version that is not newer."""


class StaleCursorError(RKNIError):
    """Raised when a query cursor is used after the data version moved."""


class DimensionError(RKNIError):
    """Raised when a vector dimension does not match the index dimension."""


class VerificationError(RKNIError):
    """Raised when the independent verifier rejects a query result."""
