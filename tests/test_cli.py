import json
import os
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(request, *extra_args):
    proc = subprocess.run(
        [sys.executable, "-m", "exactnum", *extra_args],
        input=json.dumps(request),
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
    )
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


SQRT2 = {"poly": ["-2", "0", "1"], "interval": ["1", "2"]}
SQRT2_WIDE = {"poly": ["-2", "0", "1"], "interval": ["1", "3"]}
SQRT3 = {"poly": ["-3", "0", "1"], "interval": ["1", "2"]}


class TestCli(unittest.TestCase):
    def test_introot(self):
        n = 7**40
        out = run_cli({"op": "introot", "n": str(n), "k": 4})
        self.assertEqual(out["r"], str(7**10))
        ev = out["evidence"]
        self.assertEqual(ev["r_pow_k"], str(n))
        verify = run_cli({"op": "verify_introot", "evidence": ev})
        self.assertTrue(verify["valid"])

    def test_introot_negative_odd(self):
        out = run_cli({"op": "introot", "n": "-9", "k": 3})
        self.assertEqual(out["r"], "-3")

    def test_verify_introot_tampered(self):
        out = run_cli({"op": "introot", "n": "1000000", "k": 3})
        ev = out["evidence"]
        ev["r"] = str(int(ev["r"]) + 1)
        self.assertFalse(run_cli({"op": "verify_introot",
                                  "evidence": ev})["valid"])
        ev2 = out["evidence"]
        ev2["r_plus_1_pow_k"] = str(int(ev2["r_plus_1_pow_k"]) - 1)
        self.assertFalse(run_cli({"op": "verify_introot",
                                  "evidence": ev2})["valid"])

    def test_floor_ceil_round(self):
        self.assertEqual(run_cli({"op": "floor", "alg": SQRT2})["result"], "1")
        self.assertEqual(run_cli({"op": "ceil", "alg": SQRT2})["result"], "2")
        self.assertEqual(run_cli({"op": "round_even", "alg": SQRT2})["result"],
                         "1")
        half = {"poly": ["5/2", "1"], "interval": ["-3", "-2"]}
        self.assertEqual(
            run_cli({"op": "round_even", "alg": half})["result"], "-2")

    def test_scaled_rounding(self):
        out = run_cli({"op": "floor", "alg": SQRT2, "scale": "3/7"})
        self.assertEqual(out["result"], "0")
        out = run_cli({"op": "ceil", "alg": SQRT2, "scale": "-3/7"})
        self.assertEqual(out["result"], "0")

    def test_compare(self):
        out = run_cli({"op": "compare", "a": SQRT2, "b": SQRT3})
        self.assertEqual(out["result"], -1)
        same = run_cli({"op": "compare", "a": SQRT2,
                        "b": {"poly": ["4", "0", "-4", "0", "1"],
                              "interval": ["1", "2"]}})
        self.assertEqual(same["result"], 0)

    def test_budget_exhausted(self):
        out = run_cli({"op": "floor", "alg": SQRT2_WIDE, "budget": 0})
        self.assertEqual(out["error"], "budget_exhausted")
        out = run_cli({"op": "floor", "alg": SQRT2_WIDE, "budget": 5})
        self.assertEqual(out["result"], "1")

    def test_checkpoint_save_and_resume(self):
        with tempfile.TemporaryDirectory() as tmp:
            ckpt = os.path.join(tmp, "ckpt.json")
            out = run_cli({"op": "floor", "alg": SQRT2_WIDE},
                          "--save-checkpoint", ckpt)
            self.assertEqual(out["result"], "1")
            self.assertTrue(os.path.exists(ckpt))
            # Resuming from the checkpoint decides with zero budget.
            out = run_cli({"op": "floor", "alg": SQRT2_WIDE, "budget": 0},
                          "--checkpoint", ckpt)
            self.assertEqual(out["result"], "1")

    def test_tampered_checkpoint_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            ckpt = os.path.join(tmp, "ckpt.json")
            run_cli({"op": "floor", "alg": SQRT2_WIDE},
                    "--save-checkpoint", ckpt)
            with open(ckpt, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            key = next(iter(data["intervals"]))
            data["intervals"][key] = ["3/2", "2"]  # no sign change
            with open(ckpt, "w", encoding="utf-8") as fh:
                json.dump(data, fh)
            proc = subprocess.run(
                [sys.executable, "-m", "exactnum", "--checkpoint", ckpt],
                input=json.dumps({"op": "floor", "alg": SQRT2_WIDE}),
                capture_output=True, text=True, cwd=REPO_ROOT,
            )
            self.assertEqual(proc.returncode, 1)
            self.assertIn("invalid evidence", proc.stdout)

    def test_unknown_op(self):
        out = run_cli({"op": "nonsense"})
        self.assertIn("error", out)


if __name__ == "__main__":
    unittest.main()
