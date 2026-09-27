"""Acceptance A: enumerate workloads with <=3 replicas and <=15
transactions; store visibility must match an independently computed
reference over the causal/serialization graph."""

import random
import unittest

from mvcc import MVCCStore, MvccError
from mvcc import vector as vc


def reference_read(commits, key, ctx):
    """Independent reference: scan all committed versions, keep those
    causally <= ctx, return the value of a maximal one (highest seq)."""
    candidates = [c for c in commits
                  if c["key"] == key and vc.leq(c["vv"], ctx)]
    if not candidates:
        return None
    maximal = [c for c in candidates
               if not any(o is not c and vc.leq(c["vv"], o["vv"])
                          for o in candidates)]
    return max(maximal, key=lambda c: c["seq"])["value"]


def assert_acyclic(testcase, nodes, edges):
    indeg = {n: 0 for n in nodes}
    adj = {n: [] for n in nodes}
    for a, b in edges:
        if a == b:
            continue
        adj[a].append(b)
        indeg[b] += 1
    queue = [n for n in nodes if indeg[n] == 0]
    seen = 0
    while queue:
        n = queue.pop()
        seen += 1
        for m in adj[n]:
            indeg[m] -= 1
            if indeg[m] == 0:
                queue.append(m)
    testcase.assertEqual(seen, len(nodes),
                         "serialization graph has a cycle")


class VisibilityEnumerationTest(unittest.TestCase):
    def run_workload(self, seed):
        rng = random.Random(seed)
        n_replicas = rng.randint(1, 3)
        n_txns = rng.randint(1, 15)
        keys = ["k%d" % i for i in range(rng.randint(1, 4))]
        store = MVCCStore(num_replicas=n_replicas)

        commits = []          # reference commit log
        committed_ctxs = []   # causal contexts available to future begins
        edges = set()
        txn_ids = []

        for i in range(n_txns):
            tid = "t%d" % i
            replica = "r%d" % rng.randrange(n_replicas)
            # begin with a ctx merged from a random subset of past commits
            ctx = {}
            for c in committed_ctxs:
                if rng.random() < 0.6:
                    ctx = vc.merge(ctx, c)
            store.begin(tid, ctx=ctx, replica=replica)
            txn_ids.append(tid)

            wrote = {}
            for _ in range(rng.randint(1, 3)):
                key = rng.choice(keys)
                value = "%s:%s" % (tid, key)
                try:
                    store.write(tid, key, value)
                    wrote[key] = value
                except MvccError as exc:
                    self.assertEqual(exc.code, "WRITE_SKEW")

            # reads must match the reference model (own writes first)
            for key in keys:
                expected = wrote.get(key, reference_read(commits, key, ctx))
                self.assertEqual(store.read(tid, key), expected,
                                 "seed=%d txn=%s key=%s" % (seed, tid, key))

            try:
                vv = store.commit(tid)
            except MvccError as exc:
                self.assertEqual(exc.code, "WRITE_SKEW")
                continue  # aborted: no versions produced
            for key, value in wrote.items():
                commits.append({"key": key, "value": value,
                                "vv": vv, "seq": len(commits) + 1,
                                "txn": tid})
            committed_ctxs.append(vv)
            # causal edges: every commit visible to this txn happens-before it
            for c in commits:
                if c["txn"] != tid and vc.leq(c["vv"], ctx):
                    edges.add((c["txn"], tid))

        assert_acyclic(self, txn_ids, edges)

        # final full-causality snapshot must observe the reference state
        full = {}
        for c in committed_ctxs:
            full = vc.merge(full, c)
        store.begin("final", ctx=full)
        for key in keys:
            self.assertEqual(store.read("final", key),
                             reference_read(commits, key, full),
                             "seed=%d final key=%s" % (seed, key))

    def test_enumeration(self):
        for seed in range(300):
            with self.subTest(seed=seed):
                self.run_workload(seed)

    def test_snapshot_isolation_basic(self):
        store = MVCCStore(num_replicas=2)
        store.begin("w1", replica="r0")
        store.write("w1", "x", 1)
        vv1 = store.commit("w1")

        store.begin("snap", ctx={})          # empty causal ctx: sees nothing
        self.assertIsNone(store.read("snap", "x"))

        store.begin("after", ctx=vv1, replica="r1")
        self.assertEqual(store.read("after", "x"), 1)

        store.begin("w2", ctx=vv1, replica="r0")
        store.write("w2", "x", 2)
        store.commit("w2")
        # old snapshot still sees the old value
        self.assertEqual(store.read("after", "x"), 1)


if __name__ == "__main__":
    unittest.main()
