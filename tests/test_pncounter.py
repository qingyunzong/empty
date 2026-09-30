import itertools
import random
import unittest

from pncounter import (
    BadDelta,
    IdRetired,
    IdTaken,
    NoMajority,
    PNCounter,
    RemovedNode,
    UnknownNode,
)


class RefReplica:
    """Independent reference model: grow-only P/N vectors, merge = max.

    Membership/removal never affects value, so the reference ignores it;
    this encodes the requirement that removal must not discard
    causally-known increments.
    """

    def __init__(self):
        self.p = {}
        self.n = {}

    def inc(self, node, k):
        self.p[node] = self.p.get(node, 0) + k

    def dec(self, node, k):
        self.n[node] = self.n.get(node, 0) + k

    def merge(self, other):
        for vec, ovec in ((self.p, other.p), (self.n, other.n)):
            for node, count in ovec.items():
                if count > vec.get(node, 0):
                    vec[node] = count

    def value(self):
        return sum(self.p.values()) - sum(self.n.values())


def make_cluster(nodes):
    c = PNCounter()
    for node in nodes:
        c.add_node(node)
    return c


class TestBasic(unittest.TestCase):
    def test_inc_dec_value(self):
        c = make_cluster(["a", "b"])
        c.inc("a", 5)
        c.inc("b", 3)
        c.dec("a", 2)
        self.assertEqual(c.value(), 6)

    def test_bad_delta(self):
        c = make_cluster(["a"])
        for k in (0, -1, -100, 1.5, "2", None, True):
            with self.assertRaises(BadDelta, msg=repr(k)):
                c.inc("a", k)
            with self.assertRaises(BadDelta, msg=repr(k)):
                c.dec("a", k)
        self.assertEqual(c.value(), 0)

    def test_unknown_node_write(self):
        c = make_cluster(["a"])
        with self.assertRaises(UnknownNode):
            c.inc("ghost", 1)

    def test_node_limit(self):
        c = PNCounter()
        for i in range(10):
            c.add_node("n%d" % i)
        with self.assertRaises(Exception):
            c.add_node("n10")

    def test_duplicate_live_id(self):
        c = make_cluster(["a"])
        with self.assertRaises(IdTaken):
            c.add_node("a")


class TestRemoval(unittest.TestCase):
    def test_majority_required(self):
        c = make_cluster(["a", "b", "c", "d"])
        with self.assertRaises(NoMajority):
            c.remove_node("d", ["a", "b"])  # 2 of 4 is not a majority
        self.assertIn("d", c.members)
        c.remove_node("d", ["a", "b", "c"])  # 3 of 4 is a majority
        self.assertIn("d", c.retired)
        self.assertNotIn("d", c.members)

    def test_voters_must_be_live(self):
        c = make_cluster(["a", "b", "c"])
        with self.assertRaises(UnknownNode):
            c.remove_node("c", ["a", "ghost"])

    def test_remove_unknown_node(self):
        c = make_cluster(["a"])
        with self.assertRaises(UnknownNode):
            c.remove_node("ghost", ["a"])

    def test_double_remove_rejected(self):
        c = make_cluster(["a", "b", "c"])
        c.remove_node("b", ["a", "c"])
        with self.assertRaises(RemovedNode):
            c.remove_node("b", ["a", "c"])

    def test_C_write_after_remove_rejected_state_unchanged(self):
        c = make_cluster(["a", "b", "c"])
        c.inc("b", 7)
        c.dec("b", 2)
        c.remove_node("b", ["a", "c"])
        before = c.state()
        value_before = c.value()
        with self.assertRaises(RemovedNode):
            c.inc("b", 1)
        with self.assertRaises(RemovedNode):
            c.dec("b", 1)
        self.assertEqual(c.state(), before)
        self.assertEqual(c.value(), value_before)
        self.assertEqual(c.value(), 5)

    def test_B_late_increments_still_merge(self):
        # r1 and r2 are replicas; b is removed on r1, then a stale r2 with
        # old (pre-removal) increments from b merges into r1.
        r1 = make_cluster(["a", "b", "c"])
        r2 = r1.copy()
        r1.inc("b", 4)
        r2.merge(r1.copy())
        r1.remove_node("b", ["a", "c"])
        # r2 never saw the removal and records more increments for b that
        # were causally started before the removal (late delivery).
        r2.inc("b", 3)
        r2.inc("a", 10)
        r1.merge(r2.copy())
        self.assertEqual(r1.value(), 4 + 3 + 10)
        self.assertIn("b", r1.retired)
        # Removal also propagates to r2 via merge.
        r2.merge(r1.copy())
        self.assertIn("b", r2.retired)
        with self.assertRaises(RemovedNode):
            r2.inc("b", 1)

    def test_D_rejoin_same_id_retired_new_id_starts_zero(self):
        c = make_cluster(["a", "b", "c"])
        c.inc("b", 9)
        c.remove_node("b", ["a", "c"])
        with self.assertRaises(IdRetired):
            c.add_node("b")
        c.add_node("d")  # replacement node with a fresh id
        self.assertEqual(c.p["d"], 0)
        self.assertEqual(c.n["d"], 0)
        self.assertEqual(c.value(), 9)  # b's history retained, d contributes 0
        c.inc("d", 1)
        self.assertEqual(c.value(), 10)


