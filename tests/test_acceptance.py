"""Acceptance tests required by the task specification."""

import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from fdsolver import (
    Searcher,
    Solver,
    SpecError,
    check_witness,
    solve,
    verify_unsat,
)

ROOT = Path(__file__).resolve().parent.parent

HALL = {
    "variables": {"a": [1, 2], "b": [1, 2], "c": [1, 2, 3]},
    "constraints": [{"type": "alldifferent", "scope": ["a", "b", "c"]}],
}

PAIRWISE_UNSAT = {
    "variables": {"x": [1, 2], "y": [1, 2], "z": [1, 2]},
    "constraints": [
        {"type": "table", "scope": ["x", "y"], "tuples": [[1, 2], [2, 1]]},
        {"type": "table", "scope": ["x", "z"], "tuples": [[1, 2], [2, 1]]},
        {"type": "table", "scope": ["y", "z"], "tuples": [[1, 2], [2, 1]]},
    ],
}


def run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "fdsolver", *args],
        cwd=ROOT, capture_output=True, text=True,
    )


class HallSetTest(unittest.TestCase):
    def test_hall_set_forces_third_variable(self):
        solver = Solver.from_spec(HALL)
        self.assertTrue(solver.propagate())
        self.assertEqual(solver.domains["a"], {1, 2})
        self.assertEqual(solver.domains["b"], {1, 2})
        self.assertEqual(solver.domains["c"], {3})

    def test_hall_violation_detected(self):
        spec = {
            "variables": {"a": [1, 2], "b": [1, 2], "c": [1, 2]},
            "constraints": [{"type": "alldifferent", "scope": ["a", "b", "c"]}],
        }
        solver = Solver.from_spec(spec)
        self.assertFalse(solver.propagate())


class ArcConsistencyNotEnoughTest(unittest.TestCase):
    def test_pairwise_neq_is_arc_consistent_but_globally_unsat(self):
        solver = Solver.from_spec(PAIRWISE_UNSAT)
        # Propagation keeps every domain: the network is arc consistent.
        self.assertTrue(solver.propagate())
        for name in ("x", "y", "z"):
            self.assertEqual(solver.domains[name], {1, 2})
        # ... yet no global solution exists.
        result = solve(PAIRWISE_UNSAT)
        self.assertEqual(result["status"], "unsat")
        self.assertTrue(verify_unsat(PAIRWISE_UNSAT, result["certificate"]))


class RollbackTest(unittest.TestCase):
    def test_two_level_rollback_restores_domains(self):
        solver = Solver.from_spec({
            "variables": {"a": [1, 2], "b": [1, 2], "c": [1, 2, 3]},
            "constraints": [],
        })
        base = solver.snapshot()
        solver.push()
        solver.assign("c", 3)
        level1 = solver.snapshot()
        solver.push()
        solver.add_alldifferent(["a", "b", "c"])
        self.assertTrue(solver.propagate())
        self.assertEqual(solver.domains["a"], {1, 2})
        solver.assign("a", 1)
        self.assertTrue(solver.propagate())
        self.assertEqual(solver.domains["b"], {2})
        solver.pop()
        self.assertEqual(solver.snapshot(), level1)
        solver.pop()
        self.assertEqual(solver.snapshot(), base)

    def test_retracting_alldifferent_restores_pruned_values(self):
        solver = Solver.from_spec({
            "variables": {"a": [1, 2], "b": [1, 2], "c": [1, 2, 3]},
            "constraints": [],
        })
        solver.push()
        solver.add_alldifferent(["a", "b", "c"])
        self.assertTrue(solver.propagate())
        self.assertEqual(solver.domains["c"], {3})
        solver.pop()
        self.assertEqual(solver.domains["c"], {1, 2, 3})
        self.assertEqual(solver.constraints, [])

    def test_table_supports_restored_on_pop(self):
        solver = Solver.from_spec({
            "variables": {"x": [1, 2], "y": [1, 2]},
            "constraints": [
                {"type": "table", "scope": ["x", "y"],
                 "tuples": [[1, 1], [1, 2], [2, 2]]},
            ],
        })
        table = solver.constraints[0]
        self.assertTrue(solver.propagate())
        valid_before = set(table.valid)
        solver.push()
        solver.assign("x", 2)
        self.assertTrue(solver.propagate())
        self.assertNotEqual(set(table.valid), valid_before)
        solver.pop()
        self.assertEqual(set(table.valid), valid_before)
        self.assertEqual(solver.domains["x"], {1, 2})
        # Re-propagating after undo reaches the same fixpoint as a fresh run.
        fresh = Solver.from_spec(solver.to_spec())
        self.assertTrue(solver.propagate())
        self.assertTrue(fresh.propagate())
        self.assertEqual(solver.snapshot(), fresh.snapshot())


