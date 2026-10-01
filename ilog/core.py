"""ilog: a persistent set of half-open intervals [lo, hi) in a single JSON file.

Persistence protocol (crash-safe commit)
----------------------------------------
A commit of the in-memory working state goes through these steps:

1. Serialize the working state and write it to ``<path>.tmp``, then fsync.
2. Write a commit marker ``<path>.commit`` (JSON with the SHA-256 of the tmp
   file), then fsync.  The marker means "a commit is in progress; the tmp
   file holds the complete pending state".
3. Atomically ``os.replace(<path>.tmp, <path>)`` and fsync the directory.
4. Remove the commit marker.

Fault points (see :func:`set_fault`) are placed after step 1
(``after_tmp_write``), after step 2 (``after_marker_write``) and after step 3
(``after_replace``).

Recovery on open
----------------
* No marker: the main file is authoritative.  A leftover tmp file (crash
  before the marker was written) is discarded; uncommitted changes never
  take effect.
* Marker present and tmp file intact (digest matches, payload valid): the
  commit was interrupted before the replace, so the tmp state is adopted
  (``os.replace`` to the main file) and the marker is cleared.
  ``store.recovered == "committed"``.
* Marker present but tmp file missing: the replace already happened, the
  main file holds the new state; the marker is cleared.
  ``store.recovered == "committed"``.
* Marker present but tmp file corrupt (digest mismatch or invalid payload):
  roll back to the main file, discard tmp and marker, and report
  ``store.recovered == "rollback"``.
"""

from __future__ import annotations

import hashlib
import json
import math
import os

BAD_INTERVAL = "BAD_INTERVAL"
IO = "IO"

FORMAT_VERSION = 1

#: Fault points where a crash can be injected during :meth:`IntervalStore.commit`.
FAULT_POINTS = ("after_tmp_write", "after_marker_write", "after_replace")


