"""Tests for the JSON-lines CLI protocol."""

import io
import json
import unittest

from lockmgr.cli import run


def run_script(lines):
    stdin = io.StringIO("\n".join(json.dumps(op) for op in lines) + "\n")
    stdout = io.StringIO()
    run(stdin, stdout)
    return [json.loads(line) for line in stdout.getvalue().splitlines()]


class TestCli(unittest.TestCase):
    def test_grant_and_commit(self):
        events = run_script([
            {"op": "lock", "txn": 1, "resource": "A", "mode": "S"},
            {"op": "commit", "txn": 1},
        ])
        self.assertEqual(events, [
            {"event": "granted", "txn": 1, "resource": "A", "mode": "S"},
            {"event": "committed", "txn": 1},
        ])

    def test_blocked_request_produces_no_grant_until_woken(self):
        events = run_script([
            {"op": "lock", "txn": 1, "resource": "A", "mode": "X"},
            {"op": "lock", "txn": 2, "resource": "A", "mode": "X"},
            {"op": "commit", "txn": 1},
        ])
        self.assertEqual(events, [
            {"event": "granted", "txn": 1, "resource": "A", "mode": "X"},
            {"event": "waiting", "txn": 2, "resource": "A", "mode": "X"},
            {"event": "committed", "txn": 1},
            {"event": "granted", "txn": 2, "resource": "A", "mode": "X"},
        ])

    def test_deadlock_reported_and_victim_locks_released(self):
        events = run_script([
            {"op": "lock", "txn": 1, "resource": "A", "mode": "X"},
            {"op": "lock", "txn": 2, "resource": "B", "mode": "X"},
            {"op": "lock", "txn": 1, "resource": "B", "mode": "X"},
            {"op": "lock", "txn": 2, "resource": "A", "mode": "X"},
        ])
        self.assertIn({"event": "deadlock", "txn": 2}, events)
        # txn 1's queued request on B is woken by the victim's release
        self.assertIn({"event": "granted", "txn": 1, "resource": "B", "mode": "X"},
                      events)

    def test_requesting_txn_is_victim(self):
        events = run_script([
            {"op": "lock", "txn": 5, "resource": "A", "mode": "X"},
            {"op": "lock", "txn": 9, "resource": "B", "mode": "X"},
            {"op": "lock", "txn": 5, "resource": "B", "mode": "X"},
            {"op": "lock", "txn": 9, "resource": "A", "mode": "X"},
        ])
        self.assertEqual(events[-2:], [
            {"event": "deadlock", "txn": 9},
            {"event": "granted", "txn": 5, "resource": "B", "mode": "X"},
        ])

    def test_error_on_finished_txn_and_bad_input(self):
        events = run_script([
            {"op": "lock", "txn": 1, "resource": "A", "mode": "X"},
            {"op": "commit", "txn": 1},
            {"op": "lock", "txn": 1, "resource": "B", "mode": "S"},
            {"op": "lock", "txn": 2, "resource": "B", "mode": "Q"},
            {"op": "frob", "txn": 3},
        ])
        self.assertEqual(events[2]["event"], "error")
        self.assertEqual(events[3]["event"], "error")
        self.assertEqual(events[4]["event"], "error")

    def test_invalid_json_line(self):
        stdin = io.StringIO("not json\n")
        stdout = io.StringIO()
        run(stdin, stdout)
        (event,) = [json.loads(l) for l in stdout.getvalue().splitlines()]
        self.assertEqual(event["event"], "error")


if __name__ == "__main__":
    unittest.main()
