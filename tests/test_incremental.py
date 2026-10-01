"""Acceptance tests A-D plus semantic edge cases for IncrementalGraph."""

import heapq
import random
import unittest

from incsp import INF, IncrementalGraph


# --------------------------------------------------------------------- refs
def ref_dijkstra(nodes, edges, s):
    """Independent full Dijkstra over an edge dict {(u, v): w}."""
    adj = {n: {} for n in nodes}
    for (u, v), w in edges.items():
        adj.setdefault(u, {})[v] = w
        adj.setdefault(v, {})
    dist = {n: INF for n in adj}
    dist[s] = 0
    pq = [(0, s)]
    while pq:
        d, u = heapq.heappop(pq)
        if d != dist[u]:
            continue
        for v, w in adj[u].items():
            nd = d + w
            if nd < dist[v]:
                dist[v] = nd
                heapq.heappush(pq, (nd, v))
    return dist


def ref_best_path(edges, s, t, dist):
    """Enumerate ALL shortest s->t paths (tight prefixes) and return the
    lexicographically smallest node sequence; [] if unreachable."""
    if dist.get(t, INF) == INF:
        return []
    adj = {}
    for (u, v), w in edges.items():
        adj.setdefault(u, []).append((v, w))
        adj.setdefault(v, adj.get(v, []))
    best = []

    def dfs(cur, acc, path, visited):
        nonlocal best
        if cur == t:
            if acc == dist[t] and (not best or path < best):
                best = list(path)
            return
        for nxt, w in adj.get(cur, []):
            if nxt in visited:
                continue
            na = acc + w
            # Any shortest-path prefix is tight: na == dist[nxt].
            if na > dist.get(nxt, INF) or na > dist[t]:
                continue
            visited.add(nxt)
            path.append(nxt)
            dfs(nxt, na, path, visited)
            path.pop()
            visited.discard(nxt)

    dfs(s, 0, [s], {s})
    return best


# --------------------------------------------------------------- acceptance
class TestA_ShorterPathAppears(unittest.TestCase):
    def test_edge_addition_improves_dist_incrementally(self):
        g = IncrementalGraph()
        g.set_source("s")
        g.add_edge("s", "a", 5)
        g.add_edge("a", "t", 5)
        g.add_edge("s", "b", 1)
        self.assertEqual(g.distance("t"), 10)
        g.add_edge("b", "t", 1)  # s->b->t = 2
        self.assertEqual(g.distance("t"), 2)
        self.assertEqual(g.path("t"), ["s", "b", "t"])
        # Only t had to be re-finalized, not the whole graph.
        self.assertEqual(g.last_recomputed, 1)

    def test_decrease_propagates_downstream(self):
        g = IncrementalGraph()
        g.set_source("s")
        for u, v, w in [("s", "a", 9), ("a", "b", 1), ("b", "c", 1), ("c", "t", 1)]:
            g.add_edge(u, v, w)
        self.assertEqual(g.distance("t"), 12)
        g.add_edge("s", "a", 2)  # cheaper weight on existing edge
        self.assertEqual(g.distance("t"), 5)
        self.assertEqual(g.last_recomputed, 4)  # a, b, c, t
        self.assertEqual(g.path("t"), ["s", "a", "b", "c", "t"])


class TestB_BridgeRemoval(unittest.TestCase):
    def test_removing_unique_bridge_makes_unreachable(self):
        g = IncrementalGraph()
        g.set_source("s")
        for u, v, w in [("s", "a", 1), ("a", "b", 2), ("b", "c", 3)]:
            g.add_edge(u, v, w)
        self.assertEqual(g.distance("c"), 6)
        g.remove_edge("a", "b")  # the only bridge
        self.assertEqual(g.distance("b"), INF)
        self.assertEqual(g.distance("c"), INF)
        self.assertEqual(g.path("b"), [])
        self.assertEqual(g.path("c"), [])
        # Only the affected subtree {b, c} was recomputed.
        self.assertEqual(g.last_recomputed, 2)
        # Unaffected side keeps its distance.
        self.assertEqual(g.distance("a"), 1)

    def test_removal_with_alternative_reroutes(self):
        g = IncrementalGraph()
        g.set_source("s")
        for u, v, w in [("s", "a", 1), ("a", "t", 1), ("s", "b", 5), ("b", "t", 5)]:
            g.add_edge(u, v, w)
        self.assertEqual(g.distance("t"), 2)
        g.remove_edge("a", "t")
        self.assertEqual(g.distance("t"), 10)
        self.assertEqual(g.path("t"), ["s", "b", "t"])
        self.assertEqual(g.last_recomputed, 1)  # only t changed


class TestC_LexicographicTieBreak(unittest.TestCase):
    def test_equal_length_paths_pick_lexicographically_smallest(self):
        g = IncrementalGraph()
        g.set_source("s")
        for u, v, w in [("s", "b", 1), ("s", "a", 1), ("a", "t", 1), ("b", "t", 1)]:
            g.add_edge(u, v, w)
        self.assertEqual(g.distance("t"), 2)
        self.assertEqual(g.path("t"), ["s", "a", "t"])

    def test_zero_weight_tie_prefers_smaller_next_node(self):
        g = IncrementalGraph()
        g.set_source("s")
        g.add_edge("s", "t", 2)
        g.add_edge("s", "a", 0)
        g.add_edge("a", "t", 2)
        # [s, a, t] < [s, t] because "a" < "t" at position 1.
        self.assertEqual(g.path("t"), ["s", "a", "t"])

    def test_tie_break_survives_updates(self):
        g = IncrementalGraph()
        g.set_source("s")
        g.add_edge("s", "t", 4)
        g.add_edge("s", "c", 2)
        g.add_edge("c", "t", 2)
        self.assertEqual(g.path("t"), ["s", "c", "t"])
        g.add_edge("s", "b", 2)
        g.add_edge("b", "t", 2)
        self.assertEqual(g.path("t"), ["s", "b", "t"])
        g.remove_edge("s", "b")
        self.assertEqual(g.path("t"), ["s", "c", "t"])


