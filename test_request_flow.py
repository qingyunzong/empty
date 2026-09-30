"""Acceptance tests for request_flow CLI.

Each scenario is expressed as a reference state table: a list of steps
(command, expected exit code, expected state, expected new events).
The per-tick event sequences for the timeout scenario are asserted
explicitly against the persisted event log.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

CLI = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "request_flow.py")

EXIT_OK = 0
EXIT_NOT_DECIDABLE = 4
EXIT_CONFLICT = 9
EXIT_CRASH = 10


class RequestFlowTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = self.tmp.name

    def run_cli(self, *argv):
        return subprocess.run(
            [sys.executable, CLI, "--dir", self.home, *argv],
            capture_output=True, text=True)

    def events(self):
        path = os.path.join(self.home, "events.jsonl")
        if not os.path.exists(path):
            return []
        with open(path, encoding="utf-8") as fh:
            return [json.loads(line) for line in fh if line.strip()]

    def event_types(self):
        return [ev["type"] for ev in self.events()]

    def assert_step(self, argv, expected_exit, expected_state,
                    expected_new_events):
        before = len(self.events())
        result = self.run_cli(*argv)
        self.assertEqual(result.returncode, expected_exit,
                         msg="cmd=%s stderr=%s" % (argv, result.stderr))
        state = self.run_cli("state")
        self.assertEqual(state.stdout.strip(), expected_state)
        new_types = self.event_types()[before:]
        self.assertEqual(new_types, expected_new_events,
                         msg="cmd=%s new events mismatch" % (argv,))
        return result

    def test_high_amount_two_level_approval(self):
        """高额单(>=1000)需经理+财务两级审批, 全部批准后汇合完成."""
        table = [
            (["new", "--amount", "1500", "--items", "gpu,db", "--timeout", "5"],
             EXIT_OK, "RUNNING",
             ["RequestCreated", "ItemReserved", "ItemReserved"]),
            (["decide", "manager", "APPROVE"], EXIT_OK, "RUNNING",
             ["DecisionRecorded"]),
            (["decide", "finance", "APPROVE"], EXIT_OK, "APPROVED",
             ["DecisionRecorded", "Completed"]),
        ]
        for argv, code, state, new_events in table:
            self.assert_step(argv, code, state, new_events)
        compensated = [ev for ev in self.events()
                       if ev["type"] == "ItemCompensated"]
        self.assertEqual(compensated, [])

    def test_low_amount_single_level_approval(self):
        """低额单(<1000)只需经理一级审批; 财务不是必需审批人."""
        table = [
            (["new", "--amount", "999", "--items", "vm", "--timeout", "3"],
             EXIT_OK, "RUNNING", ["RequestCreated", "ItemReserved"]),
            (["decide", "manager", "APPROVE"], EXIT_OK, "APPROVED",
             ["DecisionRecorded", "Completed"]),
            (["decide", "finance", "APPROVE"], EXIT_NOT_DECIDABLE, "APPROVED",
             []),
        ]
        for argv, code, state, new_events in table:
            self.assert_step(argv, code, state, new_events)

    def test_manager_reject_reverse_compensation(self):
        """经理拒绝后按逆序补偿预留项; 之后财务的决定被拒."""
        table = [
            (["new", "--amount", "1500", "--items", "a,b,c", "--timeout", "9"],
             EXIT_OK, "RUNNING",
             ["RequestCreated", "ItemReserved", "ItemReserved",
              "ItemReserved"]),
            (["decide", "manager", "REJECT"], EXIT_OK, "REJECTED",
             ["DecisionRecorded", "RejectingStarted", "ItemCompensated",
              "ItemCompensated", "ItemCompensated", "Rejected"]),
            (["decide", "finance", "APPROVE"], EXIT_NOT_DECIDABLE, "REJECTED",
             []),
        ]
        for argv, code, state, new_events in table:
            self.assert_step(argv, code, state, new_events)
        compensated = [ev["item"] for ev in self.events()
                       if ev["type"] == "ItemCompensated"]
        self.assertEqual(compensated, ["c", "b", "a"])

    def test_timeout_auto_cancel_per_tick_events(self):
        """tick 达到截止时间未决定则自动取消并补偿; 校验每 tick 事件序列."""
        self.assert_step(
            ["new", "--amount", "100", "--items", "x,y", "--timeout", "2"],
            EXIT_OK, "RUNNING",
            ["RequestCreated", "ItemReserved", "ItemReserved"])
        per_tick = [
            (EXIT_OK, "RUNNING", ["Tick"]),
            (EXIT_OK, "CANCELED",
             ["Tick", "TimeoutCancelingStarted", "ItemCompensated",
              "ItemCompensated", "Canceled"]),
        ]
        for code, state, new_events in per_tick:
            self.assert_step(["tick"], code, state, new_events)
        compensated = [ev["item"] for ev in self.events()
                       if ev["type"] == "ItemCompensated"]
        self.assertEqual(compensated, ["y", "x"])
        ticks = [ev["n"] for ev in self.events() if ev["type"] == "Tick"]
        self.assertEqual(ticks, [1, 2])

    def test_idempotent_and_conflicting_decision(self):
        """同一审批人重复相同决定幂等; 已决后相反决定返回退出码 9."""
        table = [
            (["new", "--amount", "1500", "--items", "k", "--timeout", "5"],
             EXIT_OK, "RUNNING", ["RequestCreated", "ItemReserved"]),
            (["decide", "manager", "APPROVE"], EXIT_OK, "RUNNING",
             ["DecisionRecorded"]),
            (["decide", "manager", "APPROVE"], EXIT_OK, "RUNNING", []),
            (["decide", "manager", "REJECT"], EXIT_CONFLICT, "RUNNING", []),
        ]
        for argv, code, state, new_events in table:
            result = self.assert_step(argv, code, state, new_events)
        decisions = [ev for ev in self.events()
                     if ev["type"] == "DecisionRecorded"]
        self.assertEqual(len(decisions), 1)
        self.assertEqual(result.returncode, EXIT_CONFLICT)

    def test_crash_between_decision_event_and_action_recover(self):
        """决策事件与动作之间崩溃, 恢复后补偿不重复."""
        table = [
            (["new", "--amount", "2000", "--items", "p,q", "--timeout", "9"],
             EXIT_OK, "RUNNING",
             ["RequestCreated", "ItemReserved", "ItemReserved"]),
            (["crash", "--at", "after-decision-event"], EXIT_OK, "RUNNING",
             []),
            (["decide", "manager", "REJECT"], EXIT_CRASH, "RUNNING",
             ["DecisionRecorded"]),
            (["recover"], EXIT_OK, "REJECTED",
             ["RejectingStarted", "ItemCompensated", "ItemCompensated",
              "Rejected"]),
            (["recover"], EXIT_OK, "REJECTED", []),
        ]
        for argv, code, state, new_events in table:
            self.assert_step(argv, code, state, new_events)
        compensated = [ev["item"] for ev in self.events()
                       if ev["type"] == "ItemCompensated"]
        self.assertEqual(compensated, ["q", "p"])

    def test_crash_mid_compensation_recover_no_duplicate(self):
        """补偿中途崩溃, 恢复只补剩余项, 不重复补偿."""
        table = [
            (["new", "--amount", "2000", "--items", "a,b,c", "--timeout", "9"],
             EXIT_OK, "RUNNING",
             ["RequestCreated", "ItemReserved", "ItemReserved",
              "ItemReserved"]),
            (["crash", "--at", "mid-compensation"], EXIT_OK, "RUNNING", []),
            (["decide", "manager", "REJECT"], EXIT_CRASH, "REJECTING",
             ["DecisionRecorded", "RejectingStarted", "ItemCompensated"]),
            (["recover"], EXIT_OK, "REJECTED",
             ["ItemCompensated", "ItemCompensated", "Rejected"]),
        ]
        for argv, code, state, new_events in table:
            self.assert_step(argv, code, state, new_events)
        compensated = [ev["item"] for ev in self.events()
                       if ev["type"] == "ItemCompensated"]
        self.assertEqual(compensated, ["c", "b", "a"])

    def test_corrupt_log_reports_failed(self):
        """事件日志损坏时状态为 FAILED."""
        self.assert_step(
            ["new", "--amount", "10", "--items", "z", "--timeout", "1"],
            EXIT_OK, "RUNNING", ["RequestCreated", "ItemReserved"])
        with open(os.path.join(self.home, "events.jsonl"), "a",
                  encoding="utf-8") as fh:
            fh.write("not-json\n")
        state = self.run_cli("state")
        self.assertEqual(state.stdout.strip(), "FAILED")


if __name__ == "__main__":
    unittest.main()
