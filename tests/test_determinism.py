"""Acceptance A: identical seeds produce byte-identical event traces."""

import json
import subprocess
import sys
import unittest

SCRIPT = [
    {"cmd": "init", "nodes": 6, "seed": 42, "fanout": 2},
    {"cmd": "inject", "node": 0, "key": "alpha", "value": 1},
    {"cmd": "inject", "node": 3, "key": "beta", "value": [1, 2, 3]},
    {"cmd": "step", "rounds": 5},
    {"cmd": "down", "node": 2},
    {"cmd": "inject", "node": 1, "key": "gamma", "value": "x"},
    {"cmd": "step", "rounds": 10},
    {"cmd": "up", "node": 2},
    {"cmd": "step", "rounds": 30},
    {"cmd": "status"},
]


def run_cli(script):
    payload = "\n".join(json.dumps(cmd) for cmd in script) + "\n"
    proc = subprocess.run(
        [sys.executable, "-m", "gossip"],
        input=payload.encode(),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return proc


class DeterminismTest(unittest.TestCase):
    def test_same_seed_byte_identical_trace(self):
        first = run_cli(SCRIPT)
        second = run_cli(SCRIPT)
        self.assertEqual(first.returncode, 0, first.stderr.decode())
        self.assertEqual(second.returncode, 0, second.stderr.decode())
        self.assertEqual(first.stdout, second.stdout)
        self.assertGreater(len(first.stdout.splitlines()), 100)

    def test_different_seeds_diverge(self):
        other = [dict(cmd, seed=7) if cmd["cmd"] == "init" else cmd
                 for cmd in SCRIPT]
        base = run_cli(SCRIPT)
        alt = run_cli(other)
        self.assertEqual(alt.returncode, 0, alt.stderr.decode())
        self.assertNotEqual(base.stdout, alt.stdout)


if __name__ == "__main__":
    unittest.main()
