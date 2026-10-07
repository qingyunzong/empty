"""Model-based tests: random interleaved histories checked against an
independent serial-commit model, plus a CLI smoke test."""

import random
import unittest

from wal_kv import Database, InMemoryFileAdapter
from wal_kv.cli import run as cli_run


def model_state(history, committed):
    """Apply only committed transactions' operations, in issue order."""
    state = {}
    for op, txn, key, value in history:
        if txn not in committed:
            continue
        if op == "put":
            state[key] = value
        else:
            state.pop(key, None)
    return state


class SerialModelTests(unittest.TestCase):
    def test_random_histories_match_serial_model(self):
        for seed in range(6):
            with self.subTest(seed=seed):
                self._run_one(seed)

    def _run_one(self, seed):
        rng = random.Random(seed)
        adapter = InMemoryFileAdapter()
        db = Database(adapter)
        txns = ["T1", "T2", "T3"]
        for txn in txns:
            db.begin(txn)
        keys = [f"k{i}" for i in range(6)]
        history = []
        committed = set()
        active = list(txns)
        key_owner = {}  # mirrors the engine's strict-2PL key locks
        for step in range(40):
            roll = rng.random()
            if roll < 0.08:
                db.checkpoint()  # fuzzy checkpoint mid-history
                continue
            if not active:
                break
            txn = rng.choice(active)
            free_keys = [
                k for k in keys if key_owner.get(k) in (None, txn)
            ]
            if roll < 0.16 or not free_keys:
                db.commit(txn)
                committed.add(txn)
                active.remove(txn)
                key_owner = {k: t for k, t in key_owner.items() if t != txn}
            elif roll < 0.24:
                db.abort(txn)
                active.remove(txn)
                key_owner = {k: t for k, t in key_owner.items() if t != txn}
            elif roll < 0.85:
                key, value = rng.choice(free_keys), f"v{step}"
                db.put(txn, key, value)
                history.append(("put", txn, key, value))
                key_owner[key] = txn
            else:
                key = rng.choice(free_keys)
                db.delete(txn, key)
                history.append(("del", txn, key, None))
                key_owner[key] = txn
        # Crash at an arbitrary dirty point and recover.
        adapter.crash()
        db2 = Database(adapter)
        db2.recover()
        expected = model_state(history, committed)
        self.assertEqual(db2.dump(), expected)
        # A second, consecutive recovery must not change anything.
        db3 = Database(adapter)
        db3.recover()
        self.assertEqual(db3.dump(), expected)


class CliTests(unittest.TestCase):
    def test_cli_end_to_end_with_trace(self):
        out = cli_run(
            [
                {"op": "begin", "txn": "T1"},
                {"op": "put", "txn": "T1", "key": "a", "value": "1"},
                {"op": "commit", "txn": "T1"},
                {"op": "begin", "txn": "T2"},
                {"op": "put", "txn": "T2", "key": "b", "value": "2"},
                {"op": "checkpoint"},
                {"op": "crash"},
                {"op": "recover"},
            ]
        )
        self.assertEqual(out["state"], {"a": "1"})
        self.assertTrue(all(r["ok"] for r in out["results"]))
        phases = [t["phase"] for t in out["trace"]]
        self.assertIn("undo", phases)
        for entry in out["trace"]:
            self.assertTrue(entry["reason"])


if __name__ == "__main__":
    unittest.main()
