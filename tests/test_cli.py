import json
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(script):
    proc = subprocess.run(
        [sys.executable, "-m", "bagra.cli", "-"],
        input=json.dumps(script),
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


class CliTest(unittest.TestCase):
    def test_end_to_end_script_with_recovery(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = os.path.join(tmp, "state.json")
            script = {
                "commands": [
                    {"op": "add_table", "name": "R"},
                    {"op": "add_node", "node": {"id": "r", "type": "scan", "table": "R"}},
                    {"op": "add_node", "node": {"id": "d", "type": "distinct", "inputs": ["r"]}},
                    {"op": "subscribe", "node": "d"},
                    {"op": "batch", "changes": {"R": [[[1], 1], [[1], 1], [[2], 1]]}},
                    {"op": "result", "node": "d"},
                    {"op": "batch", "changes": {"R": [[[9], -1]]}},  # error: rolled back
                    {"op": "result", "node": "d"},
                    {"op": "save", "path": state},
                ]
            }
            results = run_cli(script)
            self.assertTrue(all(r["ok"] or r.get("error") for r in results))
            self.assertEqual(results[3], {"ok": True, "subscription": 1})
            batch = results[4]
            self.assertTrue(batch["ok"])
            self.assertEqual(batch["version"], 1)
            self.assertEqual(batch["published"][0]["changes"], [[[1], 1], [[2], 1]])
            self.assertEqual(results[5]["result"], [[[1], 1], [[2], 1]])
            self.assertFalse(results[6]["ok"])  # failed batch reported, not fatal
            self.assertEqual(results[7]["result"], [[[1], 1], [[2], 1]])
            self.assertTrue(results[8]["ok"])

            # recover in a fresh process: version continues, no republish
            script2 = {
                "load": state,
                "commands": [
                    {"op": "batch", "changes": {"R": [[[1], -1], [[1], -1]]}},
                    {"op": "publish_log"},
                ],
            }
            results2 = run_cli(script2)
            batch2 = results2[0]
            self.assertEqual(batch2["version"], 2)
            self.assertEqual(batch2["published"][0]["changes"], [[[1], -1]])
            log = results2[1]["publish_log"]
            self.assertEqual([rec["version"] for rec in log], [1, 2])
            self.assertEqual([rec["seq"] for rec in log], [1, 2])


if __name__ == "__main__":
    unittest.main()
