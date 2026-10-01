"""ilog core: a crash-safe, persistent set of half-open integer intervals.

Storage layout (single JSON file plus two sidecar files):

    <path>          main data file: {"version": 1, "intervals": [[lo, hi], ...]}
    <path>.tmp      staging file for the next committed state
    <path>.commit   commit marker: sha256 hex digest of the staged tmp file

Commit protocol (all mutations are in-memory only until commit()):

    1. serialize the new state and write it to <path>.tmp, then fsync
    2. write the commit marker containing the tmp file's sha256, then fsync
    3. atomically os.replace(<path>.tmp, <path>) and fsync the directory
    4. remove the commit marker

Fault points (injectable via set_fault_hook for tests):

    after_tmp_write   crash after step 1, before the marker exists
    after_marker      crash after step 2, before the atomic replace
    after_replace     crash after step 3, before the marker is cleared

Recovery on open:

    * no marker              -> the last commit either finished or never
                                started; load the main file, discard any
                                leftover tmp file (recovered="clean")
    * marker + complete tmp  -> a commit was interrupted before the replace;
                                finish it by adopting the tmp state and
                                clearing the marker (recovered="committed")
    * marker + tmp missing, main matches the marker digest
                             -> the replace already happened; just clear the
                                marker (recovered="clean")
    * marker + corrupted tmp -> roll back to the main file, discard tmp,
                                clear the marker (recovered="rollback")

A commit is atomic: recovery never exposes a half-committed interval set.
"""

from __future__ import annotations

import hashlib
import json
import os
from typing import Callable, Optional


