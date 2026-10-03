import unittest

from mcflow import repair, verify, verify_cut_certificate
from helpers import (cascade_network, diamond_network, infeasible_network,
                     l1_tiebreak_network)


class RepairerTest(unittest.TestCase):
    def test_valid_flow_is_left_untouched(self):
        network = diamond_network()
        flow = {"e1": 3, "e2": 3, "e3": 0}
        result = repair(network, flow)
        self.assertEqual(result.status, "optimal")
        self.assertTrue(result.optimal)
        self.assertEqual(result.flow, flow)
        self.assertEqual(result.changed_edges, 0)
        self.assertEqual(result.l1_distance, 0)
        self.assertEqual(result.cost, 6)

    def test_single_over_capacity_edge_cascades(self):
        network = cascade_network()
        # Only e1 violates its capacity (3 > 2); the submitted flow conserves
        # balance everywhere.  Pushing e1 back to 2 forces e4 to take one
        # unit and the whole path to be rebalanced: 4 edges must change.
        base = {"e1": 3, "e2": 3, "e3": 3, "e4": 0}
        result = repair(network, base)
        self.assertEqual(result.status, "optimal")
        self.assertEqual(result.flow, {"e1": 2, "e2": 2, "e3": 2, "e4": 1})
        self.assertEqual(result.changed_edges, 4)
        self.assertEqual(result.l1_distance, 4)
        self.assertEqual(result.cost, 16)
        self.assertEqual(result.lower_bound_changes, 4)

    def test_same_change_count_prefers_smaller_l1(self):
        network = l1_tiebreak_network()
        # Base flow violates conservation at s/x.  Two repairs modify exactly
        # two edges: {e1->3, e2->3} with L1 = 2, or {e4->3, e2->3} with
        # L1 = 4.  The repairer must pick the smaller L1.
        result = repair(network, {"e1": 2, "e2": 2, "e4": 0})
        self.assertEqual(result.status, "optimal")
        self.assertEqual(result.changed_edges, 2)
        self.assertEqual(result.l1_distance, 2)
        self.assertEqual(result.flow, {"e1": 3, "e2": 3, "e4": 0})
        self.assertEqual(result.cost, 6)

    def test_infeasible_network_yields_cut_certificate(self):
        network = infeasible_network()
        result = repair(network, {"e1": 3})
        self.assertEqual(result.status, "infeasible")
        self.assertIsNone(result.flow)
        self.assertIsNotNone(result.cut)
        self.assertTrue(verify_cut_certificate(network, result.cut))
        self.assertEqual(set(result.cut["nodes"]), {"s"})
        self.assertGreater(result.cut["demand"],
                           result.cut["capacity_in"] - result.cut["lower_out"])

    def test_repaired_flow_passes_independent_verification(self):
        network = cascade_network()
        result = repair(network, {"e1": 3, "e2": 3, "e3": 3, "e4": 0})
        from mcflow import compute_potentials
        cert = {
            "flows": result.flow,
            "potentials": compute_potentials(network, result.flow),
            "declared_cost": result.cost,
        }
        self.assertTrue(verify(network, cert).ok)

    def test_budget_exhaustion_reports_bounds_not_optimality(self):
        network = l1_tiebreak_network()
        base = {"e1": 2, "e2": 2, "e4": 0}

        # Budget 1: only the zero-change attempt runs (infeasible).
        starved = repair(network, base, budget=1)
        self.assertEqual(starved.status, "budget_exhausted")
        self.assertIsNone(starved.flow)
        self.assertFalse(starved.optimal)
        self.assertEqual(starved.lower_bound_changes, 1)
        self.assertEqual(starved.solver_calls, 1)

        # Budget 5: a feasible repair is found at level 2, but the level is
        # not fully enumerated, so optimality must not be claimed.
        partial = repair(network, base, budget=5)
        self.assertEqual(partial.status, "feasible")
        self.assertFalse(partial.optimal)
        self.assertEqual(partial.changed_edges, 2)
        self.assertEqual(partial.l1_distance, 2)
        self.assertEqual(partial.lower_bound_changes, 2)
        self.assertLessEqual(partial.lower_bound_changes, partial.changed_edges)

        # Full budget proves optimality.
        full = repair(network, base, budget=100)
        self.assertEqual(full.status, "optimal")
        self.assertEqual(full.lower_bound_changes, full.changed_edges)

    def test_checkpoints_are_emitted_per_attempt(self):
        network = l1_tiebreak_network()
        seen = []
        result = repair(network, {"e1": 2, "e2": 2, "e4": 0},
                        checkpoint=seen.append)
        self.assertEqual(result.status, "optimal")
        self.assertEqual(len(seen), result.solver_calls)
        self.assertEqual(result.checkpoints, result.solver_calls)
        levels = [c["level"] for c in seen]
        self.assertEqual(levels, sorted(levels))  # level-by-level search
        self.assertTrue(all("best" in c and "feasible" in c for c in seen))

    def test_proven_lower_bounds_present(self):
        network = l1_tiebreak_network()
        result = repair(network, {"e1": 2, "e2": 2, "e4": 0}, budget=1)
        self.assertIsNotNone(result.cost_lower_bound)
        self.assertLessEqual(result.cost_lower_bound, 6)
        self.assertEqual(result.l1_lower_bound, 0)  # no forced edges here
        cascade = repair(cascade_network(), {"e1": 3, "e2": 3, "e3": 3,
                                             "e4": 0}, budget=0)
        self.assertEqual(cascade.status, "budget_exhausted")
        self.assertEqual(cascade.lower_bound_changes, 1)  # e1 forced
        self.assertEqual(cascade.l1_lower_bound, 1)       # e1 exceeds upper by 1


if __name__ == "__main__":
    unittest.main()
