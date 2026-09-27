"""Acceptance and randomized differential tests for the vgc package."""

import io
import json
import random
import unittest

from vgc import GC_DEFERRED, OK, MVCCStore, SnapshotExpired, TxnError
from vgc.cli import serve


def commit_value(store, txn, key, value):
    """Helper: single-write transaction, returns commit_ts."""
    store.begin(txn)
    store.put(txn, key, value)
    return store.commit(txn)


class LongTransactionPinningTest(unittest.TestCase):
    """(a) While a long transaction is alive, gc keeps its visible versions."""

    def test_gc_preserves_versions_visible_to_long_txn(self):
        store = MVCCStore()
        commit_value(store, "w0", "k", "v1")
        snap_ts = store.begin("long")  # snapshot sees "v1"
        commit_value(store, "w1", "k", "v2")
        commit_value(store, "w2", "k", "v3")

        result = store.gc()
        self.assertEqual(result.status, OK)
        self.assertEqual(result.collected, 0)  # v1 still visible to "long"
        self.assertEqual(result.low_watermark, snap_ts)

        # The long transaction still reads its own snapshot.
        self.assertEqual(store.as_of("k", snap_ts), "v1")
        self.assertEqual(store.get("long", "k"), "v1")
        # Newer snapshots see the newest committed version.
        self.assertEqual(store.as_of("k", store.clock), "v3")
        self.assertEqual(len(store._versions["k"]), 3)


class CollectAfterLongTxnCommitTest(unittest.TestCase):
    """(b) After the long transaction commits, gc collects and reports stats."""

    def test_gc_collects_after_long_txn_commits(self):
        store = MVCCStore()
        commit_value(store, "w0", "k", "v1")
        store.begin("long")
        commit_value(store, "w1", "k", "v2")
        commit_value(store, "w2", "k", "v3")
        store.gc()
        self.assertEqual(len(store._versions["k"]), 3)

        store.put("long", "other", "x")
        store.commit("long")  # long txn no longer pins anything

        result = store.gc()
        self.assertEqual(result.status, OK)
        self.assertEqual(result.collected, 2)  # v1, v2 collected; v3 kept
        self.assertEqual(result.low_watermark, store.clock)
        self.assertEqual(len(store._versions["k"]), 1)

        stats = store.stats()
        self.assertEqual(stats["collected_total"], 2)
        self.assertEqual(stats["gc_runs"], 2)
        self.assertEqual(stats["versions_total"], 2)  # k: v3, other: x
        self.assertEqual(stats["versions_per_key"], {"k": 1, "other": 1})
        self.assertEqual(stats["active_snapshots"], {})
        self.assertEqual(stats["low_watermark"], store.clock)


class SnapshotExpiredTest(unittest.TestCase):
    """(c) as_of on an expired snapshot reports SNAPSHOT_EXPIRED."""

    def test_as_of_expired_snapshot(self):
        store = MVCCStore()
        ts_v1 = commit_value(store, "w0", "k", "v1")
        commit_value(store, "w1", "k", "v2")
        store.gc()  # no active snapshots: v1 collected

        with self.assertRaises(SnapshotExpired) as ctx:
            store.as_of("k", ts_v1)
        self.assertEqual(ctx.exception.key, "k")
        self.assertEqual(ctx.exception.ts, ts_v1)

        # A timestamp before the key ever existed is NOT_FOUND, not expired.
        self.assertIsNone(store.as_of("k", ts_v1 - 1))
        # Current reads still work.
        self.assertEqual(store.as_of("k", store.clock), "v2")

    def test_cli_reports_snapshot_expired(self):
        responses = run_cli([
            {"op": "begin", "txn": "w0"},
            {"op": "put", "txn": "w0", "key": "k", "value": "v1"},
            {"op": "commit", "txn": "w0"},          # commit_ts = 1
            {"op": "begin", "txn": "w1"},
            {"op": "put", "txn": "w1", "key": "k", "value": "v2"},
            {"op": "commit", "txn": "w1"},
            {"op": "gc"},
            {"op": "as_of", "key": "k", "ts": 1},
            {"op": "as_of", "key": "k", "ts": 2},
        ])
        self.assertEqual(responses[6]["status"], OK)
        self.assertEqual(responses[6]["collected"], 1)
        self.assertEqual(responses[7]["status"], "SNAPSHOT_EXPIRED")
        self.assertEqual(responses[8]["status"], OK)
        self.assertEqual(responses[8]["value"], "v2")


class MaxVersionsBudgetTest(unittest.TestCase):
    """max_versions budget: GC_DEFERRED instead of an error when pinned."""

    def test_deferred_while_pinned_then_ok(self):
        store = MVCCStore(max_versions=2)
        commit_value(store, "w0", "k", "v1")
        store.begin("long")  # pins v1
        commit_value(store, "w1", "k", "v2")
        commit_value(store, "w2", "k", "v3")
        commit_value(store, "w3", "k", "v4")

        result = store.gc()
        self.assertEqual(result.status, GC_DEFERRED)
        self.assertEqual(result.deferred_keys, ["k"])
        self.assertEqual(result.collected, 0)
        self.assertEqual(len(store._versions["k"]), 4)  # over budget but pinned

        store.abort("long")
        result = store.gc()
        self.assertEqual(result.status, OK)
        self.assertEqual(result.collected, 3)
        self.assertEqual(len(store._versions["k"]), 1)  # only v4 remains
        self.assertEqual(store.as_of("k", store.clock), "v4")


