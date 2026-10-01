"""rchunk: content-defined chunking with a verifiable .chunk index."""
from .core import (
    BASE,
    FORMAT,
    MASK,
    MAX_CHUNK,
    MIN_CHUNK,
    MOD,
    PARAMS,
    WINDOW,
    Chunker,
    CorruptError,
    build_index,
    chunk_bytes,
    locate_chunk,
    verify_index,
)

__all__ = [
    "BASE",
    "FORMAT",
    "MASK",
    "MAX_CHUNK",
    "MIN_CHUNK",
    "MOD",
    "PARAMS",
    "WINDOW",
    "Chunker",
    "CorruptError",
    "build_index",
    "chunk_bytes",
    "locate_chunk",
    "verify_index",
]

__version__ = "1.0.0"
