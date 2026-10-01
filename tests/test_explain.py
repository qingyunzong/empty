"""Tests for the 1-UIP conflict explanation library and CLI."""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from csp_explain import AnalysisError, ValidationError, generate_explanation, parse_model
from csp_explain.reference import enumerate_first_uip

REPO_ROOT = Path(__file__).resolve().parent.parent
EXAMPLES = REPO_ROOT / "examples"


def load_example(name: str) -> dict:
    with open(EXAMPLES / name, "r", encoding="utf-8") as handle:
        return json.load(handle)


def clause_keys(explanation) -> set:
    return {(lit.kind, lit.variable, lit.value, lit.level) for lit in explanation.clause}


class ThreeVariableChainTest(unittest.TestCase):
    """Scenario 1: fixed propagation chain over three variables x, y, z."""

    @classmethod
    def setUpClass(cls):
        cls.model = parse_model(load_example("conflict_3var.json"))
        cls.explanation = generate_explanation(cls.model)

    def test_clause_contents(self):
        self.assertEqual(
            clause_keys(self.explanation),
            {("removed", "z", 1, 2), ("removed", "y", 2, 1)},
        )

    def test_backjump_level(self):
        self.assertEqual(self.explanation.backjump_level, 1)
        self.assertFalse(self.explanation.unsatisfiable)

    def test_matches_naive_cut_enumeration(self):
        reference = enumerate_first_uip(self.model)
        self.assertEqual(clause_keys(self.explanation), clause_keys(reference))
        self.assertEqual(self.explanation.backjump_level, reference.backjump_level)


class LevelZeroConflictTest(unittest.TestCase):
    """Scenario 2: conflict caused entirely by level-0 propagation."""

    def test_empty_clause_and_unsat(self):
        model = parse_model(load_example("conflict_level0.json"))
        explanation = generate_explanation(model)
        self.assertEqual(explanation.clause, [])
        self.assertEqual(explanation.backjump_level, -1)
        self.assertTrue(explanation.unsatisfiable)

    def test_reference_agrees(self):
        model = parse_model(load_example("conflict_level0.json"))
        reference = enumerate_first_uip(model)
        self.assertEqual(reference.clause, [])
        self.assertEqual(reference.backjump_level, -1)
        self.assertTrue(reference.unsatisfiable)


class BrokenRecordTest(unittest.TestCase):
    """Scenario 3: malformed implication records are rejected."""

    def test_unknown_variable_reference(self):
        with self.assertRaises(ValidationError):
            parse_model(load_example("broken_unknown_variable.json"))

    def test_unknown_decision_reference(self):
        data = load_example("conflict_3var.json")
        data["implications"][0]["antecedents"] = [
            {"variable": "x", "value": 7, "kind": "assigned"}
        ]
        with self.assertRaises(ValidationError):
            parse_model(data)

    def test_unknown_removal_reference(self):
        data = load_example("conflict_3var.json")
        data["conflict"]["antecedents"] = [
            {"variable": "z", "value": 9, "kind": "removed"}
        ]
        with self.assertRaises(ValidationError):
            parse_model(data)

    def test_missing_conflict_state(self):
        data = load_example("conflict_3var.json")
        del data["conflict"]
        with self.assertRaises(ValidationError):
            parse_model(data)

    def test_cyclic_implication_log_rejected(self):
        data = {
            "decisions": [{"variable": "x", "value": 1, "level": 1}],
            "implications": [
                {"variable": "y", "value": 1, "level": 1,
                 "antecedents": [{"variable": "y", "value": 2, "kind": "removed"}]},
                {"variable": "y", "value": 2, "level": 1,
                 "antecedents": [{"variable": "x", "value": 1, "kind": "assigned"}]},
            ],
            "conflict": {"level": 1,
                         "antecedents": [{"variable": "y", "value": 1, "kind": "removed"}]},
        }
        with self.assertRaises(ValidationError):
            parse_model(data)


class MultilevelConflictTest(unittest.TestCase):
    """Scenario 4: multi-level conflict, backjump to highest external level."""

    @classmethod
    def setUpClass(cls):
        cls.model = parse_model(load_example("conflict_multilevel.json"))
        cls.explanation = generate_explanation(cls.model)

    def test_backjump_is_highest_external_level(self):
        # Clause literals outside the conflict level sit at levels 1 and 2,
        # so the search must jump straight to level 2 (not step back to 3).
        self.assertEqual(self.explanation.backjump_level, 2)

    def test_clause_contents(self):
        self.assertEqual(
            clause_keys(self.explanation),
            {
                ("assigned", "v", 1, 4),
                ("removed", "w", 1, 2),
                ("removed", "y", 1, 1),
            },
        )

    def test_no_irrelevant_decisions(self):
        variables = {lit.variable for lit in self.explanation.clause}
        self.assertNotIn("d", variables)  # unrelated decision at level 3
        self.assertNotIn("z", variables)  # only its consequence w!=1 is needed
        self.assertNotIn("x", variables)  # only its consequence y!=1 is needed

    def test_matches_naive_cut_enumeration(self):
        reference = enumerate_first_uip(self.model)
        self.assertEqual(clause_keys(self.explanation), clause_keys(reference))
        self.assertEqual(self.explanation.backjump_level, reference.backjump_level)


class CliTest(unittest.TestCase):
    def run_cli(self, *argv) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, "-m", "csp_explain", *argv],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )

    def test_generate_success(self):
        result = self.run_cli(
            "generate", "--input", str(EXAMPLES / "conflict_3var.json")
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertIn("clause", payload)
        self.assertIn("backjump_level", payload)
        self.assertEqual(payload["backjump_level"], 1)
        self.assertEqual(
            {(l["kind"], l["variable"], l["value"], l["level"]) for l in payload["clause"]},
            {("removed", "z", 1, 2), ("removed", "y", 2, 1)},
        )

    def test_generate_level0_unsat(self):
        result = self.run_cli(
            "generate", "--input", str(EXAMPLES / "conflict_level0.json")
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["clause"], [])
        self.assertEqual(payload["backjump_level"], -1)
        self.assertTrue(payload["unsatisfiable"])

    def test_generate_multilevel_backjump(self):
        result = self.run_cli(
            "generate", "--input", str(EXAMPLES / "conflict_multilevel.json")
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["backjump_level"], 2)

    def test_broken_record_nonzero_exit(self):
        result = self.run_cli(
            "generate", "--input", str(EXAMPLES / "broken_unknown_variable.json")
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("error", result.stderr)

    def test_missing_conflict_nonzero_exit(self):
        data = load_example("conflict_3var.json")
        del data["conflict"]
        with tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False, encoding="utf-8"
        ) as handle:
            json.dump(data, handle)
            path = handle.name
        try:
            result = self.run_cli("generate", "--input", path)
        finally:
            Path(path).unlink()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("conflict", result.stderr)

    def test_missing_input_file_nonzero_exit(self):
        result = self.run_cli("generate", "--input", "does_not_exist.json")
        self.assertNotEqual(result.returncode, 0)

    def test_output_option(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "explanation.json"
            result = self.run_cli(
                "generate",
                "--input", str(EXAMPLES / "conflict_multilevel.json"),
                "--output", str(out),
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(payload["backjump_level"], 2)


if __name__ == "__main__":
    unittest.main()
