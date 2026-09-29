"""Acceptance tests A-D and CLI/error handling for cegen."""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from cegen import (
    COUNTEREXAMPLE,
    INVALID_INPUT,
    PROOF,
    UNKNOWN,
    PolicyError,
    parse_spec,
    search,
)

REPO_ROOT = Path(__file__).resolve().parent.parent


def run(spec, **kwargs):
    return search(parse_spec(spec, kwargs.get("default_bound", 3)),
                  max_steps=kwargs.get("max_steps"))


class TieBreakTests(unittest.TestCase):
    def test_A_lexicographically_smallest_tie(self):
        # Counterexamples with the same minimal cost 1 are (-1, 0) and
        # (0, -1); the lexicographically smaller one must be returned.
        spec = {
            "variables": [
                {"name": "x", "type": "int", "bound": 1},
                {"name": "y", "type": "int", "bound": 1},
            ],
            "predicate": "x + y >= 0",
        }
        result = run(spec)
        self.assertEqual(result.status, COUNTEREXAMPLE)
        self.assertEqual(result.counterexample, {"x": -1, "y": 0})
        self.assertEqual(result.stats["cost"], 1)
        self.assertEqual(result.stats["enumerated"], 2)

    def test_A_tie_with_bool_and_list_domains(self):
        # Declared order is (flag, n). At cost 1 the failing assignments are
        # (False, -1) and (True, -2); both cost 1, lex picks (False, -1).
        spec = {
            "variables": [
                {"name": "flag", "type": "bool"},
                {"name": "n", "type": "int", "bound": 2},
            ],
            "predicate": "n + (1 if flag else 0) >= 0",
        }
        result = run(spec)
        self.assertEqual(result.status, COUNTEREXAMPLE)
        self.assertEqual(result.counterexample, {"flag": False, "n": -1})

    def test_A_list_minimal_by_cost_then_lex(self):
        spec = {
            "variables": [{"name": "xs", "type": "list", "max_len": 2,
                           "elem": {"type": "int", "bound": 1}}],
            "predicate": "len(xs) >= 1",
        }
        result = run(spec)
        self.assertEqual(result.status, COUNTEREXAMPLE)
        # The empty list is the unique cost-0 assignment.
        self.assertEqual(result.counterexample, {"xs": []})


class ProofTests(unittest.TestCase):
    def test_B_proof_when_no_counterexample(self):
        spec = {
            "variables": [{"name": "x", "type": "int", "bound": 2}],
            "predicate": "x * x >= 0",
        }
        result = run(spec)
        self.assertEqual(result.status, PROOF)
        self.assertIsNone(result.counterexample)
        self.assertEqual(result.stats["enumerated"], 5)
        self.assertEqual(result.stats["space_size"], 5)
        self.assertTrue(result.stats["exhausted"])
        h = result.stats["closure_hash"]
        self.assertRegex(h, r"^[0-9a-f]{64}$")

    def test_B_closure_hash_is_deterministic_and_ordered(self):
        spec = {
            "variables": [
                {"name": "a", "type": "bool"},
                {"name": "b", "type": "bool"},
            ],
            "predicate": "a or not a",
        }
        h1 = run(spec).stats["closure_hash"]
        h2 = run(spec).stats["closure_hash"]
        self.assertEqual(h1, h2)
        # Reversing declaration order enumerates the same truth table in a
        # different canonical order, hence a different closure hash.
        spec_rev = {
            "variables": [
                {"name": "b", "type": "bool"},
                {"name": "a", "type": "bool"},
            ],
            "predicate": "a or not a",
        }
        self.assertNotEqual(h1, run(spec_rev).stats["closure_hash"])


class UnknownTests(unittest.TestCase):
    def test_C_unknown_is_not_a_proof(self):
        spec = {
            "variables": [{"name": "x", "type": "int", "bound": 2}],
            "predicate": "True",
        }
        result = run(spec, max_steps=2)
        self.assertEqual(result.status, UNKNOWN)
        self.assertNotEqual(result.status, PROOF)
        self.assertIsNone(result.counterexample)
        self.assertNotIn("closure_hash", result.stats)
        self.assertFalse(result.stats["exhausted"])
        self.assertEqual(result.stats["enumerated"], 2)

    def test_C_zero_budget_immediately_unknown(self):
        spec = {
            "variables": [{"name": "x", "type": "int", "bound": 1}],
            "predicate": "False",
        }
        result = run(spec, max_steps=0)
        self.assertEqual(result.status, UNKNOWN)
        self.assertEqual(result.stats["enumerated"], 0)

    def test_C_limit_larger_than_space_still_proves(self):
        spec = {
            "variables": [{"name": "x", "type": "int", "bound": 0}],
            "predicate": "x == 0",
        }
        result = run(spec, max_steps=100)
        self.assertEqual(result.status, PROOF)
        self.assertEqual(result.stats["enumerated"], 1)


