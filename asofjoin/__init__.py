"""asofjoin: streaming as-of join between a fact stream and a dimension stream.

Facts:  {"fid": str, "key": str, "ts": int}
Dims:   {"did": str, "key": str, "ts": int, "attr": any}

For every fact, the join picks, among dims with the same key and
fact.ts - tol <= dim.ts <= fact.ts, the one with the greatest ts; ties on
ts are broken by the lexicographically smallest did.  When no dim with
ts <= fact.ts exists for the key the output is reason="no_dim"; when such
dims exist but the newest is older than fact.ts - tol the output is
reason="stale".

Streaming semantics
-------------------
* DWM (dimension watermark) = greatest dim ts observed so far.
  FWM (fact watermark)      = greatest fact ts observed so far.
* A buffered fact is emitted only when DWM > fact.ts - tol and
  FWM > fact.ts, so that no future in-order event can change the choice
  and no earlier fact can still arrive.  Everything left is emitted by
  flush() (end of input == watermarks at +inf).
* Dims may arrive out of order and update still-pending facts; a dim that
  has not arrived yet is never treated as making a fact unsatisfiable.
* Duplicate did: a later arrival overrides only when its ts is strictly
  greater; a later arrival with equal (or lower) ts has no effect.
* A fact arriving with ts < FWM is too late and is dropped silently.
* results() are deterministically ordered by (fact.ts, fid).
"""

from __future__ import annotations

__all__ = ["AsofJoiner", "run_join"]

_NO_DIM = "no_dim"
_STALE = "stale"
_OK = "ok"


class _Dim:
    __slots__ = ("did", "key", "ts", "attr")

    def __init__(self, did, key, ts, attr):
        self.did = did
        self.key = key
        self.ts = ts
        self.attr = attr


class _Fact:
    __slots__ = ("fid", "key", "ts")

    def __init__(self, fid, key, ts):
        self.fid = fid
        self.key = key
        self.ts = ts


class AsofJoiner:
    """Incremental as-of join engine driven by watermarks."""

    def __init__(self, tol):
        if not isinstance(tol, int) or isinstance(tol, bool):
            raise TypeError("tol must be an int")
        if tol < 0:
            raise ValueError("tol must be >= 0")
        self.tol = tol
        self._dims = {}        # did -> _Dim (current winning record per did)
        self._by_key = {}      # key -> list[(ts, did)] for current dims
        self._dwm = None       # dimension watermark (max dim ts seen)
        self._fwm = None       # fact watermark (max fact ts seen)
        self._pending = []     # buffered _Fact, arrival order
        self._outputs = []     # emitted result dicts, emission order
        self.dropped_facts = 0
        self.ignored_dims = 0

    @property
    def dim_watermark(self):
        return self._dwm

    @property
    def fact_watermark(self):
        return self._fwm

    @property
    def pending_count(self):
        return len(self._pending)

    def add_dim(self, did, key, ts, attr):
        """Ingest one dimension record (arrival order matters)."""
        existing = self._dims.get(did)
        if existing is not None and existing.ts >= ts:
            # Later arrival with equal or lower ts never overrides.
            self.ignored_dims += 1
            return
        if existing is not None:
            entries = self._by_key.get(existing.key)
            if entries is not None:
                try:
                    entries.remove((existing.ts, existing.did))
                except ValueError:
                    pass
        self._dims[did] = _Dim(did, key, ts, attr)
        self._by_key.setdefault(key, []).append((ts, did))
        if self._dwm is None or ts > self._dwm:
            self._dwm = ts
        self._drain()

    def add_fact(self, fid, key, ts):
        """Ingest one fact; facts later than the fact watermark are dropped."""
        if self._fwm is not None and ts < self._fwm:
            self.dropped_facts += 1
            return
        if self._fwm is None or ts > self._fwm:
            self._fwm = ts
        self._pending.append(_Fact(fid, key, ts))
        self._drain()

    def flush(self):
        """End of input: emit every still-pending fact."""
        pending, self._pending = self._pending, []
        for fact in pending:
            self._emit(fact)

    def results(self):
        """All emitted outputs, deterministically ordered by (ts, fid)."""
        return sorted(self._outputs, key=lambda o: (o["ts"], o["fid"]))

    # -- internals ---------------------------------------------------------

    def _ready(self, fact):
        return (
            self._dwm is not None
            and self._dwm > fact.ts - self.tol
            and self._fwm is not None
            and self._fwm > fact.ts
        )

    def _drain(self):
        if not self._pending:
            return
        remaining = []
        for fact in self._pending:
            if self._ready(fact):
                self._emit(fact)
            else:
                remaining.append(fact)
        self._pending = remaining

    def _emit(self, fact):
        did, attr, reason = self._lookup(fact.key, fact.ts)
        self._outputs.append(
            {
                "fid": fact.fid,
                "key": fact.key,
                "ts": fact.ts,
                "did": did,
                "attr": attr,
                "reason": reason,
            }
        )

    def _lookup(self, key, ts):
        best = None  # (ts, did)
        for dim_ts, did in self._by_key.get(key, ()):
            if dim_ts > ts:
                continue
            if best is None or dim_ts > best[0] or (dim_ts == best[0] and did < best[1]):
                best = (dim_ts, did)
        if best is None:
            return None, None, _NO_DIM
        if ts - best[0] > self.tol:
            return None, None, _STALE
        dim = self._dims[best[1]]
        return dim.did, dim.attr, _OK


def run_join(facts, dims, tol):
    """Batch helper used by the CLI.

    ``facts`` and ``dims`` are iterables of dicts in file (arrival) order.
    The two streams are merged by ts (dims before facts on equal ts, file
    order otherwise), fed through an AsofJoiner and flushed; the sorted
    outputs are returned.
    """
    events = []
    for seq, dim in enumerate(dims):
        events.append((dim["ts"], 0, seq, dim))
    for seq, fact in enumerate(facts):
        events.append((fact["ts"], 1, seq, fact))
    events.sort(key=lambda e: (e[0], e[1], e[2]))

    joiner = AsofJoiner(tol)
    for _, kind, _, rec in events:
        if kind == 0:
            joiner.add_dim(rec["did"], rec["key"], rec["ts"], rec["attr"])
        else:
            joiner.add_fact(rec["fid"], rec["key"], rec["ts"])
    joiner.flush()
    return joiner.results()
