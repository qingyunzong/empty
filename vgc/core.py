"""MVCC version garbage collector core.

Semantics
---------
- Every transaction gets a ``snapshot_ts`` at ``begin`` and versions get a
  ``commit_ts`` at ``commit`` from a single monotonic clock.
- A snapshot at ``ts`` sees, per key, the newest version with
  ``commit_ts <= ts``.
- ``low_watermark`` is the minimum ``snapshot_ts`` across all active
  transactions (or the current clock when no transaction is active).
  A version is collectable iff a newer version of the same key exists with
  ``commit_ts <= low_watermark`` -- i.e. it is invisible to every active
  snapshot and to every future snapshot.
- Each key has a ``max_versions`` budget.  ``gc()`` never collects a version
  that is still visible to an active snapshot; if a key stays over budget
  because nothing more can be safely collected, the gc run reports
  ``GC_DEFERRED`` instead of failing.
- ``as_of(ts)`` raises :class:`SnapshotExpired` when the version that would
  be visible at ``ts`` has already been collected.
"""

from __future__ import annotations

from bisect import bisect_right
from dataclasses import dataclass, field

OK = "OK"
GC_DEFERRED = "GC_DEFERRED"
SNAPSHOT_EXPIRED = "SNAPSHOT_EXPIRED"
NOT_FOUND = "NOT_FOUND"
ERROR = "ERROR"


class SnapshotExpired(Exception):
    """Raised when a time-travel read needs a version that GC collected."""

    def __init__(self, key: str, ts: int):
        super().__init__(
            f"snapshot at ts={ts} expired for key {key!r}: "
            "required version was garbage collected"
        )
        self.key = key
        self.ts = ts


class TxnError(Exception):
    """Raised for invalid transaction lifecycle operations."""


@dataclass
class Version:
    commit_ts: int
    value: object


@dataclass
class _Txn:
    snapshot_ts: int
    writes: dict = field(default_factory=dict)
    active: bool = True


@dataclass
class GcResult:
    status: str
    collected: int
    low_watermark: int
    deferred_keys: list
    versions_remaining: int


class MVCCStore:
    """A tiny MVCC key/value store with snapshot-aware version GC."""

    def __init__(self, max_versions: int | None = None):
        if max_versions is not None and max_versions < 1:
            raise ValueError("max_versions must be >= 1")
        self.max_versions = max_versions
        self.clock = 0
        # key -> list[Version] sorted by commit_ts (append-only prefix GC).
        self._versions: dict[str, list[Version]] = {}
        # key -> commit_ts of the first version ever committed for the key.
        self._first_commit: dict[str, int] = {}
        self._txns: dict[str, _Txn] = {}
        self.collected_total = 0
        self.gc_runs = 0

    # ------------------------------------------------------------------ txns

    def begin(self, txn: str) -> int:
        state = self._txns.get(txn)
        if state is not None and state.active:
            raise TxnError(f"transaction {txn!r} already active")
        state = _Txn(snapshot_ts=self.clock)
        self._txns[txn] = state
        return state.snapshot_ts

    def put(self, txn: str, key: str, value) -> None:
        state = self._require_active(txn)
        state.writes[key] = value

    def commit(self, txn: str) -> int:
        state = self._require_active(txn)
        self.clock += 1
        commit_ts = self.clock
        for key, value in state.writes.items():
            versions = self._versions.setdefault(key, [])
            versions.append(Version(commit_ts=commit_ts, value=value))
            self._first_commit.setdefault(key, commit_ts)
        state.active = False
        state.writes = {}
        return commit_ts

    def abort(self, txn: str) -> None:
        state = self._require_active(txn)
        state.active = False
        state.writes = {}

    def _require_active(self, txn: str) -> _Txn:
        state = self._txns.get(txn)
        if state is None or not state.active:
            raise TxnError(f"transaction {txn!r} is not active")
        return state

    def active_snapshots(self) -> dict[str, int]:
        return {t: s.snapshot_ts for t, s in self._txns.items() if s.active}

    # ------------------------------------------------------------------- gc

    def low_watermark(self) -> int:
        active = [s.snapshot_ts for s in self._txns.values() if s.active]
        return min(active) if active else self.clock

    def _safe_keep_start(self, commits: list[int], low_watermark: int) -> int:
        """Index of the oldest version that must be kept.

        Everything before this index has a newer version with
        ``commit_ts <= low_watermark`` and is therefore invisible to every
        active (and future) snapshot.
        """
        covered = bisect_right(commits, low_watermark)
        return max(0, covered - 1)

    def gc(self) -> GcResult:
        low_watermark = self.low_watermark()
        collected = 0
        deferred_keys = []
        for key, versions in self._versions.items():
            commits = [v.commit_ts for v in versions]
            keep_start = self._safe_keep_start(commits, low_watermark)
            if keep_start:
                del versions[:keep_start]
                collected += keep_start
            if self.max_versions is not None and len(versions) > self.max_versions:
                deferred_keys.append(key)
        self.collected_total += collected
        self.gc_runs += 1
        status = GC_DEFERRED if deferred_keys else OK
        return GcResult(
            status=status,
            collected=collected,
            low_watermark=low_watermark,
            deferred_keys=sorted(deferred_keys),
            versions_remaining=sum(len(v) for v in self._versions.values()),
        )

    # ----------------------------------------------------------------- reads

    def as_of(self, key: str, ts: int):
        """Return the value visible at ``ts`` or None if the key is absent.

        Raises :class:`SnapshotExpired` if the needed version was collected.
        """
        versions = self._versions.get(key)
        if not versions:
            return None
        commits = [v.commit_ts for v in versions]
        idx = bisect_right(commits, ts) - 1
        if idx >= 0:
            return versions[idx].value
        if ts >= self._first_commit[key]:
            raise SnapshotExpired(key, ts)
        return None

    def get(self, txn: str, key: str):
        """Read your own snapshot (including your own staged writes)."""
        state = self._require_active(txn)
        if key in state.writes:
            return state.writes[key]
        return self.as_of(key, state.snapshot_ts)

    # ----------------------------------------------------------------- stats

    def stats(self) -> dict:
        return {
            "clock": self.clock,
            "low_watermark": self.low_watermark(),
            "keys": len(self._versions),
            "versions_total": sum(len(v) for v in self._versions.values()),
            "versions_per_key": {k: len(v) for k, v in sorted(self._versions.items())},
            "collected_total": self.collected_total,
            "gc_runs": self.gc_runs,
            "active_snapshots": self.active_snapshots(),
            "max_versions": self.max_versions,
        }
