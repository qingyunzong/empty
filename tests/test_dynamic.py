"""Tests for the dynamic CSP library and CLI.

Includes a naive reference implementation that, after a deletion,
re-runs full AC-3 from the initial domains over the remaining
constraints.  The incremental solver must match it exactly.
"""

import json
import os
import random
import subprocess
import sys
import tempfile
import unittest
from collections import deque

from csp_dynamic import (
    Constraint,
    ConstraintNotFoundError,
    DynamicCSP,
    ProblemError,
    parse_problem,
)


# ----------------------------------------------------------------------
# Naive reference: full re-propagation from the initial domains.
# ----------------------------------------------------------------------
def reference_domains(variables, initial_domains, constraints):
    """Plain AC-3 (revise based) over the given constraints."""
    domains = {var: set(initial_domains[var]) for var in variables}
    supports = {}
    incident = {var: [] for var in variables}
    for c in constraints:
        supports[c.cid] = c.supports
        for var in c.scope:
            incident[var].append(c)

    queue = deque(constraints)
    in_queue = set(c.cid for c in constraints)
    while queue:
        c = queue.popleft()
        in_queue.discard(c.cid)
        for var in c.scope:
            other = c.other(var)
            removed = set()
            for value in domains[var]:
                if not (c.supports[var].get(value, set()) & domains[other]):
                    removed.add(value)
            if removed:
                domains[var] -= removed
                for neighbour in incident[var]:
                    if neighbour.cid != c.cid and neighbour.cid not in in_queue:
                        queue.append(neighbour)
                        in_queue.add(neighbour.cid)
    return {var: sorted(domains[var]) for var in variables}


def make_problem(variables, domains, constraint_specs):
    constraints = [
        Constraint(cid, scope, [tuple(p) for p in pairs])
        for cid, scope, pairs in constraint_specs
    ]
    return variables, domains, constraints


class IncrementalVsReferenceMixin:
    def assert_matches_reference(self, variables, domains, constraints, delete_id):
        csp = DynamicCSP(variables, domains, constraints)
        restored = csp.delete_constraint(delete_id)
        remaining = [c for c in constraints if c.cid != delete_id]
        expected = reference_domains(variables, domains, remaining)
        actual = csp.sorted_domains()
        self.assertEqual(actual, expected)
        return csp, restored, expected


class AcceptanceScenariosTest(IncrementalVsReferenceMixin, unittest.TestCase):
    def test_scenario_1_three_variables_two_constraints(self):
        # x in {1,2,3}, y in {2,3}, z in {1,2,3}
        # c0: x == y, c1: y < z
        variables = ["x", "y", "z"]
        domains = {"x": [1, 2, 3], "y": [2, 3], "z": [1, 2, 3]}
        specs = [
            (0, ("x", "y"), [(1, 1), (2, 2), (3, 3)]),
            (1, ("y", "z"), [(1, 2), (1, 3), (2, 3)]),
        ]
        variables, domains, constraints = make_problem(variables, domains, specs)

        csp = DynamicCSP(variables, domains, constraints)
        # After initial propagation: x={2}, y={2}, z={3}.
        self.assertEqual(csp.sorted_domains(), {"x": [2], "y": [2], "z": [3]})

        restored = csp.delete_constraint(1)
        expected = reference_domains(variables, domains, [constraints[0]])
        self.assertEqual(csp.sorted_domains(), expected)
        self.assertEqual(csp.sorted_domains(),
                         {"x": [2, 3], "y": [2, 3], "z": [1, 2, 3]})
        self.assertEqual(restored, {"x": [3], "y": [3], "z": [1, 2]})

    def test_scenario_2_deleting_constraint_without_prunings(self):
        variables = ["x", "y"]
        domains = {"x": [1, 2], "y": [1, 2]}
        specs = [
            (0, ("x", "y"), [(1, 1), (2, 2)]),
            (0 + 1, ("x", "y"), [(1, 1), (1, 2), (2, 1), (2, 2)]),
        ]
        variables, domains, constraints = make_problem(variables, domains, specs)
        csp = DynamicCSP(variables, domains, constraints)
        before = csp.sorted_domains()
        self.assertEqual(before, {"x": [1, 2], "y": [1, 2]})

        restored = csp.delete_constraint(1)
        self.assertEqual(restored, {"x": [], "y": []})
        self.assertEqual(csp.sorted_domains(), before)
        expected = reference_domains(variables, domains, [constraints[0]])
        self.assertEqual(csp.sorted_domains(), expected)

    def test_scenario_3_unknown_constraint_id(self):
        variables = ["x", "y"]
        domains = {"x": [1, 2], "y": [1, 2]}
        specs = [(0, ("x", "y"), [(1, 1), (2, 2)])]
        variables, domains, constraints = make_problem(variables, domains, specs)
        csp = DynamicCSP(variables, domains, constraints)
        before = csp.sorted_domains()

        with self.assertRaises(ConstraintNotFoundError):
            csp.delete_constraint(99)
        # Propagation state is unchanged after the failed deletion.
        self.assertEqual(csp.sorted_domains(), before)
        self.assertEqual(csp.active, {0})

    def test_scenario_4_delete_last_constraint_restores_initial_domains(self):
        variables = ["x", "y"]
        domains = {"x": [1, 2], "y": [2, 3]}
        specs = [(0, ("x", "y"), [(1, 1), (2, 2), (3, 3)])]
        variables, domains, constraints = make_problem(variables, domains, specs)
        csp = DynamicCSP(variables, domains, constraints)
        self.assertEqual(csp.sorted_domains(), {"x": [2], "y": [2]})

        restored = csp.delete_constraint(0)
        self.assertEqual(csp.sorted_domains(), {"x": [1, 2], "y": [2, 3]})
        self.assertEqual(restored, {"x": [1], "y": [3]})
        expected = reference_domains(variables, domains, [])
        self.assertEqual(csp.sorted_domains(), expected)


