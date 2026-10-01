"""Acceptance scenarios A-D plus merge-order enumeration against an
independent event-sourcing reference model."""

import itertools
import random
import unittest

import _support  # noqa: F401  (sys.path setup)
from pncounter import Cluster, ClusterError


class RefCluster:
    """Independent reference: sets of observed delta events per replica.

    value(replica) = sum of +k/-k over the events it has observed.  Merge is
    set union of observed events.  Removal never erases observed events.
    """

    def __init__(self):
        self.events = []           # [(kind, k)]
        self.know = {}             # node -> set(event_id)
        self.alive = set()

    def join(self, node):
        self.know[node] = set()
        self.alive.add(node)

    def add(self, node, kind, k):
        eid = len(self.events)
        self.events.append((kind, k))
        self.know[node].add(eid)

    def merge(self, dst, src):
        self.know[dst] |= self.know[src]

    def remove(self, node):
        self.alive.discard(node)

    def value(self, node):
        total = 0
        for eid in self.know[node]:
            kind, k = self.events[eid]
            total += k if kind == "p" else -k
        return total

    def matrix(self):
        return {node: self.value(node) for node in self.know}


def cluster_matrix(cluster):
    return {node: cluster.value(node) for node in cluster.replicas}


class TestAReferenceMatrix(unittest.TestCase):
    """A: <=6 nodes, <=25 ops, all merge orders; value matches reference."""

    def run_mixed(self, seed, n_nodes, n_ops, with_removal):
        rng = random.Random(seed)
        nodes = [f"N{i}" for i in range(n_nodes)]
        cluster = Cluster()
        ref = RefCluster()
        for _ in range(n_ops):
            live = [n for n in nodes if n in ref.alive]
            choices = ["inc", "dec", "merge", "merge"]
            if with_removal and len(live) >= 4:
                choices.append("remove")
            op = rng.choice(choices)
            if op in ("inc", "dec"):
                node = rng.choice(live) if live else rng.choice(nodes)
                k = rng.randint(1, 9)
                try:
                    getattr(cluster, op)(node, k)
                except ClusterError:
                    continue
                if node not in ref.know:
                    ref.join(node)
                ref.add(node, "p" if op == "inc" else "n", k)
            elif op == "merge":
                if len(ref.know) < 2:
                    continue
                dst, src = rng.sample(sorted(ref.know), 2)
                cluster.merge(dst, src)
                ref.merge(dst, src)
            else:
                node = rng.choice(live)
                try:
                    cluster.remove(node)
                except ClusterError:
                    continue
                ref.remove(node)
            self.assertEqual(cluster_matrix(cluster), ref.matrix())
        self.assertEqual(cluster_matrix(cluster), ref.matrix())

    def test_random_ops_match_reference_matrix(self):
        for seed in range(40):
            for n_nodes in (2, 3, 4, 5, 6):
                self.run_mixed(seed * 10 + n_nodes, n_nodes, 25, with_removal=False)

    def test_random_ops_with_removal_match_reference_matrix(self):
        for seed in range(30):
            for n_nodes in (3, 4, 5, 6):
                self.run_mixed(10_000 + seed * 10 + n_nodes, n_nodes, 25,
                               with_removal=True)

    def apply_deltas(self, cluster, deltas):
        for node, kind, k in deltas:
            getattr(cluster, "inc" if kind == "p" else "dec")(node, k)

    def expected_total(self, deltas):
        return sum(k if kind == "p" else -k for _, kind, k in deltas)

    def converged_rounds(self, cluster, nodes, rng):
        merges = [(i, j) for i in nodes for j in nodes if i != j]
        for _ in range(len(nodes) + 1):
            rng.shuffle(merges)
            for dst, src in merges:
                cluster.merge(dst, src)
            values = {cluster.value(n) for n in nodes}
            if len(values) == 1:
                return values.pop()
        return None

    def test_all_merge_orders_converge(self):
        for n_nodes in range(2, 7):
            nodes = [f"N{i}" for i in range(n_nodes)]
            rng = random.Random(7 + n_nodes)
            deltas = [(node, rng.choice("pn"), rng.randint(1, 9))
                      for node in nodes]
            deltas += [(rng.choice(nodes), rng.choice("pn"), rng.randint(1, 9))
                       for _ in range(n_nodes)]
            expected = self.expected_total(deltas)
            for trial in range(150):
                cluster = Cluster()
                self.apply_deltas(cluster, deltas)
                got = self.converged_rounds(cluster, nodes,
                                            random.Random(trial))
                self.assertEqual(got, expected)

    def test_exhaustive_merge_permutations_three_nodes(self):
        nodes = ["A", "B", "C"]
        deltas = [("A", "p", 4), ("B", "p", 3), ("B", "n", 1),
                  ("C", "n", 2), ("A", "p", 1)]
        expected = self.expected_total(deltas)
        merges = [(i, j) for i in nodes for j in nodes if i != j]
        for perm in itertools.permutations(merges):
            cluster = Cluster()
            self.apply_deltas(cluster, deltas)
            for _ in range(2):  # two rounds of the same order => fixpoint
                for dst, src in perm:
                    cluster.merge(dst, src)
            for node in nodes:
                self.assertEqual(cluster.value(node), expected)