class TestD_RandomizedVsFullDijkstra(unittest.TestCase):
    def test_50_random_updates_match_full_recompute(self):
        rng = random.Random(20261001)
        nodes = list("abcdefg")
        g = IncrementalGraph()
        src = "a"
        g.set_source(src)
        ref_edges = {}
        for step in range(50):
            before = ref_dijkstra(nodes, ref_edges, src)
            op = rng.choice(["edge", "edge", "edge", "rm", "rm", "src"])
            if op == "edge":
                u, v = rng.choice(nodes), rng.choice(nodes)
                w = rng.randint(0, 6)
                g.add_edge(u, v, w)
                key = (u, v)
                if key not in ref_edges or w < ref_edges[key]:
                    ref_edges[key] = w
            elif op == "rm":
                if ref_edges and rng.random() < 0.7:
                    u, v = rng.choice(sorted(ref_edges))
                else:
                    u, v = rng.choice(nodes), rng.choice(nodes)
                g.remove_edge(u, v)
                ref_edges.pop((u, v), None)
            else:
                src = rng.choice(nodes)
                g.set_source(src)
            after = ref_dijkstra(nodes, ref_edges, src)
            for n in nodes:
                self.assertEqual(
                    g.distance(n), after[n],
                    f"step {step} ({op}): dist({n}) differs",
                )
            for n in nodes:
                self.assertEqual(
                    g.path(n), ref_best_path(ref_edges, src, n, after),
                    f"step {step} ({op}): path({n}) differs",
                )
            changed = sum(1 for n in nodes if before[n] != after[n])
            if op in ("edge", "rm"):
                # Differential update must stay within the affected set.
                self.assertLessEqual(
                    g.last_recomputed, changed,
                    f"step {step} ({op}): recomputed {g.last_recomputed} "
                    f"> affected {changed}",
                )
            else:
                # src switch clears the cache: one bounded full pass.
                self.assertLessEqual(g.last_recomputed, len(nodes))


# ----------------------------------------------------------------- semantics
class TestSemantics(unittest.TestCase):
    def test_duplicate_edge_keeps_minimum(self):
        g = IncrementalGraph()
        g.set_source("s")
        g.add_edge("s", "t", 7)
        self.assertFalse(g.add_edge("s", "t", 9))   # larger dup: no change
        self.assertEqual(g.distance("t"), 7)
        self.assertTrue(g.add_edge("s", "t", 3))    # smaller dup: one change
        self.assertEqual(g.distance("t"), 3)
        g.remove_edge("s", "t")
        self.assertEqual(g.distance("t"), INF)      # single logical edge gone

    def test_unknown_nodes_auto_created(self):
        g = IncrementalGraph()
        g.add_edge("x", "y", 5)
        g.set_source("x")
        self.assertEqual(g.distance("y"), 5)
        self.assertEqual(g.distance("zzz"), INF)    # never mentioned
        self.assertEqual(g.path("zzz"), [])

    def test_self_loop_allowed_and_ignored(self):
        g = IncrementalGraph()
        g.set_source("s")
        g.add_edge("s", "s", 0)
        g.add_edge("s", "s", 4)
        g.add_edge("s", "a", 1)
        g.add_edge("a", "a", 2)
        self.assertEqual(g.distance("s"), 0)
        self.assertEqual(g.distance("a"), 1)
        g.remove_edge("a", "a")
        self.assertEqual(g.distance("a"), 1)
        self.assertEqual(g.last_recomputed, 0)

    def test_zero_weight_cycle(self):
        g = IncrementalGraph()
        g.set_source("s")
        g.add_edge("s", "a", 1)
        g.add_edge("a", "b", 0)
        g.add_edge("b", "a", 0)
        g.add_edge("b", "t", 1)
        self.assertEqual(g.distance("t"), 2)
        g.remove_edge("a", "b")
        self.assertEqual(g.distance("t"), INF)

    def test_zero_weight_mutual_support_cycle_not_grounded(self):
        # x and y keep dist 1 only through each other (zero-weight cycle);
        # cutting the external support must invalidate BOTH.
        g = IncrementalGraph()
        g.set_source("s")
        g.add_edge("s", "x", 1)
        g.add_edge("x", "y", 0)
        g.add_edge("y", "x", 0)
        self.assertEqual(g.distance("x"), 1)
        self.assertEqual(g.distance("y"), 1)
        g.remove_edge("s", "x")
        self.assertEqual(g.distance("x"), INF)
        self.assertEqual(g.distance("y"), INF)
        self.assertEqual(g.last_recomputed, 2)

    def test_src_switch_clears_cache(self):
        g = IncrementalGraph()
        g.set_source("s")
        g.add_edge("s", "a", 1)
        g.add_edge("a", "t", 1)
        self.assertEqual(g.distance("t"), 2)
        g.set_source("a")
        self.assertEqual(g.distance("t"), 1)
        self.assertEqual(g.distance("s"), INF)  # s unreachable from a
        g.add_edge("t", "s", 1)
        self.assertEqual(g.distance("s"), 2)    # incremental update still works

    def test_rm_missing_edge_is_noop(self):
        g = IncrementalGraph()
        g.set_source("s")
        g.add_edge("s", "a", 1)
        self.assertFalse(g.remove_edge("s", "b"))
        self.assertEqual(g.distance("a"), 1)
        self.assertEqual(g.last_recomputed, 0)


if __name__ == "__main__":
    unittest.main()
