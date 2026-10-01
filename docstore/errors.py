"""Exception types used across the document store."""


class DocStoreError(Exception):
    """Base class for all docstore errors."""


class PatchError(DocStoreError):
    """A JSON Patch operation is invalid or a ``test`` op failed."""


class DuplicateKeyError(DocStoreError, ValueError):
    """A JSON object literal contained the same key twice."""


class QueryError(DocStoreError):
    """A query references an unknown index or is malformed."""


class IndexConflictError(DocStoreError):
    """Index management error (duplicate name, unknown index, ...)."""
