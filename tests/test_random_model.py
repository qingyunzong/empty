"""Randomized interleaving test: 2000 steps checked against a serial
reference model.

Reference model: committed transactions apply their write sets to a plain
dict in commit order. A transaction's snapshot is the reference state as of
its begin; reads must match the snapshot overlaid with the transaction's
own buffered writes. The engine's final committed state must equal the
reference state.
"""

import random
import unittest

from si import Engine, WriteConflictError

KEYS = [f"k{i}" for i in range(8)]
TXNS = [f"t{i}" for i in range(6)]
STEPS = 2000
SEEDS = (1, 7, 42, 2024)


class RandomModelTest(unittest.TestCase):
    def run_interleaving(self, seed: int) -> None:
        rng = random.Random(seed)
        eng = Engine()
        ref_state = {}  # committed state, commit order applied
        snapshots = {}  # txn -> reference snapshot dict
        pending = {}  # txn -> buffered writes
        active = set()

        for step in range(STEPS):
            idle = [t for t in TXNS if t not in active]
            op = rng.choice(
                ["begin", "read", "write", "commit", "abort"] if active else ["begin"]
            )
            if op == "begin" and idle:
                txn = rng.choice(idle)
                eng.begin(txn)
                active.add(txn)
                snapshots[txn] = dict(ref_state)
                pending[txn] = {}
            elif not active:
                continue
            else:
                txn = rng.choice(sorted(active))
                if op == "read":
                    key = rng.choice(KEYS)
                    expected = pending[txn].get(key, snapshots[txn].get(key))
                    got = eng.read(txn, key)
                    self.assertEqual(
                        got,
                        expected,
                        f"seed={seed} step={step}: read {txn}.{key}",
                    )
                elif op == "write":
                    key = rng.choice(KEYS)
                    value = rng.randint(0, 10_000)
                    eng.write(txn, key, value)
                    pending[txn][key] = value
                elif op == "commit":
                    try:
                        eng.commit(txn)
                    except WriteConflictError:
                        pass  # no effect on the reference model
                    else:
                        ref_state.update(pending[txn])
                    active.discard(txn)
                    snapshots.pop(txn)
                    pending.pop(txn)
                elif op == "abort":
                    eng.abort(txn)
                    active.discard(txn)
                    snapshots.pop(txn)
                    pending.pop(txn)

        for txn in list(active):
            eng.abort(txn)

        self.assertEqual(
            eng.snapshot_state(),
            ref_state,
            f"seed={seed}: final committed state diverges from reference model",
        )

    def test_random_interleavings_match_reference_model(self):
        for seed in SEEDS:
            with self.subTest(seed=seed):
                self.run_interleaving(seed)


if __name__ == "__main__":
    unittest.main()
