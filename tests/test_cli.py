import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def run_cli(command, payload):
    proc = subprocess.run(
        [sys.executable, "-m", "pathpolicy.cli", command],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    if proc.returncode != 0:
        raise AssertionError("cli failed: %s" % proc.stderr)
    return json.loads(proc.stdout)


class CliTests(unittest.TestCase):
    def test_normalize(self):
        out = run_cli("normalize", {"path": "a//./b/"})
        self.assertEqual(out, {"ok": True, "path": "a/b"})

    def test_normalize_rejects_root_escape(self):
        out = run_cli("normalize", {"path": "../escape"})
        self.assertFalse(out["ok"])
        self.assertIn("error", out)

    def test_match(self):
        out = run_cli("match", {"expr": "a/**", "path": "a/b/c"})
        self.assertTrue(out["ok"])
        self.assertTrue(out["match"])
        self.assertEqual(out["normalized"], "a/b/c")
        out = run_cli(
            "match",
            {"expr": {"allow": ["**"], "deny": ["secret/**"]}, "path": "secret/k"},
        )
        self.assertFalse(out["match"])

    def test_check_equivalent_with_proof_roundtrip(self):
        out = run_cli(
            "check",
            {"a": "a/[bc]", "b": {"union": ["a/b", "a/c"]}},
        )
        self.assertTrue(out["ok"])
        self.assertIs(out["equivalent"], True)
        self.assertEqual(out["a_subset_b"]["status"], "included")
        proof = out["a_subset_b"]["proof"]
        verdict = run_cli(
            "verify",
            {"a": "a/[bc]", "b": {"union": ["a/b", "a/c"]}, "proof": proof},
        )
        self.assertTrue(verdict["ok"])
        self.assertIs(verdict["valid"], True)

    def test_check_not_included_witness(self):
        out = run_cli("check", {"a": "a/**", "b": "a/b"})
        self.assertIs(out["equivalent"], False)
        self.assertEqual(out["a_subset_b"]["status"], "not_included")
        self.assertEqual(out["a_subset_b"]["witness"], "a")
        self.assertTrue(out["a_subset_b"]["witness_verified"])

    def test_diff_all_shortest(self):
        out = run_cli(
            "diff",
            {"a": {"union": ["a/x", "a/y"]}, "b": "a/z", "all_shortest": True},
        )
        self.assertTrue(out["ok"])
        self.assertEqual(out["status"], "nonempty")
        self.assertEqual(sorted(out["witnesses"]), ["a/x", "a/y"])

    def test_budget_exhaustion_returns_unknown(self):
        out = run_cli("check", {"a": "a/b/c", "b": "a/**", "budget": 1})
        self.assertTrue(out["ok"])
        self.assertIsNone(out["equivalent"])
        self.assertEqual(out["a_subset_b"]["status"], "unknown")
        self.assertTrue(out["a_subset_b"]["frontier"])

    def test_enumerate(self):
        out = run_cli(
            "enumerate", {"expr": "a/**/b", "names": ["a", "b"], "depth": 3}
        )
        self.assertTrue(out["ok"])
        self.assertEqual(out["checked"], 1 + 2 + 4 + 8)
        self.assertEqual(out["mismatches"], [])

    def test_invalid_expression_reported_as_json(self):
        out = run_cli("match", {"expr": "a//b", "path": "a/b"})
        self.assertFalse(out["ok"])
        self.assertIn("error", out)


if __name__ == "__main__":
    unittest.main()
