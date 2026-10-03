import unittest

from recalc.core import (
    CycleError,
    NegativeAmountError,
    RecalcGraph,
    UnknownNodeError,
)


class BudgetBoundaryTest(unittest.TestCase):
    # Acceptance A: a budget exactly equal to the cost is affordable.

    def test_budget_equal_to_cost_allows_selection(self):
        graph = RecalcGraph()
        graph.set_node("a", 5, 10)
        plan = graph.best(5)
        self.assertEqual(plan.ids, ("a",))
        self.assertEqual(plan.value, 10)
        self.assertEqual(plan.cost, 5)

    def test_budget_one_below_cost_selects_empty(self):
        graph = RecalcGraph()
        graph.set_node("a", 5, 10)
        plan = graph.best(4)
        self.assertEqual(plan.ids, ())
        self.assertEqual(plan.value, 0)
        self.assertEqual(plan.cost, 0)

    def test_budget_insufficient_for_any_node_selects_empty_set(self):
        graph = RecalcGraph()
        graph.set_node("a", 3, 10)
        graph.set_node("b", 4, 20)
        plan = graph.run(2)
        self.assertEqual(plan.ids, ())
        self.assertEqual(graph.dirty_ids(), ["a", "b"])


class DependencyChainTest(unittest.TestCase):
    # Acceptance B: recomputing a node requires its dirty predecessors.

    def setUp(self):
        self.graph = RecalcGraph()
        self.graph.set_node("a", 1, 1)
        self.graph.set_node("b", 1, 1, ["a"])
        self.graph.set_node("c", 1, 10, ["b"])

    def test_cannot_recompute_child_without_dirty_parents(self):
        # c alone (cost 1) is not feasible: a and b must come first.
        plan = self.graph.best(2)
        self.assertEqual(plan.ids, ("a", "b"))
        self.assertEqual(plan.value, 2)

    def test_full_chain_when_budget_allows(self):
        plan = self.graph.best(3)
        self.assertEqual(plan.ids, ("a", "b", "c"))
        self.assertEqual(plan.value, 12)
        self.assertEqual(plan.cost, 3)

    def test_clean_predecessor_needs_no_recompute(self):
        self.graph.run(3)  # everything clean
        self.graph.update_cost("c", 1)  # only c dirty
        plan = self.graph.best(1)
        self.assertEqual(plan.ids, ("c",))


class TieBreakTest(unittest.TestCase):
    # Acceptance C: ties resolve to a unique answer by the rules.

    def test_lexicographically_smallest_id_sequence_wins(self):
        graph = RecalcGraph()
        graph.set_node("b", 1, 5)
        graph.set_node("a", 1, 5)
        plan = graph.best(1)  # {a} and {b} tie on value and cost
        self.assertEqual(plan.ids, ("a",))

    def test_prefix_tie_falls_back_to_smaller_cost(self):
        graph = RecalcGraph()
        graph.set_node("a", 3, 5)
        graph.set_node("b", 1, 0)
        # {a} (cost 3) and {a,b} (cost 4) both have value 5 and the
        # sequence [a] is a prefix of [a,b]: smaller cost wins.
        plan = graph.best(4)
        self.assertEqual(plan.ids, ("a",))
        self.assertEqual(plan.cost, 3)

    def test_unique_answer_among_many_ties(self):
        graph = RecalcGraph()
        for nid in ("d", "c", "b", "a"):
            graph.set_node(nid, 2, 7)
        plan = graph.best(2)
        self.assertEqual(plan.ids, ("a",))

    def test_tie_break_matches_value_first(self):
        graph = RecalcGraph()
        graph.set_node("a", 1, 1)
        graph.set_node("b", 1, 2)
        plan = graph.best(1)  # value beats lexicographic order
        self.assertEqual(plan.ids, ("b",))


class DirtyPropagationTest(unittest.TestCase):
    def test_upd_marks_node_and_transitive_successors_dirty(self):
        graph = RecalcGraph()
        graph.set_node("a", 1, 1)
        graph.set_node("b", 1, 1, ["a"])
        graph.set_node("c", 1, 1, ["b"])
        graph.set_node("d", 1, 1)
        graph.run(100)
        self.assertEqual(graph.dirty_ids(), [])
        graph.update_cost("a", 2)
        self.assertEqual(graph.dirty_ids(), ["a", "b", "c"])
        graph.run(100)
        graph.update_cost("b", 5)
        self.assertEqual(graph.dirty_ids(), ["b", "c"])

    def test_run_clears_only_selected_nodes(self):
        graph = RecalcGraph()
        graph.set_node("a", 5, 1)
        graph.set_node("b", 5, 1)
        plan = graph.run(5)
        self.assertEqual(plan.ids, ("a",))
        self.assertEqual(graph.dirty_ids(), ["b"])

    def test_best_does_not_change_state(self):
        graph = RecalcGraph()
        graph.set_node("a", 1, 1)
        graph.best(1)
        self.assertEqual(graph.dirty_ids(), ["a"])

    def test_redefine_node_marks_it_dirty_again(self):
        graph = RecalcGraph()
        graph.set_node("a", 1, 1)
        graph.set_node("b", 1, 1, ["a"])
        graph.run(10)
        graph.set_node("a", 2, 3)
        self.assertEqual(graph.dirty_ids(), ["a", "b"])


class ErrorTest(unittest.TestCase):
    def test_negative_cost_rejected_with_exit_code_2(self):
        graph = RecalcGraph()
        with self.assertRaises(NegativeAmountError) as ctx:
            graph.set_node("a", -1, 5)
        self.assertEqual(ctx.exception.exit_code, 2)
        graph.set_node("a", 1, 5)
        with self.assertRaises(NegativeAmountError):
            graph.update_cost("a", -1)

    def test_negative_budget_rejected_with_exit_code_2(self):
        graph = RecalcGraph()
        with self.assertRaises(NegativeAmountError) as ctx:
            graph.best(-1)
        self.assertEqual(ctx.exception.exit_code, 2)
        with self.assertRaises(NegativeAmountError):
            graph.run(-5)

    def test_cycle_rejected_with_exit_code_3_and_rolled_back(self):
        graph = RecalcGraph()
        graph.set_node("a", 1, 1)
        graph.set_node("b", 1, 1, ["a"])
        with self.assertRaises(CycleError) as ctx:
            graph.set_node("a", 1, 1, ["b"])
        self.assertEqual(ctx.exception.exit_code, 3)
        self.assertEqual(graph.dirty_ids(), ["a", "b"])
        with self.assertRaises(CycleError):
            graph.set_node("a", 1, 1, ["a"])  # self-loop

    def test_unknown_node_rejected_with_exit_code_4(self):
        graph = RecalcGraph()
        graph.set_node("a", 1, 1)
        with self.assertRaises(UnknownNodeError) as ctx:
            graph.update_cost("zzz", 1)
        self.assertEqual(ctx.exception.exit_code, 4)
        with self.assertRaises(UnknownNodeError):
            graph.set_node("b", 1, 1, ["zzz"])


if __name__ == "__main__":
    unittest.main()