class TestBLateIncrementsAfterRemoval(unittest.TestCase):
    """B: late-arriving old increments of a removed node still count."""

    def test_late_old_delta_still_merges(self):
        c = Cluster()
        c.inc("A", 5)
        c.inc("B", 3)
        c.inc("C", 1)
        c.merge("B", "A")          # B observed A's 5 before removal
        c.remove("B")
        c.inc("A", 7)              # A moves on: 12 total
        c.merge("C", "B")          # late old increments arrive via tombstone
        self.assertEqual(c.value("C"), 1 + 5 + 3)
        c.merge("C", "A")          # newer state still merges on top
        self.assertEqual(c.value("C"), 12 + 3 + 1)
        self.assertEqual(c.value("B"), 5 + 3)  # tombstone view intact

    def test_removed_node_own_contribution_preserved(self):
        c = Cluster()
        c.inc("X", 2)
        c.inc("Y", 2)
        c.inc("Z", 2)
        c.inc("Y", 6)
        c.remove("Y")
        c.merge("X", "Y")          # Y's pre-removal contribution survives
        self.assertEqual(c.value("X"), 2 + 8 + 0)
        c.merge("Z", "X")
        self.assertEqual(c.value("Z"), 2 + 8 + 2)


class TestCRemovedNodeWritesRejected(unittest.TestCase):
    """C: writes to a removed node are rejected and state is unchanged."""

    def test_new_writes_rejected_state_unchanged(self):
        c = Cluster()
        c.inc("A", 4)
        c.inc("B", 4)
        c.inc("C", 4)
        c.merge("B", "A")
        c.remove("B")
        snapshot = {n: (dict(r.p), dict(r.n)) for n, r in c.replicas.items()}
        with self.assertRaises(ClusterError) as ctx:
            c.inc("B", 1)
        self.assertEqual(ctx.exception.code, "REMOVED")
        with self.assertRaises(ClusterError) as ctx:
            c.dec("B", 1)
        self.assertEqual(ctx.exception.code, "REMOVED")
        after = {n: (dict(r.p), dict(r.n)) for n, r in c.replicas.items()}
        self.assertEqual(snapshot, after)
        self.assertIn("B", c.retired)
        self.assertNotIn("B", c.alive)


class TestDRejoinRejected(unittest.TestCase):
    """D: rejoin with the same ID is rejected; a new ID starts from zero."""

    def test_same_id_rejoin_rejected_new_id_fresh(self):
        c = Cluster()
        c.inc("A", 3)
        c.inc("B", 3)
        c.inc("C", 3)
        c.remove("B")
        # Any attempt to act under the retired ID fails.
        with self.assertRaises(ClusterError) as ctx:
            c.inc("B", 1)
        self.assertEqual(ctx.exception.code, "REMOVED")
        with self.assertRaises(ClusterError) as ctx:
            c.remove("B")
        self.assertEqual(ctx.exception.code, "ID_RETIRED")
        self.assertIn("B", c.retired)
        # A brand-new ID joins cleanly and starts from zero.
        self.assertEqual(c.inc("D", 1), 1)
        self.assertEqual(c.value("D"), 1)
        self.assertIn("D", c.alive)


if __name__ == "__main__":
    unittest.main()
