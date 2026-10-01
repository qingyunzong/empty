import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "polygcd", *args],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )


class TestCli(unittest.TestCase):
    def test_gcd_simple(self):
        r = run_cli("gcd", "--f", "[1,2,1]", "--g", "[1,1]")
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(r.stdout)
        self.assertEqual(out["status"], "ok")
        self.assertEqual(out["gcd"], [1, 1])
        self.assertEqual(out["content"], 1)

    def test_budget_resume_cycle(self):
        with tempfile.TemporaryDirectory() as td:
            state = Path(td) / "state.json"
            f = json.dumps([1, 1, 211, 210, 210])  # lc = 210 = 2*3*5*7
            g = json.dumps([1, 2, 2, 1])
            r1 = run_cli("gcd", "--f", f, "--g", g,
                         "--budget", "2", "--state-out", str(state))
            self.assertEqual(r1.returncode, 1)
            out1 = json.loads(r1.stdout)
            self.assertEqual(out1["status"], "budget_exhausted")
            self.assertTrue(state.exists())
            self.assertEqual(out1["used_primes"], [2, 3])

            r2 = run_cli("gcd", "--f", f, "--g", g,
                         "--resume", str(state), "--budget", "200")
            self.assertEqual(r2.returncode, 0, r2.stderr)
            out2 = json.loads(r2.stdout)
            self.assertEqual(out2["status"], "ok")
            self.assertEqual(out2["primitive_part"], [1, 1, 1])
            self.assertEqual(out2["used_primes"][:2], [2, 3])
            self.assertEqual(len(out2["used_primes"]),
                             len(set(out2["used_primes"])))

    def test_bezout_and_verify(self):
        with tempfile.TemporaryDirectory() as td:
            cert = Path(td) / "cert.json"
            r = run_cli("bezout", "--f", "[2,-3,1]", "--g", "[3,-4,1]",
                        "--cert-out", str(cert))
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertTrue(json.loads(r.stdout)["self_check"])

            rv = run_cli("verify", "--cert", str(cert))
            self.assertEqual(rv.returncode, 0)
            self.assertTrue(json.loads(rv.stdout)["valid"])

            # forge the certificate: replace d = x-1 with x+1
            data = json.loads(cert.read_text())
            data["d"] = ["1", "1"]
            cert.write_text(json.dumps(data))
            rv2 = run_cli("verify", "--cert", str(cert))
            self.assertEqual(rv2.returncode, 1)
            self.assertFalse(json.loads(rv2.stdout)["valid"])


if __name__ == "__main__":
    unittest.main()
