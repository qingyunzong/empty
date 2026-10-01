import random
import unittest

from executor.engine import (
    Action,
    Executor,
    COMMITTED,
    ROLLED_BACK,
    BUDGET_EXHAUSTED,
    compensation_order,
)
from executor.reference import reference_run


def make_action(id_, cost=0, comp=0, outcome="success", children=None):
    return Action(
        id=id_,
        cost=cost,
        compensation_cost=comp,
        outcome=outcome,
        children=children or [],
    )


def random_tree(rng, max_nodes):
    counter = [0]

    def build(nodes_left, depth):
        counter[0] += 1
        action = Action(
            id=f"n{counter[0]}",
            cost=rng.randint(0, 20),
            compensation_cost=rng.randint(0, 20),
            outcome=rng.choices(
                ["success", "fail", "unsat"], weights=[70, 20, 10]
            )[0],
            children=[],
        )
        nodes_left -= 1
        if depth < 5 and nodes_left > 0:
            n_children = rng.randint(0, min(4, nodes_left))
            for _ in range(n_children):
                share = rng.randint(0, nodes_left)
                if share == 0:
                    continue
                nodes_left -= share
                action.children.append(build(share, depth + 1))
        return action

    return build(max_nodes, 0)


class AcceptanceAReferenceComparison(unittest.TestCase):
    """A: random <=30-node trees compared against the reference enumeration."""

    def test_random_trees_match_reference(self):
        for seed in range(300):
            rng = random.Random(seed)
            root = random_tree(rng, rng.randint(1, 30))
            budget = rng.choice([rng.randint(0, 80), rng.randint(0, 1000)])
            result = Executor(root, budget).run()
            ref_state, ref_comp, ref_budget, ref_exec = reference_run(root, budget)
            with self.subTest(seed=seed, budget=budget):
                self.assertEqual(result.state, ref_state)
                self.assertEqual(result.compensations, ref_comp)
                self.assertEqual(result.budget_remaining, ref_budget)
                self.assertEqual(result.executed, ref_exec)
                self.assertIn(result.state, {COMMITTED, ROLLED_BACK, BUDGET_EXHAUSTED})


class AcceptanceBDeepFailure(unittest.TestCase):
    """B: a deep failure must not compensate unexecuted siblings."""

    def test_unexecuted_siblings_untouched(self):
        deep_fail = make_action("deep_fail", cost=1, outcome="fail")
        done_child = make_action("done_child", cost=1, comp=1)
        skipped_sibling = make_action("skipped_sibling", cost=1, comp=1)
        branch = make_action(
            "branch", cost=1, comp=1,
            children=[done_child, deep_fail, skipped_sibling],
        )
        untouched_branch = make_action(
            "untouched_branch", cost=1, comp=1,
            children=[make_action("untouched_leaf", cost=1, comp=1)],
        )
        root = make_action("root", cost=1, comp=1,
                           children=[branch, untouched_branch])

        result = Executor(root, 1000).run()

        self.assertEqual(result.state, ROLLED_BACK)
        self.assertNotIn("skipped_sibling", result.executed)
        self.assertNotIn("untouched_branch", result.executed)
        self.assertNotIn("untouched_leaf", result.executed)
        for skipped in ("skipped_sibling", "untouched_branch", "untouched_leaf"):
            self.assertNotIn(skipped, result.compensations)
        # Reverse completion order, deepest first.
        self.assertEqual(
            result.compensations,
            ["done_child", "branch", "root"],
        )

    def test_failed_action_itself_not_compensated(self):
        failing = make_action("failing", cost=3, comp=9, outcome="fail")
        root = make_action("root", cost=1, comp=1, children=[failing])
        result = Executor(root, 1000).run()
        self.assertEqual(result.state, ROLLED_BACK)
        self.assertEqual(result.compensations, ["root"])
        self.assertNotIn("failing", result.compensations)


class AcceptanceCBudgetExhaustion(unittest.TestCase):
    """C: budget running out during compensation yields a deterministic prefix."""

    def build_plan(self, root_comp):
        c1 = make_action("c1", cost=10, comp=4)
        c2 = make_action("c2", cost=10, comp=6)
        c3 = make_action("c3", cost=5, outcome="fail")
        root = make_action("root", cost=0, comp=root_comp,
                           children=[c1, c2, c3])
        return root

    def test_budget_insufficient_mid_compensation(self):
        # Forward spends 25; compensation order is c2(6) then c1(4) then root.
        root = self.build_plan(root_comp=1)
        result = Executor(root, 31).run()
        self.assertEqual(result.state, BUDGET_EXHAUSTED)
        self.assertEqual(result.compensations, ["c2"])
        self.assertEqual(result.budget_remaining, 0)

    def test_budget_exactly_exhausted_by_compensation(self):
        # Budget covers c2 and c1 exactly; root compensation (1) does not fit.
        root = self.build_plan(root_comp=1)
        result = Executor(root, 35).run()
        self.assertEqual(result.state, BUDGET_EXHAUSTED)
        self.assertEqual(result.compensations, ["c2", "c1"])
        self.assertEqual(result.budget_remaining, 0)

    def test_one_more_unit_of_budget_rolls_back(self):
        root = self.build_plan(root_comp=1)
        result = Executor(root, 36).run()
        self.assertEqual(result.state, ROLLED_BACK)
        self.assertEqual(result.compensations, ["c2", "c1", "root"])
        self.assertEqual(result.budget_remaining, 0)


