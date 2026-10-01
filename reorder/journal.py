"""Append-only JSONL write-ahead log for receive/assemble/deliver commits."""
from __future__ import annotations

import json
import os


class CorruptionError(Exception):
    """Raised when the journal violates the ack-set / output-cursor invariant."""


class Journal:
    def __init__(self, path: str, sync: bool = True):
        self.path = path
        self.sync = sync
        self._fh = open(path, "a", encoding="utf-8")

    def append(self, record: dict) -> None:
        self._fh.write(json.dumps(record, sort_keys=True) + "\n")
        self._fh.flush()
        if self.sync:
            os.fsync(self._fh.fileno())

    def replay(self) -> list[dict]:
        if not os.path.exists(self.path):
            return []
        with open(self.path, encoding="utf-8") as fh:
            return [json.loads(line) for line in fh if line.strip()]

    def close(self) -> None:
        self._fh.close()
