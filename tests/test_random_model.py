"""Randomized model-based test (acceptance criterion e).

Drives the real engine and an independent in-test reference model through
the same random interleaving of 2000 operations, then compares per-step
read results, commit/abort outcomes, and the final database state.
"""

import random
import unittest

from si import Engine, WriteConflict


class ModelTxn:
    def __init__(self, snapshot, snapshot_seq):
        self.snapshot = snapshot  # dict copy of committed state at begin
        self.snapshot_seq = snapshot_seq
        self.writes = {}


class ReferenceModel:
    """Independent SI model: commit-order serialization of committed writes."""

    def __init__(self):
        self.committed = {}          # key -> latest committed value
        self.history = []            # list of (seq, keyset), seq increasing
        self.seq = 0
        self.txns = {}               # txn_id -> ModelTxn

    def begin(self, txn_id):
        assert txn_id not in self.txns
        self.txns[txn_id] = ModelTxn(dict(self.committed), self.seq)

    def read(self, txn_id, key):
        txn = self.txns[txn_id]
        if key in txn.writes:
            return txn.writes[key]
        return txn.snapshot.get(key)

    def write(self, txn_id, key, value):
        self.txns[txn_id].writes[key] = value

    def commit(self, txn_id):
        """Returns True if the commit succeeds, False on write conflict."""
        txn = self.txns.pop(txn_id)
        keys = set(txn.writes)
        if keys:
            for seq, committed_keys in self.history:
                if seq > txn.snapshot_seq and committed_keys & keys:
                    return False
            self.seq += 1
            self.committed.update(txn.writes)
            self.history.append((self.seq, keys))
        return True

    def abort(self, txn_id):
        self.txns.pop(txn_id)


class TestRandomInterleaving(unittest.TestCase):
    STEPS = 2000

    def run_interleaving(self, seed):
        rng = random.Random(seed)
        engine = Engine()
        model = ReferenceModel()
        keys = [f"k{i}" for i in range(8)]
        active = []  # txn ids active in both engine and model
        next_id = 0

        for step in range(self.STEPS):
            op = rng.choice(["begin", "read", "write", "commit", "abort"])
            if op == "begin" or not active:
                txn_id = f"t{next_id}"
                next_id += 1
                engine.begin(txn_id)
                model.begin(txn_id)
                active.append(txn_id)
                continue

            txn_id = rng.choice(active)
            if op == "read":
                key = rng.choice(keys)
                got = engine.read(txn_id, key)
                want = model.read(txn_id, key)
                self.assertEqual(
                    got, want,
                    f"seed={seed} step={step} read {txn_id}.{key}",
                )
            elif op == "write":
                key = rng.choice(keys)
                value = rng.randint(0, 99)
                engine.write(txn_id, key, value)
                model.write(txn_id, key, value)
            elif op == "commit":
                active.remove(txn_id)
                want_ok = model.commit(txn_id)
                if want_ok:
                    engine.commit(txn_id)
                else:
                    with self.assertRaises(
                        WriteConflict,
                        msg=f"seed={seed} step={step} commit {txn_id}",
                    ):
                        engine.commit(txn_id)
            else:  # abort
                active.remove(txn_id)
                engine.abort(txn_id)
                model.abort(txn_id)

        # Drain remaining active transactions with commits.
        for txn_id in list(active):
            want_ok = model.commit(txn_id)
            if want_ok:
                engine.commit(txn_id)
            else:
                with self.assertRaises(WriteConflict):
                    engine.commit(txn_id)

        self.assertEqual(
            engine.snapshot_state(), model.committed,
            f"final state mismatch for seed={seed}",
        )

    def test_random_interleavings_match_reference_model(self):
        for seed in (1, 7, 42, 2024, 31337):
            with self.subTest(seed=seed):
                self.run_interleaving(seed)


if __name__ == "__main__":
    unittest.main()
