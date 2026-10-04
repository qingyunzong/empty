"""Cross-check the repairer against independent exhaustive enumeration."""

import unittest

from mcfcert import Certificate, Repairer, Verifier
from mcfcert import enumerator

from helpers import (
    bottleneck_direct,
    diamond,
    infeasible_network,
    lower_bound_network,
    path_network,
    tie_network,
)

CASES = [
    ("diamond-suboptimal-base", diamond, {"e_sa": 3, "e_at": 3, "e_sb": 3, "e_bt": 3}),
    ("diamond-feasible-base", diamond, {"e_sa": 2, "e_at": 2, "e_sb": 2, "e_bt": 2}),
    ("path-overflow", path_network, {"e_sa": 7, "e_ab": 7, "e_bt": 7}),
    ("bottleneck-cascade", bottleneck_direct, {"e_st": 4, "e_sa": 0, "e_at": 0}),
    ("tie-cost", tie_network, {"e_sa": 2, "e_at": 2, "e_sb": 2, "e_bt": 2}),
    ("lower-bound", lower_bound_network, {"e_st": 1}),
]


class EnumerationCrossCheckTests(unittest.TestCase):
    def test_repairer_matches_brute_force_on_all_cases(self):
        for name, build, base in CASES:
            with self.subTest(case=name):
                net = build()
                result = Repairer(net).repair(base)
                reference = enumerator.repair_reference(net, base)
                self.assertIsNotNone(reference, "case should be feasible")
                (mods, l1, cost), ref_flows = reference
                self.assertEqual(result["status"], "optimal")
                self.assertTrue(result["optimal"])
                self.assertEqual(
                    (result["modifications"], result["l1_distance"], result["cost"]),
                    (mods, l1, cost),
                )
                self.assertEqual(result["flows"], ref_flows)
                self.assertEqual(result["lower_bound_modifications"], mods)

    def test_infeasible_case_matches_brute_force(self):
        net = infeasible_network()
        self.assertIsNone(enumerator.repair_reference(net, {"e_st": 5}))
        result = Repairer(net).repair({"e_st": 5})
        self.assertEqual(result["status"], "infeasible")
        self.assertGreater(result["cut"]["deficit"], 0)

    def test_enumerator_confirms_verifier_optimality_judgement(self):
        net = diamond()
        best_cost, _ = enumerator.optimal_cost(net)
        self.assertEqual(best_cost, 8)
        # The conserving but suboptimal certificate (cost 16) is rejected...
        suboptimal = Certificate(
            flows={"e_sa": 2, "e_at": 2, "e_sb": 2, "e_bt": 2},
            potentials={"s": 0, "a": 1, "b": 3, "t": 2},
            declared_cost=16,
        )
        self.assertFalse(Verifier(net).verify(suboptimal)["valid"])
        # ...while the enumerated optimum with matching potentials passes.
        optimal = Certificate(
            flows={"e_sa": 4, "e_at": 4, "e_sb": 0, "e_bt": 0},
            potentials={"s": 0, "a": 1, "b": 3, "t": 2},
            declared_cost=best_cost,
        )
        self.assertTrue(Verifier(net).verify(optimal)["valid"])


if __name__ == "__main__":
    unittest.main()
