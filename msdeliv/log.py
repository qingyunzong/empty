"""Durable JSON-lines log for receive / assemble / delivery commit points.

Every state-changing decision is appended (and fsynced) before it is
reported to the caller, so a crash can lose at most the unacknowledged
frames.  Recovery replays the log deterministically.
"""

from __future__ import annotations

import json
import os


class DurableLog:
    def __init__(self, path=None):
        self.path = path
        self.records = []
        self._fh = None
        if path is not None:
            self._fh = open(path, "a", encoding="utf-8")

    def record(self, kind, **fields):
        rec = {"kind": kind}
        rec.update(fields)
        self.records.append(rec)
        if self._fh is not None:
            self._fh.write(json.dumps(rec, sort_keys=True) + "\n")
            self._fh.flush()
            os.fsync(self._fh.fileno())
        return rec

    def close(self):
        if self._fh is not None:
            self._fh.close()
            self._fh = None

    @staticmethod
    def replay(path):
        events = []
        if path is None or not os.path.exists(path):
            return events
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    events.append(json.loads(line))
        return events
