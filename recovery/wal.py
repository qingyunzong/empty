"""Write-ahead log: an append-only JSON-lines file.

Record types:
  begin       {txn}
  update      {txn, page, key, before, after, prev}
  commit      {txn, prev}
  end         {txn, prev}          transaction fully finished
  clr         {txn, page, key, before, after, prev, undo_next}
  checkpoint  {dirty: {page: recLSN}, txns: {txn: lastLSN}}

Every record carries an "lsn" assigned by the engine. "prev" chains
records of one transaction backwards; "undo_next" on a CLR skips
already-undone records during repeated undo passes.
"""

import json
import os


class WAL:
    def __init__(self, path):
        self.path = path
        if not os.path.exists(path):
            open(path, "wb").close()
        self._fh = open(path, "a", encoding="utf-8")

    def append(self, record):
        self._fh.write(json.dumps(record, sort_keys=True) + "\n")
        self._fh.flush()
        os.fsync(self._fh.fileno())
        return record["lsn"]

    def scan(self):
        """Return all records as a list ordered by LSN."""
        records = []
        with open(self.path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    records.append(json.loads(line))
        records.sort(key=lambda rec: rec["lsn"])
        return records

    def max_lsn(self):
        last = 0
        with open(self.path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    last = max(last, json.loads(line)["lsn"])
        return last

    def close(self):
        self._fh.close()
