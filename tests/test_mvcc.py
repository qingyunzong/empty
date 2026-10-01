import random
import unittest

from mvcc import MVCCStore, WriteSkew
from mvcc.store import vec_concurrent, vec_leq


def rank(vec):
    return (sum(vec), vec)


class Oracle:
    """Independent reference model: a flat log of committed versions plus
    the visibility and conflict rules taken directly from the spec."""

    def __init__(self, num_replicas):
        self.num_replicas = num_replicas
        self.committed = []  # list of (key, vec, value)

    def visible(self, key, snap):
        cands = [e for e in self.committed if e[0] == key and vec_leq(e[1], snap)]
        if not cands:
            return None
        return max(cands, key=lambda e: rank(e[1]))[2]

    def conflict(self, key, snap):
        return any(
            e[0] == key and vec_concurrent(e[1], snap) for e in self.committed
        )

    def commit(self, key, vec, value):
        self.committed.append((key, vec, value))


class OpenTxn:
    def __init__(self, client, snap, replica):
        self.client = client
        self.snap = snap
        self.replica = replica
        self.writes = {}


class TestVisibilityAgainstOracle(unittest.TestCase):
    """Acceptance A: enumerate scenarios with <= 3 replicas and <= 15
    transactions; every read result and every WRITE_SKEW outcome must
    match the reference serialization model."""

    def run_scenario(self, seed):
        rng = random.Random(seed)
        replicas = rng.randint(1, 3)
        store = MVCCStore(num_replicas=replicas)
        oracle = Oracle(replicas)
        clients = [(0,) * replicas for _ in range(rng.randint(1, 3))]
        keys = [f"k{i}" for i in range(rng.randint(1, 4))]
        open_txns = {}
        max_txns = rng.randint(1, 15)
        begun = 0

        for _ in range(rng.randint(20, 60)):
            op = rng.choice(["begin", "read", "write", "commit", "abort"])
            if op == "begin" and begun < max_txns:
                client = rng.randrange(len(clients))
                tid = f"t{begun}"
                begun += 1
                replica = rng.randrange(replicas)
                snap = store.begin(tid, replica=replica, ctx=list(clients[client]))
                open_txns[tid] = OpenTxn(client, snap, replica)
            elif op == "read" and open_txns:
                tid = rng.choice(list(open_txns))
                txn = open_txns[tid]
                key = rng.choice(keys)
                found, value, _ = store.read(tid, key)
                if key in txn.writes:
                    expected = txn.writes[key]  # read-your-own-writes
                else:
                    expected = oracle.visible(key, txn.snap)
                if expected is None:
                    self.assertFalse(found, f"seed={seed} read {key}")
                else:
                    self.assertTrue(found, f"seed={seed} read {key}")
                    self.assertEqual(value, expected, f"seed={seed} read {key}")
            elif op == "write" and open_txns:
                tid = rng.choice(list(open_txns))
                txn = open_txns[tid]
                key = rng.choice(keys)
                value = f"{tid}={rng.randint(0, 999)}"
                if oracle.conflict(key, txn.snap):
                    with self.assertRaises(WriteSkew, msg=f"seed={seed}"):
                        store.write(tid, key, value)
                    store.abort(tid)
                    del open_txns[tid]
                else:
                    store.write(tid, key, value)
                    txn.writes[key] = value
            elif op == "commit" and open_txns:
                tid = rng.choice(list(open_txns))
                txn = open_txns[tid]
                conflict_keys = [
                    k for k in txn.writes if oracle.conflict(k, txn.snap)
                ]
                if conflict_keys:
                    with self.assertRaises(WriteSkew, msg=f"seed={seed}"):
                        store.commit(tid)
                    store.abort(tid)
                else:
                    new_ctx = store.commit(tid)
                    for k, v in txn.writes.items():
                        oracle.commit(k, new_ctx, v)
                    clients[txn.client] = new_ctx
                del open_txns[tid]
            elif op == "abort" and open_txns:
                tid = rng.choice(list(open_txns))
                store.abort(tid)
                del open_txns[tid]

    def test_scenarios(self):
        for seed in range(100):
            with self.subTest(seed=seed):
                self.run_scenario(seed)


if __name__ == "__main__":
    unittest.main()