class TestMergeLaws(unittest.TestCase):
    def _sample_states(self, seed):
        rng = random.Random(seed)
        states = []
        for _ in range(3):
            c = PNCounter()
            for node in ("a", "b", "c"):
                c.add_node(node)
                if rng.random() < 0.8:
                    c.inc(node, rng.randint(1, 9))
                if rng.random() < 0.5:
                    c.dec(node, rng.randint(1, 5))
            states.append(c)
        return states

    def test_commutative_idempotent(self):
        for seed in range(20):
            x, y, _ = self._sample_states(seed)
            xy = x.copy().merge(y.copy())
            yx = y.copy().merge(x.copy())
            self.assertEqual(xy, yx)
            self.assertEqual(xy.value(), yx.value())
            again = xy.copy().merge(y.copy())
            self.assertEqual(again, xy)  # idempotent
            self.assertEqual(x.copy().merge(x.copy()), x)

    def test_associative(self):
        for seed in range(20):
            x, y, z = self._sample_states(seed)
            left = x.copy().merge(y.copy()).merge(z.copy())
            right = x.copy().merge(y.copy().merge(z.copy()))
            self.assertEqual(left, right)
            self.assertEqual(left.value(), right.value())

    def test_convergence_after_full_gossip(self):
        for seed in range(20):
            states = self._sample_states(seed)
            merged = [s.copy() for s in states]
            for _ in range(3):
                for i, j in itertools.permutations(range(3), 2):
                    merged[i].merge(merged[j].copy())
            values = {m.value() for m in merged}
            self.assertEqual(len(values), 1)


class TestEnumerationAgainstReference(unittest.TestCase):
    """Acceptance A: enumerate scenarios (<=6 nodes, <=25 ops, many merge
    orders) and check every replica's value against the reference matrix."""

    def _run_scenario(self, rng):
        nodes = ["n%d" % i for i in range(rng.randint(1, 6))]
        n_replicas = rng.randint(2, 3)
        impl = []
        ref = []
        for _ in range(n_replicas):
            c = PNCounter()
            r = RefReplica()
            for node in nodes:
                c.add_node(node)
            impl.append(c)
            ref.append(r)
        n_ops = rng.randint(1, 25)
        matrix = [c.value() for c in impl]
        for _ in range(n_ops):
            kind = rng.choice(["inc", "dec", "merge", "merge", "remove"])
            if kind in ("inc", "dec"):
                i = rng.randrange(n_replicas)
                live = sorted(impl[i].members)
                if not live:
                    continue
                node = rng.choice(live)
                k = rng.randint(1, 5)
                if kind == "inc":
                    impl[i].inc(node, k)
                    ref[i].inc(node, k)
                else:
                    impl[i].dec(node, k)
                    ref[i].dec(node, k)
            elif kind == "merge":
                i, j = rng.sample(range(n_replicas), 2)
                impl[i].merge(impl[j].copy())
                ref[i].merge(ref[j])
            else:  # remove with valid majority on that replica
                i = rng.randrange(n_replicas)
                live = sorted(impl[i].members)
                if len(live) < 2:
                    continue
                target = rng.choice(live)
                voters = [v for v in live if v != target]
                need = len(live) // 2 + 1
                if len(voters) < need:
                    continue
                impl[i].remove_node(target, voters[:need])
            # value matrix must match after every operation
            matrix = [c.value() for c in impl]
            expected = [r.value() for r in ref]
            self.assertEqual(matrix, expected)
        return matrix

    def test_random_scenarios(self):
        for seed in range(300):
            self._run_scenario(random.Random(seed))

    def test_all_merge_orders_small(self):
        # Fixed op set on 3 replicas; enumerate every permutation of the
        # merge sequence and compare against the reference each time.
        for perm in itertools.permutations(
            [(0, 1), (1, 2), (2, 0), (0, 2), (1, 0), (2, 1)]
        ):
            impl = []
            ref = []
            for r in range(3):
                c = make_cluster(["a", "b"])
                c.inc("a", r + 1)
                c.dec("b", r + 2)
                rr = RefReplica()
                rr.inc("a", r + 1)
                rr.dec("b", r + 2)
                impl.append(c)
                ref.append(rr)
            for i, j in perm:
                impl[i].merge(impl[j].copy())
                ref[i].merge(ref[j])
            self.assertEqual([c.value() for c in impl], [r.value() for r in ref])
            # after full gossip everyone converges; shared node ids mean
            # convergence is by max, not sum: p[a]=max(1,2,3), n[b]=max(2,3,4)
            for c in impl:
                self.assertEqual(c.value(), 3 - 4)


if __name__ == "__main__":
    unittest.main()