class SequentialDeletionTest(IncrementalVsReferenceMixin, unittest.TestCase):
    def test_multiple_sequential_deletions_match_reference(self):
        variables = ["a", "b", "c"]
        domains = {"a": [1, 2, 3], "b": [1, 2, 3], "c": [1, 2, 3]}
        specs = [
            (0, ("a", "b"), [(1, 1), (2, 2), (3, 3)]),
            (1, ("b", "c"), [(1, 2), (2, 3)]),
            (2, ("a", "c"), [(1, 1), (2, 2), (3, 3), (1, 2)]),
        ]
        variables, domains, constraints = make_problem(variables, domains, specs)
        csp = DynamicCSP(variables, domains, constraints)
        remaining = list(constraints)
        for delete_id in (1, 2, 0):
            csp.delete_constraint(delete_id)
            remaining = [c for c in remaining if c.cid != delete_id]
            expected = reference_domains(variables, domains, remaining)
            self.assertEqual(csp.sorted_domains(), expected)
        # All constraints deleted: initial domains restored.
        self.assertEqual(csp.sorted_domains(),
                         {v: sorted(domains[v]) for v in variables})

    def test_double_delete_raises(self):
        variables = ["x", "y"]
        domains = {"x": [1, 2], "y": [1, 2]}
        specs = [(0, ("x", "y"), [(1, 1), (2, 2)])]
        variables, domains, constraints = make_problem(variables, domains, specs)
        csp = DynamicCSP(variables, domains, constraints)
        csp.delete_constraint(0)
        with self.assertRaises(ConstraintNotFoundError):
            csp.delete_constraint(0)


class RandomizedCrossCheckTest(unittest.TestCase):
    def test_random_problems_match_reference(self):
        rng = random.Random(20261001)
        for trial in range(400):
            n_vars = rng.randint(2, 4)
            variables = ["v%d" % i for i in range(n_vars)]
            domains = {}
            for var in variables:
                size = rng.randint(1, 4)
                domains[var] = sorted(rng.sample(range(5), size))
            specs = []
            n_constraints = rng.randint(1, 5)
            for cid in range(n_constraints):
                x, y = rng.sample(variables, 2)
                pairs = [
                    (a, b)
                    for a in domains[x]
                    for b in domains[y]
                    if rng.random() < 0.5
                ]
                specs.append((cid, (x, y), pairs))
            variables_, domains_, constraints = make_problem(variables, domains, specs)
            csp = DynamicCSP(variables_, domains_, constraints)

            # Sanity: initial propagation matches the reference as well.
            expected = reference_domains(variables_, domains_, constraints)
            self.assertEqual(
                csp.sorted_domains(), expected,
                "initial propagation mismatch at trial %d" % trial,
            )

            # Delete all constraints one by one, in a random order, and
            # check against the reference after every single deletion.
            ids = [c.cid for c in constraints]
            rng.shuffle(ids)
            remaining = list(constraints)
            for delete_id in ids:
                csp.delete_constraint(delete_id)
                remaining = [c for c in remaining if c.cid != delete_id]
                expected = reference_domains(variables_, domains_, remaining)
                self.assertEqual(
                    csp.sorted_domains(), expected,
                    "mismatch at trial %d after deleting %d" % (trial, delete_id),
                )


