import json
import random
import subprocess
import sys
import unittest

from mvcc import MVCCStore, TxnStateError, InvalidModeError
from tests.reference import RefModel, RefError

KEYS = ["alpha", "beta", "gamma", "delta"]


def visibility_matrix(store, txn_id, keys):
    return {key: store.get(txn_id, key) for key in keys}


def ref_matrix(model, txn_id, keys):
    return {key: model.get(txn_id, key) for key in keys}


class SnapshotVisibilityTest(unittest.TestCase):
    """(a) Two interleaved snapshot transactions: per-key visibility matrix
    compared against the pure-Python reference model at every step."""

    def test_interleaved_snapshot_visibility(self):
        store = MVCCStore()
        model = RefModel()
        store.begin("snapshot", "t1")
        model.begin("t1", "snapshot")
        store.begin("snapshot", "t2")
        model.begin("t2", "snapshot")

        # Seed committed state before a third snapshot txn starts.
        store.put("t1", "alpha", 1)
        store.put("t1", "beta", 2)
        model.put("t1", "alpha", 1)
        model.put("t1", "beta", 2)
        store.commit("t1")
        model.commit("t1")

        store.begin("snapshot", "t3")
        model.begin("t3", "snapshot")

        # t2 mutates and commits after t3's snapshot was taken.
        store.put("t2", "alpha", 100)
        store.delete("t2", "beta")
        store.put("t2", "gamma", 3)
        model.put("t2", "alpha", 100)
        model.delete("t2", "beta")
        model.put("t2", "gamma", 3)
        store.commit("t2")
        model.commit("t2")

        # t3's snapshot is fixed: it must NOT see t2's commit.
        self.assertEqual(visibility_matrix(store, "t3", KEYS),
                         ref_matrix(model, "t3", KEYS))
        self.assertEqual(store.get("t3", "alpha"), 1)
        self.assertEqual(store.get("t3", "beta"), 2)
        self.assertIsNone(store.get("t3", "gamma"))

        # A fresh snapshot txn sees t2's committed state (incl. tombstone).
        store.begin("snapshot", "t4")
        model.begin("t4", "snapshot")
        self.assertEqual(visibility_matrix(store, "t4", KEYS),
                         ref_matrix(model, "t4", KEYS))
        self.assertEqual(store.get("t4", "alpha"), 100)
        self.assertIsNone(store.get("t4", "beta"))
        self.assertEqual(store.get("t4", "gamma"), 3)

        # t3's snapshot remains fixed even after further commits.
        store.begin("snapshot", "t5")
        model.begin("t5", "snapshot")
        store.put("t5", "alpha", 999)
        model.put("t5", "alpha", 999)
        store.commit("t5")
        model.commit("t5")
        self.assertEqual(visibility_matrix(store, "t3", KEYS),
                         ref_matrix(model, "t3", KEYS))
        self.assertEqual(store.get("t3", "alpha"), 1)


class AbortTest(unittest.TestCase):
    """(b) After abort, the transaction's writes are completely invisible."""

    def test_abort_hides_writes(self):
        store = MVCCStore()
        store.begin("snapshot", "t1")
        store.put("t1", "alpha", 1)
        store.put("t1", "beta", 2)
        store.delete("t1", "gamma")
        store.abort("t1")

        store.begin("snapshot", "t2")
        for key in ("alpha", "beta", "gamma"):
            self.assertIsNone(store.get("t2", key))

    def test_abort_preserves_prior_committed_versions(self):
        store = MVCCStore()
        store.begin("snapshot", "t1")
        store.put("t1", "alpha", "committed")
        store.commit("t1")

        store.begin("snapshot", "t2")
        store.put("t2", "alpha", "dirty")
        store.abort("t2")

        store.begin("snapshot", "t3")
        self.assertEqual(store.get("t3", "alpha"), "committed")


class TxnStateTest(unittest.TestCase):
    """(c) Committing an already-committed transaction raises TXN_STATE."""

    def test_double_commit_raises_txn_state(self):
        store = MVCCStore()
        store.begin("snapshot", "t1")
        store.put("t1", "alpha", 1)
        store.commit("t1")
        with self.assertRaises(TxnStateError) as ctx:
            store.commit("t1")
        self.assertEqual(ctx.exception.code, "TXN_STATE")

    def test_ops_on_finished_or_unknown_txn_raise_txn_state(self):
        store = MVCCStore()
        store.begin("snapshot", "t1")
        store.abort("t1")
        for fn in (
            lambda: store.commit("t1"),
            lambda: store.abort("t1"),
            lambda: store.get("t1", "k"),
            lambda: store.put("t1", "k", 1),
            lambda: store.delete("t1", "k"),
            lambda: store.get("missing", "k"),
        ):
            with self.assertRaises(TxnStateError):
                fn()

    def test_invalid_mode(self):
        store = MVCCStore()
        with self.assertRaises(InvalidModeError):
            store.begin("serializable")