class ReferenceModel:
    """Keeps every version forever; the ground truth for visibility."""

    def __init__(self):
        self.versions = {}  # key -> list[(commit_ts, value)]

    def commit(self, writes, commit_ts):
        for key, value in writes.items():
            self.versions.setdefault(key, []).append((commit_ts, value))

    def visible(self, key, ts):
        result = None
        for commit_ts, value in self.versions.get(key, []):
            if commit_ts <= ts:
                result = value
            else:
                break
        return result

    def keys(self):
        return self.versions.keys()


class RandomizedDifferentialTest(unittest.TestCase):
    """(d) Random op sequences: every active snapshot must see exactly what
    the keep-everything reference sees, across arbitrary gc interleavings."""

    def run_random(self, seed, steps=400):
        rng = random.Random(seed)
        store = MVCCStore(max_versions=rng.choice([None, 2, 3, 5]))
        ref = ReferenceModel()
        keys = [f"k{i}" for i in range(4)]
        active = {}  # txn -> {"snapshot_ts": int, "writes": dict}
        counter = 0

        for _ in range(steps):
            op = rng.choice(
                ["begin", "put", "commit", "abort", "gc", "gc", "check"]
            )
            if op == "begin" or not active and op in ("put", "commit", "abort"):
                counter += 1
                txn = f"t{counter}"
                snap = store.begin(txn)
                active[txn] = {"snapshot_ts": snap, "writes": {}}
            elif op == "put":
                txn = rng.choice(list(active))
                key = rng.choice(keys)
                value = rng.randint(0, 1000)
                store.put(txn, key, value)
                active[txn]["writes"][key] = value
            elif op == "commit":
                txn = rng.choice(list(active))
                commit_ts = store.commit(txn)
                ref.commit(active.pop(txn)["writes"], commit_ts)
            elif op == "abort":
                txn = rng.choice(list(active))
                store.abort(txn)
                active.pop(txn)
            elif op == "gc":
                store.gc()
            else:  # check
                pass

            # After every step: all active snapshots must see exactly what
            # the reference (which never collects) sees.
            for txn, state in active.items():
                snap = state["snapshot_ts"]
                for key in keys:
                    expected = state["writes"].get(key, ref.visible(key, snap))
                    actual = store.get(txn, key)
                    self.assertEqual(
                        actual,
                        expected,
                        f"seed={seed} txn={txn} snap={snap} key={key}",
                    )
            # low_watermark invariant: min active snapshot, else clock.
            if active:
                self.assertEqual(
                    store.low_watermark(),
                    min(s["snapshot_ts"] for s in active.values()),
                )
            else:
                self.assertEqual(store.low_watermark(), store.clock)

    def test_random_sequences(self):
        for seed in range(10):
            with self.subTest(seed=seed):
                self.run_random(seed)


class CliTest(unittest.TestCase):
    def test_json_lines_protocol(self):
        responses = run_cli([
            {"op": "config", "max_versions": 2},
            {"op": "begin", "txn": "t1"},
            {"op": "put", "txn": "t1", "key": "a", "value": 1},
            {"op": "commit", "txn": "t1"},
            {"op": "begin", "txn": "t2"},
            {"op": "put", "txn": "t2", "key": "a", "value": 2},
            {"op": "commit", "txn": "t2"},
            {"op": "gc"},
            {"op": "as_of", "key": "a", "ts": 2},
            {"op": "stats"},
            {"op": "bogus"},
            {"op": "commit", "txn": "t1"},
        ])
        self.assertEqual(responses[0], {"status": OK, "max_versions": 2})
        self.assertEqual(responses[1]["snapshot_ts"], 0)
        self.assertEqual(responses[3]["commit_ts"], 1)
        self.assertEqual(responses[6]["commit_ts"], 2)
        self.assertEqual(responses[7]["status"], OK)
        self.assertEqual(responses[7]["collected"], 1)
        self.assertEqual(responses[8]["status"], OK)
        self.assertEqual(responses[8]["value"], 2)
        stats = responses[9]
        self.assertEqual(stats["status"], OK)
        self.assertEqual(stats["versions_total"], 1)
        self.assertEqual(stats["collected_total"], 1)
        self.assertEqual(responses[10]["status"], "ERROR")
        self.assertEqual(responses[11]["status"], "ERROR")

    def test_txn_lifecycle_errors(self):
        store = MVCCStore()
        store.begin("t")
        with self.assertRaises(TxnError):
            store.begin("t")
        store.commit("t")
        with self.assertRaises(TxnError):
            store.put("t", "k", 1)


def run_cli(lines):
    stdin = io.StringIO("".join(json.dumps(line) + "\n" for line in lines))
    stdout = io.StringIO()
    serve(MVCCStore(), stdin, stdout)
    return [json.loads(line) for line in stdout.getvalue().splitlines()]


if __name__ == "__main__":
    unittest.main()
