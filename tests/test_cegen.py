"""Acceptance tests A-D plus CLI and PolicyError behaviour."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from cegen import (COUNTEREXAMPLE, INVALID_INPUT, PROOF, UNKNOWN,
                   PolicyError, find)

ROOT = Path(__file__).resolve().parent.parent


def run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "cegen", *args],
        capture_output=True, text=True, cwd=ROOT,
    )


def write_spec(spec):
    tmp = tempfile.NamedTemporaryFile(
        "w", suffix=".json", delete=False, encoding="utf-8")
    json.dump(spec, tmp)
    tmp.close()
    return tmp.name


class AcceptanceA(unittest.TestCase):
    """A: tied minimal counterexamples -> lexicographically smallest."""

    def test_tied_minima_returns_lex_smallest(self):
        # x*y == 1 has exactly two minima of cost 2: (-1,-1) and (1,1).
        # Canonical int order is 0,-1,1 so (-1,-1) is lexicographically first.
        spec = {
            "variables": [
                {"name": "x", "type": "int"},
                {"name": "y", "type": "int"},
            ],
            "predicate": "x * y != 1",
            "bound": 1,
        }
        result = find(spec)
        self.assertEqual(result["status"], COUNTEREXAMPLE)
        self.assertEqual(result["counterexample"], {"x": -1, "y": -1})

    def test_tied_minima_cli(self):
        path = write_spec({
            "variables": [
                {"name": "x", "type": "int"},
                {"name": "y", "type": "int"},
            ],
            "predicate": "x * y != 1",
            "bound": 1,
        })
        proc = run_cli("find", path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertEqual(payload["status"], COUNTEREXAMPLE)
        self.assertEqual(payload["counterexample"], {"x": -1, "y": -1})

    def test_minimality_prefers_lower_cost(self):
        # (0, anything) falsifies at cost 0; must be returned before costlier ones.
        spec = {
            "variables": [
                {"name": "x", "type": "int"},
                {"name": "b", "type": "bool"},
            ],
            "predicate": "x != 0",
            "bound": 2,
        }
        result = find(spec)
        self.assertEqual(result["status"], COUNTEREXAMPLE)
        self.assertEqual(result["counterexample"], {"x": 0, "b": False})


class AcceptanceB(unittest.TestCase):
    """B: no counterexample within the bound -> PROOF with closure hash."""

    def test_proof_with_closure_hash(self):
        spec = {
            "variables": [{"name": "x", "type": "int"}],
            "predicate": "x * x >= 0",
        }
        result = find(spec, bound=6)
        self.assertEqual(result["status"], PROOF)
        self.assertIsNone(result["counterexample"])
        self.assertEqual(result["stats"]["enumerated"], 13)  # [-6, 6]
        digest = result["stats"]["closure_hash"]
        self.assertEqual(len(digest), 64)
        int(digest, 16)  # valid hex

    def test_proof_is_deterministic(self):
        spec = {
            "variables": [
                {"name": "x", "type": "int"},
                {"name": "xs", "type": "list", "max_len": 1},
            ],
            "predicate": "len(xs) <= 1 and x + x == 2 * x",
            "bound": 2,
        }
        first = find(spec)
        second = find(spec)
        self.assertEqual(first["status"], PROOF)
        self.assertEqual(first["stats"]["closure_hash"],
                         second["stats"]["closure_hash"])

    def test_proof_cli(self):
        path = write_spec({
            "variables": [{"name": "x", "type": "int"}],
            "predicate": "x * x >= 0",
        })
        proc = run_cli("find", path, "--bound", "6")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertEqual(payload["status"], PROOF)
        self.assertIn("closure_hash", payload["stats"])
        self.assertEqual(
            set(payload), {"status", "counterexample", "stats"})


class AcceptanceC(unittest.TestCase):
    """C: resource limit -> UNKNOWN, never claimed safe."""

    def test_unknown_on_limit(self):
        spec = {
            "variables": [{"name": "x", "type": "int"}],
            "predicate": "x * x >= 0",  # actually true everywhere
        }
        result = find(spec, bound=6, max_enumerated=5)
        self.assertEqual(result["status"], UNKNOWN)
        self.assertIsNone(result["counterexample"])
        self.assertEqual(result["stats"]["enumerated"], 5)
        self.assertEqual(result["stats"]["limit"], 5)
        # UNKNOWN must not look like a proof of safety.
        self.assertNotIn("closure_hash", result["stats"])
        self.assertFalse(result["stats"]["exhausted"])

    def test_unknown_cli(self):
        path = write_spec({
            "variables": [{"name": "x", "type": "int"}],
            "predicate": "x * x >= 0",
        })
        proc = run_cli("find", path, "--bound", "6", "--max-enumerated", "5")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertEqual(payload["status"], UNKNOWN)
        self.assertNotIn("closure_hash", payload["stats"])
        self.assertNotIn("PROOF", proc.stdout)
        self.assertNotIn("safe", proc.stdout.lower())

    def test_limit_larger_than_space_still_proves(self):
        spec = {
            "variables": [{"name": "x", "type": "int"}],
            "predicate": "x * x >= 0",
        }
        result = find(spec, bound=1, max_enumerated=100)
        self.assertEqual(result["status"], PROOF)


class AcceptanceD(unittest.TestCase):
    """D: predicate raising -> INVALID_INPUT, not a counterexample."""

    def test_predicate_exception_is_invalid_input(self):
        spec = {
            "variables": [{"name": "xs", "type": "list", "max_len": 1}],
            "predicate": "xs[0] > 0",  # IndexError on the empty list
            "bound": 1,
        }
        result = find(spec)
        self.assertEqual(result["status"], INVALID_INPUT)
        self.assertIsNone(result["counterexample"])

    def test_division_by_zero(self):
        spec = {
            "variables": [{"name": "x", "type": "int"}],
            "predicate": "10 % x >= 0",
            "bound": 2,
        }
        result = find(spec)
        self.assertEqual(result["status"], INVALID_INPUT)

    def test_undefined_name(self):
        spec = {
            "variables": [{"name": "x", "type": "int"}],
            "predicate": "y > 0",
            "bound": 1,
        }
        result = find(spec)
        self.assertEqual(result["status"], INVALID_INPUT)

    def test_invalid_input_cli(self):
        path = write_spec({
            "variables": [{"name": "xs", "type": "list", "max_len": 1}],
            "predicate": "xs[0] > 0",
        })
        proc = run_cli("find", path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertEqual(payload["status"], INVALID_INPUT)
        self.assertIsNone(payload["counterexample"])


class PolicyErrorTests(unittest.TestCase):
    def test_missing_file_exit_2(self):
        proc = run_cli("find", "/no/such/spec.json")
        self.assertEqual(proc.returncode, 2)
        self.assertIn("PolicyError", proc.stderr)

    def test_invalid_json_exit_2(self):
        tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        tmp.write("{not json")
        tmp.close()
        proc = run_cli("find", tmp.name)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("PolicyError", proc.stderr)

    def test_bad_spec_exit_2(self):
        path = write_spec({"variables": [{"name": "x", "type": "real"}],
                           "predicate": "True"})
        proc = run_cli("find", path)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("PolicyError", proc.stderr)

    def test_bad_predicate_syntax_exit_2(self):
        path = write_spec({"variables": [], "predicate": "x >="})
        proc = run_cli("find", path)
        self.assertEqual(proc.returncode, 2)

    def test_find_raises_policy_error(self):
        with self.assertRaises(PolicyError):
            find({"variables": [{"name": "1bad", "type": "int"}],
                  "predicate": "True"})
        with self.assertRaises(PolicyError):
            find({"variables": [], "predicate": ""})


class DomainOrderTests(unittest.TestCase):
    def test_int_canonical_order(self):
        from cegen.domains import build_domain
        domain = build_domain("x", {"type": "int"}, 2, 0)
        self.assertEqual(domain.values, (0, -1, 1, -2, 2))
        self.assertEqual(domain.costs, (0, 1, 1, 2, 2))

    def test_list_canonical_order(self):
        from cegen.domains import build_domain
        domain = build_domain("xs", {"type": "list", "max_len": 2}, 1, 2)
        self.assertEqual(
            domain.values,
            ((), (0,), (0, 0), (-1,), (1,), (0, -1), (0, 1), (-1, 0),
             (1, 0), (-1, -1), (-1, 1), (1, -1), (1, 1)),
        )
        self.assertEqual(domain.costs,
                         (0, 1, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4))


if __name__ == "__main__":
    unittest.main()
