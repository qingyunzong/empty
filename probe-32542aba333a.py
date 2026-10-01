"""Independent, assertion-backed demonstrations of the delivered vgc package.

Run from the product workspace with Python 3.11 -B. Each mode is one scenario.
"""

import io
import json
import os
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.getcwd())

from vgc import GC_DEFERRED, OK, MVCCStore, SnapshotExpired
from vgc.cli import serve


def committed(store, txn, value, key="k"):
    store.begin(txn)
    store.put(txn, key, value)
    return store.commit(txn)


def boundary():
    store = MVCCStore(max_versions=1)
    first = committed(store, "first", "v1")
    committed(store, "second", "v2")
    gc = store.gc()
    before = store.as_of("k", first - 1)
    assert gc.status == OK and gc.collected == 1, vars(gc)
    assert before is None, before
    print(json.dumps({"collected": gc.collected, "before_first_commit": before}))


def pin():
    store = MVCCStore()
    committed(store, "first", "v1")
    snapshot = store.begin("long")
    committed(store, "second", "v2")
    committed(store, "third", "v3")
    gc = store.gc()
    visible = store.get("long", "k")
    assert gc.status == OK and gc.collected == 0, vars(gc)
    assert gc.low_watermark == snapshot and visible == "v1"
    print(json.dumps({"collected": gc.collected, "low_watermark": gc.low_watermark, "long_read": visible}))


def release():
    store = MVCCStore()
    committed(store, "first", "v1")
    store.begin("long")
    committed(store, "second", "v2")
    committed(store, "third", "v3")
    before = store.gc()
    store.commit("long")
    after = store.gc()
    stats = store.stats()
    assert before.collected == 0, vars(before)
    assert after.status == OK and after.collected == 2, vars(after)
    assert stats["collected_total"] == 2 and stats["versions_total"] == 1, stats
    assert stats["gc_runs"] == 2 and store.as_of("k", store.clock) == "v3", stats
    print(json.dumps({"after_collected": after.collected, "collected_total": stats["collected_total"], "versions_total": stats["versions_total"]}))


def budget():
    store = MVCCStore(max_versions=2)
    committed(store, "first", "v1")
    store.begin("long")
    for txn, value in (("second", "v2"), ("third", "v3"), ("fourth", "v4")):
        committed(store, txn, value)
    gc = store.gc()
    visible = store.get("long", "k")
    assert gc.status == GC_DEFERRED and gc.collected == 0, vars(gc)
    assert gc.deferred_keys == ["k"] and gc.versions_remaining == 4, vars(gc)
    assert visible == "v1", visible
    print(json.dumps({"status": gc.status, "deferred_keys": gc.deferred_keys, "versions_remaining": gc.versions_remaining, "long_read": visible}))


def expiry():
    requests = [
        {"op": "begin", "txn": "first"},
        {"op": "put", "txn": "first", "key": "k", "value": "v1"},
        {"op": "commit", "txn": "first"},
        {"op": "begin", "txn": "second"},
        {"op": "put", "txn": "second", "key": "k", "value": "v2"},
        {"op": "commit", "txn": "second"},
        {"op": "gc"},
        {"op": "as_of", "key": "k", "ts": 1},
    ]
    output = io.StringIO()
    serve(MVCCStore(), io.StringIO("".join(json.dumps(x) + "\n" for x in requests)), output)
    responses = [json.loads(line) for line in output.getvalue().splitlines()]
    assert responses[6]["status"] == OK and responses[6]["collected"] == 1, responses[6]
    assert responses[7] == {"status": "SNAPSHOT_EXPIRED", "key": "k", "ts": 1}, responses[7]
    print(json.dumps({"gc_collected": responses[6]["collected"], "as_of": responses[7]}))


def get_abort():
    store = MVCCStore()
    store.begin("draft")
    store.put("draft", "k", "temporary")
    own_read = store.get("draft", "k")
    store.abort("draft")
    store.begin("later")
    later_read = store.get("later", "k")
    assert own_read == "temporary" and later_read is None
    assert store.stats()["versions_total"] == 0
    print(json.dumps({"own_read": own_read, "after_abort": later_read, "versions_total": store.stats()["versions_total"]}))


SCENARIOS = {
    "boundary": boundary,
    "pin": pin,
    "release": release,
    "budget": budget,
    "expiry": expiry,
    "get_abort": get_abort,
}

if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in SCENARIOS:
        raise SystemExit("usage: probe.py " + "|".join(SCENARIOS))
    SCENARIOS[sys.argv[1]]()
