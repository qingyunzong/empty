"""Pure-Python reference model for the MVCC store.

Deliberately implemented independently from mvcc.Store: committed writes
are kept as an append-only log of (commit_ts, key, value) events where a
value of None is a tombstone. Reads replay the log up to the reader's
timestamp and take the last event per key.
"""

SNAPSHOT = "snapshot"
READ_COMMITTED = "read_committed"


class RefTxnStateError(Exception):
    pass


class RefModel:
    def __init__(self):
        self.events = []  # (commit_ts, key, value); value None == tombstone
        self.ts = 0
        self.txns = {}
        self.next_id = 1

    def begin(self, mode):
        tid = self.next_id
        self.next_id += 1
        self.txns[tid] = {
            "mode": mode,
            "snap": self.ts if mode == SNAPSHOT else None,
            "writes": {},
            "state": "active",
        }
        return tid

    def _active(self, tid):
        txn = self.txns[tid]
        if txn["state"] != "active":
            raise RefTxnStateError(tid)
        return txn

    def get(self, tid, key):
        txn = self._active(tid)
        if key in txn["writes"]:
            return txn["writes"][key]
        ts = txn["snap"] if txn["mode"] == SNAPSHOT else self.ts
        best = None
        for commit_ts, k, v in self.events:
            if k == key and commit_ts <= ts:
                best = v
        return best

    def put(self, tid, key, value):
        self._active(tid)["writes"][key] = value

    def delete(self, tid, key):
        self._active(tid)["writes"][key] = None

    def commit(self, tid):
        txn = self._active(tid)
        self.ts += 1
        for k, v in txn["writes"].items():
            self.events.append((self.ts, k, v))
        txn["writes"] = {}
        txn["state"] = "committed"
        return self.ts

    def abort(self, tid):
        txn = self._active(tid)
        txn["writes"] = {}
        txn["state"] = "aborted"