class ILogError(Exception):
    """Error with a machine-readable ``code`` ("IO" or "BAD_INTERVAL")."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


class InjectedFault(Exception):
    """Raised at an armed fault point to simulate a crash mid-commit."""

    def __init__(self, point):
        super().__init__("injected fault at %s" % point)
        self.point = point


_fault_point = None


def set_fault(point):
    """Arm a one-shot fault injection at one of :data:`FAULT_POINTS`.

    The next :meth:`IntervalStore.commit` (or ``compact``) that reaches the
    point raises :class:`InjectedFault`, simulating a process crash.  The
    fault is consumed when it fires.  ``None`` disarms.
    """
    global _fault_point
    if point is not None and point not in FAULT_POINTS:
        raise ValueError("unknown fault point: %r" % (point,))
    _fault_point = point


def clear_fault():
    """Disarm any pending fault injection."""
    global _fault_point
    _fault_point = None


def _maybe_fault(point):
    global _fault_point
    if _fault_point == point:
        _fault_point = None
        raise InjectedFault(point)


def _validate_bound(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ILogError(BAD_INTERVAL, "interval bound must be a number, got %r" % (value,))
    if isinstance(value, float) and not math.isfinite(value):
        raise ILogError(BAD_INTERVAL, "interval bound must be finite, got %r" % (value,))


def _validate_interval(lo, hi):
    _validate_bound(lo)
    _validate_bound(hi)
    if not lo < hi:
        raise ILogError(BAD_INTERVAL, "invalid half-open interval [%r, %r)" % (lo, hi))


def _serialize(intervals):
    payload = {
        "version": FORMAT_VERSION,
        "intervals": [[lo, hi] for lo, hi in intervals],
    }
    return (json.dumps(payload, sort_keys=True) + "\n").encode("utf-8")


def _parse(data):
    """Parse and validate serialized state; raises ILogError(code=IO) if corrupt."""
    try:
        payload = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ILogError(IO, "file is not valid JSON: %s" % exc)
    if not isinstance(payload, dict) or payload.get("version") != FORMAT_VERSION:
        raise ILogError(IO, "unsupported or missing format version")
    raw = payload.get("intervals")
    if not isinstance(raw, list):
        raise ILogError(IO, "missing or invalid 'intervals' list")
    intervals = []
    for item in raw:
        if not (isinstance(item, list) and len(item) == 2):
            raise ILogError(IO, "corrupt interval entry: %r" % (item,))
        lo, hi = item
        try:
            _validate_interval(lo, hi)
        except ILogError as exc:
            raise ILogError(IO, "corrupt interval data: %s" % exc.message)
        intervals.append((lo, hi))
    for (_, prev_hi), (next_lo, _) in zip(intervals, intervals[1:]):
        if prev_hi > next_lo:
            raise ILogError(IO, "intervals are not sorted/non-overlapping")
    return intervals


def _write_file_sync(path, data):
    try:
        with open(path, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
    except OSError as exc:
        raise ILogError(IO, "cannot write %s: %s" % (path, exc))


def _read_file(path):
    try:
        with open(path, "rb") as fh:
            return fh.read()
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise ILogError(IO, "cannot read %s: %s" % (path, exc))


def _fsync_dir(path):
    try:
        fd = os.open(path or ".", os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def _remove_file(path):
    try:
        os.remove(path)
    except FileNotFoundError:
        pass
    except OSError as exc:
        raise ILogError(IO, "cannot remove %s: %s" % (path, exc))


class IntervalStore:
    """A set of half-open intervals persisted to a single JSON file.

    ``add``/``remove`` mutate only the in-memory working state; ``commit``
    (and ``compact``, which commits through the same protocol) makes the
    working state durable.
    """

    def __init__(self, path):
        self.path = os.fspath(path)
        self.tmp_path = self.path + ".tmp"
        self.marker_path = self.path + ".commit"
        self.recovered = None
        self._intervals = self._recover()

    def intervals(self):
        """Return the working-state intervals as a sorted list of (lo, hi)."""
        return list(self._intervals)

    # -- interval operations (in-memory only) -------------------------------

    def add(self, lo, hi):
        """Add [lo, hi), merging overlapping intervals. Adjacent (touching)
        intervals are kept separate until :meth:`compact`."""
        _validate_interval(lo, hi)
        result = []
        placed = False
        for a, b in self._intervals:
            if b <= lo:
                result.append((a, b))
            elif a >= hi:
                if not placed:
                    result.append((lo, hi))
                    placed = True
                result.append((a, b))
            else:
                lo = min(lo, a)
                hi = max(hi, b)
        if not placed:
            result.append((lo, hi))
        self._intervals = result

    def remove(self, lo, hi):
        """Subtract [lo, hi) from the set."""
        _validate_interval(lo, hi)
        result = []
        for a, b in self._intervals:
            if b <= lo or a >= hi:
                result.append((a, b))
                continue
            if a < lo:
                result.append((a, lo))
            if b > hi:
                result.append((hi, b))
        self._intervals = result

    def compact(self):
        """Merge boundary-adjacent intervals and persist via the commit flow."""
        merged = []
        for lo, hi in self._intervals:
            if merged and lo <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], hi)
            else:
                merged.append([lo, hi])
        self._intervals = [(lo, hi) for lo, hi in merged]
        self.commit()

    # -- persistence ---------------------------------------------------------

    def commit(self):
        """Durably persist the working state via tmp -> marker -> replace."""
        data = _serialize(self._intervals)
        _write_file_sync(self.tmp_path, data)
        _maybe_fault("after_tmp_write")
        marker = json.dumps(
            {"version": FORMAT_VERSION, "sha256": hashlib.sha256(data).hexdigest()},
            sort_keys=True,
        ).encode("utf-8") + b"\n"
        _write_file_sync(self.marker_path, marker)
        _maybe_fault("after_marker_write")
        try:
            os.replace(self.tmp_path, self.path)
        except OSError as exc:
            raise ILogError(IO, "cannot replace %s: %s" % (self.path, exc))
        _fsync_dir(os.path.dirname(os.path.abspath(self.path)))
        _maybe_fault("after_replace")
        _remove_file(self.marker_path)

    def _recover(self):
        marker = _read_file(self.marker_path)
        if marker is None:
            # No commit in progress: the main file is authoritative.
            main = _read_file(self.path)
            _remove_file(self.tmp_path)
            if main is None:
                return []
            return _parse(main)

        tmp = _read_file(self.tmp_path)
        if tmp is not None:
            expected = self._marker_digest(marker)
            intact = (
                expected is not None
                and expected == hashlib.sha256(tmp).hexdigest()
            )
            if intact:
                try:
                    intervals = _parse(tmp)
                except ILogError:
                    intact = False
            if intact:
                # Commit interrupted before the replace: adopt the new state.
                self._install_tmp()
                _remove_file(self.marker_path)
                self.recovered = "committed"
                return intervals
            # tmp is corrupt or unverifiable: roll back to the main file.
            main = _read_file(self.path)
            intervals = _parse(main) if main is not None else []
            _remove_file(self.tmp_path)
            _remove_file(self.marker_path)
            self.recovered = "rollback"
            return intervals

        # tmp is gone: the replace already happened, main holds the new state.
        main = _read_file(self.path)
        intervals = _parse(main) if main is not None else []
        _remove_file(self.marker_path)
        self.recovered = "committed"
        return intervals

    @staticmethod
    def _marker_digest(marker):
        try:
            payload = json.loads(marker.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
        if not isinstance(payload, dict):
            return None
        digest = payload.get("sha256")
        return digest if isinstance(digest, str) else None

    def _install_tmp(self):
        try:
            os.replace(self.tmp_path, self.path)
        except OSError as exc:
            raise ILogError(IO, "cannot replace %s: %s" % (self.path, exc))
        _fsync_dir(os.path.dirname(os.path.abspath(self.path)))