class AtomicRejectionTest(unittest.TestCase):
    def test_bad_references_and_duplicates_rejected_atomically(self):
        solver = Solver.from_spec(HALL)
        before = solver.to_spec()
        with self.assertRaises(SpecError):
            solver.add_alldifferent(["a", "a", "b"])
        with self.assertRaises(SpecError):
            solver.add_alldifferent(["a", "missing"])
        with self.assertRaises(SpecError):
            solver.add_table(["a", "nope"], [[1, 2]])
        with self.assertRaises(SpecError):
            solver.add_table(["a"], [["not-an-int"]])
        with self.assertRaises(SpecError):
            solver.add_variable("a", [9])
        with self.assertRaises(SpecError):
            solver.add_variable("new", [])
        self.assertEqual(solver.to_spec(), before)


class PausableSearchTest(unittest.TestCase):
    SPECS = [
        ("sat", {
            "variables": {"p": [1, 2, 3], "q": [1, 2, 3], "r": [1, 2, 3]},
            "constraints": [
                {"type": "alldifferent", "scope": ["p", "q", "r"]},
                {"type": "table", "scope": ["p", "q"],
                 "tuples": [[1, 2], [2, 3], [3, 1]]},
            ],
        }),
        ("unsat", PAIRWISE_UNSAT),
    ]

    def _run_one_node_at_a_time(self, spec):
        state = None
        while True:
            if state is None:
                searcher = Searcher(spec)
            else:
                # round-trip through JSON to prove serialisability
                state = json.loads(json.dumps(state))
                searcher = Searcher.from_state(spec, state)
            result = searcher.run(budget=searcher.nodes + 1)
            if result["status"] == "unknown":
                state = result["state"]
                continue
            return result

    def test_incremental_matches_continuous(self):
        for name, spec in self.SPECS:
            with self.subTest(name=name):
                continuous = Searcher(spec).run()
                incremental = self._run_one_node_at_a_time(spec)
                self.assertEqual(continuous["status"], incremental["status"])
                self.assertEqual(continuous["witness"], incremental["witness"])
                self.assertEqual(
                    continuous["certificate"], incremental["certificate"])
                self.assertEqual(
                    continuous["stats"]["nodes"], incremental["stats"]["nodes"])

    def test_budget_exhaustion_only_unknown(self):
        result = solve(self.SPECS[0][1], budget=1)
        self.assertEqual(result["status"], "unknown")
        self.assertIsNotNone(result["state"])
        self.assertIsNone(result["witness"])
        self.assertIsNone(result["certificate"])

    def test_tampered_state_rejected(self):
        result = solve(self.SPECS[0][1], budget=1)
        state = result["state"]
        state["frames"][0]["current"] = 99
        with self.assertRaises(SpecError):
            Searcher.from_state(self.SPECS[0][1], state)


