"""Single-process, multi-replica MVCC key-value store with causal contexts.

Causality is tracked with version vectors (one component per replica).
A transaction begins with a causal context (its snapshot), reads only see
committed versions dominated by that context, and commits produce new
versions whose vectors extend the snapshot at the coordinator replica.
"""

from __future__ import annotations

import itertools
import time
from dataclasses import dataclass, field

MAX_KEYS = 500
MAX_VERSIONS = 5000


class MVCCError(Exception):
    """Base class for semantic (per-operation) errors."""

    code = "ERROR"

    def __init__(self, message: str = ""):
        super().__init__(message or self.code)


class WriteSkew(MVCCError):
    code = "WRITE_SKEW"


class TxnNotActive(MVCCError):
    code = "TXN_NOT_ACTIVE"


class TxnAborted(MVCCError):
    code = "TXN_ABORTED"


class StoreLimitExceeded(MVCCError):
    code = "STORE_LIMIT"


def vec_leq(a: tuple[int, ...], b: tuple[int, ...]) -> bool:
    return all(x <= y for x, y in zip(a, b))


def vec_concurrent(a: tuple[int, ...], b: tuple[int, ...]) -> bool:
    return not vec_leq(a, b) and not vec_leq(b, a)


def _version_rank(vec: tuple[int, ...]) -> tuple[int, tuple[int, ...]]:
    """Deterministic total order used to pick among visible versions."""
    return (sum(vec), vec)


@dataclass
class Version:
    vec: tuple[int, ...]
    value: object
    txn_id: str
    seq: int


@dataclass
class Transaction:
    txn_id: str
    replica: int
    ctx: tuple[int, ...]
    deadline: float | None = None
    writes: dict[str, object] = field(default_factory=dict)
    state: str = "active"  # active | committed | aborted


