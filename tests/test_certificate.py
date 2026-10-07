import copy
import json
import unittest

from exactcount import Problem, Solver, verify_certificate
from exactcount.checker import frontier_spaces_disjoint

PDICT = {
    "variables": {"x": [0, 1, 2], "y": [0, 1, 2], "z": [0, 1, 2]},
    "constraints": [
        {"scope": ["x", "y"], "tuples": [[0, 0], [1, 1], [2, 2]]},
        {"scope": ["y", "z"], "tuples": [[0, 1], [1, 2], [2, 0]]},
    ],
}


def solved_certificate():
    solver = Solver(Problem.from_dict(PDICT))
    solver.solve()
    return solver.certificate()


def paused_certificate():
    """A certificate with at least two disjoint frontier nodes."""
    solver = Solver(Problem.from_dict(PDICT))
    budget = 1
    while True:
        solver.solve(budget)
        cert = solver.certificate()
        if not cert["complete"] and len(cert["frontier"]) >= 2:
            return cert
        budget *= 2
        assert budget < 10**6


class ValidCertificateTest(unittest.TestCase):
    def test_complete_certificate_accepted(self):
        cert = solved_certificate()
        self.assertTrue(cert["complete"])
        self.assertEqual(verify_certificate(cert), [])

    def test_paused_certificate_accepted(self):
        cert = paused_certificate()
        self.assertFalse(cert["complete"])
        self.assertGreaterEqual(len(cert["frontier"]), 2)
        self.assertEqual(verify_certificate(cert), [])

    def test_certificate_json_roundtrip(self):
        cert = solved_certificate()
        self.assertEqual(verify_certificate(json.loads(json.dumps(cert))), [])


class TamperedCertificateTest(unittest.TestCase):
    def assert_rejected(self, cert):
        errors = verify_certificate(cert)
        self.assertTrue(errors, "tampered certificate was accepted")

    def test_inflated_upper_bound(self):
        cert = solved_certificate()
        cert["certified_upper"] += 1
        self.assert_rejected(cert)

    def test_lowered_lower_bound(self):
        cert = solved_certificate()
        cert["confirmed_lower"] -= 1
        self.assert_rejected(cert)

    def test_flipped_complete_flag(self):
        cert = paused_certificate()
        cert["complete"] = True
        self.assert_rejected(cert)

    def test_forged_solution(self):
        cert = solved_certificate()

        def corrupt(node):
            if node["type"] == "solution":
                var = node["context"][0]
                node["domains"][var] = [
                    (node["domains"][var][0] + 1) % 3
                ]
                return True
            return any(corrupt(c) for c in node.get("children", []))

        self.assertTrue(corrupt(cert["tree"]))
        self.assert_rejected(cert)

    def test_shrunk_frontier_domain(self):
        cert = paused_certificate()
        # Remove a supported value from a frontier node (tree + flat list).
        target = cert["frontier"][0]["domains"]
        var = sorted(target)[0]
        removed = target[var].pop()

        def shrink(node):
            if node["type"] == "frontier":
                node["domains"][var] = [
                    v for v in node["domains"][var] if v != removed
                ] or node["domains"][var]
                return True
            return any(shrink(c) for c in node.get("children", []))

        shrink(cert["tree"])
        self.assert_rejected(cert)

    def test_overlapping_frontier(self):
        cert = paused_certificate()
        # Make two flattened frontier entries identical: they now overlap.
        cert["frontier"][1] = copy.deepcopy(cert["frontier"][0])
        self.assert_rejected(cert)

    def test_tampered_problem_tuples(self):
        cert = solved_certificate()
        cert["problem"]["constraints"][0]["tuples"] = [[0, 0]]
        self.assert_rejected(cert)

    def test_tampered_problem_domain(self):
        cert = solved_certificate()
        cert["problem"]["variables"]["x"] = [0, 1]
        self.assert_rejected(cert)

    def test_wrong_format(self):
        cert = solved_certificate()
        cert["format"] = "something-else"
        self.assert_rejected(cert)

    def test_garbage_input(self):
        self.assertTrue(verify_certificate(None))
        self.assertTrue(verify_certificate({}))
        self.assertTrue(verify_certificate({"format": "exactcount-certificate-1"}))


class FrontierDisjointnessTest(unittest.TestCase):
    def test_disjoint_helper(self):
        a = {"x": [0], "y": [0, 1, 2]}
        b = {"x": [1, 2], "y": [0, 1, 2]}
        c = {"x": [0], "y": [1]}
        self.assertTrue(frontier_spaces_disjoint(a, b))
        self.assertFalse(frontier_spaces_disjoint(a, c))

    def test_frontier_of_valid_certificate_is_disjoint(self):
        cert = paused_certificate()
        spaces = [entry["domains"] for entry in cert["frontier"]]
        for i in range(len(spaces)):
            for j in range(i + 1, len(spaces)):
                self.assertTrue(frontier_spaces_disjoint(spaces[i], spaces[j]))


if __name__ == "__main__":
    unittest.main()
