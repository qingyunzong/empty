"""Reference implementation: full logical replay of the entire WAL.

Ignores checkpoints, pageLSNs and buffer state entirely.  The final state
is defined as: apply, in LSN order, every UPDATE belonging to a
transaction that committed; ignore everything else (aborted transactions
and their CLRs cancel out).  Used to cross-check ARIES recovery.
"""

import json
import os


def reference_state(dbdir):
    wal_path = os.path.join(dbdir, "wal.log")
    records = []
    if os.path.exists(wal_path):
        with open(wal_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    records.append(json.loads(line))
    committed = {rec["txn"] for rec in records if rec["type"] == "COMMIT"}
    state = {}
    for rec in records:
        if rec["type"] == "UPDATE" and rec["txn"] in committed:
            if rec["after"] is None:
                state.pop(rec["key"], None)
            else:
                state[rec["key"]] = rec["after"]
    return state
