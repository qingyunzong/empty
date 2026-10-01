import itertools
import json
import os
import random
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lincheck import check_history, get_model, load_history_text
from lincheck.checker import Verdict
from lincheck.history import HistoryError, Operation

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def op(idx, thread, opname, arg=None, ret=None, start=0, end=None):
    return Operation(
        index=idx, id=idx, thread=thread, op=opname,
        arg=arg, ret=ret, start=float(start),
        end=None if end is None else float(end),
    )


def brute_force_linearizable(ops, model):
    """Reference: enumerate every permutation consistent with real-time order."""
    n = len(ops)
    for perm in itertools.permutations(range(n)):
        pos = {op_idx: p for p, op_idx in enumerate(perm)}
        respects_rt = all(
            not (ops[i].end is not None and ops[i].end <= ops[j].start)
            or pos[i] < pos[j]
            for i in range(n)
            for j in range(n)
            if i != j
        )
        if not respects_rt:
            continue
        state = model.initial_state()
        for idx in perm:
            state = model.step_completed(state, ops[idx])
            if state is None:
                break
        else:
            return True
    return False


class TestRegisterVsBruteForce(unittest.TestCase):
    """Acceptance A: 3-thread register histories agree with brute force."""

    def test_fixed_linearizable_history(self):
        ops = [
            op(0, "A", "write", arg=1, ret=None, start=0, end=10),
            op(1, "B", "write", arg=2, ret=None, start=1, end=11),
            op(2, "C", "read", ret=1, start=2, end=3),
            op(3, "C", "read", ret=2, start=12, end=13),
        ]
        model = get_model("register")
        result = check_history(ops, model)
        self.assertIs(result.verdict, Verdict.LINEARIZABLE)
        self.assertEqual(
            result.verdict is Verdict.LINEARIZABLE,
            brute_force_linearizable(ops, model),
        )
        # The returned linearization must itself be sequentially legal.
        state = model.initial_state()
        for o in result.linearization:
            state = model.step_completed(state, o)
            self.assertIsNotNone(state)

    def test_fixed_non_linearizable_history(self):
        ops = [
            op(0, "A", "write", arg=1, ret=None, start=0, end=1),
            op(1, "B", "write", arg=2, ret=None, start=2, end=3),
            op(2, "C", "read", ret=1, start=4, end=5),
        ]
        model = get_model("register")
        result = check_history(ops, model)
        self.assertIs(result.verdict, Verdict.NON_LINEARIZABLE)
        self.assertFalse(brute_force_linearizable(ops, model))

    def test_random_histories_match_brute_force(self):
        rng = random.Random(20261001)
        for trial in range(150):
            n = rng.randint(2, 6)
            ops = []
            for i in range(n):
                start = rng.randint(0, 8)
                end = start + rng.randint(1, 4)
                if rng.random() < 0.5:
                    ops.append(op(i, str(i % 3), "write",
                                  arg=rng.randint(0, 2), start=start, end=end))
                else:
                    ops.append(op(i, str(i % 3), "read",
                                  ret=rng.choice([None, 0, 1, 2]),
                                  start=start, end=end))
            model = get_model("register")
            result = check_history(ops, model, max_states=100000)
            self.assertIn(
                result.verdict, (Verdict.LINEARIZABLE, Verdict.NON_LINEARIZABLE)
            )
            expected = brute_force_linearizable(ops, model)
            self.assertEqual(
                expected,
                result.verdict is Verdict.LINEARIZABLE,
                msg=f"trial {trial}: mismatch for {ops}",
            )


class TestPendingHandling(unittest.TestCase):
    """Acceptance B: pending calls are not equated with failure."""

    def test_queue_lost_pending_response_gives_unknown(self):
        ops = [
            op(0, "A", "enq", arg=1, start=0, end=None),      # pending enq
            op(1, "B", "deq", ret=1, start=1, end=2),         # observed deq
        ]
        result = check_history(ops, get_model("queue"))
        self.assertIs(result.verdict, Verdict.UNKNOWN)
        self.assertIsNotNone(result.linearization)

    def test_pending_may_be_dropped(self):
        # Pending write(2) never has to take effect: read->1 is fine.
        ops = [
            op(0, "A", "write", arg=1, start=0, end=1),
            op(1, "B", "write", arg=2, start=2, end=None),
            op(2, "C", "read", ret=1, start=3, end=4),
        ]
        result = check_history(ops, get_model("register"))
        self.assertIs(result.verdict, Verdict.LINEARIZABLE)

    def test_pending_cannot_rescue_impossible_history(self):
        # read->2 with no write(2) anywhere, pending or not.
        ops = [
            op(0, "A", "write", arg=1, start=0, end=1),
            op(1, "B", "read", ret=1, start=2, end=None),  # pending read
            op(2, "C", "read", ret=2, start=3, end=4),
        ]
        result = check_history(ops, get_model("register"))
        self.assertIs(result.verdict, Verdict.NON_LINEARIZABLE)