class MVCCStore:
    def __init__(
        self,
        num_replicas: int = 3,
        max_keys: int = MAX_KEYS,
        max_versions: int = MAX_VERSIONS,
        now_fn=time.monotonic,
    ):
        if num_replicas < 1:
            raise ValueError("num_replicas must be >= 1")
        self.num_replicas = num_replicas
        self.max_keys = max_keys
        self.max_versions = max_versions
        self._now = now_fn
        self._data: dict[str, list[Version]] = {}
        self._txns: dict[str, Transaction] = {}
        self._seq = itertools.count(1)

    # ------------------------------------------------------------------
    # transaction lifecycle
    # ------------------------------------------------------------------
    def begin(
        self,
        txn_id: str,
        replica: int = 0,
        ctx: list[int] | tuple[int, ...] | None = None,
        timeout_ms: float | None = None,
    ) -> tuple[int, ...]:
        if txn_id in self._txns and self._txns[txn_id].state == "active":
            raise MVCCError(f"TXN_EXISTS: {txn_id}")
        if not 0 <= replica < self.num_replicas:
            raise MVCCError(f"BAD_REPLICA: {replica}")
        snap = self._normalize_ctx(ctx)
        deadline = None if timeout_ms is None else self._now() + timeout_ms / 1000.0
        self._txns[txn_id] = Transaction(
            txn_id=txn_id, replica=replica, ctx=snap, deadline=deadline
        )
        return snap

    def commit(self, txn_id: str) -> tuple[int, ...]:
        txn = self._active(txn_id)
        # Re-check conflicts at commit: a concurrent version may have been
        # committed after this transaction performed its writes.
        for key in txn.writes:
            self._check_write_conflict(key, txn.ctx)
        new_vec = list(txn.ctx)
        new_vec[txn.replica] += 1
        new_vec = tuple(new_vec)
        if len(self._data) + sum(
            1 for k in txn.writes if k not in self._data
        ) > self.max_keys:
            raise StoreLimitExceeded(f"key limit {self.max_keys} exceeded")
        pending = len(txn.writes)
        if self._version_count() + pending > self.max_versions:
            self.gc()
            if self._version_count() + pending > self.max_versions:
                raise StoreLimitExceeded(
                    f"version limit {self.max_versions} exceeded"
                )
        for key, value in txn.writes.items():
            self._data.setdefault(key, []).append(
                Version(vec=new_vec, value=value, txn_id=txn_id, seq=next(self._seq))
            )
        txn.state = "committed"
        return new_vec

    def abort(self, txn_id: str) -> None:
        txn = self._get(txn_id)
        if txn.state == "active":
            txn.state = "aborted"
            txn.writes.clear()

    # ------------------------------------------------------------------
    # operations
    # ------------------------------------------------------------------
    def read(self, txn_id: str, key: str):
        """Return (found, value, version_vector) under the txn snapshot."""
        txn = self._active(txn_id)
        if key in txn.writes:  # read-your-own-writes
            return True, txn.writes[key], None
        visible = [
            v for v in self._data.get(key, []) if vec_leq(v.vec, txn.ctx)
        ]
        if not visible:
            return False, None, None
        best = max(visible, key=lambda v: _version_rank(v.vec))
        return True, best.value, best.vec

    def write(self, txn_id: str, key: str, value) -> None:
        txn = self._active(txn_id)
        self._check_write_conflict(key, txn.ctx)
        txn.writes[key] = value

    # ------------------------------------------------------------------
    # garbage collection
    # ------------------------------------------------------------------
    def gc_watermark(self) -> tuple[int, ...] | None:
        """Component-wise min of all active snapshot contexts.

        Returns None when no snapshot is active (watermark is +infinity).
        """
        self._expire_txns()
        active = [t.ctx for t in self._txns.values() if t.state == "active"]
        if not active:
            return None
        return tuple(min(ctx[i] for ctx in active) for i in range(self.num_replicas))

    def gc(self) -> int:
        """Collect versions below the watermark that no snapshot can see.

        A version is kept when it is not dominated by the watermark, or it
        is a maximal version at/below the watermark for its key (some
        active snapshot may still read it).  Everything strictly dominated
        by another kept-or-keepable version at/below the watermark is
        unreachable and removed.
        """
        watermark = self.gc_watermark()
        collected = 0
        for key in list(self._data):
            versions = self._data[key]
            if watermark is None:
                below = list(versions)
                keep = set()
            else:
                below = [v for v in versions if vec_leq(v.vec, watermark)]
                keep = {id(v) for v in versions if not vec_leq(v.vec, watermark)}
            # Maximal elements among `below` must survive.
            for v in below:
                if not any(
                    w is not v and vec_leq(v.vec, w.vec) for w in below
                ):
                    keep.add(id(v))
            survivors = [v for v in versions if id(v) in keep]
            collected += len(versions) - len(survivors)
            if survivors:
                self._data[key] = survivors
            else:
                del self._data[key]
        return collected

    # ------------------------------------------------------------------
    # introspection helpers (used by tests and the CLI)
    # ------------------------------------------------------------------
    def txn_state(self, txn_id: str) -> str:
        txn = self._get(txn_id)
        self._expire_txns()
        return txn.state

    def version_count(self, key: str | None = None) -> int:
        if key is not None:
            return len(self._data.get(key, []))
        return self._version_count()

    def versions(self, key: str) -> list[Version]:
        return list(self._data.get(key, []))

    # ------------------------------------------------------------------
    # internals
    # ------------------------------------------------------------------
    def _version_count(self) -> int:
        return sum(len(v) for v in self._data.values())

    def _normalize_ctx(self, ctx) -> tuple[int, ...]:
        if ctx is None:
            return (0,) * self.num_replicas
        vec = [int(x) for x in ctx]
        if len(vec) > self.num_replicas:
            raise MVCCError("BAD_CTX: too many components")
        if any(x < 0 for x in vec):
            raise MVCCError("BAD_CTX: negative component")
        vec.extend([0] * (self.num_replicas - len(vec)))
        return tuple(vec)

    def _get(self, txn_id: str) -> Transaction:
        txn = self._txns.get(txn_id)
        if txn is None:
            raise TxnNotActive(f"unknown transaction {txn_id}")
        return txn

    def _expire_txns(self) -> None:
        now = self._now()
        for txn in self._txns.values():
            if (
                txn.state == "active"
                and txn.deadline is not None
                and now >= txn.deadline
            ):
                txn.state = "aborted"
                txn.writes.clear()

    def _active(self, txn_id: str) -> Transaction:
        txn = self._get(txn_id)
        self._expire_txns()
        if txn.state == "aborted":
            raise TxnAborted(f"transaction {txn_id} is aborted")
        if txn.state != "active":
            raise TxnNotActive(f"transaction {txn_id} is {txn.state}")
        return txn

    def _check_write_conflict(self, key: str, ctx: tuple[int, ...]) -> None:
        # Only committed versions matter; pending writes of other
        # transactions never make this write unsatisfiable.
        for v in self._data.get(key, []):
            if vec_concurrent(v.vec, ctx):
                raise WriteSkew(
                    f"key {key!r} has committed version {v.vec} "
                    f"concurrent with snapshot {ctx}"
                )
