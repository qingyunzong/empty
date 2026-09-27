"""merklesync: bounded-round Merkle interval diff for ordered JSONL key-value streams."""

from .core import (
    EMPTY_HASH,
    EXIT_ORDER_ERROR,
    InputError,
    OrderError,
    Stream,
    canonicalize,
    key_equal,
    key_order,
    load_stream,
    merkle_diff,
)

__all__ = [
    "EMPTY_HASH",
    "EXIT_ORDER_ERROR",
    "InputError",
    "OrderError",
    "Stream",
    "canonicalize",
    "key_equal",
    "key_order",
    "load_stream",
    "merkle_diff",
]

__version__ = "0.1.0"
