import json
import os
import subprocess
import sys
import tempfile
import unittest


def run_cli(doc):
    proc = subprocess.run(
        [sys.executable, "-m", "budget_auth"],
        input=json.dumps(doc), capture_output=True, text=True,
        cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


class CliTest(unittest.TestCase):
    def test_end_to_end_session(self):
        out = run_cli({"commands": [
            {"op": "add_budget", "budget_id": "root", "quota": 100},
            {"op": "add_budget", "budget_id": "a", "quota": 60,
             "parent": "root"},
            {"op": "add_rule", "rule_id": "r1", "subject": "alice",
             "resource": "doc/*", "start": 0, "end": 100, "budget": "a"},
            {"op": "reserve", "request_id": "q1", "subject": "alice",
             "resource": "doc/1", "amount": 30, "ttl": 10},
            {"op": "confirm", "request_id": "q1"},
            {"op": "state"},
        ]})
        results = out["results"]
        self.assertTrue(all(r.get("ok") for r in results[:5]))
        self.assertEqual(results[3]["reservation"]["allocation"], {"a": 30})
        state = results[5]
        self.assertEqual(state["budgets"]["root"]["held"], 30)
        self.assertEqual(state["reservations"]["q1"]["status"], "confirmed")

    def test_rejection_reports_unsat_core(self):
        out = run_cli({"commands": [
            {"op": "add_budget", "budget_id": "root", "quota": 10},
            {"op": "add_budget", "budget_id": "a", "quota": 10,
             "parent": "root"},
            {"op": "add_budget", "budget_id": "b", "quota": 10,
             "parent": "root"},
            {"op": "add_rule", "rule_id": "r1", "subject": "*",
             "resource": "*", "start": 0, "end": 100, "budget": "a"},
            {"op": "add_rule", "rule_id": "r2", "subject": "*",
             "resource": "*", "start": 0, "end": 100, "budget": "b"},
            {"op": "reserve", "request_id": "q1", "subject": "s",
             "resource": "x", "amount": 15, "ttl": 5},
        ]})
        r = out["results"][5]
        self.assertFalse(r["ok"])
        core = r["unsat_core"]
        self.assertEqual(core["amount"], 15)
        self.assertEqual(core["max_allocatable"], 10)
        self.assertEqual([c["budget"] for c in core["constraints"]],
                         ["root"])
        self.assertEqual(core["constraints"][0]["remaining"], 10)

    def test_persistent_log_across_processes(self):
        with tempfile.TemporaryDirectory() as d:
            log = os.path.join(d, "auth.log")
            run_cli({"log": log, "commands": [
                {"op": "add_budget", "budget_id": "root", "quota": 50},
                {"op": "add_rule", "rule_id": "r1", "subject": "*",
                 "resource": "*", "start": 0, "end": 100, "budget": "root"},
                {"op": "reserve", "request_id": "q1", "subject": "s",
                 "resource": "x", "amount": 20, "ttl": 10},
                {"op": "confirm", "request_id": "q1"},
            ]})
            # second process recovers from the log; deduction seen once
            out = run_cli({"log": log, "commands": [
                {"op": "confirm", "request_id": "q1"},
                {"op": "state"},
            ]})
            dup = out["results"][0]
            self.assertFalse(dup["ok"])
            self.assertEqual(dup["error"]["code"], "duplicate_confirm")
            state = out["results"][1]
            self.assertEqual(state["budgets"]["root"]["held"], 20)

    def test_unknown_op_and_bad_params(self):
        out = run_cli({"commands": [
            {"op": "explode"},
            {"op": "add_budget"},
        ]})
        self.assertEqual(out["results"][0]["error"]["code"], "unknown_op")
        self.assertEqual(out["results"][1]["error"]["code"], "bad_params")


if __name__ == "__main__":
    unittest.main()
