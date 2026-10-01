"""Acceptance (d): 1000 random operations compared against the reference."""

import random
import unittest

from mvcc import READ_COMMITTED, SNAPSHOT, Store
from mvcc import TxnStateError

from reference import RefModel, RefTxnStateError

KEYS = ["k1", "k2", "k3", "k4", "k5"]
MODES = [SNAPSHOT, READ_COMMITTED]


def random_script(seed, steps):
    rng = random.Random(seed)
    store = Store()
    model = RefModel()
    open_txns = []  # list of (store_tid, model_tid)
    mismatches = []

    for step in range(steps):
        op = rng.choice(
            ["begin", "get", "get", "put", "put", "delete", "commit", "abort"]
        )
        if op == "begin" or not open_txns:
            mode = rng.choice(MODES)
            open_txns.append((store.begin(mode), model.begin(mode)))
            continue
        pair = rng.choice(open_txns)
        stid, mtid = pair
        key = rng.choice(KEYS)
        if op == "get":
            got = store.get(stid, key)
            want = model.get(mtid, key)
            if got != want:
                mismatches.append((step, stid, key, got, want))
        elif op == "put":
            value = rng.randint(0, 100)
            store.put(stid, key, value)
            model.put(mtid, key, value)
        elif op == "delete":
            store.delete(stid, key)
            model.delete(mtid, key)
        elif op == "commit":
            store.commit(stid)
            model.commit(mtid)
            open_txns.remove(pair)
        elif op == "abort":
            store.abort(stid)
            model.abort(mtid)
            open_txns.remove(pair)

    # Drain remaining transactions and cross-check every key.
    for stid, mtid in open_txns:
        if rng.random() < 0.5:
            store.commit(stid)
            model.commit(mtid)
        else:
            store.abort(stid)
            model.abort(mtid)
    final_store = store.begin(READ_COMMITTED)
    final_model = model.begin(READ_COMMITTED)
    for key in KEYS:
        got = store.get(final_store, key)
        want = model.get(final_model, key)
        if got != want:
            mismatches.append(("final", key, got, want))
    return mismatches


class TestRandomModel(unittest.TestCase):
    def test_1000_random_steps_match_reference(self):
        mismatches = random_script(seed=20261001, steps=1000)
        self.assertEqual(mismatches, [])

    def test_more_seeds(self):
        for seed in (1, 7, 42, 1337):
            with self.subTest(seed=seed):
                self.assertEqual(random_script(seed=seed, steps=300), [])


if __name__ == "__main__":
    unittest.main()
