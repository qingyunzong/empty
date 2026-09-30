"""vcmerge: deterministic merge of JSON document replicas under vector clocks."""

from .core import (
    DocumentError,
    MergeError,
    NegativeClockError,
    canonical_dumps,
    count_conflicts,
    dump_document,
    merge_documents,
)

__all__ = [
    "DocumentError",
    "MergeError",
    "NegativeClockError",
    "canonical_dumps",
    "count_conflicts",
    "dump_document",
    "merge_documents",
]
