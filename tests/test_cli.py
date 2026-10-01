import json
import os
import subprocess
import sys
import tempfile
import unittest

SCRIPT = {
    "ops": [
        {"op": "add_budget", "id": "p", "quota": 100},
        {"op": "add_budget", "id": "a", "quota": 60, "parent": "p"},
        {"op": "add_rule", "id": "r", "subject": "*", "resource": "*",
         "budget": "a", "start": 0, "end": 100},
        {"op": "reserve", "request": "q1", "subject": "alice",
         "resource": "gpu", "amount": 30, "ttl": 10},
        {"op": "reserve", "request": "q2", "subject": "bob",
         "resource": "gpu", "amount": 90, "ttl": 10},
        {"op": "confirm", "request": "q1"},
        {"op": "confirm", "request": "q1"},
        {"op": "tick", "now": 50},
    ]
}


def run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "budget_auth.cli", *args],
        capture_output=True, text=True, check=True,
        cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class CliTest(unittest.TestCase):
    def test_script_and_recovery(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = os.path.join(tmp, "state.log")
            script = os.path.join(tmp, "ops.json")
            with open(script, "w", encoding="utf-8") as fh:
                json.dump(SCRIPT, fh)
            out = run_cli("--db", db, "--script", script)
            doc = json.loads(out.stdout)
            results = doc["results"]
            self.assertEqual(len(results), len(SCRIPT["ops"]))
            self.assertTrue(results[3]["ok"])
            self.assertEqual(results[3]["holds"], {"a": 30})
            # q2 exceeds remaining capacity: unsat certificate present
            self.assertFalse(results[4]["ok"])
            self.assertEqual(results[4]["error"], "insufficient_capacity")
            self.assertEqual(results[4]["unsat"]["requested"], 90)
            self.assertEqual(results[4]["unsat"]["allocatable"], 30)
            self.assertTrue(results[4]["unsat"]["constraints"])
            # duplicate confirm rejected
            self.assertFalse(results[6]["ok"])
            self.assertEqual(results[6]["error"], "invalid_status")
            # state persisted: recover-only run reproduces it
            out2 = run_cli("--db", db, "--recover-only")
            doc2 = json.loads(out2.stdout)
            self.assertEqual(doc2["state"], doc["state"])
            self.assertEqual(doc2["state"]["reservations"]["q1"]["status"],
                             "confirmed")
            self.assertEqual(doc2["state"]["now"], 50)


if __name__ == "__main__":
    unittest.main()