class AcceptanceDTieBreak(unittest.TestCase):
    """D: tied optimal recovery strategies are broken by action id."""

    def test_equal_cost_siblings_compensated_by_id_order(self):
        # Declared (completion) order is c, a, b; all costs and compensation
        # costs equal, so the tie is broken by ascending id: a, b, c.
        children = [
            make_action("c", cost=5, comp=2),
            make_action("a", cost=5, comp=2),
            make_action("b", cost=5, comp=2),
            make_action("boom", cost=1, outcome="fail"),
        ]
        root = make_action("root", cost=0, comp=0, children=children)
        result = Executor(root, 1000).run()
        self.assertEqual(result.state, ROLLED_BACK)
        self.assertEqual(result.compensations, ["a", "b", "c", "root"])

    def test_tie_break_only_when_costs_exactly_equal(self):
        # Same declared order, but b has a different compensation cost, so
        # plain reverse completion order applies: b, a, c.
        children = [
            make_action("c", cost=5, comp=2),
            make_action("a", cost=5, comp=2),
            make_action("b", cost=5, comp=3),
            make_action("boom", cost=1, outcome="fail"),
        ]
        root = make_action("root", cost=0, comp=0, children=children)
        result = Executor(root, 1000).run()
        self.assertEqual(result.compensations, ["b", "a", "c", "root"])

    def test_compensation_order_key(self):
        kids = [make_action("x", 1, 1), make_action("y", 2, 2), make_action("z", 1, 1)]
        ordered = compensation_order(kids)
        # y is alone in its class at position 1; class of {x, z} sits at
        # position 2 (its last member), so it is compensated first, by id.
        self.assertEqual([a.id for a in ordered], ["x", "z", "y"])


class Semantics(unittest.TestCase):
    def test_commit(self):
        root = make_action("root", cost=3, comp=1,
                           children=[make_action("k", cost=2, comp=1)])
        result = Executor(root, 1000).run()
        self.assertEqual(result.state, COMMITTED)
        self.assertEqual(result.compensations, [])
        self.assertEqual(result.budget_remaining, 995)
        self.assertEqual(result.executed, ["root", "k"])

    def test_unsat_costs_nothing_and_is_not_retried(self):
        unsat = make_action("unsat_node", cost=50, outcome="unsat")
        root = make_action("root", cost=1, comp=1, children=[unsat])
        result = Executor(root, 1000).run()
        self.assertEqual(result.state, ROLLED_BACK)
        self.assertNotIn("unsat_node", result.executed)
        events = [e for e in result.events if e[1] == "unsat_node"]
        self.assertEqual(events, [("unsat", "unsat_node")])
        # Only root's cost (1) and compensation (1) were spent.
        self.assertEqual(result.budget_remaining, 998)

    def test_forward_budget_shortfall_triggers_rollback(self):
        pricey = make_action("pricey", cost=50, comp=0)
        cheap = make_action("cheap", cost=4, comp=2)
        root = make_action("root", cost=1, comp=1,
                           children=[cheap, pricey])
        result = Executor(root, 10).run()
        self.assertEqual(result.state, ROLLED_BACK)
        self.assertEqual(result.executed, ["root", "cheap"])
        self.assertEqual(result.compensations, ["cheap", "root"])
        self.assertIn(("budget_shortfall", "pricey"), result.events)

    def test_nested_compensation_is_deepest_first(self):
        # Distinct compensation costs: no tie class, pure reverse order.
        leaf1 = make_action("leaf1", cost=1, comp=1)
        leaf2 = make_action("leaf2", cost=1, comp=2)
        mid = make_action("mid", cost=1, comp=1, children=[leaf1, leaf2])
        failer = make_action("failer", cost=1, outcome="fail")
        root = make_action("root", cost=1, comp=1, children=[mid, failer])
        result = Executor(root, 1000).run()
        self.assertEqual(result.compensations, ["leaf2", "leaf1", "mid", "root"])


if __name__ == "__main__":
    unittest.main()
