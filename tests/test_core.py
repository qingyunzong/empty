import heapq
import random
import unittest

from topo import CycleError, IncrementalTopo, UnknownNodeError


def reference_order(nodes, edges):
    """Independent offline Kahn with lexicographic (min-heap) tie-breaking."""
    succ = {n: set() for n in nodes}
    indeg = {n: 0 for n in nodes}
    for u, v in edges:
        if v not in succ[u]:
            succ[u].add(v)
            indeg[v] += 1
    heap = [n for n in nodes if indeg[n] == 0]
    heapq.heapify(heap)
    out = []
    while heap:
        n = heapq.heappop(heap)
        out.append(n)
        for m in succ[n]:
            indeg[m] -= 1
            if indeg[m] == 0:
                heapq.heappush(heap, m)
    if len(out) != len(nodes):
        return None  # cyclic
    return out


def is_valid_topo(nodes, edges, order):
    if sorted(order) != sorted(nodes):
        return False
    pos = {n: i for i, n in enumerate(order)}
    return all(pos[u] < pos[v] for u, v in edges)


class TestIncrementalVsOfflineKahn(unittest.TestCase):
    """Acceptance A: step-by-step edge additions match offline Kahn on 100 small graphs."""

    def test_random_small_graphs(self):
        rng = random.Random(20261001)
        for trial in range(100):
            n = rng.randint(2, 8)
            nodes = [chr(ord("a") + i) for i in range(n)]
            ts = IncrementalTopo()
            for node in nodes:
                ts.add_node(node)
            edges = set()
            # random permutation so any edge earlier->later keeps the graph a DAG
            perm = nodes[:]
            rng.shuffle(perm)
            pos = {node: i for i, node in enumerate(perm)}
            steps = rng.randint(1, n * (n - 1) // 2)
            for _ in range(steps):
                u, v = rng.sample(nodes, 2)
                if pos[u] > pos[v]:
                    u, v = v, u
                ts.add_edge(u, v)
                edges.add((u, v))
                got = ts.order()
                want = reference_order(nodes, edges)
                self.assertEqual(got, want, msg=f"trial={trial} edges={sorted(edges)}")
                self.assertTrue(is_valid_topo(nodes, edges, got))

    def test_random_ops_with_cycle_rejection(self):
        """Random op stream incl. cyclic attempts; state must match acyclic edge set."""
        rng = random.Random(7)
        for trial in range(50):
            nodes = [chr(ord("a") + i) for i in range(rng.randint(2, 7))]
            ts = IncrementalTopo()
            for node in nodes:
                ts.add_node(node)
            edges = set()
            for _ in range(60):
                u, v = rng.choice(nodes), rng.choice(nodes)
                try:
                    if ts.add_edge(u, v):
                        edges.add((u, v))
                except CycleError:
                    pass  # rejected: edge set must stay acyclic
                self.assertEqual(ts.order(), reference_order(nodes, edges),
                                 msg=f"trial={trial} edges={sorted(edges)}")


class TestDeleteEdgeLocality(unittest.TestCase):
    """Acceptance B: deleting a key edge only unlocks successors locally."""

    def test_delete_unlocks_only_successor(self):
        ts = IncrementalTopo()
        for node in ["a", "x", "y", "z"]:
            ts.add_node(node)
        ts.add_edge("x", "a")
        before = ts.order()
        self.assertEqual(before, ["x", "a", "y", "z"])
        ts.del_edge("x", "a")
        after = ts.order()
        self.assertEqual(after, ["a", "x", "y", "z"])
        # unrelated nodes keep their relative order
        rel = [n for n in after if n in ("x", "y", "z")]
        self.assertEqual(rel, ["x", "y", "z"])

    def test_delete_edge_noop_when_missing(self):
        ts = IncrementalTopo()
        for node in ["a", "b"]:
            ts.add_node(node)
        version = ts.version
        self.assertFalse(ts.del_edge("a", "b"))
        self.assertEqual(ts.version, version)


class TestCycleErrors(unittest.TestCase):
    """Acceptance C: self-loop and 2-node cycle fail consistently; state is preserved."""

    def test_self_loop(self):
        ts = IncrementalTopo()
        ts.add_node("a")
        version = ts.version
        with self.assertRaises(CycleError) as ctx:
            ts.add_edge("a", "a")
        self.assertEqual(ctx.exception.nodes, ["a"])
        self.assertEqual(ts.version, version)  # last acyclic snapshot kept
        self.assertEqual(ts.order(), ["a"])

    def test_two_node_cycle(self):
        ts = IncrementalTopo()
        ts.add_node("a")
        ts.add_node("b")
        ts.add_edge("a", "b")
        version = ts.version
        with self.assertRaises(CycleError) as ctx:
            ts.add_edge("b", "a")
        self.assertEqual(ctx.exception.nodes, ["a", "b"])
        self.assertEqual(ts.version, version)
        self.assertEqual(ts.order(), ["a", "b"])

    def test_cycle_error_kind_consistent(self):
        """Self-loop and 2-node cycle raise the same error type with sorted node sets."""
        for edges, bad, want in [
            ([], ("a", "a"), ["a"]),
            ([("a", "b")], ("b", "a"), ["a", "b"]),
        ]:
            ts = IncrementalTopo()
            ts.add_node("a")
            ts.add_node("b")
            for u, v in edges:
                ts.add_edge(u, v)
            with self.assertRaises(CycleError) as ctx:
                ts.add_edge(*bad)
            self.assertEqual(ctx.exception.nodes, want)


class TestIdempotency(unittest.TestCase):
    """Acceptance D: duplicate add_edge / add_node produce no version change."""

    def test_duplicate_add_edge_no_version_change(self):
        ts = IncrementalTopo()
        ts.add_node("a")
        ts.add_node("b")
        self.assertTrue(ts.add_edge("a", "b"))
        version = ts.version
        order = ts.order()
        self.assertFalse(ts.add_edge("a", "b"))
        self.assertFalse(ts.add_edge("a", "b"))
        self.assertEqual(ts.version, version)
        self.assertEqual(ts.order(), order)

    def test_duplicate_add_node_no_version_change(self):
        ts = IncrementalTopo()
        self.assertTrue(ts.add_node("a"))
        version = ts.version
        self.assertFalse(ts.add_node("a"))
        self.assertEqual(ts.version, version)


class TestSemantics(unittest.TestCase):
    def test_del_node_cascades_edges(self):
        ts = IncrementalTopo()
        for node in ["a", "b", "c"]:
            ts.add_node(node)
        ts.add_edge("a", "b")
        ts.add_edge("b", "c")
        ts.del_node("b")
        self.assertEqual(ts.edges, set())
        self.assertEqual(ts.order(), ["a", "c"])

    def test_unknown_node_no_partial_application(self):
        ts = IncrementalTopo()
        ts.add_node("a")
        version = ts.version
        with self.assertRaises(UnknownNodeError):
            ts.add_edge("a", "ghost")
        # 'ghost' must not have been created implicitly; nothing applied
        self.assertEqual(ts.nodes, {"a"})
        self.assertEqual(ts.edges, set())
        self.assertEqual(ts.version, version)
        with self.assertRaises(UnknownNodeError):
            ts.del_node("ghost")
        with self.assertRaises(UnknownNodeError):
            ts.del_edge("ghost", "a")

    def test_deterministic_order_no_hash_dependence(self):
        """Same graph built in different insertion orders yields the same order."""
        orders = []
        for inserts in [
            ["d", "c", "b", "a"],
            ["a", "b", "c", "d"],
            ["c", "a", "d", "b"],
        ]:
            ts = IncrementalTopo()
            for node in inserts:
                ts.add_node(node)
            ts.add_edge("b", "c")
            orders.append(ts.order())
        self.assertEqual(orders[0], orders[1])
        self.assertEqual(orders[1], orders[2])
        self.assertEqual(orders[0], ["a", "b", "c", "d"])


if __name__ == "__main__":
    unittest.main()
