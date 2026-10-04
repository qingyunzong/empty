import unittest

from mcfcert import Certificate, Verifier

from helpers import diamond, imbalanced_network, path_network

OPTIMAL_FLOWS = {"e_sa": 4, "e_at": 4, "e_sb": 0, "e_bt": 0}
OPTIMAL_POTENTIALS = {"s": 0, "a": 1, "b": 3, "t": 2}
SUBOPTIMAL_FLOWS = {"e_sa": 2, "e_at": 2, "e_sb": 2, "e_bt": 2}


def make_cert(flows, potentials, declared_cost):
    return Certificate(flows=flows, potentials=potentials, declared_cost=declared_cost)


class CapacityAndConservationTests(unittest.TestCase):
    def setUp(self):
        self.net = diamond()
        self.verifier = Verifier(self.net)

    def test_valid_optimal_certificate(self):
        cert = make_cert(OPTIMAL_FLOWS, OPTIMAL_POTENTIALS, 8)
        verdict = self.verifier.verify(cert)
        self.assertTrue(verdict["valid"], verdict)
        for name, check in verdict["checks"].items():
            self.assertTrue(check["ok"], (name, check))
        self.assertEqual(verdict["negative_cycle"], {"found": False})

    def test_over_capacity_reports_every_violating_edge(self):
        net = path_network()
        cert = make_cert(
            {"e_sa": 7, "e_ab": 7, "e_bt": 7},
            {"s": 0, "a": 1, "b": 2, "t": 3},
            21,
        )
        verdict = Verifier(net).verify(cert)
        self.assertFalse(verdict["valid"])
        violations = verdict["checks"]["capacity"]["violations"]
        self.assertEqual({v["edge"] for v in violations}, {"e_sa", "e_ab", "e_bt"})
        self.assertTrue(all(v["reason"] == "out of bounds" for v in violations))
        self.assertTrue(verdict["negative_cycle"]["skipped"])

    def test_conservation_violation_reports_nodes(self):
        cert = make_cert(
            {"e_sa": 4, "e_at": 3, "e_sb": 0, "e_bt": 0}, OPTIMAL_POTENTIALS, 7
        )
        verdict = self.verifier.verify(cert)
        self.assertFalse(verdict["valid"])
        violations = verdict["checks"]["conservation"]["violations"]
        self.assertEqual({v["node"] for v in violations}, {"a", "t"})
        by_node = {v["node"]: v for v in violations}
        self.assertEqual(by_node["t"]["required"], 4)
        self.assertEqual(by_node["t"]["actual"], 3)

    def test_non_integer_flow_rejected(self):
        cert = make_cert(
            {"e_sa": 2.5, "e_at": 4, "e_sb": 0, "e_bt": 0}, OPTIMAL_POTENTIALS, 8
        )
        verdict = self.verifier.verify(cert)
        self.assertFalse(verdict["valid"])
        reasons = {v["reason"] for v in verdict["checks"]["capacity"]["violations"]}
        self.assertIn("non-integer flow", reasons)

    def test_missing_flow_rejected(self):
        cert = make_cert({"e_sa": 4, "e_at": 4, "e_sb": 0}, OPTIMAL_POTENTIALS, 8)
        verdict = self.verifier.verify(cert)
        self.assertFalse(verdict["valid"])
        reasons = {v["reason"] for v in verdict["checks"]["capacity"]["violations"]}
        self.assertIn("missing flow", reasons)


