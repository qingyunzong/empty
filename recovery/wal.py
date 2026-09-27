"""Append-only write-ahead log.

Every record is a JSON object on its own line.  Records are flushed and
fsynced on append, so anything acknowledged by :meth:`Wal.append` survives
a crash.  LSNs are monotonically increasing integers starting at 1.
"""

import json
import os


class Wal:
    def __init__(self, path):
        self.path = path
        self.next_lsn = 1
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as existing:
                for line in existing:
                    line = line.strip()
                    if line:
                        lsn = json.loads(line)["lsn"]
                        self.next_lsn = max(self.next_lsn, lsn + 1)
        self._file = open(path, "a", encoding="utf-8")

    def append(self, record):
        """Assign an LSN, persist the record durably, and return the LSN."""
        record["lsn"] = self.next_lsn
        self.next_lsn += 1
        self._file.write(json.dumps(record, sort_keys=True) + "\n")
        self._file.flush()
        os.fsync(self._file.fileno())
        return record["lsn"]

    def read_all(self):
        records = []
        if os.path.exists(self.path):
            with open(self.path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line:
                        records.append(json.loads(line))
        return records

    def close(self):
        self._file.close()