class InvalidInputTests(unittest.TestCase):
    def test_D_predicate_division_error(self):
        spec = {
            "variables": [{"name": "x", "type": "int", "bound": 1}],
            "predicate": "1 / x > 0",
        }
        result = run(spec)
        self.assertEqual(result.status, INVALID_INPUT)
        self.assertIsNone(result.counterexample)
        self.assertEqual(result.stats["assignment"], {"x": 0})
        self.assertIn("ZeroDivisionError", result.stats["error"])
        self.assertEqual(result.stats["enumerated"], 1)

    def test_D_predicate_name_error_on_later_assignment(self):
        spec = {
            "variables": [{"name": "x", "type": "int", "bound": 1}],
            "predicate": "x == 0 or mystery(x) == 0",
        }
        result = run(spec)
        self.assertEqual(result.status, INVALID_INPUT)
        self.assertEqual(result.stats["assignment"], {"x": -1})

    def test_D_non_boolean_result_is_invalid_input(self):
        spec = {
            "variables": [{"name": "x", "type": "int", "bound": 1}],
            "predicate": "x",
        }
        self.assertEqual(run(spec).status, INVALID_INPUT)


class SpecValidationTests(unittest.TestCase):
    def test_unknown_domain_type(self):
        with self.assertRaises(PolicyError):
            parse_spec({"variables": [{"name": "x", "type": "float"}],
                        "predicate": "True"})

    def test_duplicate_and_bad_names(self):
        with self.assertRaises(PolicyError):
            parse_spec({
                "variables": [
                    {"name": "x", "type": "bool"},
                    {"name": "x", "type": "bool"},
                ],
                "predicate": "x",
            })
        with self.assertRaises(PolicyError):
            parse_spec({"variables": [{"name": "len", "type": "bool"}],
                        "predicate": "True"})

    def test_bad_bounds_and_lengths(self):
        with self.assertRaises(PolicyError):
            parse_spec({"variables": [{"name": "x", "type": "int",
                                       "bound": -1}], "predicate": "True"})
        with self.assertRaises(PolicyError):
            parse_spec({"variables": [{"name": "x", "type": "list",
                                       "max_len": -1,
                                       "elem": {"type": "bool"}}],
                        "predicate": "True"})

    def test_predicate_syntax_error_is_policy_error(self):
        with self.assertRaises(PolicyError):
            parse_spec({"variables": [], "predicate": "x +"})


class CliTests(unittest.TestCase):
    def _run_cli(self, spec, *args):
        with tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False
        ) as handle:
            json.dump(spec, handle)
            path = handle.name
        proc = subprocess.run(
            [sys.executable, "-m", "cegen", "find", path, *args],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )
        return proc

    def test_cli_counterexample(self):
        spec = {
            "variables": [{"name": "x", "type": "int"}],
            "predicate": "x > 0",
        }
        proc = self._run_cli(spec, "--bound", "1")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        data = json.loads(proc.stdout)
        self.assertEqual(set(data), {"status", "counterexample", "stats"})
        self.assertEqual(data["status"], COUNTEREXAMPLE)
        # Cost |x| is minimised first: x=0 (cost 0) beats x=-1 (cost 1).
        self.assertEqual(data["counterexample"], {"x": 0})
        self.assertEqual(data["stats"]["cost"], 0)

    def test_cli_proof(self):
        spec = {
            "variables": [{"name": "x", "type": "int"}],
            "predicate": "abs(x) >= 0",
        }
        proc = self._run_cli(spec, "--bound", "2")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout)["status"], PROOF)

    def test_cli_unknown(self):
        spec = {
            "variables": [{"name": "x", "type": "int"}],
            "predicate": "True",
        }
        proc = self._run_cli(spec, "--bound", "5", "--max-steps", "3")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        data = json.loads(proc.stdout)
        self.assertEqual(data["status"], UNKNOWN)
        self.assertEqual(data["stats"]["enumerated"], 3)

    def test_cli_invalid_input(self):
        spec = {
            "variables": [{"name": "x", "type": "int"}],
            "predicate": "1 // x == 1",
        }
        proc = self._run_cli(spec, "--bound", "1")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout)["status"], INVALID_INPUT)

    def test_cli_policy_error_exit_code(self):
        with tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False
        ) as handle:
            json.dump({"variables": [{"name": "x", "type": "real"}],
                       "predicate": "True"}, handle)
            path = handle.name
        proc = subprocess.run(
            [sys.executable, "-m", "cegen", "find", path, "--bound", "1"],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(json.loads(proc.stderr)["type"], "PolicyError")

    def test_cli_missing_file_exit_code(self):
        proc = subprocess.run(
            [sys.executable, "-m", "cegen", "find", "/no/such/spec.json"],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(json.loads(proc.stderr)["type"], "PolicyError")


if __name__ == "__main__":
    unittest.main()
