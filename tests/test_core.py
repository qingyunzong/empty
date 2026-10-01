import os
import random
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from recompute.core import (
    CycleError,
    Graph,
    UnknownNodeError,
    UsageError,
    _solution_key,
)


def make_graph(spec):
    """spec: {node_id: (cost, value, deps)} built in insertion order."""
    graph = Graph()
    for nid, (cost, value, deps) in spec.items():
        graph.set_node(nid, cost, value, deps)
    return graph


class BudgetBoundaryTests(unittest.TestCase):
    """Acceptance A: a budget exactly equal to the cost must allow selection."""

    def test_budget_equal_to_cost_is_selectable(self):
        graph = make_graph({"a": (5, 10, ())})
        self.assertEqual(graph.select(5), ["a"])

    def test_budget_one_below_cost_selects_nothing(self):
        graph = make_graph({"a": (5, 10, ())})
        self.assertEqual(graph.select(4), [])

    def test_zero_cost_node_with_zero_budget(self):
        graph = make_graph({"a": (0, 3, ())})
        self.assertEqual(graph.select(0), ["a"])


class DependencyClosureTests(unittest.TestCase):
    """Acceptance B: a node may not be recomputed without its dirty parents."""

    def setUp(self):
        self.graph = make_graph(
            {
                "a": (1, 5, ()),
                "b": (1, 0, ("a",)),
                "c": (1, 100, ("b",)),
            }
        )

    def test_cannot_recompute_child_without_parent(self):
        # budget fits c alone, but c needs b which needs a
        self.assertEqual(self.graph.select(1), ["a"])

    def test_child_alone_is_never_chosen(self):
        graph = make_graph(
            {
                "a": (1, 0, ()),
                "b": (1, 0, ("a",)),
                "c": (1, 100, ("b",)),
            }
        )
        for budget in (0, 1, 2):
            self.assertNotIn("c", graph.select(budget))
        self.assertEqual(graph.select(3), ["a", "b", "c"])

    def test_result_is_always_closed_under_dirty_predecessors(self):
        for budget in range(0, 5):
            chosen = set(self.graph.select(budget))
            for nid in chosen:
                for dep in self.graph.nodes[nid].deps:
                    if self.graph.nodes[dep].dirty:
                        self.assertIn(dep, chosen)

    def test_full_chain_when_budget_allows(self):
        self.assertEqual(self.graph.select(3), ["a", "b", "c"])


class TieBreakTests(unittest.TestCase):
    """Acceptance C: ties resolve to one unique answer by the fixed rules."""

    def test_lexicographic_pick_regardless_of_definition_order(self):
        graph = make_graph({"b": (1, 5, ()), "a": (1, 5, ())})
        self.assertEqual(graph.select(1), ["a"])

    def test_lexicographic_beats_lower_cost(self):
        # equal value; [a] wins over [b] even though b is cheaper
        graph = make_graph({"a": (2, 4, ()), "b": (1, 4, ())})
        self.assertEqual(graph.select(2), ["a"])

    def test_multiple_tie_groups_have_unique_winner(self):
        graph = make_graph({"c": (1, 5, ()), "a": (1, 5, ()), "b": (1, 5, ())})
        self.assertEqual(graph.select(2), ["a", "b"])

    def test_shorter_prefix_wins(self):
        graph = make_graph({"a": (1, 5, ()), "b": (1, 0, ("a",))})
        # {a} and {a, b} both give value 5; [a] < [a, b]
        self.assertEqual(graph.select(2), ["a"])

    def test_solution_key_orders_value_then_ids_then_cost(self):
        self.assertLess(_solution_key(["a"], 6, 9), _solution_key(["a"], 5, 0))
        self.assertLess(_solution_key(["a"], 5, 2), _solution_key(["b"], 5, 1))
        self.assertLess(_solution_key(["a"], 5, 1), _solution_key(["a"], 5, 2))
        self.assertLess(_solution_key([], 0, 0), _solution_key(["a"], 0, 0))


class EmptySelectionTests(unittest.TestCase):
    """Rule 5: an unaffordable plan degrades to the empty set, never partial."""

    def test_budget_below_single_node_cost(self):
        graph = make_graph({"a": (10, 1, ()), "b": (20, 2, ())})
        self.assertEqual(graph.select(3), [])

    def test_negative_value_nodes_are_not_selected(self):
        graph = make_graph({"a": (0, -5, ()), "b": (1, 3, ())})
        self.assertEqual(graph.select(0), [])
        self.assertEqual(graph.select(1), ["b"])


class DirtyPropagationTests(unittest.TestCase):
    """Semantics 1: upd dirties the node and its transitive successors."""

    def test_upd_marks_node_and_transitive_successors(self):
        graph = make_graph(
            {
                "a": (1, 1, ()),
                "b": (1, 1, ("a",)),
                "c": (1, 1, ("b",)),
                "d": (1, 1, ()),
            }
        )
        graph.recompute(10)
        self.assertTrue(all(not n.dirty for n in graph.nodes.values()))
        graph.update_cost("a", 2)
        dirty = [nid for nid in "abcd" if graph.nodes[nid].dirty]
        self.assertEqual(dirty, ["a", "b", "c"])
        graph.recompute(10)
        graph.update_cost("b", 5)
        dirty = [nid for nid in "abcd" if graph.nodes[nid].dirty]
        self.assertEqual(dirty, ["b", "c"])

    def test_set_redefinition_dirties_successors(self):
        graph = make_graph({"a": (1, 1, ()), "b": (1, 1, ("a",))})
        graph.recompute(10)
        graph.set_node("a", 1, 9)
        self.assertTrue(graph.nodes["a"].dirty)
        self.assertTrue(graph.nodes["b"].dirty)

    def test_recompute_clears_only_selected(self):
        graph = make_graph({"a": (1, 5, ()), "b": (100, 1, ())})
        chosen = graph.recompute(1)
        self.assertEqual(chosen, ["a"])
        self.assertFalse(graph.nodes["a"].dirty)
        self.assertTrue(graph.nodes["b"].dirty)


