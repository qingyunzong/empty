import json
import os
import random
import subprocess
import sys
import tempfile
import unittest

from csp_dynamic import (
    ConstraintNotFound,
    DynamicCSP,
    ProblemError,
    parse_problem,
)


def reference_domains(problem, remaining_ids):
    """Naive reference: reload only the remaining constraints and run a full
    AC-3 propagation from the initial domains."""
    reduced = {
        "variables": problem["variables"],
        "constraints": [c for c in problem["constraints"] if c["id"] in remaining_ids],
    }
    return parse_problem(reduced).sorted_domains()


def sorted_domain_sets(csp):
    return {name: sorted(dom) for name, dom in csp.domains.items()}


class ThreeVariableProblemMixin:
    """x, y, z in {1,2,3}; c0: (x,y) diagonal-ish; c1: (y,z) diagonal."""

    def make_problem(self):
        return {
            "variables": {"x": [1, 2, 3], "y": [1, 2, 3], "z": [1, 2, 3]},
            "constraints": [
                {
                    "id": 0,
                    "scope": ["x", "y"],
                    "type": "allowed",
                    "tuples": [[1, 1], [2, 2]],
                },
                {
                    "id": 1,
                    "scope": ["y", "z"],
                    "type": "allowed",
                    "tuples": [[1, 1], [2, 2], [3, 3]],
                },
            ],
        }


class TestInitialPropagation(ThreeVariableProblemMixin, unittest.TestCase):
    def test_initial_ac3(self):
        csp = parse_problem(self.make_problem())
        self.assertEqual(
            sorted_domain_sets(csp), {"x": [1, 2], "y": [1, 2], "z": [1, 2]}
        )
        self.assertEqual(csp.status(), "ok")

    def test_removal_reasons_recorded(self):
        csp = parse_problem(self.make_problem())
        self.assertEqual(csp.justifications[("x", 3)], {0})
        self.assertEqual(csp.justifications[("y", 3)], {0})
        self.assertEqual(csp.justifications[("z", 3)], {1})


class TestDeleteMatchesNaiveReference(ThreeVariableProblemMixin, unittest.TestCase):
    def test_delete_one_of_two_constraints(self):
        problem = self.make_problem()
        csp = parse_problem(problem)
        restored = csp.delete_constraint(0)
        self.assertEqual(csp.sorted_domains(), reference_domains(problem, {1}))
        self.assertEqual(
            csp.sorted_domains(),
            {"x": [1, 2, 3], "y": [1, 2, 3], "z": [1, 2, 3]},
        )
        self.assertEqual(set(restored), {("x", 3), ("y", 3), ("z", 3)})

    def test_delete_other_constraint(self):
        problem = self.make_problem()
        csp = parse_problem(problem)
        csp.delete_constraint(1)
        self.assertEqual(csp.sorted_domains(), reference_domains(problem, {0}))
        self.assertEqual(
            csp.sorted_domains(), {"x": [1, 2], "y": [1, 2], "z": [1, 2, 3]}
        )


class TestDeleteInactiveConstraint(unittest.TestCase):
    def test_domains_unchanged_and_nothing_restored(self):
        problem = {
            "variables": {"x": [1, 2], "y": [1, 2]},
            "constraints": [
                {"id": 0, "scope": ["x", "y"], "tuples": [[1, 1], [2, 2]]},
                {"id": 1, "scope": ["x", "y"], "tuples": [[1, 2], [2, 1]]},
            ],
        }
        csp = parse_problem(problem)
        before = sorted_domain_sets(csp)
        restored = csp.delete_constraint(1)
        self.assertEqual(sorted_domain_sets(csp), before)
        self.assertEqual(restored, [])
        self.assertEqual(csp.sorted_domains(), reference_domains(problem, {0}))


class TestDeleteUnknownConstraint(ThreeVariableProblemMixin, unittest.TestCase):
    def test_library_raises_and_state_unchanged(self):
        csp = parse_problem(self.make_problem())
        before = sorted_domain_sets(csp)
        with self.assertRaises(ConstraintNotFound):
            csp.delete_constraint(99)
        self.assertEqual(sorted_domain_sets(csp), before)


class TestDeleteLastConstraint(unittest.TestCase):
    def test_domains_restore_to_initial(self):
        problem = {
            "variables": {"x": [1, 2, 3], "y": [1, 2, 3]},
            "constraints": [
                {"id": 0, "scope": ["x", "y"], "tuples": [[1, 1]]},
            ],
        }
        csp = parse_problem(problem)
        self.assertEqual(sorted_domain_sets(csp), {"x": [1], "y": [1]})
        restored = csp.delete_constraint(0)
        self.assertEqual(sorted_domain_sets(csp), {"x": [1, 2, 3], "y": [1, 2, 3]})
        self.assertEqual(csp.sorted_domains(), reference_domains(problem, set()))
        self.assertEqual(len(restored), 4)