class TestNonLinearizable(unittest.TestCase):
    """Acceptance C: classic ABA-style register anomaly."""

    def test_aba_history(self):
        ops = [
            op(0, "A", "write", arg=1, start=0, end=1),
            op(1, "B", "write", arg=2, start=2, end=3),
            op(2, "C", "read", ret=1, start=4, end=5),
        ]
        result = check_history(ops, get_model("register"))
        self.assertIs(result.verdict, Verdict.NON_LINEARIZABLE)
        self.assertIsNotNone(result.conflict_prefix)
        # The prefix must itself be non-linearizable and minimal by start order.
        model = get_model("register")
        self.assertFalse(brute_force_linearizable(result.conflict_prefix, model))
        if len(result.conflict_prefix) > 1:
            shorter = result.conflict_prefix[:-1]
            self.assertTrue(brute_force_linearizable(shorter, model))

    def test_queue_order_violation(self):
        ops = [
            op(0, "A", "enq", arg=1, start=0, end=1),
            op(1, "A", "enq", arg=2, start=2, end=3),
            op(2, "B", "deq", ret=2, start=4, end=5),
        ]
        result = check_history(ops, get_model("queue"))
        self.assertIs(result.verdict, Verdict.NON_LINEARIZABLE)


class TestResourceLimit(unittest.TestCase):
    """Acceptance D: exhausting the budget yields UNKNOWN_RESOURCE, never FAIL."""

    def test_state_budget_exceeded(self):
        ops = [
            op(i, str(i), "write", arg=i + 1, start=0, end=10) for i in range(9)
        ]
        # read->99 is impossible, so the whole (large) search space is needed.
        ops.append(op(9, "R", "read", ret=99, start=11, end=12))
        result = check_history(ops, get_model("register"), max_states=200)
        self.assertIs(result.verdict, Verdict.UNKNOWN_RESOURCE)
        self.assertIsNot(result.verdict, Verdict.NON_LINEARIZABLE)

    def test_generous_budget_decides_same_history(self):
        ops = [
            op(i, str(i), "write", arg=i + 1, start=0, end=10) for i in range(9)
        ]
        ops.append(op(9, "R", "read", ret=5, start=11, end=12))
        result = check_history(ops, get_model("register"), max_states=1000000)
        self.assertIs(result.verdict, Verdict.LINEARIZABLE)


class TestHistoryParsing(unittest.TestCase):
    def test_op_records(self):
        text = json.dumps([
            {"id": 1, "thread": "A", "op": "write", "arg": 1,
             "ret": None, "start": 0, "end": 2},
            {"id": 2, "thread": "B", "op": "read", "ret": 1,
             "start": 3, "end": None},
        ])
        ops, initial = load_history_text(text)
        self.assertEqual(len(ops), 2)
        self.assertFalse(ops[0].pending)
        self.assertTrue(ops[1].pending)
        self.assertIsNone(initial)

    def test_call_return_events_matched_by_thread_and_id(self):
        text = json.dumps([
            {"type": "call", "id": 1, "thread": "A", "op": "enq",
             "arg": 7, "time": 0},
            {"type": "call", "id": 1, "thread": "B", "op": "deq", "time": 1},
            {"type": "return", "id": 1, "thread": "B", "ret": 7, "time": 2},
            {"type": "return", "id": 1, "thread": "A", "ret": None, "time": 3},
        ])
        ops, _ = load_history_text(text)
        self.assertEqual(len(ops), 2)
        by_thread = {o.thread: o for o in ops}
        self.assertEqual(by_thread["A"].end, 3)
        self.assertEqual(by_thread["B"].ret, 7)

    def test_initial_value_from_object_form(self):
        text = json.dumps({"initial": 42, "events": [
            {"thread": "A", "op": "read", "ret": 42, "start": 0, "end": 1},
        ]})
        ops, initial = load_history_text(text)
        self.assertEqual(initial, 42)
        result = check_history(ops, get_model("register", initial))
        self.assertIs(result.verdict, Verdict.LINEARIZABLE)

    def test_invalid_inputs(self):
        bad = [
            "{not json",
            json.dumps({"no_events": 1}),
            json.dumps([{"thread": "A", "op": "read", "start": "x"}]),
            json.dumps([{"thread": "A", "op": "read", "start": 5, "end": 1}]),
            json.dumps([{"type": "return", "id": 9, "thread": "A", "time": 1}]),
            json.dumps([{"thread": "A", "op": "read", "start": 0},
                        {"type": "call", "id": 1, "thread": "A",
                         "op": "read", "time": 0}]),
        ]
        for text in bad:
            with self.assertRaises(HistoryError, msg=text):
                load_history_text(text)


