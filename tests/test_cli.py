import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest

from mcfcert.cli import main

from helpers import diamond, infeasible_network, tie_network

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

GOOD_CERT = {
    "flows": {"e_sa": 4, "e_at": 4, "e_sb": 0, "e_bt": 0},
    "potentials": {"s": 0, "a": 1, "b": 3, "t": 2},
    "declared_cost": 8,
}
BAD_CERT = {
    "flows": {"e_sa": 4, "e_at": 4, "e_sb": 0, "e_bt": 0},
    "potentials": {"s": 0, "a": 1, "b": 3, "t": 0},
    "declared_cost": 9,
}
BROKEN_FLOWS = {"flows": {"e_sa": 2, "e_at": 2, "e_sb": 2, "e_bt": 2}}


class CliTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.net_path = self._write("network.json", diamond().to_dict())
        self.good_path = self._write("good.json", GOOD_CERT)
        self.bad_path = self._write("bad.json", BAD_CERT)

    def _write(self, name, payload):
        path = os.path.join(self.tmp.name, name)
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
        return path

    def _run(self, argv):
        stdout = io.StringIO()
        stderr = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = main(argv)
        out = stdout.getvalue()
        return code, json.loads(out) if out.strip() else None, stderr.getvalue()

    def test_verify_valid_certificate_exits_zero(self):
        code, verdict, _ = self._run(["verify", self.net_path, self.good_path])
        self.assertEqual(code, 0)
        self.assertTrue(verdict["valid"])

    def test_verify_invalid_certificate_exits_one(self):
        code, verdict, _ = self._run(["verify", self.net_path, self.bad_path])
        self.assertEqual(code, 1)
        self.assertFalse(verdict["valid"])
        self.assertFalse(verdict["checks"]["reduced_costs"]["ok"])
        self.assertFalse(verdict["checks"]["cost"]["ok"])

    def test_repair_optimal_exits_zero(self):
        net_path = self._write("tie.json", tie_network().to_dict())
        code, result, _ = self._run(["repair", net_path, self._write("broken.json", BROKEN_FLOWS)])
        self.assertEqual(code, 0)
        self.assertEqual(result["status"], "optimal")
        self.assertTrue(result["optimal"])
        self.assertEqual(result["cost"], 4)

    def test_repair_budget_exhausted_exits_two(self):
        net_path = self._write("tie.json", tie_network().to_dict())
        code, result, _ = self._run(
            ["repair", net_path, self._write("broken.json", BROKEN_FLOWS), "--budget", "3"]
        )
        self.assertEqual(code, 2)
        self.assertEqual(result["status"], "budget_exhausted")
        self.assertFalse(result["optimal"])
        self.assertIsNotNone(result["lower_bound_modifications"])

    def test_repair_infeasible_exits_three_with_cut(self):
        net_path = self._write("inf.json", infeasible_network().to_dict())
        cert_path = self._write("inf-cert.json", {"flows": {"e_st": 5}})
        code, result, _ = self._run(["repair", net_path, cert_path])
        self.assertEqual(code, 3)
        self.assertEqual(result["status"], "infeasible")
        self.assertGreater(result["cut"]["deficit"], 0)

    def test_repair_verbose_emits_checkpoints(self):
        net_path = self._write("tie.json", tie_network().to_dict())
        code, _, stderr = self._run(
            ["repair", net_path, self._write("broken.json", BROKEN_FLOWS), "--verbose"]
        )
        self.assertEqual(code, 0)
        self.assertIn("[checkpoint]", stderr)

    def test_malformed_input_exits_four(self):
        junk = self._write("junk.json", {"not": "a network"})
        code, _, stderr = self._run(["verify", junk, self.good_path])
        self.assertEqual(code, 4)
        self.assertIn("error", stderr)

    def test_module_entrypoint(self):
        proc = subprocess.run(
            [sys.executable, "-m", "mcfcert", "verify", self.net_path, self.good_path],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue(json.loads(proc.stdout)["valid"])


if __name__ == "__main__":
    unittest.main()
