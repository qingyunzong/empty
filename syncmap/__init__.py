"""syncmap: local two-directory diff/sync tool with block-level checksums."""

from .core import (
    BLOCK_SIZE,
    MANIFEST_NAME,
    Block,
    FileEntry,
    Manifest,
    Op,
    PathError,
    SourceIndex,
    build_manifest,
    diff,
    hash_block,
    load_manifest,
    validate_relpath,
    write_manifest,
)
from .apply import ApplyError, apply

__all__ = [
    "BLOCK_SIZE",
    "MANIFEST_NAME",
    "ApplyError",
    "Block",
    "FileEntry",
    "Manifest",
    "Op",
    "PathError",
    "SourceIndex",
    "apply",
    "build_manifest",
    "diff",
    "hash_block",
    "load_manifest",
    "validate_relpath",
    "write_manifest",
]