class TestCli(unittest.TestCase):
    def run_cli(self, *argv):
        return subprocess.run(
            [sys.executable, "-m", "lincheck", *argv],
            capture_output=True, text=True, cwd=REPO_ROOT,
        )

    def write_history(self, events):
        fd, path = tempfile.mkstemp(suffix=".json")
        with os.fdopen(fd, "w") as fh:
            json.dump(events, fh)
        self.addCleanup(os.unlink, path)
        return path

    def test_cli_linearizable_exit_0(self):
        path = self.write_history([
            {"thread": "A", "op": "write", "arg": 1, "start": 0, "end": 1},
            {"thread": "B", "op": "read", "ret": 1, "start": 2, "end": 3},
        ])
        proc = self.run_cli("verify", path, "--impl", "register")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("LINEARIZABLE", proc.stdout)
        self.assertIn("linearization:", proc.stdout)

    def test_cli_non_linearizable_exit_1(self):
        path = self.write_history([
            {"thread": "A", "op": "write", "arg": 1, "start": 0, "end": 1},
            {"thread": "B", "op": "write", "arg": 2, "start": 2, "end": 3},
            {"thread": "C", "op": "read", "ret": 1, "start": 4, "end": 5},
        ])
        proc = self.run_cli("verify", path, "--impl", "register")
        self.assertEqual(proc.returncode, 1, proc.stderr)
        self.assertIn("NON_LINEARIZABLE", proc.stdout)
        self.assertIn("minimal conflicting prefix:", proc.stdout)

    def test_cli_unknown_exit_5(self):
        path = self.write_history([
            {"thread": "A", "op": "enq", "arg": 1, "start": 0, "end": None},
            {"thread": "B", "op": "deq", "ret": 1, "start": 1, "end": 2},
        ])
        proc = self.run_cli("verify", path, "--impl", "queue")
        self.assertEqual(proc.returncode, 5, proc.stderr)
        self.assertIn("UNKNOWN", proc.stdout)
        self.assertNotIn("NON_LINEARIZABLE", proc.stdout)

    def test_cli_resource_exit_5(self):
        events = [
            {"thread": str(i), "op": "write", "arg": i + 1, "start": 0, "end": 10}
            for i in range(9)
        ]
        events.append({"thread": "R", "op": "read", "ret": 99,
                       "start": 11, "end": 12})
        path = self.write_history(events)
        proc = self.run_cli("verify", path, "--impl", "register",
                            "--max-states", "200")
        self.assertEqual(proc.returncode, 5, proc.stderr)
        self.assertIn("UNKNOWN_RESOURCE", proc.stdout)
        self.assertNotIn("NON_LINEARIZABLE", proc.stdout)

    def test_cli_invalid_input_exit_2(self):
        fd, path = tempfile.mkstemp(suffix=".json")
        with os.fdopen(fd, "w") as fh:
            fh.write("{broken")
        self.addCleanup(os.unlink, path)
        proc = self.run_cli("verify", path, "--impl", "register")
        self.assertEqual(proc.returncode, 2)

        proc = self.run_cli("verify", "/nonexistent.json", "--impl", "register")
        self.assertEqual(proc.returncode, 2)

        path = self.write_history([
            {"thread": "A", "op": "teleport", "start": 0, "end": 1},
        ])
        proc = self.run_cli("verify", path, "--impl", "register")
        self.assertEqual(proc.returncode, 2)


if __name__ == "__main__":
    unittest.main()
