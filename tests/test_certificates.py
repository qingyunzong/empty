import unittest

from mincostflow import verify

from support import make_solver


def infeasible_model():
    demands = {"s": -5, "t": 5}
    edges = [{"id": "e", "tail": "s", "head": "t", "lower": 0,
              "upper": 3, "cost": 1}]
    return demands, edges


class TestCertificates(unittest.TestCase):
    def test_valid_certificate_accepted(self):
        demands, edges = infeasible_model()
        result = make_solver(demands, edges).solve()
        self.assertEqual(verify.check_cut_certificate(
            demands, edges, result.certificate), [])

    def test_tampered_certificates_rejected(self):
        demands, edges = infeasible_model()
        cert = make_solver(demands, edges).solve().certificate

        wrong_nodes = dict(cert, nodes=["t"])
        self.assertTrue(verify.check_cut_certificate(
            demands, edges, wrong_nodes))

        wrong_form = dict(cert, form="demand" if cert["form"] == "supply"
                          else "supply")
        self.assertTrue(verify.check_cut_certificate(
            demands, edges, wrong_form))

        empty = dict(cert, nodes=[])
        self.assertTrue(verify.check_cut_certificate(
            demands, edges, empty))

        unknown = dict(cert, nodes=["s", "ghost"])
        self.assertTrue(verify.check_cut_certificate(
            demands, edges, unknown))

        # Forged sums inside the certificate do not matter: the verifier
        # recomputes everything from the model.
        forged = dict(cert, demand=-999, upper_out=0)
        self.assertEqual(verify.check_cut_certificate(
            demands, edges, forged), [])

    def test_no_certificate_for_feasible_model(self):
        demands = {"s": -2, "t": 2}
        edges = [{"id": "e", "tail": "s", "head": "t", "lower": 0,
                  "upper": 3, "cost": 1}]
        result = make_solver(demands, edges).solve()
        self.assertIsNone(result.certificate)
        # A hand-crafted certificate on a feasible model must not verify.
        fake = {"form": "demand", "nodes": ["s", "t"]}
        self.assertTrue(verify.check_cut_certificate(demands, edges, fake))

    def test_tampered_flow_and_potentials_rejected(self):
        demands = {"s": -3, "t": 3}
        edges = [
            {"id": "e1", "tail": "s", "head": "t", "lower": 0,
             "upper": 3, "cost": 2},
            {"id": "e2", "tail": "t", "head": "s", "lower": 0,
             "upper": 3, "cost": 1},
        ]
        result = make_solver(demands, edges).solve()
        self.assertEqual(verify.check_optimality(
            demands, edges, result.flow, result.potentials), [])

        over_bound = dict(result.flow, e1=result.flow["e1"] + 1)
        self.assertTrue(verify.check_flow(demands, edges, over_bound))

        unbalanced = dict(result.flow, e2=result.flow["e2"] + 1)
        self.assertTrue(verify.check_flow(demands, edges, unbalanced))

        missing_edge = {k: v for k, v in result.flow.items() if k != "e1"}
        self.assertTrue(verify.check_flow(demands, edges, missing_edge))

        bad_potentials = dict(result.potentials, t=result.potentials["t"] - 100)
        self.assertTrue(verify.check_optimality(
            demands, edges, result.flow, bad_potentials))

        missing_potential = {k: v for k, v in result.potentials.items()
                             if k != "t"}
        self.assertTrue(verify.check_optimality(
            demands, edges, result.flow, missing_potential))


if __name__ == "__main__":
    unittest.main()
