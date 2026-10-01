"""Read-only comparison probe for an as_of timestamp before key creation."""

import importlib
import json
import sys

side, workspace = sys.argv[1:3]
sys.path.insert(0, workspace)
core = importlib.import_module("vgc.core")
store = core.MVCCStore(max_versions=1)

for txn, value in (("first", "v1"), ("second", "v2")):
    store.begin(txn)
    store.put(txn, "k", value)
    store.commit(txn)

gc_result = store.gc()
try:
    value = store.as_of(0, "k") if side == "A" else store.as_of("k", 0)
    outcome = {"kind": "value", "value": value}
except core.SnapshotExpired:
    outcome = {"kind": "SNAPSHOT_EXPIRED"}

print(json.dumps({
    "side": side,
    "gc": gc_result if isinstance(gc_result, dict) else vars(gc_result),
    "as_of_before_first_commit": outcome,
    "expected": {"kind": "value", "value": None},
}, ensure_ascii=False, sort_keys=True))
