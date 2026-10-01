"""Exception types for the docindex package."""


class DocIndexError(Exception):
    """Base class for all docindex errors."""


class QueryError(DocIndexError):
    """Raised for malformed or semantically invalid queries."""


class AliasError(DocIndexError):
    """Raised for invalid field alias rules (e.g. cycles)."""


class BatchError(DocIndexError):
    """Raised when a batch of mutations cannot be applied atomically."""


class FieldPathError(DocIndexError):
    """Raised for invalid or unresolvable field paths."""


class SnapshotError(DocIndexError):
    """Raised for invalid snapshot operations."""