class DemandAndCostTests(unittest.TestCase):
    def test_imbalanced_demands_flagged(self):
        net = imbalanced_network()
        cert = make_cert({"e_st": 3}, {"s": 0, "t": 1}, 3)
        verdict = Verifier(net).verify(cert)
        self.assertFalse(verdict["valid"])
        demand = verdict["checks"]["demand"]
        self.assertFalse(demand["ok"])
        self.assertEqual(demand["violations"][0]["imbalance"], 1)

    def test_tampered_declared_cost_detected(self):
        cert = make_cert(OPTIMAL_FLOWS, OPTIMAL_POTENTIALS, 9)
        verdict = Verifier(diamond()).verify(cert)
        self.assertFalse(verdict["valid"])
        cost = verdict["checks"]["cost"]
        self.assertFalse(cost["ok"])
        self.assertEqual(cost["declared"], 9)
        self.assertEqual(cost["actual"], 8)

    def test_missing_declared_cost_detected(self):
        cert = make_cert(OPTIMAL_FLOWS, OPTIMAL_POTENTIALS, None)
        verdict = Verifier(diamond()).verify(cert)
        self.assertFalse(verdict["valid"])
        self.assertFalse(verdict["checks"]["cost"]["ok"])


class OptimalityTests(unittest.TestCase):
    def setUp(self):
        self.verifier = Verifier(diamond())

    def test_conserving_but_suboptimal_flow_exposed(self):
        # Feasible and cost-honest, but not cost-optimal: the residual graph
        # contains a negative cycle and some reduced cost is negative.
        cert = make_cert(SUBOPTIMAL_FLOWS, OPTIMAL_POTENTIALS, 16)
        verdict = self.verifier.verify(cert)
        self.assertFalse(verdict["valid"])
        self.assertTrue(verdict["checks"]["capacity"]["ok"])
        self.assertTrue(verdict["checks"]["conservation"]["ok"])
        self.assertTrue(verdict["checks"]["cost"]["ok"])
        reduced = verdict["checks"]["reduced_costs"]
        self.assertFalse(reduced["ok"])
        self.assertIn(
            {"edge": "e_bt", "direction": "backward", "reduced_cost": -4},
            reduced["violations"],
        )
        cycle = verdict["negative_cycle"]
        self.assertTrue(cycle["found"])
        self.assertEqual(cycle["cost"], -4)
        self.assertEqual(
            set(cycle["edges"]), {"e_sa", "e_at", "e_sb", "e_bt"}
        )

    def test_tampered_potentials_detected(self):
        tampered = dict(OPTIMAL_POTENTIALS, t=0)
        cert = make_cert(OPTIMAL_FLOWS, tampered, 8)
        verdict = self.verifier.verify(cert)
        self.assertFalse(verdict["valid"])
        reduced = verdict["checks"]["reduced_costs"]
        self.assertFalse(reduced["ok"])
        self.assertTrue(reduced["violations"])

    def test_missing_potential_detected(self):
        potentials = {k: v for k, v in OPTIMAL_POTENTIALS.items() if k != "b"}
        cert = make_cert(OPTIMAL_FLOWS, potentials, 8)
        verdict = self.verifier.verify(cert)
        self.assertFalse(verdict["valid"])
        reasons = {
            v["reason"] for v in verdict["checks"]["reduced_costs"]["violations"]
        }
        self.assertIn("missing potential", reasons)


class BatchIsolationTests(unittest.TestCase):
    def test_invalid_certificate_does_not_pollute_next_verdict(self):
        verifier = Verifier(diamond())
        good = make_cert(OPTIMAL_FLOWS, OPTIMAL_POTENTIALS, 8)
        bad = make_cert(OPTIMAL_FLOWS, dict(OPTIMAL_POTENTIALS, t=0), 999)

        first_good = verifier.verify(good)
        bad_verdict = verifier.verify(bad)
        second_good = verifier.verify(good)
        third_bad = verifier.verify(bad)

        self.assertTrue(first_good["valid"])
        self.assertFalse(bad_verdict["valid"])
        self.assertTrue(second_good["valid"])
        self.assertFalse(third_bad["valid"])
        # Repeated verification of the same certificate is bit-identical...
        self.assertEqual(first_good, second_good)
        self.assertEqual(bad_verdict, third_bad)
        # ...and identical to what a fresh verifier reports.
        self.assertEqual(first_good, Verifier(diamond()).verify(good))


if __name__ == "__main__":
    unittest.main()
