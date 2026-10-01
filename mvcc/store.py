"""MVCC key-value store.

Each version of a key carries (begin_ts, end_ts). Committing a transaction
allocates a globally monotonic commit_ts. Snapshot transactions see a fixed
snapshot taken at begin; read_committed transactions see the latest committed
version on every read. Deletes write tombstone versions. Transactions read
their own uncommitted writes.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


class MVCError(Exception):
    """Base error carrying a stable machine-readable code."""

    code = "INTERNAL"


class TxnStateError(MVCError):
    """Operation on a transaction that is unknown or not active."""

    code = "TXN_STATE"


class InvalidModeError(MVCError):
    """Unknown isolation mode passed to begin."""

    code = "INVALID_MODE"


class _Tombstone:
    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __repr__(self):  # pragma: no cover - debugging aid
        return "TOMBSTONE"


TOMBSTONE = _Tombstone()

SNAPSHOT = "snapshot"
READ_COMMITTED = "read_committed"
_MODES = (SNAPSHOT, READ_COMMITTED)

_ACTIVE = "active"
_COMMITTED = "committed"
_ABORTED = "aborted"


@dataclass
class Version:
    begin_ts: int
    end_ts: Optional[int]  # None means still latest
    value: Any  # TOMBSTONE marks a deleted key


@dataclass
class Transaction:
    txn_id: str
    mode: str
    snapshot_ts: int
    state: str = _ACTIVE
    writes: Dict[str, Any] = field(default_factory=dict)  # value or TOMBSTONE
    commit_ts: Optional[int] = None


class MVCCStore:
    def __init__(self) -> None:
        self._versions: Dict[str, List[Version]] = {}
        self._clock = 0  # last allocated commit_ts; also the visible frontier
        self._txns: Dict[str, Transaction] = {}
        self._next_txn_seq = 0

    # -- transaction lifecycle -------------------------------------------------

    def begin(self, mode: str, txn_id: Optional[str] = None) -> str:
        if mode not in _MODES:
            raise InvalidModeError(f"unknown isolation mode: {mode!r}")
        if txn_id is None:
            txn_id = f"txn-{self._next_txn_seq}"
            self._next_txn_seq += 1
        if txn_id in self._txns and self._txns[txn_id].state == _ACTIVE:
            raise TxnStateError(f"transaction {txn_id!r} already active")
        self._txns[txn_id] = Transaction(
            txn_id=txn_id, mode=mode, snapshot_ts=self._clock
        )
        return txn_id

    def commit(self, txn_id: str) -> int:
        txn = self._require_active(txn_id)
        self._clock += 1
        commit_ts = self._clock
        for key, value in txn.writes.items():
            versions = self._versions.setdefault(key, [])
            if versions and versions[-1].end_ts is None:
                versions[-1].end_ts = commit_ts
            versions.append(Version(begin_ts=commit_ts, end_ts=None, value=value))
        txn.state = _COMMITTED
        txn.commit_ts = commit_ts
        return commit_ts

    def abort(self, txn_id: str) -> None:
        txn = self._require_active(txn_id)
        txn.writes.clear()
        txn.state = _ABORTED

    # -- data operations ---------------------------------------------------------

    def get(self, txn_id: str, key: str) -> Any:
        """Return the visible value, or None when the key is absent/deleted."""
        txn = self._require_active(txn_id)
        if key in txn.writes:
            value = txn.writes[key]
            return None if value is TOMBSTONE else value
        read_ts = txn.snapshot_ts if txn.mode == SNAPSHOT else self._clock
        version = self._visible_version(key, read_ts)
        if version is None or version.value is TOMBSTONE:
            return None
        return version.value

    def put(self, txn_id: str, key: str, value: Any) -> None:
        txn = self._require_active(txn_id)
        txn.writes[key] = value

    def delete(self, txn_id: str, key: str) -> None:
        txn = self._require_active(txn_id)
        txn.writes[key] = TOMBSTONE

    # -- internals ---------------------------------------------------------------

    def _require_active(self, txn_id: str) -> Transaction:
        txn = self._txns.get(txn_id)
        if txn is None or txn.state != _ACTIVE:
            raise TxnStateError(f"transaction {txn_id!r} is not active")
        return txn

    def _visible_version(self, key: str, read_ts: int) -> Optional[Version]:
        for version in reversed(self._versions.get(key, [])):
            if version.begin_ts <= read_ts and (
                version.end_ts is None or version.end_ts > read_ts
            ):
                return version
        return None
