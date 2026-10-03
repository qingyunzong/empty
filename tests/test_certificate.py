"""Certificate generation, independent verification, tamper rejection."""

import copy
import json
import os
import random
import subprocess
import sys
import tempfile
import unittest

from schcount import Constraint, Problem, Solver, verify_certificate

from helpers import brute_force, random_problem

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def branching_problem():
    """Deterministic problem whose certificate tree contains sum nodes,
    product nodes and multi-value domains."""
    p = Problem()
    for v in ("x", "y", "z"):
        p.add_variable(v, [0, 1, 2])
    p.add_constraint(Constraint("c1", ("x", "y"), [(0, 0), (1, 1), (2, 2)]))
    return p


def find_node(node, kind):
    if node["kind"] == kind:
        return node
    for child in node.get("children", []):
        found = find_node(child, kind)
        if found is not None:
            return found
    return None


def iter_nodes(node, kind):
    if node["kind"] == kind:
        yield node
    for child in node.get("children", []):
        yield from iter_nodes(child, kind)


def walk(node):
    yield node
    for child in node.get("children", []):
        yield from walk(child)


def paused_cert_with(problem, predicate, step=3, max_rounds=100000):
    """Solve in small budget steps until the certificate tree contains a
    node matching ``predicate``; returns the paused certificate."""
    solver = Solver(problem)
    for _ in range(max_rounds):
        solver.solve(budget=step)
        cert = solver.certificate()
        if any(predicate(n) for n in walk(cert["tree"])):
            return cert
        if cert["complete"]:
            break
    raise AssertionError("no matching node appeared before completion")


class TestCertificates(unittest.TestCase):
    def test_complete_certificate_verifies(self):
        for seed in range(4):
            rng = random.Random(4000 + seed)
            problem = random_problem(rng, max_vars=5, max_dom=3)
            solver = Solver(problem)
            solver.solve()
            ok, reason = verify_certificate(solver.certificate())
            self.assertTrue(ok, reason)

    def test_paused_certificate_verifies_and_bounds_hold(self):
        rng = random.Random(4001)
        problem = random_problem(rng, max_vars=5, max_dom=3)
        exact = brute_force(problem)
        solver = Solver(problem)
        solver.solve(budget=3)
        cert = solver.certificate()
        ok, reason = verify_certificate(cert)
        self.assertTrue(ok, reason)
        self.assertLessEqual(cert["lower"], exact)
        self.assertLessEqual(exact, cert["upper"])
        self.assertFalse(cert["complete"])

    def test_paused_mid_propagation_certificate_verifies(self):
        rng = random.Random(4002)
        problem = random_problem(rng, max_vars=6, max_dom=3)
        solver = Solver(problem)
        solver.solve(budget=1)
        cert = solver.certificate()
        ok, reason = verify_certificate(cert)
        self.assertTrue(ok, reason)
        self.assertIsNotNone(find_node(cert["tree"], "leaf"))

    def test_tampered_digest_rejected(self):
        solver = self._solved_solver()
        cert = solver.certificate()
        cert["problem_digest"] = "0" * 64
        ok, _ = verify_certificate(cert)
        self.assertFalse(ok)

    def test_tampered_bounds_rejected(self):
        solver = self._solved_solver()
        cert = solver.certificate()
        cert["upper"] += 1
        ok, _ = verify_certificate(cert)
        self.assertFalse(ok)

    def test_tampered_solved_count_rejected(self):
        solver = self._solved_solver()
        cert = solver.certificate()
        node = find_node(cert["tree"], "solved")
        self.assertIsNotNone(node)
        node["count"] += 1
        ok, _ = verify_certificate(cert)
        self.assertFalse(ok)

    def test_removed_branch_rejected(self):
        cert = paused_cert_with(
            branching_problem(), lambda n: n["kind"] == "sum"
        )
        node = find_node(cert["tree"], "sum")
        node["children"] = node["children"][1:]
        ok, _ = verify_certificate(cert)
        self.assertFalse(ok)

    def test_duplicated_branch_rejected(self):
        cert = paused_cert_with(
            branching_problem(), lambda n: n["kind"] == "sum"
        )
        node = find_node(cert["tree"], "sum")
        node["children"] = node["children"] + [copy.deepcopy(node["children"][0])]
        ok, _ = verify_certificate(cert)
        self.assertFalse(ok)

    def test_tampered_leaf_ub_rejected(self):
        rng = random.Random(4003)
        problem = random_problem(rng, max_vars=5, max_dom=3)
        solver = Solver(problem)
        solver.solve(budget=2)
        cert = solver.certificate()
        leaf = find_node(cert["tree"], "leaf")
        self.assertIsNotNone(leaf)
        leaf["ub"] += 1
        ok, _ = verify_certificate(cert)
        self.assertFalse(ok)

    def test_tampered_domain_rejected(self):
        solver = Solver(branching_problem())
        solver.solve()
        cert = solver.certificate()
        # The solved root keeps multi-value domains; shrinking one below
        # the arc-consistency closure must be rejected.
        node = cert["tree"]
        self.assertEqual(node["kind"], "solved")
        var = node["vars"][0]
        self.assertGreater(len(node["domains"][var]), 1)
        node["domains"][var] = node["domains"][var][1:]
        ok, _ = verify_certificate(cert)
        self.assertFalse(ok)

    def test_tampered_confirmed_solution_rejected(self):
        cert = paused_cert_with(
            branching_problem(),
            lambda n: n["kind"] == "solved"
            and n["count"] == 1
            and "x" in n["vars"],
        )
        target = None
        for cand in iter_nodes(cert["tree"], "solved"):
            if cand["count"] == 1 and "x" in cand["vars"]:
                target = cand
                break
        self.assertIsNotNone(target)
        target["domains"]["x"] = [(target["domains"]["x"][0] + 1) % 3]
        ok, _ = verify_certificate(cert)
        self.assertFalse(ok)

    def test_cli_verify_accepts_and_rejects(self):
        solver = self._solved_solver()
        cert = solver.certificate()
        env = dict(os.environ)
        env["PYTHONPATH"] = REPO_ROOT + os.pathsep + env.get("PYTHONPATH", "")
        with tempfile.TemporaryDirectory() as tmp:
            good = os.path.join(tmp, "good.json")
            bad = os.path.join(tmp, "bad.json")
            with open(good, "w", encoding="utf-8") as fh:
                json.dump(cert, fh)
            tampered = copy.deepcopy(cert)
            tampered["lower"] += 1
            with open(bad, "w", encoding="utf-8") as fh:
                json.dump(tampered, fh)
            proc_ok = subprocess.run(
                [sys.executable, "-m", "schcount", "verify", good],
                capture_output=True,
                text=True,
                cwd=REPO_ROOT,
                env=env,
                timeout=120,
            )
            self.assertEqual(proc_ok.returncode, 0, proc_ok.stderr)
            self.assertTrue(json.loads(proc_ok.stdout)["valid"])
            proc_bad = subprocess.run(
                [sys.executable, "-m", "schcount", "verify", bad],
                capture_output=True,
                text=True,
                cwd=REPO_ROOT,
                env=env,
                timeout=120,
            )
            self.assertEqual(proc_bad.returncode, 1)
            self.assertFalse(json.loads(proc_bad.stdout)["valid"])

    @staticmethod
    def _solved_solver():
        rng = random.Random(777)
        problem = random_problem(rng, max_vars=5, max_dom=3)
        solver = Solver(problem)
        solver.solve()
        return solver


if __name__ == "__main__":
    unittest.main()
