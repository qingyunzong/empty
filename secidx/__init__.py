"""secidx: transactional row store with secondary indexes."""

from .core import (
    BadRequest,
    Database,
    DuplicatePk,
    ErrorCode,
    IndexExists,
    NoSuchIndex,
    NoSuchTxn,
    NotFound,
    SecIdxError,
    TxnConflict,
    TxnExists,
    UniqueViolation,
)

__all__ = [
    "BadRequest",
    "Database",
    "DuplicatePk",
    "ErrorCode",
    "IndexExists",
    "NoSuchIndex",
    "NoSuchTxn",
    "NotFound",
    "SecIdxError",
    "TxnConflict",
    "TxnExists",
    "UniqueViolation",
]

__version__ = "0.1.0"
