"""Snapshot isolation transaction engine.

Semantics:
- A transaction takes a consistent snapshot at begin; reads never block.
- At commit, if any key in the transaction's write set was committed by
  another transaction after this transaction's snapshot point, the whole
  transaction fails with WRITE_CONFLICT and has no effect
  (first-committer-wins).
- Conflict detection is based on key sets, not value comparison.
- A failed transaction can be safely retried (as a new transaction).
"""

from __future__ import annotations

import bisect
import threading
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple


class WriteConflictError(Exception):
    """Raised when a commit loses the first-committer-wins race."""

    def __init__(self, txn_id: str, conflicts: List[str]):
        self.txn_id = txn_id
        self.conflicts = sorted(conflicts)
        super().__init__(
            f"WRITE_CONFLICT: txn {txn_id!r} conflicts on keys {self.conflicts}"
        )


class UnknownTransactionError(Exception):
    """Raised when an operation references an inactive transaction."""


class TransactionStateError(Exception):
    """Raised when an operation is invalid for the transaction's state."""


@dataclass
class Transaction:
    txn_id: str
    snapshot_ts: int
    writes: Dict[str, Any] = field(default_factory=dict)
    active: bool = True


class Engine:
    """MVCC key-value store with snapshot isolation transactions."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        # key -> list of (commit_ts, value), sorted by commit_ts ascending.
        self._versions: Dict[str, List[Tuple[int, Any]]] = {}
        self._commit_ts = 0
        self._txns: Dict[str, Transaction] = {}

    # ------------------------------------------------------------------
    # Transaction lifecycle
    # ------------------------------------------------------------------
    def begin(self, txn_id: str) -> int:
        """Start a transaction; returns its snapshot timestamp."""
        with self._lock:
            if txn_id in self._txns:
                raise TransactionStateError(f"txn {txn_id!r} already exists")
            txn = Transaction(txn_id=txn_id, snapshot_ts=self._commit_ts)
            self._txns[txn_id] = txn
            return txn.snapshot_ts

    def commit(self, txn_id: str) -> int:
        """Commit a transaction; returns its commit timestamp.

        Raises WriteConflictError if any key in the write set was committed
        by another transaction after this transaction's snapshot. On conflict
        the transaction is aborted and has no effect.
        """
        with self._lock:
            txn = self._get_active(txn_id)
            conflicts = [
                key
                for key in txn.writes
                if self._latest_commit_ts(key) > txn.snapshot_ts
            ]
            if conflicts:
                txn.active = False
                del self._txns[txn_id]
                raise WriteConflictError(txn_id, conflicts)
            self._commit_ts += 1
            commit_ts = self._commit_ts
            for key, value in txn.writes.items():
                self._versions.setdefault(key, []).append((commit_ts, value))
            txn.active = False
            del self._txns[txn_id]
            return commit_ts

    def abort(self, txn_id: str) -> None:
        """Abort a transaction, discarding all of its buffered writes."""
        with self._lock:
            txn = self._get_active(txn_id)
            txn.active = False
            txn.writes.clear()
            del self._txns[txn_id]

    # ------------------------------------------------------------------
    # Data operations
    # ------------------------------------------------------------------
    def read(self, txn_id: str, key: str) -> Optional[Any]:
        """Read `key` as of the transaction's snapshot.

        Read-your-own-writes is honored. Reads never block. Returns None
        when the key is absent in the snapshot.
        """
        with self._lock:
            txn = self._get_active(txn_id)
            if key in txn.writes:
                return txn.writes[key]
            return self._read_at(key, txn.snapshot_ts)

    def write(self, txn_id: str, key: str, value: Any) -> None:
        """Buffer a write; it becomes visible to others only at commit."""
        with self._lock:
            txn = self._get_active(txn_id)
            txn.writes[key] = value

    # ------------------------------------------------------------------
    # Introspection
    # ------------------------------------------------------------------
    def snapshot_state(self, ts: Optional[int] = None) -> Dict[str, Any]:
        """Committed state as of timestamp `ts` (latest commit if None)."""
        with self._lock:
            if ts is None:
                ts = self._commit_ts
            return {
                key: self._read_at(key, ts)
                for key in self._versions
                if self._read_at(key, ts) is not None
            }

    @property
    def commit_ts(self) -> int:
        with self._lock:
            return self._commit_ts

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------
    def _get_active(self, txn_id: str) -> Transaction:
        txn = self._txns.get(txn_id)
        if txn is None:
            raise UnknownTransactionError(f"unknown or inactive txn {txn_id!r}")
        return txn

    def _latest_commit_ts(self, key: str) -> int:
        versions = self._versions.get(key)
        return versions[-1][0] if versions else 0

    def _read_at(self, key: str, ts: int) -> Optional[Any]:
        versions = self._versions.get(key)
        if not versions:
            return None
        idx = bisect.bisect_right(versions, ts, key=lambda entry: entry[0]) - 1
        if idx < 0:
            return None
        return versions[idx][1]
