"""Snapshot-isolation (SI) transaction engine.

Semantics:
- A transaction takes a consistent snapshot at begin; reads never block.
- At commit, if any key in the transaction's write set was committed by
  another transaction after this transaction's snapshot point, the whole
  commit fails with WRITE_CONFLICT and has no effect (first-committer-wins).
- Conflict detection is based on key sets, not value comparison.
- A failed transaction can be safely retried.
"""

from __future__ import annotations

from dataclasses import dataclass, field


class WriteConflict(Exception):
    """Raised when a commit loses the first-committer-wins race."""


class UnknownTransaction(Exception):
    """Raised when operating on a transaction id that is not active."""


class TransactionExists(Exception):
    """Raised when beginning a transaction id that is already active."""


@dataclass
class Transaction:
    txn_id: str
    snapshot_ts: int
    writes: dict = field(default_factory=dict)
    reads: set = field(default_factory=set)


class Engine:
    """In-memory MVCC key-value store with snapshot isolation."""

    def __init__(self) -> None:
        self._clock = 0
        # key -> list of (commit_ts, value), ordered by commit_ts ascending
        self._data: dict[str, list[tuple[int, object]]] = {}
        # committed history: list of (commit_ts, frozenset of written keys)
        self._history: list[tuple[int, frozenset]] = []
        self._active: dict[str, Transaction] = {}

    def begin(self, txn_id: str) -> Transaction:
        if txn_id in self._active:
            raise TransactionExists(txn_id)
        txn = Transaction(txn_id=txn_id, snapshot_ts=self._clock)
        self._active[txn_id] = txn
        return txn

    def _get(self, txn_id: str) -> Transaction:
        try:
            return self._active[txn_id]
        except KeyError:
            raise UnknownTransaction(txn_id) from None

    def read(self, txn_id: str, key: str):
        txn = self._get(txn_id)
        txn.reads.add(key)
        if key in txn.writes:
            return txn.writes[key]
        versions = self._data.get(key)
        if not versions:
            return None
        result = None
        for ts, value in versions:
            if ts <= txn.snapshot_ts:
                result = value
            else:
                break
        return result

    def write(self, txn_id: str, key: str, value) -> None:
        txn = self._get(txn_id)
        txn.writes[key] = value

    def commit(self, txn_id: str) -> int:
        txn = self._get(txn_id)
        try:
            write_keys = frozenset(txn.writes)
            if write_keys:
                for ts, keys in self._history:
                    if ts > txn.snapshot_ts and keys & write_keys:
                        raise WriteConflict(txn_id)
                self._clock += 1
                commit_ts = self._clock
                for key, value in txn.writes.items():
                    self._data.setdefault(key, []).append((commit_ts, value))
                self._history.append((commit_ts, write_keys))
                return commit_ts
            return txn.snapshot_ts
        finally:
            del self._active[txn_id]

    def abort(self, txn_id: str) -> None:
        self._get(txn_id)
        del self._active[txn_id]

    def snapshot_state(self) -> dict:
        """Current committed state (latest version of each key)."""
        return {key: versions[-1][1] for key, versions in self._data.items()}
