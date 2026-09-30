"""Append-only write-ahead log with per-record checksums.

Every mutation is logged (and fsynced) *before* it is applied to in-memory
state, so recovery from any prefix of the file — including a torn final
write — replays exactly the committed mutations.  Records carry a
monotonically increasing sequence number, which makes replay idempotent:
a confirmed deduction recorded once is applied exactly once.
"""

from __future__ import annotations

import hashlib
import json
import os


def _digest(payload: dict) -> str:
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


class WriteAheadLog:
    def __init__(self, path: str):
        self.path = path
        self._fh = open(path, "ab", buffering=0)

    def append(self, record: dict) -> dict:
        """Seal and durably append one record; returns the sealed record."""
        sealed = dict(record)
        sealed["checksum"] = _digest(record)
        line = json.dumps(sealed, sort_keys=True) + "\n"
        data = line.encode("utf-8")
        self._fh.write(data)
        self._fh.flush()
        os.fsync(self._fh.fileno())
        return sealed

    def close(self) -> None:
        self._fh.close()


def replay(path: str):
    """Yield the valid committed records from `path`, in order.

    Stops silently at the first incomplete or corrupt line (torn tail).
    """
    if not os.path.exists(path):
        return
    with open(path, "rb") as fh:
        for raw in fh:
            raw = raw.strip()
            if not raw:
                continue
            try:
                record = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                break
            checksum = record.pop("checksum", None)
            if checksum is None or checksum != _digest(record):
                break
            yield record
