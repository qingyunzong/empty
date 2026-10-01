"""CLI contract: JSON lines in/out, errors exit with status 9."""

import json
import subprocess
import sys
import unittest


def run_cli(lines):
    payload = "".join(
        line if line.endswith("\n") else line + "\n" for line in lines)
    return subprocess.run(
        [sys.executable, "-m", "gossip"],
        input=payload.encode(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


class CliTest(unittest.TestCase):
    def test_happy_path(self):
        proc = run_cli([
            json.dumps({"cmd": "init", "nodes": 3, "seed": 1, "fanout": 2}),
            json.dumps({"cmd": "inject", "node": 0, "key": "a", "value": 1}),
            json.dumps({"cmd": "step", "rounds": 3}),
            json.dumps({"cmd": "status"}),
        ])
        self.assertEqual(proc.returncode, 0, proc.stderr.decode())
        lines = [json.loads(l) for l in proc.stdout.decode().splitlines()]
        responses = [l for l in lines if "ok" in l]
        events = [l for l in lines if "event" in l]
        self.assertTrue(all(r["ok"] for r in responses))
        self.assertEqual(len(responses), 4)
        self.assertGreater(len(events), 0)
        status = responses[-1]
        self.assertTrue(status["converged"])
        self.assertEqual(status["state"], "CONVERGED")
        self.assertEqual(len(status["nodes"]), 3)

    def test_errors_exit_9(self):
        cases = [
            ["not json"],
            [json.dumps({"cmd": "bogus"})],
            [json.dumps({"cmd": "init", "nodes": 65, "seed": 1, "fanout": 1})],
            [json.dumps({"cmd": "init", "nodes": 2, "seed": 1, "fanout": 5})],
            [json.dumps({"cmd": "init", "nodes": 2, "seed": 1, "fanout": 0})],
            [json.dumps({"cmd": "step"})],  # before init
            [json.dumps({"cmd": "init", "nodes": 2, "seed": 1, "fanout": 1}),
             json.dumps({"cmd": "inject", "node": 7, "key": "a", "value": 1})],
            [json.dumps({"cmd": "init", "nodes": 2, "seed": 1, "fanout": 1}),
             json.dumps({"cmd": "down", "node": -1})],
            [json.dumps({"cmd": "init", "nodes": 2, "seed": 1, "fanout": 1}),
             json.dumps({"cmd": "step", "rounds": 201})],
        ]
        for lines in cases:
            with self.subTest(lines=lines):
                proc = run_cli(lines)
                self.assertEqual(proc.returncode, 9, lines)
                out = proc.stdout.decode().splitlines()
                last = json.loads(out[-1])
                self.assertFalse(last["ok"])
                self.assertIn("error", last)


if __name__ == "__main__":
    unittest.main()