class TestCascadedRestoration(unittest.TestCase):
    """Restoring a value must enable further restorations via propagation."""

    def test_chain_restoration(self):
        problem = {
            "variables": {"a": [1, 2], "b": [1, 2], "c": [1, 2]},
            "constraints": [
                {"id": 0, "scope": ["a", "b"], "tuples": [[1, 1]]},
                {"id": 1, "scope": ["b", "c"], "tuples": [[1, 1], [2, 2]]},
            ],
        }
        csp = parse_problem(problem)
        self.assertEqual(sorted_domain_sets(csp), {"a": [1], "b": [1], "c": [1]})
        csp.delete_constraint(0)
        self.assertEqual(csp.sorted_domains(), reference_domains(problem, {1}))
        self.assertEqual(
            sorted_domain_sets(csp), {"a": [1, 2], "b": [1, 2], "c": [1, 2]}
        )

    def test_mutually_supporting_values_restore_together(self):
        # x=1 and y=1 only support each other through c0; deleting c1
        # (which removed y=1) must let both come back.
        problem = {
            "variables": {"x": [1, 2], "y": [1, 2]},
            "constraints": [
                {"id": 0, "scope": ["x", "y"], "tuples": [[1, 1]]},
                {"id": 1, "scope": ["y"], "tuples": [[2]]},
            ],
        }
        csp = parse_problem(problem)
        self.assertEqual(sorted_domain_sets(csp), {"x": [], "y": []})
        csp.delete_constraint(1)
        self.assertEqual(csp.sorted_domains(), reference_domains(problem, {0}))
        self.assertEqual(sorted_domain_sets(csp), {"x": [1], "y": [1]})


class TestSharedSupport(unittest.TestCase):
    """A value unsupported by two constraints must stay removed when only
    one of them is deleted."""

    def test_other_constraint_still_supports_removal(self):
        problem = {
            "variables": {"x": [1, 2], "y": [1, 2]},
            "constraints": [
                {"id": 0, "scope": ["x", "y"], "tuples": [[1, 1], [1, 2]]},
                {"id": 1, "scope": ["x", "y"], "tuples": [[1, 1], [1, 2]]},
            ],
        }
        csp = parse_problem(problem)
        self.assertEqual(sorted_domain_sets(csp), {"x": [1], "y": [1, 2]})
        restored = csp.delete_constraint(0)
        self.assertEqual(restored, [])
        self.assertEqual(sorted_domain_sets(csp), {"x": [1], "y": [1, 2]})
        self.assertEqual(csp.sorted_domains(), reference_domains(problem, {1}))
        # The remaining constraint now owns the removal reason.
        self.assertEqual(csp.justifications[("x", 2)], {1})


class TestForbiddenConstraints(unittest.TestCase):
    def test_forbidden_type(self):
        problem = {
            "variables": {"x": [1, 2, 3], "y": [1, 2, 3]},
            "constraints": [
                {
                    "id": 0,
                    "scope": ["x", "y"],
                    "type": "forbidden",
                    "tuples": [[1, 2], [1, 3], [2, 2], [2, 3], [3, 2], [3, 3]],
                },
            ],
        }
        csp = parse_problem(problem)
        self.assertEqual(sorted_domain_sets(csp), {"x": [1, 2, 3], "y": [1]})
        csp.delete_constraint(0)
        self.assertEqual(csp.sorted_domains(), reference_domains(problem, set()))


class TestWipeoutRecovery(unittest.TestCase):
    """Domains emptied by propagation must recover correctly on deletion."""

    def test_inconsistent_problem_becomes_consistent(self):
        problem = {
            "variables": {"x": [1, 2], "y": [1, 2]},
            "constraints": [
                {"id": 0, "scope": ["x"], "tuples": [[1]]},
                {"id": 1, "scope": ["x", "y"], "tuples": [[2, 1]]},
            ],
        }
        csp = parse_problem(problem)
        self.assertEqual(csp.status(), "unsatisfiable")
        csp.delete_constraint(0)
        self.assertEqual(csp.sorted_domains(), reference_domains(problem, {1}))
        self.assertEqual(sorted_domain_sets(csp), {"x": [2], "y": [1]})


