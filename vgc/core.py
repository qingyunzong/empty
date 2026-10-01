"""Core MVCC storage engine with version garbage collection.

Semantics:
  * A global ``low_watermark`` tracks the oldest active snapshot
    timestamp (or the current clock when no snapshot is active).
  * A version is reclaimable when its commit_ts is strictly below the
    low_watermark AND it is not the visible version for any active
    snapshot AND it is not the newest version of its key.
  * Each key has a ``max_versions`` budget.  When GC cannot drop enough
    versions to satisfy the budget (because the survivors are still
    needed by active snapshots), it reports ``GC_DEFERRED`` instead of
    raising an error.
  * ``as_of(ts)`` raises :class:`SnapshotExpired` when the version
    required to serve the time-travel query has been reclaimed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

GC_OK = "GC_OK"
GC_DEFERRED = "GC_DEFERRED"
SNAPSHOT_EXPIRED = "SNAPSHOT_EXPIRED"


class SnapshotExpired(Exception):
    """Raised when an as_of query needs a version that GC reclaimed."""

    def __init__(self, key: str, ts: int):
        super().__init__(
            f"{SNAPSHOT_EXPIRED}: key={key!r} ts={ts} predates the GC horizon"
        )
        self.key = key
        self.ts = ts


class TxnError(Exception):
    """Raised for invalid transaction lifecycle operations."""


@dataclass
class Version:
    commit_ts: int
    value: Any


@dataclass
class Transaction:
    txn_id: str
    snapshot_ts: int
    writes: Dict[str, Any] = field(default_factory=dict)
    state: str = "active"  # active | committed
    commit_ts: Optional[int] = None


class MVCCStore:
    """Multi-versioned key/value store with snapshot GC."""

    def __init__(self, max_versions: int = 3):
        if max_versions < 1:
            raise ValueError("max_versions must be >= 1")
        self.max_versions = max_versions
        self.clock = 0
        # key -> versions sorted by commit_ts ascending
        self.data: Dict[str, List[Version]] = {}
        # key -> commit_ts of the oldest retained version, recorded when GC
        # has reclaimed at least one version of that key.  as_of(ts) with
        # ts below this horizon reports SNAPSHOT_EXPIRED.
        self.expired_below: Dict[str, int] = {}
        self.txns: Dict[str, Transaction] = {}
        self.reclaimed_total = 0
        self.last_gc_reclaimed = 0
        self.last_gc_status = GC_OK
        self.last_gc_deferred_keys: List[str] = []

    # ------------------------------------------------------------------
    # transactions
    # ------------------------------------------------------------------
    def begin(self, txn_id: str) -> int:
        txn = self.txns.get(txn_id)
        if txn is not None and txn.state == "active":
            raise TxnError(f"transaction {txn_id!r} is already active")
        txn = Transaction(txn_id=txn_id, snapshot_ts=self.clock)
        self.txns[txn_id] = txn
        return txn.snapshot_ts

    def _active_txn(self, txn_id: str) -> Transaction:
        txn = self.txns.get(txn_id)
        if txn is None:
            raise TxnError(f"unknown transaction {txn_id!r}")
        if txn.state != "active":
            raise TxnError(f"transaction {txn_id!r} is not active")
        return txn

    def put(self, txn_id: str, key: str, value: Any) -> None:
        txn = self._active_txn(txn_id)
        txn.writes[key] = value

    def commit(self, txn_id: str) -> int:
        txn = self._active_txn(txn_id)
        self.clock += 1
        commit_ts = self.clock
        for key, value in txn.writes.items():
            self.data.setdefault(key, []).append(Version(commit_ts, value))
        txn.state = "committed"
        txn.commit_ts = commit_ts
        return commit_ts

    # ------------------------------------------------------------------
    # reads
    # ------------------------------------------------------------------
    @staticmethod
    def _visible(versions: List[Version], ts: int) -> Optional[Version]:
        """Newest version with commit_ts <= ts, or None."""
        result = None
        for v in versions:
            if v.commit_ts <= ts:
                result = v
            else:
                break
        return result

    def as_of(self, ts: int, key: str) -> Any:
        """Time-travel read of ``key`` at snapshot ``ts``.

        Raises SnapshotExpired if the required version was reclaimed.
        Returns None when the key has no version visible at ``ts``.
        """
        horizon = self.expired_below.get(key)
        if horizon is not None and ts < horizon:
            raise SnapshotExpired(key, ts)
        versions = self.data.get(key)
        if not versions:
            return None
        visible = self._visible(versions, ts)
        if visible is None:
            return None
        return visible.value

    def get(self, key: str) -> Any:
        """Read the newest committed value of ``key`` (None if absent)."""
        versions = self.data.get(key)
        if not versions:
            return None
        return versions[-1].value

    # ------------------------------------------------------------------
    # garbage collection
    # ------------------------------------------------------------------
    def active_snapshots(self) -> List[int]:
        return sorted(
            t.snapshot_ts for t in self.txns.values() if t.state == "active"
        )

    def low_watermark(self) -> int:
        snapshots = self.active_snapshots()
        return min(snapshots) if snapshots else self.clock

    def gc(self) -> Dict[str, Any]:
        """Reclaim versions not visible to any active snapshot.

        Returns a report dict with status GC_OK or GC_DEFERRED.
        """
        snapshots = self.active_snapshots()
        low = min(snapshots) if snapshots else self.clock
        reclaimed = 0
        deferred_keys: List[str] = []

        for key, versions in self.data.items():
            protected = {versions[-1].commit_ts}  # newest: serves current reads
            for snap in snapshots:
                visible = self._visible(versions, snap)
                if visible is not None:
                    protected.add(visible.commit_ts)

            survivors: List[Version] = []
            key_reclaimed = 0
            for v in versions:
                if v.commit_ts in protected or v.commit_ts >= low:
                    survivors.append(v)
                else:
                    key_reclaimed += 1

            # Enforce the per-key max_versions budget, oldest first, but
            # never drop a version still protected by an active snapshot.
            if len(survivors) > self.max_versions:
                excess = len(survivors) - self.max_versions
                trimmed: List[Version] = []
                for v in survivors:
                    if (
                        excess > 0
                        and v.commit_ts not in protected
                        and v.commit_ts < low
                    ):
                        excess -= 1
                        key_reclaimed += 1
                        continue
                    trimmed.append(v)
                survivors = trimmed

            if len(survivors) > self.max_versions:
                deferred_keys.append(key)

            if key_reclaimed:
                reclaimed += key_reclaimed
                self.data[key] = survivors
                horizon = survivors[0].commit_ts
                if horizon > self.expired_below.get(key, 0):
                    self.expired_below[key] = horizon

        self.last_gc_reclaimed = reclaimed
        self.reclaimed_total += reclaimed
        self.last_gc_deferred_keys = deferred_keys
        self.last_gc_status = GC_DEFERRED if deferred_keys else GC_OK
        return {
            "status": self.last_gc_status,
            "reclaimed": reclaimed,
            "low_watermark": low,
            "deferred_keys": deferred_keys,
        }

    # ------------------------------------------------------------------
    # stats
    # ------------------------------------------------------------------
    def stats(self) -> Dict[str, Any]:
        return {
            "clock": self.clock,
            "keys": len(self.data),
            "versions": sum(len(v) for v in self.data.values()),
            "max_versions": self.max_versions,
            "active_snapshots": self.active_snapshots(),
            "low_watermark": self.low_watermark(),
            "reclaimed_total": self.reclaimed_total,
            "last_gc_reclaimed": self.last_gc_reclaimed,
            "last_gc_status": self.last_gc_status,
            "last_gc_deferred_keys": list(self.last_gc_deferred_keys),
        }