class IlogError(Exception):
    """Error with a machine-readable ``code`` (IO or BAD_INTERVAL)."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class FaultInjected(Exception):
    """Raised by the test fault hook to simulate a crash mid-commit."""


_FAULT_HOOK: Optional[Callable[[str], None]] = None


def set_fault_hook(hook: Optional[Callable[[str], None]]) -> None:
    """Install a hook called with each fault-point name during commit()."""
    global _FAULT_HOOK
    _FAULT_HOOK = hook


def _fault(point: str) -> None:
    if _FAULT_HOOK is not None:
        _FAULT_HOOK(point)


def _validate_interval(lo, hi) -> None:
    if (
        isinstance(lo, bool)
        or isinstance(hi, bool)
        or not isinstance(lo, int)
        or not isinstance(hi, int)
    ):
        raise IlogError(
            "BAD_INTERVAL", f"interval bounds must be integers, got [{lo!r}, {hi!r})"
        )
    if lo >= hi:
        raise IlogError("BAD_INTERVAL", f"empty or inverted interval [{lo}, {hi})")


def _normalize(intervals):
    """Sort and merge overlapping or adjacent half-open intervals."""
    merged = []
    for lo, hi in sorted(intervals):
        if merged and lo <= merged[-1][1]:
            if hi > merged[-1][1]:
                merged[-1][1] = hi
        else:
            merged.append([lo, hi])
    return merged


class IntervalStore:
    """A set of half-open intervals [lo, hi) persisted to a single JSON file."""

    def __init__(self, path):
        self.path = os.fspath(path)
        self.tmp_path = self.path + ".tmp"
        self.marker_path = self.path + ".commit"
        self.recovered = "clean"
        self._intervals = []
        self._load()

    @classmethod
    def open(cls, path) -> "IntervalStore":
        return cls(path)

    @property
    def intervals(self):
        """The current in-memory (possibly uncommitted) interval set."""
        return [tuple(iv) for iv in self._intervals]

    # ------------------------------------------------------------------ ops

    def add(self, lo, hi) -> None:
        _validate_interval(lo, hi)
        self._intervals = _normalize(self._intervals + [[lo, hi]])

    def remove(self, lo, hi) -> None:
        _validate_interval(lo, hi)
        result = []
        for a, b in self._intervals:
            if b <= lo or a >= hi:
                result.append([a, b])
                continue
            if a < lo:
                result.append([a, lo])
            if b > hi:
                result.append([hi, b])
        self._intervals = result

    def compact(self) -> None:
        """Normalize the in-memory set; persists only via commit()."""
        self._intervals = _normalize(self._intervals)

    # -------------------------------------------------------------- commit

    def commit(self) -> None:
        data = self._serialize()
        digest = hashlib.sha256(data.encode("utf-8")).hexdigest()

        try:
            with open(self.tmp_path, "w", encoding="utf-8") as fh:
                fh.write(data)
                fh.flush()
                os.fsync(fh.fileno())
        except OSError as exc:
            raise IlogError("IO", f"cannot write tmp file: {exc}") from exc
        _fault("after_tmp_write")

        try:
            with open(self.marker_path, "w", encoding="utf-8") as fh:
                fh.write(digest)
                fh.flush()
                os.fsync(fh.fileno())
        except OSError as exc:
            raise IlogError("IO", f"cannot write commit marker: {exc}") from exc
        _fault("after_marker")

        try:
            os.replace(self.tmp_path, self.path)
            self._fsync_dir()
        except OSError as exc:
            raise IlogError("IO", f"cannot replace main file: {exc}") from exc
        _fault("after_replace")

        self._clear_marker()

    # ------------------------------------------------------------ recovery

    def _load(self) -> None:
        digest = self._read_marker()
        if digest is None:
            self._discard_tmp()
            self._intervals = self._read_main()
            self.recovered = "clean"
            return

        tmp_state = self._read_tmp_if_valid(digest)
        if tmp_state is not None:
            # Commit interrupted before the replace: adopt the tmp state.
            try:
                os.replace(self.tmp_path, self.path)
                self._fsync_dir()
            except OSError as exc:
                raise IlogError("IO", f"cannot finish interrupted commit: {exc}") from exc
            self._clear_marker()
            self._intervals = tmp_state
            self.recovered = "committed"
            return

        main_state, main_raw = self._read_main_raw()
        if (
            not os.path.exists(self.tmp_path)
            and main_raw is not None
            and hashlib.sha256(main_raw.encode("utf-8")).hexdigest() == digest
        ):
            # The replace already happened before the crash.
            self._clear_marker()
            self._intervals = main_state
            self.recovered = "clean"
            return

        # Tmp is corrupted: roll back to the main file.
        self._discard_tmp()
        self._clear_marker()
        self._intervals = main_state
        self.recovered = "rollback"

    # -------------------------------------------------------------- helpers

    def _serialize(self) -> str:
        return json.dumps(
            {"version": 1, "intervals": self._intervals}, sort_keys=True
        )

    @staticmethod
    def _parse(text: str):
        try:
            obj = json.loads(text)
        except json.JSONDecodeError as exc:
            raise IlogError("IO", f"file is not valid JSON: {exc}") from exc
        if not isinstance(obj, dict) or not isinstance(obj.get("intervals"), list):
            raise IlogError("IO", "file does not contain an interval set")
        parsed = []
        for item in obj["intervals"]:
            if (
                not isinstance(item, list)
                or len(item) != 2
                or isinstance(item[0], bool)
                or isinstance(item[1], bool)
                or not isinstance(item[0], int)
                or not isinstance(item[1], int)
                or item[0] >= item[1]
            ):
                raise IlogError("IO", f"malformed interval entry: {item!r}")
            parsed.append([item[0], item[1]])
        return _normalize(parsed)

    def _read_marker(self) -> Optional[str]:
        try:
            with open(self.marker_path, "r", encoding="utf-8") as fh:
                return fh.read().strip()
        except FileNotFoundError:
            return None
        except OSError as exc:
            raise IlogError("IO", f"cannot read commit marker: {exc}") from exc

    def _read_tmp_if_valid(self, digest: str):
        try:
            with open(self.tmp_path, "r", encoding="utf-8") as fh:
                raw = fh.read()
        except OSError:
            return None
        if digest and hashlib.sha256(raw.encode("utf-8")).hexdigest() != digest:
            return None
        try:
            return self._parse(raw)
        except IlogError:
            return None

    def _read_main(self):
        state, _ = self._read_main_raw()
        return state

    def _read_main_raw(self):
        try:
            with open(self.path, "r", encoding="utf-8") as fh:
                raw = fh.read()
        except FileNotFoundError:
            return [], None
        except OSError as exc:
            raise IlogError("IO", f"cannot read main file: {exc}") from exc
        return self._parse(raw), raw

    def _discard_tmp(self) -> None:
        try:
            os.unlink(self.tmp_path)
        except FileNotFoundError:
            pass
        except OSError as exc:
            raise IlogError("IO", f"cannot discard tmp file: {exc}") from exc

    def _clear_marker(self) -> None:
        try:
            os.unlink(self.marker_path)
        except FileNotFoundError:
            pass
        except OSError as exc:
            raise IlogError("IO", f"cannot clear commit marker: {exc}") from exc

    def _fsync_dir(self) -> None:
        dirpath = os.path.dirname(os.path.abspath(self.path))
        try:
            fd = os.open(dirpath, os.O_RDONLY)
        except OSError:
            return
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
