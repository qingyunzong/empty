"""secidx: row store with transactional secondary indexes."""

from .store import (
    Store, SecIdxError, UniqueViolation, TxnNotActive, NoSuchTxn,
    NoSuchIndex, IndexExists, PkExists, PkNotFound, BadRequest, freeze,
)

__version__ = "0.1.0"
