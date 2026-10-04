"""Core as-of join semantics with stream watermarks.

Streams
-------
Dimensions and facts are consumed in arrival order.  Two watermarks govern
when a result may be emitted:

* DWM (dimension watermark): max ``ts`` over all dimension arrivals.  A fact
  may only be resolved once ``DWM > fact.ts - tol``; before that a missing
  dimension is *not yet due* and must not be treated as unsatisfiable.
* FWM (fact watermark): max ``ts`` over all fact arrivals.  A fact arriving
  with ``ts < FWM`` is late and is dropped immediately.

Dimension updates
-----------------
Dimensions are keyed by ``did``.  A re-arrival overrides the previous record
only when its ``ts`` is strictly higher; a re-arrival with the same or lower
``ts`` is invalid and ignored.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Optional

REASON_NO_DIM = "no_dim"
REASON_STALE = "stale"


@dataclass(frozen=True)
class Fact:
    fid: str
    key: str
    ts: int


@dataclass(frozen=True)
class Dim:
    did: str
    key: str
    ts: int
    attr: Any


@dataclass(frozen=True)
class Result:
    fid: str
    ts: int
    did: Optional[str]
    attr: Any
    reason: Optional[str]  # None when a dimension matched

    def to_dict(self) -> dict:
        return {
            "fid": self.fid,
            "ts": self.ts,
            "did": self.did,
            "attr": self.attr,
            "reason": self.reason,
        }


class DimTable:
    """Current dimension state plus the dimension watermark (DWM)."""

    def __init__(self) -> None:
        # key -> did -> (ts, attr)
        self._by_key: dict[str, dict[str, tuple[int, Any]]] = {}
        # did -> (key, ts) currently in effect
        self._live: dict[str, tuple[str, int]] = {}
        self.watermark: Optional[int] = None

    def add(self, dim: Dim) -> bool:
        """Apply one dimension arrival; return True if it took effect."""
        self.watermark = (
            dim.ts if self.watermark is None else max(self.watermark, dim.ts)
        )
        prev = self._live.get(dim.did)
        if prev is not None and dim.ts <= prev[1]:
            return False  # re-arrival without a strictly higher ts is invalid
        if prev is not None:
            old_key, _ = prev
            bucket = self._by_key.get(old_key)
            if bucket is not None:
                bucket.pop(dim.did, None)
                if not bucket:
                    del self._by_key[old_key]
        self._live[dim.did] = (dim.key, dim.ts)
        self._by_key.setdefault(dim.key, {})[dim.did] = (dim.ts, dim.attr)
        return True

    def select(
        self, key: str, fact_ts: int, tol: int
    ) -> tuple[Optional[str], Any, Optional[str]]:
        """Pick the dimension for one fact.

        Among same-key dims with ``ts <= fact_ts`` and ``fact_ts - ts <= tol``
        choose the latest ``ts``; ties break to the lexicographically smallest
        ``did``.  Returns ``(did, attr, None)`` on a match, otherwise
        ``(None, None, reason)`` where reason is ``stale`` when same-key dims
        with ``ts <= fact_ts`` exist but all are older than the tolerance, or
        ``no_dim`` when no such dim exists at all.
        """
        bucket = self._by_key.get(key)
        best: Optional[tuple[int, str, Any]] = None
        has_candidate_key = False
        if bucket:
            for did, (ts, attr) in bucket.items():
                if ts > fact_ts:
                    continue
                has_candidate_key = True
                if fact_ts - ts > tol:
                    continue
                if best is None or ts > best[0] or (ts == best[0] and did < best[1]):
                    best = (ts, did, attr)
        if best is not None:
            return best[1], best[2], None
        reason = REASON_STALE if has_candidate_key else REASON_NO_DIM
        return None, None, reason


def join(
    facts: Iterable[Fact], dims: Iterable[Dim], tol: int
) -> list[Result]:
    """Run the as-of join and return results ordered by ``(fact.ts, fid)``.

    Facts are dropped when they arrive later than the fact watermark
    (``ts < FWM``).  A result (match or null-with-reason) is emitted only
    when ``DWM > fact.ts - tol``; otherwise the fact is still pending and
    produces no output.
    """
    if tol < 0:
        raise ValueError("tol must be >= 0")

    table = DimTable()
    for dim in dims:
        table.add(dim)
    dwm = table.watermark

    fwm: Optional[int] = None
    results: list[Result] = []
    for fact in facts:
        if fwm is not None and fact.ts < fwm:
            continue  # late fact: dropped
        fwm = fact.ts if fwm is None else max(fwm, fact.ts)
        if dwm is None or dwm <= fact.ts - tol:
            continue  # dimension watermark has not passed the lookback window
        did, attr, reason = table.select(fact.key, fact.ts, tol)
        results.append(Result(fact.fid, fact.ts, did, attr, reason))

    results.sort(key=lambda r: (r.ts, r.fid))
    return results
