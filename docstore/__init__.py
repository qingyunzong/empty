"""Persistent JSON document store with incremental path indexes."""

from .errors import (DocStoreError, DuplicateKeyError, IndexConflictError,
                     PatchError, QueryError)
from .store import DocumentStore, Snapshot, Version
from .strictjson import dumps, loads
from .values import json_equal, type_tag, value_key

__all__ = [
    "DocumentStore",
    "Snapshot",
    "Version",
    "DocStoreError",
    "DuplicateKeyError",
    "IndexConflictError",
    "PatchError",
    "QueryError",
    "loads",
    "dumps",
    "json_equal",
    "type_tag",
    "value_key",
]