class CertificateTest(unittest.TestCase):
    def test_unsat_certificate_verifies_independently(self):
        result = solve(PAIRWISE_UNSAT)
        self.assertEqual(result["status"], "unsat")
        self.assertTrue(verify_unsat(PAIRWISE_UNSAT, result["certificate"]))

    def test_tampered_certificates_fail(self):
        result = solve(PAIRWISE_UNSAT)
        cert = result["certificate"]

        changed_value = copy.deepcopy(cert)
        changed_value["children"]["9"] = changed_value["children"].pop("1")
        self.assertFalse(verify_unsat(PAIRWISE_UNSAT, changed_value))

        missing_branch = copy.deepcopy(cert)
        del missing_branch["children"]["2"]
        self.assertFalse(verify_unsat(PAIRWISE_UNSAT, missing_branch))

        wrong_var = copy.deepcopy(cert)
        wrong_var["var"] = "unknown_variable"
        self.assertFalse(verify_unsat(PAIRWISE_UNSAT, wrong_var))

        fake_leaf = copy.deepcopy(cert)
        fake_leaf["children"]["1"] = {"conflict": False}
        self.assertFalse(verify_unsat(PAIRWISE_UNSAT, fake_leaf))

        relaxed_leaf = copy.deepcopy(cert)
        relaxed_leaf["children"]["1"] = {"var": "y", "children": {"1": {"conflict": True}, "2": {"conflict": True}}}
        self.assertFalse(verify_unsat(PAIRWISE_UNSAT, relaxed_leaf))

        self.assertFalse(verify_unsat(PAIRWISE_UNSAT, {"conflict": True}))
        self.assertFalse(verify_unsat(PAIRWISE_UNSAT, None))

    def test_witness_checking(self):
        result = solve(HALL)
        self.assertEqual(result["status"], "sat")
        self.assertTrue(check_witness(HALL, result["witness"]))
        bad = dict(result["witness"])
        bad["c"] = 1
        self.assertFalse(check_witness(HALL, bad))
        incomplete = dict(result["witness"])
        del incomplete["a"]
        self.assertFalse(check_witness(HALL, incomplete))


class DeterminismTest(unittest.TestCase):
    def test_json_output_is_sorted_and_deterministic(self):
        outputs = set()
        for _ in range(2):
            proc = run_cli("solve", "examples/send_more_money.json")
            self.assertEqual(proc.returncode, 0, proc.stderr)
            outputs.add(proc.stdout)
        self.assertEqual(len(outputs), 1)
        text = outputs.pop()
        parsed = json.loads(text)
        self.assertEqual(list(parsed), sorted(parsed))
        self.assertEqual(list(parsed["witness"]), sorted(parsed["witness"]))
        self.assertEqual(text, json.dumps(parsed, indent=2, sort_keys=True) + "\n")


class CliTest(unittest.TestCase):
    def test_solve_sat_and_check_witness(self):
        proc = run_cli("solve", "examples/hall.json")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertEqual(result["status"], "sat")
        with tempfile.TemporaryDirectory() as tmp:
            witness = Path(tmp) / "witness.json"
            witness.write_text(json.dumps(result["witness"]))
            proc = run_cli("check", "examples/hall.json", str(witness))
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertTrue(json.loads(proc.stdout)["valid"])

    def test_solve_unsat_and_verify_certificate(self):
        proc = run_cli("solve", "examples/pairwise_unsat.json")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertEqual(result["status"], "unsat")
        with tempfile.TemporaryDirectory() as tmp:
            cert = Path(tmp) / "cert.json"
            cert.write_text(json.dumps(result["certificate"]))
            proc = run_cli("verify", "examples/pairwise_unsat.json", str(cert))
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertTrue(json.loads(proc.stdout)["valid"])
            # tampered certificate must fail
            tampered = json.loads(cert.read_text())
            tampered["children"]["1"] = {"conflict": False}
            cert.write_text(json.dumps(tampered))
            proc = run_cli("verify", "examples/pairwise_unsat.json", str(cert))
            self.assertEqual(proc.returncode, 1)
            self.assertFalse(json.loads(proc.stdout)["valid"])

    def test_budget_save_and_resume(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "state.json"
            proc = run_cli("solve", "examples/send_more_money.json",
                           "--budget", "3", "--save-state", str(state))
            self.assertEqual(proc.returncode, 0, proc.stderr)
            result = json.loads(proc.stdout)
            self.assertEqual(result["status"], "unknown")
            self.assertTrue(state.exists())
            proc = run_cli("solve", "examples/send_more_money.json",
                           "--resume", str(state))
            self.assertEqual(proc.returncode, 0, proc.stderr)
            resumed = json.loads(proc.stdout)
            continuous = json.loads(
                run_cli("solve", "examples/send_more_money.json").stdout)
            self.assertEqual(resumed["status"], continuous["status"])
            self.assertEqual(resumed["witness"], continuous["witness"])

    def test_bad_problem_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / "bad.json"
            bad.write_text(json.dumps({
                "variables": {"a": [1]},
                "constraints": [{"type": "alldifferent", "scope": ["a", "a"]}],
            }))
            proc = run_cli("solve", str(bad))
            self.assertEqual(proc.returncode, 2)
            self.assertIn("error", json.loads(proc.stderr))


if __name__ == "__main__":
    unittest.main()