class ErrorTests(unittest.TestCase):
    def test_negative_cost_rejected(self):
        graph = Graph()
        with self.assertRaises(UsageError):
            graph.set_node("a", -1, 5)
        graph.set_node("a", 1, 5)
        with self.assertRaises(UsageError):
            graph.update_cost("a", -2)

    def test_negative_budget_rejected(self):
        graph = make_graph({"a": (1, 1, ())})
        with self.assertRaises(UsageError):
            graph.select(-1)

    def test_cycle_rejected(self):
        graph = make_graph({"a": (1, 1, ()), "b": (1, 1, ("a",))})
        with self.assertRaises(CycleError):
            graph.set_node("a", 1, 1, ("b",))

    def test_self_cycle_rejected(self):
        graph = Graph()
        with self.assertRaises(CycleError):
            graph.set_node("a", 1, 1, ("a",))

    def test_unknown_node_rejected(self):
        graph = make_graph({"a": (1, 1, ())})
        with self.assertRaises(UnknownNodeError):
            graph.update_cost("zzz", 1)
        with self.assertRaises(UnknownNodeError):
            graph.set_node("b", 1, 1, ("zzz",))


class BruteForce:
    """Independent 0-1 enumeration over all dirty-node subsets."""

    def __init__(self, nodes, dirty_ids):
        self.dirty_ids = list(dirty_ids)
        count = len(dirty_ids)
        index = {nid: i for i, nid in enumerate(dirty_ids)}
        pred_mask = [0] * count
        for nid in dirty_ids:
            for dep in nodes[nid].deps:
                if dep in index:
                    pred_mask[index[nid]] |= 1 << index[dep]
        size = 1 << count
        self.cost = [0] * size
        self.value = [0] * size
        union_pred = [0] * size
        self.feasible = [True] * size
        for mask in range(1, size):
            lsb = mask & -mask
            i = lsb.bit_length() - 1
            prev = mask ^ lsb
            self.cost[mask] = self.cost[prev] + nodes[dirty_ids[i]].cost
            self.value[mask] = self.value[prev] + nodes[dirty_ids[i]].value
            union_pred[mask] = union_pred[prev] | pred_mask[i]
            self.feasible[mask] = (union_pred[mask] & ~mask) == 0

    def _decode(self, mask):
        return tuple(
            sorted(
                self.dirty_ids[i]
                for i in range(len(self.dirty_ids))
                if mask >> i & 1
            )
        )

    def best(self, budget):
        best_mask, best_value, best_cost, best_ids = 0, 0, 0, ()
        for mask in range(1, 1 << len(self.dirty_ids)):
            if not self.feasible[mask]:
                continue
            cost = self.cost[mask]
            if cost > budget:
                continue
            value = self.value[mask]
            if value > best_value:
                best_mask, best_value, best_cost = mask, value, cost
                best_ids = self._decode(mask)
            elif value == best_value:
                ids = self._decode(mask)
                if ids < best_ids or (ids == best_ids and cost < best_cost):
                    best_mask, best_cost, best_ids = mask, cost, ids
        return list(self._decode(best_mask))


class BruteForceCrossCheckTests(unittest.TestCase):
    """Acceptance D: solver output matches exhaustive 0-1 enumeration."""

    def _random_graph(self, rng, count):
        graph = Graph()
        ids = [f"n{i:02d}" for i in range(count)]
        for i, nid in enumerate(ids):
            deps = [ids[j] for j in range(i) if rng.random() < 0.25]
            graph.set_node(nid, rng.randint(0, 9), rng.randint(-3, 12), deps)
        return graph, ids

    def test_random_20_nodes_all_dirty(self):
        rng = random.Random(20261001)
        graph, ids = self._random_graph(rng, 20)
        brute = BruteForce(graph.nodes, sorted(ids))
        for budget in (0, 3, 17, 55, 10**9):
            with self.subTest(budget=budget):
                self.assertEqual(graph.select(budget), brute.best(budget))

    def test_random_20_nodes_partial_dirty(self):
        rng = random.Random(777)
        graph, ids = self._random_graph(rng, 20)
        for nid in ids:
            if rng.random() < 0.4:
                graph.nodes[nid].dirty = False
        dirty = sorted(nid for nid in ids if graph.nodes[nid].dirty)
        brute = BruteForce(graph.nodes, dirty)
        for budget in (1, 8, 30, 10**9):
            with self.subTest(budget=budget):
                self.assertEqual(graph.select(budget), brute.best(budget))

    def test_random_small_graphs_many_seeds(self):
        for seed in range(8):
            rng = random.Random(seed)
            graph, ids = self._random_graph(rng, 12)
            brute = BruteForce(graph.nodes, sorted(ids))
            for budget in (0, 5, 20, 10**9):
                with self.subTest(seed=seed, budget=budget):
                    self.assertEqual(graph.select(budget), brute.best(budget))


if __name__ == "__main__":
    unittest.main()
