"""syncmap: local two-directory diff/apply tool (64 KiB blocks, adler32+sha256)."""

from .core import (
    BLOCK_SIZE,
    MANIFEST_NAME,
    ApplyError,
    Block,
    BlockIndex,
    FileEntry,
    Manifest,
    ManifestError,
    PathError,
    apply,
    build_manifest,
    diff,
    find_block_match,
    hash_file,
    validate_relpath,
)

__all__ = [
    "BLOCK_SIZE",
    "MANIFEST_NAME",
    "ApplyError",
    "Block",
    "BlockIndex",
    "FileEntry",
    "Manifest",
    "ManifestError",
    "PathError",
    "apply",
    "build_manifest",
    "diff",
    "find_block_match",
    "hash_file",
    "validate_relpath",
]
