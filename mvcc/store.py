"""Single-process multi-replica MVCC key-value store with causal contexts.

Semantics:
  * begin(ctx) pins a snapshot: reads only see committed versions whose
    version vector is causally <= ctx.
  * A write conflicts (WRITE_SKEW) when the key holds a committed version
    that is not causally visible to the transaction context (concurrent
    with, or causally after, ctx). Checked at write time and revalidated
    at commit time.
  * commit assigns a fresh version vector (replica clock merged with ctx,
    local component bumped) and returns it as the new causal context.
  * abort has no side effects.
  * gc_watermark is the component-wise min of all active snapshot ctxs;
    versions strictly below the watermark that are dominated by another
    version still <= watermark are collected.
  * Timed-out transactions are only marked ABORTED; pending transactions
    never block or fail other transactions.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from . import vector as vc
from .errors import MvccError

ACTIVE = "ACTIVE"
COMMITTED = "COMMITTED"
ABORTED = "ABORTED"


@dataclass
class Version:
    key: str
    value: object
    vv: dict
    seq: int
    txn_id: str


@dataclass
class Transaction:
    txn_id: str
    replica: str
    ctx: dict
    timeout_ms: float | None
    begin_time: float
    status: str = ACTIVE
    writes: dict = field(default_factory=dict)
    commit_vv: dict | None = None
    timed_out: bool = False

    def expired(self, now: float) -> bool:
        return (
            self.timeout_ms is not None
            and now >= self.begin_time + self.timeout_ms / 1000.0
        )


class MVCCStore:
    def __init__(self, num_replicas=3, max_keys=500, max_versions=5000,
                 time_fn=time.monotonic):
        if num_replicas < 1:
            raise ValueError("num_replicas must be >= 1")
        self.replicas = ["r%d" % i for i in range(num_replicas)]
        self.max_keys = max_keys
        self.max_versions = max_versions
        self._time_fn = time_fn
        self._clocks = {r: {r: 0} for r in self.replicas}
        self._versions = {}          # key -> [Version]
        self._txns = {}              # txn_id -> Transaction
        self._seq = 0
        self._version_count = 0

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------
    def _now(self):
        return self._time_fn()

    def _get_txn(self, txn_id):
        txn = self._txns.get(txn_id)
        if txn is None:
            raise MvccError("TXN_NOT_FOUND", "unknown transaction %r" % txn_id)
        return txn

    def _refresh(self, txn):
        """Lazily mark an expired active transaction ABORTED."""
        if txn.status == ACTIVE and txn.expired(self._now()):
            txn.status = ABORTED
            txn.writes.clear()
            txn.timed_out = True
            raise MvccError("TIMEOUT",
                            "transaction %r timed out" % txn.txn_id)

    def _require_active(self, txn):
        self._refresh(txn)
        if txn.status != ACTIVE:
            if txn.timed_out:
                raise MvccError("TIMEOUT",
                                "transaction %r timed out" % txn.txn_id)
            raise MvccError("TXN_NOT_ACTIVE",
                            "transaction %r is %s" % (txn.txn_id, txn.status))

    def _visible_version(self, key, ctx):
        """Newest committed version of key causally visible at ctx."""
        candidates = [v for v in self._versions.get(key, ())
                      if vc.leq(v.vv, ctx)]
        if not candidates:
            return None
        maximal = [v for v in candidates
                   if not any(o is not v and vc.leq(v.vv, o.vv)
                              for o in candidates)]
        return max(maximal, key=lambda v: v.seq)

    def _check_write_conflict(self, txn, key):
        for v in self._versions.get(key, ()):
            if not vc.leq(v.vv, txn.ctx):
                raise MvccError(
                    "WRITE_SKEW",
                    "key %r has a committed version concurrent with or "
                    "after the snapshot of %r" % (key, txn.txn_id))

    # ------------------------------------------------------------------
    # transaction API
    # ------------------------------------------------------------------
    def begin(self, txn_id, ctx=None, replica=None, timeout_ms=None):
        if txn_id in self._txns and self._txns[txn_id].status == ACTIVE:
            raise MvccError("TXN_EXISTS",
                            "transaction %r already active" % txn_id)
        replica = replica or self.replicas[0]
        if replica not in self._clocks:
            raise MvccError("BAD_REPLICA", "unknown replica %r" % replica)
        if ctx is None:
            ctx = dict(self._clocks[replica])
        txn = Transaction(txn_id=txn_id, replica=replica, ctx=dict(ctx),
                          timeout_ms=timeout_ms, begin_time=self._now())
        self._txns[txn_id] = txn
        return dict(txn.ctx)

    def read(self, txn_id, key):
        txn = self._get_txn(txn_id)
        self._require_active(txn)
        if key in txn.writes:  # read-your-writes
            return txn.writes[key]
        version = self._visible_version(key, txn.ctx)
        return None if version is None else version.value

    def write(self, txn_id, key, value):
        txn = self._get_txn(txn_id)
        self._require_active(txn)
        self._check_write_conflict(txn, key)
        if key not in self._versions and key not in txn.writes:
            if len(self._versions) >= self.max_keys:
                raise MvccError("KEY_LIMIT",
                                "key limit %d reached" % self.max_keys)
        txn.writes[key] = value

    def commit(self, txn_id):
        txn = self._get_txn(txn_id)
        self._require_active(txn)
        try:
            for key in txn.writes:
                self._check_write_conflict(txn, key)
        except MvccError:
            txn.status = ABORTED
            txn.writes.clear()
            raise
        if self._version_count + len(txn.writes) > self.max_versions:
            txn.status = ABORTED
            txn.writes.clear()
            raise MvccError("VERSION_LIMIT",
                            "version limit %d reached" % self.max_versions)
        clock = vc.merge(self._clocks[txn.replica], txn.ctx)
        clock[txn.replica] = clock.get(txn.replica, 0) + 1
        self._clocks[txn.replica] = dict(clock)
        for key, value in txn.writes.items():
            self._seq += 1
            self._versions.setdefault(key, []).append(
                Version(key=key, value=value, vv=dict(clock),
                        seq=self._seq, txn_id=txn.txn_id))
            self._version_count += 1
        txn.status = COMMITTED
        txn.commit_vv = dict(clock)
        txn.writes.clear()
        return dict(clock)

    def abort(self, txn_id):
        txn = self._get_txn(txn_id)
        if txn.status == ACTIVE:
            txn.status = ABORTED
            txn.writes.clear()

    # ------------------------------------------------------------------
    # garbage collection
    # ------------------------------------------------------------------
    def gc_watermark(self):
        active = [t for t in self._txns.values()
                  if t.status == ACTIVE and not t.expired(self._now())]
        if active:
            return vc.minimum(t.ctx for t in active)
        watermark = {}
        for clock in self._clocks.values():
            watermark = vc.merge(watermark, clock)
        return watermark

    def gc(self):
        """Collect versions strictly below the watermark that no active
        snapshot can reference. Returns (watermark, collected_count)."""
        watermark = self.gc_watermark()
        collected = 0
        for key in list(self._versions):
            versions = self._versions[key]
            keep = []
            for v in versions:
                dominated_below_wm = any(
                    o is not v
                    and vc.leq(v.vv, o.vv)
                    and vc.leq(o.vv, watermark)
                    for o in versions)
                if vc.leq(v.vv, watermark) and dominated_below_wm:
                    collected += 1
                else:
                    keep.append(v)
            if keep:
                self._versions[key] = keep
            else:
                del self._versions[key]
        self._version_count -= collected
        return watermark, collected

    # ------------------------------------------------------------------
    # introspection (used by tests / CLI)
    # ------------------------------------------------------------------
    def txn_status(self, txn_id):
        txn = self._get_txn(txn_id)
        if txn.status == ACTIVE and txn.expired(self._now()):
            txn.status = ABORTED
            txn.writes.clear()
            txn.timed_out = True
        return txn.status

    def version_count(self, key=None):
        if key is None:
            return self._version_count
        return len(self._versions.get(key, ()))

    def versions(self, key):
        return list(self._versions.get(key, ()))