class SemanticsTest(unittest.TestCase):
    def test_read_committed_sees_latest_committed(self):
        store = MVCCStore()
        store.begin("read_committed", "rc")
        self.assertIsNone(store.get("rc", "alpha"))

        store.begin("snapshot", "w")
        store.put("w", "alpha", 1)
        store.commit("w")
        self.assertEqual(store.get("rc", "alpha"), 1)

        store.begin("snapshot", "w2")
        store.delete("w2", "alpha")
        store.commit("w2")
        self.assertIsNone(store.get("rc", "alpha"))

    def test_read_own_writes(self):
        store = MVCCStore()
        store.begin("snapshot", "t1")
        store.put("t1", "alpha", 7)
        self.assertEqual(store.get("t1", "alpha"), 7)
        store.delete("t1", "alpha")
        self.assertIsNone(store.get("t1", "alpha"))

    def test_commit_ts_is_globally_monotonic(self):
        store = MVCCStore()
        stamps = []
        for i in range(5):
            store.begin("snapshot", f"t{i}")
            store.put(f"t{i}", "k", i)
            stamps.append(store.commit(f"t{i}"))
        self.assertEqual(stamps, sorted(stamps))
        self.assertEqual(len(set(stamps)), len(stamps))

    def test_delete_writes_tombstone_not_physical_delete(self):
        store = MVCCStore()
        store.begin("snapshot", "t1")
        store.put("t1", "alpha", 1)
        store.commit("t1")
        store.begin("snapshot", "t2")
        store.delete("t2", "alpha")
        store.commit("t2")
        # Version chain keeps both the value version and the tombstone.
        chain = store._versions["alpha"]
        self.assertEqual(len(chain), 2)
        self.assertIsNotNone(chain[0].end_ts)
        self.assertIsNone(chain[1].end_ts)
        # Old snapshot still sees the pre-delete value.
        store.begin("snapshot", "t3")
        self.assertIsNone(store.get("t3", "alpha"))


class RandomizedDifferentialTest(unittest.TestCase):
    """(d) 1000 random operations, store vs reference model, step by step."""

    def test_random_ops_match_reference(self):
        rng = random.Random(20261001)
        store = MVCCStore()
        model = RefModel()
        txn_ids = [f"t{i}" for i in range(6)]
        keys = [f"k{i}" for i in range(8)]

        def both(fn_store, fn_model):
            store_result = store_error = None
            model_result = model_error = None
            try:
                store_result = fn_store()
            except (TxnStateError, InvalidModeError) as exc:
                store_error = exc.code
            try:
                model_result = fn_model()
            except RefError as exc:
                model_error = exc.code
            self.assertEqual(store_error, model_error)
            if store_error is None:
                self.assertEqual(store_result, model_result)

        for step in range(1000):
            op = rng.choice(
                ["begin", "get", "get", "put", "put", "delete",
                 "commit", "abort"]
            )
            txn = rng.choice(txn_ids)
            if op == "begin":
                mode = rng.choice(["snapshot", "read_committed"])
                both(lambda: store.begin(mode, txn),
                     lambda: model.begin(txn, mode))
            elif op == "get":
                key = rng.choice(keys)
                both(lambda: store.get(txn, key),
                     lambda: model.get(txn, key))
            elif op == "put":
                key, value = rng.choice(keys), rng.randint(0, 100)
                both(lambda: store.put(txn, key, value),
                     lambda: model.put(txn, key, value))
            elif op == "delete":
                key = rng.choice(keys)
                both(lambda: store.delete(txn, key),
                     lambda: model.delete(txn, key))
            elif op == "commit":
                both(lambda: store.commit(txn),
                     lambda: model.commit(txn))
            else:
                both(lambda: store.abort(txn),
                     lambda: model.abort(txn))


class CliTest(unittest.TestCase):
    def run_cli(self, commands):
        payload = "\n".join(json.dumps(c) for c in commands) + "\n"
        proc = subprocess.run(
            [sys.executable, "-m", "mvcc.cli"],
            input=payload, capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return [json.loads(line) for line in proc.stdout.splitlines()]

    def test_cli_roundtrip_and_error_recovery(self):
        results = self.run_cli([
            {"op": "begin", "txn": "t1", "mode": "snapshot"},
            {"op": "put", "txn": "t1", "key": "a", "value": 42},
            {"op": "commit", "txn": "t1"},
            {"op": "commit", "txn": "t1"},          # TXN_STATE, process continues
            {"op": "begin", "txn": "t2", "mode": "read_committed"},
            {"op": "get", "txn": "t2", "key": "a"},
            {"op": "get", "txn": "t2", "key": "missing"},
            {"op": "delete", "txn": "t2", "key": "a"},
            {"op": "get", "txn": "t2", "key": "a"},  # own tombstone
            {"op": "abort", "txn": "t2"},
            {"op": "begin", "txn": "t3", "mode": "snapshot"},
            {"op": "get", "txn": "t3", "key": "a"},  # abort hid the delete
        ])
        self.assertEqual(results[0], {"ok": True, "txn": "t1"})
        self.assertEqual(results[1], {"ok": True})
        self.assertEqual(results[2]["ok"], True)
        self.assertEqual(results[3], {"error": "TXN_STATE"})
        self.assertEqual(results[5], {"value": 42})
        self.assertEqual(results[6], {"value": None})
        self.assertEqual(results[8], {"value": None})
        self.assertEqual(results[11], {"value": 42})

    def test_cli_bad_json_recovers(self):
        proc = subprocess.run(
            [sys.executable, "-m", "mvcc.cli"],
            input='{"op": "begin", "txn": "t1", "mode": "snapshot"}\nnot json\n'
                  '{"op": "get", "txn": "t1", "key": "x"}\n',
            capture_output=True, text=True, timeout=30,
        )
        lines = [json.loads(l) for l in proc.stdout.splitlines()]
        self.assertEqual(lines[1], {"error": "BAD_COMMAND"})
        self.assertEqual(lines[2], {"value": None})


if __name__ == "__main__":
    unittest.main()
