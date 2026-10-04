import unittest

from mcfcert import Certificate, Repairer, Verifier

from helpers import (
    bottleneck_direct,
    diamond,
    infeasible_network,
    lower_bound_network,
    path_network,
    tie_network,
)


class CascadeRepairTests(unittest.TestCase):
    def test_single_over_capacity_edge_triggers_cascade(self):
        # Only e_st exceeds its bounds, yet feasibility forces all three
        # edges to change: the overflow must be rerouted via the detour.
        net = bottleneck_direct()
        result = Repairer(net).repair({"e_st": 4, "e_sa": 0, "e_at": 0})
        self.assertEqual(result["status"], "optimal")
        self.assertTrue(result["optimal"])
        self.assertEqual(result["modifications"], 3)
        self.assertEqual(result["flows"], {"e_st": 2, "e_sa": 2, "e_at": 2})

    def test_uniform_overflow_repairs_whole_path(self):
        net = path_network()
        result = Repairer(net).repair({"e_sa": 7, "e_ab": 7, "e_bt": 7})
        self.assertEqual(result["status"], "optimal")
        self.assertEqual(result["flows"], {"e_sa": 5, "e_ab": 5, "e_bt": 5})
        self.assertEqual(result["modifications"], 3)
        self.assertEqual(result["l1_distance"], 6)
        self.assertEqual(result["cost"], 15)


class LexicographicObjectiveTests(unittest.TestCase):
    def test_same_modification_count_smaller_l1_wins(self):
        # Two repairs modify all three edges: (2,2,2) with L1 = 6 and
        # (0,4,4) with L1 = 12.  The repairer must pick the smaller L1.
        net = bottleneck_direct()
        result = Repairer(net).repair({"e_st": 4, "e_sa": 0, "e_at": 0})
        self.assertEqual(result["modifications"], 3)
        self.assertEqual(result["l1_distance"], 6)
        self.assertEqual(result["flows"], {"e_st": 2, "e_sa": 2, "e_at": 2})

    def test_l1_tie_broken_by_cost(self):
        # Both minimal repairs change 2 edges with L1 = 4; only the cost
        # differs (4 via the cheap path vs 20 via the expensive one).
        net = tie_network()
        base = {"e_sa": 2, "e_at": 2, "e_sb": 2, "e_bt": 2}
        result = Repairer(net).repair(base)
        self.assertEqual(result["status"], "optimal")
        self.assertEqual(result["modifications"], 2)
        self.assertEqual(result["l1_distance"], 4)
        self.assertEqual(result["cost"], 4)
        self.assertEqual(
            result["flows"], {"e_sa": 2, "e_at": 2, "e_sb": 0, "e_bt": 0}
        )

    def test_modification_count_dominates_cost(self):
        # The cheapest feasible flow (4,4,0,0) costs 8 but needs 4 changes
        # from the base; the repairer prefers 2 changes at cost 12.
        net = diamond()
        base = {"e_sa": 3, "e_at": 3, "e_sb": 3, "e_bt": 3}
        result = Repairer(net).repair(base)
        self.assertEqual(result["modifications"], 2)
        self.assertEqual(result["l1_distance"], 4)
        self.assertEqual(result["cost"], 12)
        self.assertEqual(
            result["flows"], {"e_sa": 3, "e_at": 3, "e_sb": 1, "e_bt": 1}
        )

    def test_lower_bound_violation_repaired(self):
        net = lower_bound_network()
        result = Repairer(net).repair({"e_st": 1})
        self.assertEqual(result["status"], "optimal")
        self.assertEqual(result["flows"], {"e_st": 4})
        self.assertEqual(result["modifications"], 1)
        self.assertEqual(result["l1_distance"], 3)

    def test_repaired_flow_passes_independent_verification(self):
        net = tie_network()
        base = {"e_sa": 2, "e_at": 2, "e_sb": 2, "e_bt": 2}
        result = Repairer(net).repair(base)
        certificate = Certificate(
            flows=result["flows"],
            potentials={"s": 0, "a": 1, "b": 0, "t": 2},
            declared_cost=result["cost"],
        )
        verdict = Verifier(net).verify(certificate)
        self.assertTrue(verdict["valid"], verdict)


class InfeasibleTests(unittest.TestCase):
    def test_infeasible_network_yields_cut_certificate(self):
        net = infeasible_network()
        result = Repairer(net).repair({"e_st": 5})
        self.assertEqual(result["status"], "infeasible")
        self.assertFalse(result["optimal"])
        self.assertIsNone(result["flows"])
        cut = result["cut"]
        self.assertEqual(cut["nodes"], ["t"])
        self.assertEqual(cut["net_demand"], 5)
        self.assertEqual(cut["max_net_inflow"], 3)
        self.assertEqual(cut["deficit"], 2)


class BudgetTests(unittest.TestCase):
    def setUp(self):
        self.net = tie_network()
        self.base = {"e_sa": 2, "e_at": 2, "e_sb": 2, "e_bt": 2}

    def test_zero_budget_reports_lower_bound_only(self):
        result = Repairer(self.net).repair(self.base, budget=0)
        self.assertEqual(result["status"], "budget_exhausted")
        self.assertFalse(result["optimal"])
        self.assertIsNone(result["flows"])
        self.assertEqual(result["lower_bound_modifications"], 0)

    def test_small_budget_returns_best_feasible_and_proven_bound(self):
        result = Repairer(self.net).repair(self.base, budget=3)
        self.assertEqual(result["status"], "budget_exhausted")
        self.assertFalse(result["optimal"])
        # The phase-0 max flow already provides a feasible incumbent.
        self.assertIsNotNone(result["flows"])
        # Level 0 is fully exhausted, so at least 1 modification is proven.
        self.assertEqual(result["lower_bound_modifications"], 1)
        self.assertEqual(result["steps_used"], 3)

    def test_medium_budget_finds_two_modification_repair(self):
        result = Repairer(self.net).repair(self.base, budget=8)
        self.assertEqual(result["status"], "budget_exhausted")
        self.assertFalse(result["optimal"])
        self.assertEqual(result["modifications"], 2)
        self.assertEqual(result["lower_bound_modifications"], 2)

    def test_unlimited_budget_certifies_optimality(self):
        result = Repairer(self.net).repair(self.base)
        self.assertEqual(result["status"], "optimal")
        self.assertTrue(result["optimal"])
        self.assertEqual(result["lower_bound_modifications"], 2)

    def test_checkpoints_are_emitted_in_order(self):
        seen = []
        Repairer(self.net).repair(self.base, checkpoint=seen.append)
        self.assertTrue(seen)
        steps = [c["steps"] for c in seen]
        self.assertEqual(steps, sorted(steps))
        events = [c["event"] for c in seen]
        self.assertIn("feasibility", events)
        self.assertIn("modifications", events)
        self.assertIn("objective", events)
        self.assertEqual(events[-1], "done")


if __name__ == "__main__":
    unittest.main()