class ProblemValidationTest(unittest.TestCase):
    def test_invalid_problems_rejected(self):
        bad_inputs = [
            {},
            {"variables": [], "constraints": []},
            {"variables": [{"name": "x"}], "constraints": []},
            {"variables": [{"name": "x", "domain": []}], "constraints": []},
            {"variables": [{"name": "x", "domain": [1]}, {"name": "x", "domain": [2]}],
             "constraints": []},
            {"variables": [{"name": "x", "domain": [1, 1]}], "constraints": []},
            {"variables": [{"name": "x", "domain": [1]}],
             "constraints": [{"id": 0, "scope": ["x", "y"], "relation": []}]},
            {"variables": [{"name": "x", "domain": [1]}],
             "constraints": [{"id": 0, "scope": ["x", "x"], "relation": []}]},
            {"variables": [{"name": "x", "domain": [1]}, {"name": "y", "domain": [1]}],
             "constraints": [{"id": -1, "scope": ["x", "y"], "relation": []}]},
            {"variables": [{"name": "x", "domain": [1]}, {"name": "y", "domain": [1]}],
             "constraints": [{"id": 0, "scope": ["x", "y"], "relation": []},
                             {"id": 0, "scope": ["x", "y"], "relation": []}]},
            {"variables": [{"name": "x", "domain": [1]}, {"name": "y", "domain": [1]}],
             "constraints": [{"id": 0, "scope": ["x", "y"], "relation": [[1]]}]},
        ]
        for data in bad_inputs:
            with self.assertRaises(ProblemError, msg="should reject: %r" % (data,)):
                parse_problem(data)

    def test_valid_problem_without_ids_uses_indices(self):
        data = {
            "variables": [{"name": "x", "domain": [1, 2]},
                          {"name": "y", "domain": [1, 2]}],
            "constraints": [{"scope": ["x", "y"], "relation": [[1, 1], [2, 2]]}],
        }
        variables, domains, constraints = parse_problem(data)
        self.assertEqual([c.cid for c in constraints], [0])


class CliTest(unittest.TestCase):
    def run_cli(self, *argv):
        return subprocess.run(
            [sys.executable, "-m", "csp_dynamic", *argv],
            capture_output=True,
            text=True,
            cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        )

    def write_problem(self, data):
        handle = tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False, encoding="utf-8"
        )
        json.dump(data, handle)
        handle.close()
        self.addCleanup(os.unlink, handle.name)
        return handle.name

    def test_cli_delete_success(self):
        problem = {
            "variables": [
                {"name": "x", "domain": [1, 2, 3]},
                {"name": "y", "domain": [2, 3]},
                {"name": "z", "domain": [1, 2, 3]},
            ],
            "constraints": [
                {"id": 0, "scope": ["x", "y"], "relation": [[1, 1], [2, 2], [3, 3]]},
                {"id": 1, "scope": ["y", "z"], "relation": [[1, 2], [1, 3], [2, 3]]},
            ],
        }
        path = self.write_problem(problem)
        proc = self.run_cli("delete", "--input", path, "--constraint-id", "1")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["domains"],
                         {"x": [2, 3], "y": [2, 3], "z": [1, 2, 3]})
        self.assertEqual(result["restored_values"],
                         {"x": [3], "y": [3], "z": [1, 2]})

    def test_cli_unknown_constraint_id(self):
        problem = {
            "variables": [{"name": "x", "domain": [1, 2]},
                          {"name": "y", "domain": [1, 2]}],
            "constraints": [{"id": 0, "scope": ["x", "y"],
                             "relation": [[1, 1], [2, 2]]}],
        }
        path = self.write_problem(problem)
        proc = self.run_cli("delete", "--input", path, "--constraint-id", "7")
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout, "")
        error = json.loads(proc.stderr)
        self.assertEqual(error["status"], "error")

    def test_cli_invalid_problem_file(self):
        path = self.write_problem({"variables": []})
        proc = self.run_cli("delete", "--input", path, "--constraint-id", "0")
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout, "")

    def test_cli_malformed_json(self):
        handle = tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False, encoding="utf-8"
        )
        handle.write("{not json")
        handle.close()
        self.addCleanup(os.unlink, handle.name)
        proc = self.run_cli("delete", "--input", handle.name, "--constraint-id", "0")
        self.assertNotEqual(proc.returncode, 0)

    def test_cli_negative_constraint_id_rejected(self):
        problem = {
            "variables": [{"name": "x", "domain": [1]},
                          {"name": "y", "domain": [1]}],
            "constraints": [],
        }
        path = self.write_problem(problem)
        proc = self.run_cli("delete", "--input", path, "--constraint-id", "-1")
        self.assertNotEqual(proc.returncode, 0)


if __name__ == "__main__":
    unittest.main()
