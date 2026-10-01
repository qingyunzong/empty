"""CLI integration tests: JSON lines in/out, exit code 11 on errors."""
import json
import os
import subprocess
import sys
import unittest

import _bootstrap  # noqa: F401

ROOT = _bootstrap.ROOT
EXIT_ERROR = 11


def run_cli(lines):
    proc = subprocess.run(
        [sys.executable, "-m", "raft_sim.cli"],
        input="\n".join(lines) + "\n",
        capture_output=True, text=True, cwd=ROOT)
    return proc


def stdout_json(proc):
    return [json.loads(line) for line in proc.stdout.strip().splitlines()]


class TestCLI(unittest.TestCase):
    def test_happy_path_exit_0(self):
        proc = run_cli([
            json.dumps({"cmd": "init", "nodes": 3}),
            json.dumps({"cmd": "elect", "candidate": "n1", "term": 1}),
            json.dumps({"cmd": "append", "key": "a", "value": 1}),
            json.dumps({"cmd": "ack", "follower": "n2"}),
            json.dumps({"cmd": "commit"}),
            json.dumps({"cmd": "state"}),
        ])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = stdout_json(proc)
        self.assertTrue(all(o["ok"] for o in out))
        self.assertTrue(out[1]["elected"])
        self.assertEqual(out[2]["index"], 1)
        self.assertTrue(out[3]["ack"])
        self.assertEqual(out[4]["commitIndex"], 1)
        self.assertEqual(out[5]["leader"], "n1")
        self.assertEqual(out[5]["nodes"]["n2"]["log"][0]["key"], "a")

    def test_reject_is_not_an_error(self):
        proc = run_cli([
            json.dumps({"cmd": "init", "nodes": 3}),
            json.dumps({"cmd": "elect", "candidate": "n1", "term": 1}),
            json.dumps({"cmd": "append", "key": "a"}),
            json.dumps({"cmd": "ack", "follower": "n2"}),
            json.dumps({"cmd": "append", "key": "b"}),   # only on n1
            json.dumps({"cmd": "crash", "node": "n1"}),
            json.dumps({"cmd": "elect", "candidate": "n2", "term": 2}),
            json.dumps({"cmd": "append", "key": "x"}),   # fork at idx 2
            json.dumps({"cmd": "recover", "node": "n1"}),
            json.dumps({"cmd": "ack", "follower": "n1"}),
        ])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = stdout_json(proc)
        self.assertFalse(out[-1]["ack"])
        self.assertEqual(out[-1]["reason"], "REJECT")
        self.assertEqual(out[-1]["conflictIndex"], 2)
        self.assertEqual(out[-1]["conflictTerm"], 1)

    def test_full_scenario_with_repair(self):
        proc = run_cli([
            json.dumps({"cmd": "init", "nodes": 3}),
            json.dumps({"cmd": "elect", "candidate": "n1", "term": 1}),
            json.dumps({"cmd": "append", "key": "a"}),
            json.dumps({"cmd": "ack", "follower": "n2"}),
            json.dumps({"cmd": "ack", "follower": "n3"}),
            json.dumps({"cmd": "commit"}),
            json.dumps({"cmd": "ack", "follower": "n2"}),
            json.dumps({"cmd": "ack", "follower": "n3"}),
            json.dumps({"cmd": "append", "key": "b"}),
            json.dumps({"cmd": "crash", "node": "n1"}),
            json.dumps({"cmd": "elect", "candidate": "n2", "term": 2}),
            json.dumps({"cmd": "append", "key": "x"}),
            json.dumps({"cmd": "ack", "follower": "n3"}),
            json.dumps({"cmd": "commit"}),
            json.dumps({"cmd": "recover", "node": "n1"}),
            json.dumps({"cmd": "repair"}),
            json.dumps({"cmd": "state"}),
        ])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = stdout_json(proc)
        state = out[-1]
        for name in ("n1", "n2", "n3"):
            keys = [e["key"] for e in state["nodes"][name]["log"]]
            self.assertEqual(keys, ["a", "x"], name)
        self.assertEqual(state["nodes"]["n1"]["commitIndex"], 2)

    def test_crash_before_vote_persist_via_cli(self):
        proc = run_cli([
            json.dumps({"cmd": "init", "nodes": 3}),
            json.dumps({"cmd": "elect", "candidate": "n1", "term": 1}),
            json.dumps({"cmd": "append", "key": "a"}),
            json.dumps({"cmd": "ack", "follower": "n2"}),
            json.dumps({"cmd": "crash", "node": "n3"}),
            json.dumps({"cmd": "elect", "candidate": "n2", "term": 2,
                        "fault": {"node": "n1",
                                  "point": "before_vote_persist"}}),
            json.dumps({"cmd": "recover", "node": "n1"}),
        ])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = stdout_json(proc)
        self.assertFalse(out[5]["elected"])
        self.assertEqual(out[5]["votes"], ["n2"])
        self.assertEqual(out[6]["term"], 1)  # no illegal term rollback

    def test_errors_exit_11(self):
        cases = [
            ["not json"],                                        # malformed
            [json.dumps({"cmd": "bogus"})],                      # unknown cmd
            [json.dumps({"cmd": "append", "key": "a"})],         # no init
            [json.dumps({"cmd": "init", "nodes": 6})],           # too many
            [json.dumps({"cmd": "init", "nodes": 3}),
             json.dumps({"cmd": "append", "key": "a"})],         # no leader
            [json.dumps({"cmd": "init", "nodes": 3}),
             json.dumps({"cmd": "elect", "candidate": "n9", "term": 1})],
            [json.dumps({"cmd": "init", "nodes": 3}),
             json.dumps({"cmd": "elect", "candidate": "n1", "term": 1}),
             json.dumps({"cmd": "append", "key": "a", "leader": "n2"})],
            [json.dumps({"cmd": "init", "nodes": 3}),
             json.dumps({"cmd": "elect", "candidate": "n1", "term": 1}),
             json.dumps({"cmd": "elect", "candidate": "n1", "term": 1}),
             json.dumps({"cmd": "elect", "candidate": "n2", "term": 1})],
        ]
        for lines in cases:
            with self.subTest(lines=lines):
                proc = run_cli(lines)
                self.assertEqual(proc.returncode, EXIT_ERROR,
                                 proc.stdout + proc.stderr)
                err = json.loads(proc.stderr.strip())
                self.assertFalse(err["ok"])
                self.assertIn("error", err)

    def test_entrypoint_script(self):
        proc = subprocess.run(
            [sys.executable, "raft_cli.py"],
            input='{"cmd": "init", "nodes": 1}\n',
            capture_output=True, text=True, cwd=ROOT)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue(json.loads(proc.stdout.strip())["ok"])


if __name__ == "__main__":
    unittest.main()
