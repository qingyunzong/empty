import os
import random
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from incsp import IncrementalSSSP


def reference(graph, src, extra_nodes=()):
    """Independent brute force: fixpoint relaxation over simple paths.

    Returns (dist, key) dicts; dist[t] is None when t is unreachable and
    key[t] is the lexicographically smallest shortest node sequence.
    """
    nodes = {src} | set(extra_nodes)
    for u, vs in graph.items():
        nodes.add(u)
        nodes.update(vs)
    dist = {n: None for n in nodes}
    key = {n: None for n in nodes}
    dist[src] = 0
    key[src] = (src,)
    improved = True
    while improved:
        improved = False
        for u in sorted(nodes):
            if dist[u] is None:
                continue
            for v, w in sorted(graph.get(u, {}).items()):
                if v in key[u]:
                    continue  # simple paths only
                nd = dist[u] + w
                nk = key[u] + (v,)
                if dist[v] is None or nd < dist[v] or (nd == dist[v] and nk < key[v]):
                    dist[v] = nd
                    key[v] = nk
                    improved = True
    return dist, key


def affected_upper_bound(graph_after, old_dist, u, v, w):
    """Independent bound: size of the tight-edge closure from v, computed
    from the pre-removal distances and the post-removal graph."""
    du, dv = old_dist.get(u), old_dist.get(v)
    if du is None or dv is None or du + w != dv:
        return 0
    seen = set()
    stack = [v]
    while stack:
        x = stack.pop()
        if x in seen:
            continue
        seen.add(x)
        dx = old_dist.get(x)
        if dx is None:
            continue
        for y, ww in graph_after.get(x, {}).items():
            dy = old_dist.get(y)
            if dy is not None and dx + ww == dy and y not in seen:
                stack.append(y)
    return len(seen)


class AcceptanceA(unittest.TestCase):
    """A: inserting an edge reveals a shorter path incrementally."""

    def test_insert_reveals_shorter_path(self):
        g = IncrementalSSSP()
        g.set_source("s")
        for u, v, w in [("s", "a", 1), ("a", "b", 1), ("b", "t", 1), ("s", "t", 10)]:
            g.add_edge(u, v, w)
        self.assertEqual(g.dist("t"), 3)
        self.assertEqual(g.path("t"), ["s", "a", "b", "t"])
        g.add_edge("a", "t", 1)
        self.assertEqual(g.dist("t"), 2)
        self.assertEqual(g.path("t"), ["s", "a", "t"])
        # Only t needed recomputation; the rest of the graph was untouched.
        self.assertEqual(g.recomputed, 1)

    def test_duplicate_edge_keeps_minimum(self):
        g = IncrementalSSSP()
        g.set_source("s")
        g.add_edge("s", "a", 5)
        self.assertFalse(g.add_edge("s", "a", 7))  # ignored, min kept
        self.assertEqual(g.dist("a"), 5)
        self.assertTrue(g.add_edge("s", "a", 3))  # lower weight wins
        self.assertEqual(g.dist("a"), 3)
        self.assertEqual(g.weight("s", "a"), 3)
        g.remove_edge("s", "a")  # single logical edge: one rm removes it
        self.assertIsNone(g.dist("a"))


class AcceptanceB(unittest.TestCase):
    """B: removing the unique bridge makes the target unreachable."""

    def test_remove_unique_bridge(self):
        g = IncrementalSSSP()
        g.set_source("s")
        g.add_edge("s", "a", 2)
        g.add_edge("a", "b", 3)
        self.assertEqual(g.dist("b"), 5)
        g.remove_edge("a", "b")
        self.assertIsNone(g.dist("b"))
        self.assertIsNone(g.path("b"))
        # Only the affected subtree {b} was recomputed.
        self.assertEqual(g.recomputed, 1)
        # Removing a non-existent edge is a no-op.
        self.assertFalse(g.remove_edge("a", "b"))
        self.assertEqual(g.recomputed, 0)


class AcceptanceC(unittest.TestCase):
    """C: among equal-distance paths pick the lexicographically smallest
    node sequence (not the fewest hops, not the smallest last hop)."""

    def test_lexicographic_tie_break(self):
        g = IncrementalSSSP()
        g.set_source("s")
        # Three shortest paths to t, all with distance 3:
        #   (s, t), (s, c, t), (s, b, a, t)
        # Lexicographically smallest sequence is (s, b, a, t).
        for u, v, w in [
            ("s", "t", 3),
            ("s", "c", 1), ("c", "t", 2),
            ("s", "b", 1), ("b", "a", 1), ("a", "t", 1),
        ]:
            g.add_edge(u, v, w)
        self.assertEqual(g.dist("t"), 3)
        self.assertEqual(g.path("t"), ["s", "b", "a", "t"])
        # Removing an edge on the best path falls back to the next one.
        g.remove_edge("b", "a")
        self.assertEqual(g.dist("t"), 3)
        self.assertEqual(g.path("t"), ["s", "c", "t"])

    def test_zero_weight_edges_and_self_loops(self):
        g = IncrementalSSSP()
        g.set_source("s")
        g.add_edge("s", "s", 0)   # self-loop allowed
        g.add_edge("s", "a", 0)
        g.add_edge("a", "a", 0)   # zero self-loop must not loop forever
        g.add_edge("a", "b", 0)
        g.add_edge("b", "a", 0)   # zero-weight cycle
        g.add_edge("b", "t", 1)
        self.assertEqual(g.dist("t"), 1)
        self.assertEqual(g.path("t"), ["s", "a", "b", "t"])


class AcceptanceD(unittest.TestCase):
    """D: 50 random updates cross-checked against full recomputation."""

    def test_random_updates_match_full_dijkstra(self):
        rng = random.Random(20261001)
        labels = [chr(ord("a") + i) for i in range(8)]
        eng = IncrementalSSSP()
        graph: dict[str, dict[str, int]] = {}
        src = "a"
        eng.set_source(src)
        deletes_checked = 0
        for step in range(50):
            roll = rng.random()
            has_edges = any(graph.values())
            if roll < 0.55 or not has_edges:
                u, v, w = rng.choice(labels), rng.choice(labels), rng.randint(0, 6)
                eng.add_edge(u, v, w)
                cur = graph.setdefault(u, {}).get(v)
                if cur is None or w < cur:
                    graph[u][v] = w
            elif roll < 0.85:
                edges = [(u, v) for u, vs in graph.items() for v in vs]
                u, v = rng.choice(edges)
                old_w = graph[u][v]
                old_dist, _ = reference(graph, src)
                eng.remove_edge(u, v)
                del graph[u][v]
                bound = affected_upper_bound(graph, old_dist, u, v, old_w)
                self.assertLessEqual(
                    eng.recomputed, bound,
                    f"step {step}: recomputed {eng.recomputed} > bound {bound}",
                )
                deletes_checked += 1
            else:
                src = rng.choice(labels)
                eng.set_source(src)
            dist, key = reference(graph, src, labels)
            for t in labels:
                self.assertEqual(
                    eng.dist(t), dist[t], f"step {step}: dist({t})")
                want = list(key[t]) if key[t] is not None else None
                self.assertEqual(
                    eng.path(t), want, f"step {step}: path({t})")
        self.assertGreater(deletes_checked, 0)


if __name__ == "__main__":
    unittest.main()
