"""MVCC: a multi-version key-value store.

Each committed version of a key records (begin_ts, end_ts). Committing a
transaction allocates a globally monotonic commit_ts. Deletes write
tombstone versions instead of physically removing data.
"""

from __future__ import annotations

SNAPSHOT = "snapshot"
READ_COMMITTED = "read_committed"

_ACTIVE = "active"
_COMMITTED = "committed"
_ABORTED = "aborted"


class MVCCError(Exception):
    """Base error carrying a stable machine-readable code."""

    code = "MVCC_ERROR"


class TxnStateError(MVCCError):
    """Operation not allowed in the transaction's current state."""

    code = "TXN_STATE"


class UnknownTxnError(MVCCError):
    """The referenced transaction id does not exist."""

    code = "UNKNOWN_TXN"


class InvalidModeError(MVCCError):
    """Isolation mode must be 'snapshot' or 'read_committed'."""

    code = "INVALID_MODE"


class Version:
    __slots__ = ("begin_ts", "end_ts", "value", "deleted")

    def __init__(self, begin_ts: int, value, deleted: bool = False):
        self.begin_ts = begin_ts
        self.end_ts: int | None = None
        self.value = value
        self.deleted = deleted

    def visible_at(self, ts: int) -> bool:
        return self.begin_ts <= ts and (self.end_ts is None or self.end_ts > ts)


class Transaction:
    __slots__ = ("txn_id", "mode", "snapshot_ts", "state", "writes", "commit_ts")

    def __init__(self, txn_id: int, mode: str, snapshot_ts: int | None):
        self.txn_id = txn_id
        self.mode = mode
        self.snapshot_ts = snapshot_ts
        self.state = _ACTIVE
        # Buffered writes: key -> (value, deleted). Read-your-own-writes.
        self.writes: dict = {}
        self.commit_ts: int | None = None


class Store:
    """Multi-version key-value store with snapshot / read-committed txns."""

    def __init__(self):
        self._versions: dict = {}  # key -> list[Version], ordered by begin_ts
        self._commit_ts = 0
        self._txns: dict[int, Transaction] = {}
        self._next_txn_id = 1

    def begin(self, mode: str) -> int:
        if mode not in (SNAPSHOT, READ_COMMITTED):
            raise InvalidModeError(f"invalid mode: {mode!r}")
        txn_id = self._next_txn_id
        self._next_txn_id += 1
        snapshot_ts = self._commit_ts if mode == SNAPSHOT else None
        self._txns[txn_id] = Transaction(txn_id, mode, snapshot_ts)
        return txn_id

    def commit(self, txn_id: int) -> int:
        txn = self._active_txn(txn_id)
        self._commit_ts += 1
        commit_ts = self._commit_ts
        for key, (value, deleted) in txn.writes.items():
            versions = self._versions.setdefault(key, [])
            if versions and versions[-1].end_ts is None:
                versions[-1].end_ts = commit_ts
            versions.append(Version(commit_ts, value, deleted))
        txn.state = _COMMITTED
        txn.commit_ts = commit_ts
        txn.writes.clear()
        return commit_ts

    def abort(self, txn_id: int) -> None:
        txn = self._active_txn(txn_id)
        txn.writes.clear()
        txn.state = _ABORTED

    def get(self, txn_id: int, key):
        txn = self._active_txn(txn_id)
        if key in txn.writes:
            value, deleted = txn.writes[key]
            return None if deleted else value
        ts = txn.snapshot_ts if txn.mode == SNAPSHOT else self._commit_ts
        for version in reversed(self._versions.get(key, [])):
            if version.visible_at(ts):
                return None if version.deleted else version.value
        return None

    def put(self, txn_id: int, key, value) -> None:
        txn = self._active_txn(txn_id)
        txn.writes[key] = (value, False)

    def delete(self, txn_id: int, key) -> None:
        txn = self._active_txn(txn_id)
        txn.writes[key] = (None, True)

    def versions(self, key) -> list:
        return list(self._versions.get(key, []))

    @property
    def commit_ts(self) -> int:
        return self._commit_ts

    def _active_txn(self, txn_id: int) -> Transaction:
        txn = self._txns.get(txn_id)
        if txn is None:
            raise UnknownTxnError(f"unknown txn: {txn_id}")
        if txn.state != _ACTIVE:
            raise TxnStateError(f"txn {txn_id} is {txn.state}")
        return txn
