"""jsondoc: persistent, versioned JSON document store with path indexes."""
from .patch import PatchError, apply_patch
from .query import QueryError
from .store import DocumentStore, Faults, InjectedFault, Snapshot
from .strictjson import (
    DuplicateKeyError,
    StrictJSONError,
    dumps,
    json_equal,
    loads,
    sort_key,
    type_name,
    value_key,
)

__all__ = [
    "DocumentStore",
    "Snapshot",
    "Faults",
    "InjectedFault",
    "PatchError",
    "QueryError",
    "StrictJSONError",
    "DuplicateKeyError",
    "apply_patch",
    "loads",
    "dumps",
    "json_equal",
    "type_name",
    "value_key",
    "sort_key",
]
