"""bandjoin: watermark-driven temporal band join over two event streams.

Semantics
---------
* Each side (left/right) keeps an independent watermark:
  ``WM = max(ts seen so far) - skew`` (undefined until the first event).
* The lateness safe point is ``max(LWM, RWM) - bound``.  An event whose
  ``ts`` is strictly below that point on arrival is dropped as late and
  counted.  Events that are merely out of order within the bound are kept.
* Events with a repeated ``id`` on the same side are the same logical
  event: the first occurrence wins, later ones are counted as duplicates.
* A left and a right event match when ``key`` is equal and
  ``|ts_l - ts_r| <= bound`` (``bound == 0`` requires equal timestamps).
* ``finalise()`` emits pairs only once the watermarks guarantee no further
  matching events can appear; the output is deterministically sorted by
  ``(key, ts_l, ts_r, l_id, r_id)``.
"""

from __future__ import annotations

__all__ = [
    "BandJoin",
    "InputError",
    "pair_sort_key",
    "validate_event",
    "load_stream",
]

_LEFT = "L"
_RIGHT = "R"


class InputError(ValueError):
    """Raised when an input line is not a valid event record."""


def _scalar_token(value):
    """Total-order token so mixed str/number scalars sort deterministically."""
    if isinstance(value, bool):
        return (2, str(value))
    if isinstance(value, (int, float)):
        return (0, value)
    return (1, str(value))


def pair_sort_key(pair):
    """Deterministic output ordering: key, ts_l, ts_r, l_id, r_id."""
    return (
        _scalar_token(pair["key"]),
        pair["ts_l"],
        pair["ts_r"],
        _scalar_token(pair["l_id"]),
        _scalar_token(pair["r_id"]),
    )


def _is_num(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def validate_event(obj, where=""):
    """Validate one decoded JSON object as an event; return a clean dict."""
    prefix = f"{where}: " if where else ""
    if not isinstance(obj, dict):
        raise InputError(f"{prefix}expected a JSON object, got {type(obj).__name__}")
    for field in ("id", "key", "ts"):
        if field not in obj:
            raise InputError(f"{prefix}missing field {field!r}")
    if not (isinstance(obj["id"], (str, int)) and not isinstance(obj["id"], bool)):
        raise InputError(f"{prefix}field 'id' must be a string or integer")
    if not _is_num(obj["key"]) and not isinstance(obj["key"], str):
        raise InputError(f"{prefix}field 'key' must be a string or number")
    if not _is_num(obj["ts"]):
        raise InputError(f"{prefix}field 'ts' must be a number")
    return {"id": obj["id"], "key": obj["key"], "ts": obj["ts"]}


def _reject_constant(value):
    raise InputError(f"invalid JSON constant {value!r}")


def load_stream(path, name=None):
    """Read and validate a JSONL event stream; raises InputError on bad lines."""
    import json

    label = name or path
    events = []
    try:
        fh = open(path, "r", encoding="utf-8")
    except OSError as exc:
        raise InputError(f"{label}: cannot read file: {exc}") from exc
    with fh:
        for lineno, line in enumerate(fh, start=1):
            text = line.strip()
            if not text:
                raise InputError(f"{label}:{lineno}: blank line")
            try:
                obj = json.loads(text, parse_constant=_reject_constant)
            except json.JSONDecodeError as exc:
                raise InputError(f"{label}:{lineno}: invalid JSON: {exc}") from exc
            events.append(validate_event(obj, where=f"{label}:{lineno}"))
    return events


class BandJoin:
    """Incremental band join with independent per-side watermarks."""

    def __init__(self, bound, left_skew=0, right_skew=0):
        if not _is_num(bound) or bound < 0:
            raise ValueError("bound must be a non-negative number")
        for skew in (left_skew, right_skew):
            if not _is_num(skew) or skew < 0:
                raise ValueError("skew must be a non-negative number")
        self.bound = bound
        self._skew = {_LEFT: left_skew, _RIGHT: right_skew}
        self._max_ts = {_LEFT: None, _RIGHT: None}
        self._seen_ids = {_LEFT: set(), _RIGHT: set()}
        self._buf = {_LEFT: [], _RIGHT: []}
        self._pairs = []
        self._count = {
            side: {"input": 0, "accepted": 0, "duplicates": 0, "late": 0}
            for side in (_LEFT, _RIGHT)
        }

    # -- watermarks -----------------------------------------------------
    def watermark(self, side):
        peak = self._max_ts[side]
        return None if peak is None else peak - self._skew[side]

    def late_threshold(self):
        """Safe point: events with ts below it are dropped as late."""
        wms = [wm for wm in (self.watermark(_LEFT), self.watermark(_RIGHT)) if wm is not None]
        if not wms:
            return None
        return max(wms) - self.bound

    def safe_point(self):
        """Match safe point min(LWM + bound, RWM + bound), if both defined."""
        lwm, rwm = self.watermark(_LEFT), self.watermark(_RIGHT)
        if lwm is None or rwm is None:
            return None
        return min(lwm + self.bound, rwm + self.bound)

    # -- ingestion ------------------------------------------------------
    def add_left(self, event):
        self._add(_LEFT, event)

    def add_right(self, event):
        self._add(_RIGHT, event)

    def add(self, side, event):
        if side == _LEFT:
            self.add_left(event)
        elif side == _RIGHT:
            self.add_right(event)
        else:
            raise ValueError(f"unknown side {side!r}")

    def _add(self, side, event):
        self._count[side]["input"] += 1
        if event["id"] in self._seen_ids[side]:
            self._count[side]["duplicates"] += 1
            return
        threshold = self.late_threshold()
        if threshold is not None and event["ts"] < threshold:
            self._count[side]["late"] += 1
            return
        self._seen_ids[side].add(event["id"])
        self._count[side]["accepted"] += 1
        peak = self._max_ts[side]
        if peak is None or event["ts"] > peak:
            self._max_ts[side] = event["ts"]
        other = _RIGHT if side == _LEFT else _LEFT
        for candidate in self._buf[other]:
            if candidate["key"] == event["key"] and abs(candidate["ts"] - event["ts"]) <= self.bound:
                if side == _LEFT:
                    self._pairs.append((event, candidate))
                else:
                    self._pairs.append((candidate, event))
        self._buf[side].append(event)
        self._evict()

    def _evict(self):
        # Any event accepted in the future has ts >= current late threshold
        # (the threshold never decreases), so a buffered event whose match
        # window ends below the threshold can never match again.
        threshold = self.late_threshold()
        if threshold is None:
            return
        for side in (_LEFT, _RIGHT):
            self._buf[side] = [
                ev for ev in self._buf[side] if ev["ts"] + self.bound >= threshold
            ]

    # -- results --------------------------------------------------------
    def finalise(self):
        """Return matched pairs in deterministic sorted order."""
        out = [
            {
                "l_id": left["id"],
                "r_id": right["id"],
                "key": left["key"],
                "ts_l": left["ts"],
                "ts_r": right["ts"],
            }
            for left, right in self._pairs
        ]
        out.sort(key=pair_sort_key)
        return out

    def stats(self):
        return {
            "bound": self.bound,
            "left": dict(self._count[_LEFT]),
            "right": dict(self._count[_RIGHT]),
            "pairs": len(self._pairs),
            "left_watermark": self.watermark(_LEFT),
            "right_watermark": self.watermark(_RIGHT),
            "safe_point": self.safe_point(),
        }
