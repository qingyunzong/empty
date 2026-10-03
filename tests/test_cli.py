import json
import os
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SPEC = {
    "nfa": {
        "states": 3,
        "start": 0,
        "accepting": [2],
        "edges": [
            {"from": 0, "to": 1, "lo": 97, "hi": 122},
            {"from": 1, "to": 2, "lo": 48, "hi": 57},
            {"from": 1, "to": 1, "lo": 97, "hi": 122},
        ],
    },
    "strings": ["a1", "ab", "1a", "a", "z9"],
}


def run_cli(spec):
    env = dict(os.environ)
    env["PYTHONPATH"] = REPO_ROOT + os.pathsep + env.get("PYTHONPATH", "")
    proc = subprocess.run(
        [sys.executable, "-m", "lazydfa"],
        input=json.dumps(spec), capture_output=True, text=True,
        cwd=REPO_ROOT, env=env)
    if proc.returncode != 0:
        raise AssertionError(f"CLI failed: {proc.stderr}")
    return json.loads(proc.stdout)


class CLITest(unittest.TestCase):
    def test_match_results(self):
        out = run_cli(SPEC)
        self.assertEqual(out["results"]["a1"], "accept")
        self.assertEqual(out["results"]["ab"], "reject")
        self.assertEqual(out["results"]["1a"], "reject")
        self.assertEqual(out["results"]["a"], "reject")
        self.assertEqual(out["results"]["z9"], "accept")

    def test_witnesses_present(self):
        out = run_cli(SPEC)
        self.assertTrue(out["transitions"])
        for t in out["transitions"]:
            self.assertIn("witness", t)
            self.assertTrue(t["witness"])
            for w in t["witness"]:
                self.assertIn("id", w)

    def test_unknown_states_reported(self):
        spec = dict(SPEC, state_budget=1)
        out = run_cli(spec)
        statuses = {s["status"] for s in out["states"]}
        self.assertIn("unknown", statuses)
        self.assertEqual(out["results"]["a1"], "unknown")
        self.assertTrue(out["budgets"]["exhausted"])

    def test_checkpoint_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            ckpt = os.path.join(tmp, "ckpt.json")
            spec1 = dict(SPEC, state_budget=2, checkpoint_out=ckpt)
            out1 = run_cli(spec1)
            self.assertTrue(os.path.exists(ckpt))
            spec2 = dict(SPEC, checkpoint_in=ckpt)
            out2 = run_cli(spec2)
            full = run_cli(SPEC)
            self.assertEqual(out2["results"], full["results"])
            self.assertEqual(out2["states"], full["states"])
            self.assertEqual(out2["transitions"], full["transitions"])
            self.assertEqual(out1["budgets"]["states_used"], 2)

    def test_checkpoint_version_mismatch_via_cli(self):
        with tempfile.TemporaryDirectory() as tmp:
            ckpt = os.path.join(tmp, "ckpt.json")
            run_cli(dict(SPEC, checkpoint_out=ckpt))
            mutated = json.loads(json.dumps(SPEC))
            mutated["nfa"]["edges"].append(
                {"from": 0, "to": 2, "lo": 33, "hi": 33})
            mutated["checkpoint_in"] = ckpt
            env = dict(os.environ)
            env["PYTHONPATH"] = REPO_ROOT
            proc = subprocess.run(
                [sys.executable, "-m", "lazydfa"],
                input=json.dumps(mutated), capture_output=True, text=True,
                cwd=REPO_ROOT, env=env)
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn("version mismatch", proc.stderr)


if __name__ == "__main__":
    unittest.main()