class TestRandomizedAgainstNaive(unittest.TestCase):
    def test_random_problems_match_naive_reference(self):
        rng = random.Random(20261004)
        for trial in range(60):
            names = ["a", "b", "c", "d"]
            variables = {n: [1, 2, 3] for n in names}
            constraints = []
            for cid in range(4):
                scope = rng.sample(names, rng.choice([1, 2]))
                domain_product = [
                    [u] if len(scope) == 1 else [u, v]
                    for u in variables[scope[0]]
                    for v in (variables[scope[1]] if len(scope) == 2 else [None])
                ]
                tuples = [t for t in domain_product if rng.random() < 0.6]
                constraints.append(
                    {
                        "id": cid,
                        "scope": scope,
                        "type": rng.choice(["allowed", "forbidden"]),
                        "tuples": tuples,
                    }
                )
            problem = {"variables": variables, "constraints": constraints}
            csp = parse_problem(problem)
            remaining = set(range(4))
            for cid in rng.sample(range(4), 4):
                csp.delete_constraint(cid)
                remaining.discard(cid)
                self.assertEqual(
                    csp.sorted_domains(),
                    reference_domains(problem, remaining),
                    msg=f"trial {trial}, deleted {cid}, remaining {remaining}",
                )
            self.assertEqual(
                sorted_domain_sets(csp), {n: sorted(d) for n, d in variables.items()}
            )


class TestInvalidProblems(unittest.TestCase):
    def test_rejects_non_object(self):
        with self.assertRaises(ProblemError):
            parse_problem([1, 2, 3])

    def test_rejects_empty_variables(self):
        with self.assertRaises(ProblemError):
            parse_problem({"variables": {}, "constraints": []})

    def test_rejects_unknown_variable_in_scope(self):
        with self.assertRaises(ProblemError):
            parse_problem(
                {
                    "variables": {"x": [1]},
                    "constraints": [{"id": 0, "scope": ["x", "y"], "tuples": []}],
                }
            )

    def test_rejects_bad_tuple_arity(self):
        with self.assertRaises(ProblemError):
            parse_problem(
                {
                    "variables": {"x": [1], "y": [1]},
                    "constraints": [{"id": 0, "scope": ["x", "y"], "tuples": [[1]]}],
                }
            )

    def test_rejects_duplicate_constraint_id(self):
        with self.assertRaises(ProblemError):
            parse_problem(
                {
                    "variables": {"x": [1]},
                    "constraints": [
                        {"id": 0, "scope": ["x"], "tuples": [[1]]},
                        {"id": 0, "scope": ["x"], "tuples": [[1]]},
                    ],
                }
            )

    def test_rejects_negative_constraint_id(self):
        with self.assertRaises(ProblemError):
            parse_problem(
                {
                    "variables": {"x": [1]},
                    "constraints": [{"id": -1, "scope": ["x"], "tuples": [[1]]}],
                }
            )


class TestCLI(ThreeVariableProblemMixin, unittest.TestCase):
    def run_cli(self, *argv):
        return subprocess.run(
            [sys.executable, "-m", "csp_dynamic", *argv],
            capture_output=True,
            text=True,
            cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        )

    def write_problem(self, problem):
        handle = tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False, encoding="utf-8"
        )
        with handle:
            json.dump(problem, handle)
        self.addCleanup(os.unlink, handle.name)
        return handle.name

    def test_delete_success(self):
        problem = self.make_problem()
        path = self.write_problem(problem)
        result = self.run_cli("delete", "--input", path, "--constraint-id", "0")
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual(output["status"], "ok")
        self.assertEqual(output["domains"], reference_domains(problem, {1}))
        self.assertEqual(
            {(r["variable"], r["value"]) for r in output["restored_values"]},
            {("x", 3), ("y", 3), ("z", 3)},
        )

    def test_delete_unknown_constraint_id(self):
        path = self.write_problem(self.make_problem())
        result = self.run_cli("delete", "--input", path, "--constraint-id", "42")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertEqual(json.loads(result.stderr)["status"], "error")

    def test_invalid_problem_file(self):
        handle = tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False, encoding="utf-8"
        )
        with handle:
            handle.write("{not json")
        self.addCleanup(os.unlink, handle.name)
        result = self.run_cli("delete", "--input", handle.name, "--constraint-id", "0")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stderr)["status"], "error")

    def test_negative_constraint_id(self):
        path = self.write_problem(self.make_problem())
        result = self.run_cli("delete", "--input", path, "--constraint-id", "-1")
        self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
