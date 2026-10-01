import itertools
import json
import os
import random
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lincheck import Verdict, parse_history, verify

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAX_STATES = 200_000


def make_op(id, thread, op, arg=None, ret=None, start=0, end=None):
    return {"id": id, "thread": thread, "op": op, "arg": arg,
            "ret": ret, "start": start, "end": end}


def run_ops(ops, impl, max_states=MAX_STATES, initial=None):
    parsed, parsed_initial = parse_history(list(ops), impl)
    if initial is None:
        initial = parsed_initial
    return verify(parsed, impl, max_states=max_states, initial=initial)


def run_cli(history_data, impl, max_states=100_000):
    with tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False) as handle:
        if isinstance(history_data, str):
            handle.write(history_data)
        else:
            json.dump(history_data, handle)
        path = handle.name
    try:
        proc = subprocess.run(
            [sys.executable, "-m", "lincheck", "verify", path,
             "--impl", impl, "--max-states", str(max_states)],
            capture_output=True, text=True, cwd=REPO_ROOT)
        return proc
    finally:
        os.unlink(path)


def brute_force_linearizable(ops, initial=0):
    """Reference: try every permutation consistent with real-time order."""
    n = len(ops)

    def precedes(a, b):
        return ops[a]["end"] is not None and ops[a]["end"] <= ops[b]["start"]

    for perm in itertools.permutations(range(n)):
        ok = True
        for x in range(n):
            for y in range(x + 1, n):
                if precedes(perm[y], perm[x]):
                    ok = False
                    break
            if not ok:
                break
        if not ok:
            continue
        value = initial
        valid = True
        for idx in perm:
            op = ops[idx]
            if op["op"] == "write":
                value = op["arg"]
            else:  # read
                if op["ret"] != value:
                    valid = False
                    break
        if valid:
            return True
    return False


class TestRegisterAgainstBruteForce(unittest.TestCase):
    """Acceptance A: 3-thread register histories match brute-force reference."""

    def test_handcrafted_linearizable_three_threads(self):
        ops = [
            make_op(0, 0, "write", arg=1, start=0, end=2),
            make_op(1, 1, "read", ret=1, start=3, end=4),
            make_op(2, 2, "write", arg=2, start=1, end=5),
            make_op(3, 0, "read", ret=2, start=6, end=7),
            make_op(4, 1, "read", ret=2, start=6, end=8),
            make_op(5, 2, "write", arg=1, start=9, end=10),
            make_op(6, 0, "read", ret=1, start=11, end=12),
        ]
        result = run_ops(ops, "register")
        self.assertEqual(result.verdict, Verdict.LINEARIZABLE)
        self.assertEqual(brute_force_linearizable(ops), True)
        self.assertEqual(len(result.linearization), len(ops))
        points = [entry["point"] for entry in result.linearization]
        self.assertEqual(points, list(range(len(ops))))

    def test_handcrafted_non_linearizable_three_threads(self):
        ops = [
            make_op(0, 0, "write", arg=1, start=0, end=1),
            make_op(1, 1, "read", ret=2, start=2, end=3),
            make_op(2, 2, "write", arg=3, start=4, end=5),
            make_op(3, 0, "read", ret=1, start=6, end=7),
        ]
        result = run_ops(ops, "register")
        self.assertEqual(result.verdict, Verdict.NON_LINEARIZABLE)
        self.assertEqual(brute_force_linearizable(ops), False)

    def test_randomized_histories_match_brute_force(self):
        rng = random.Random(20261001)
        for trial in range(60):
            n = rng.randint(2, 7)
            ops = []
            for i in range(n):
                start = rng.randint(0, 12)
                end = start + rng.randint(0, 4)
                kind = rng.choice(["read", "write"])
                if kind == "write":
                    op = make_op(i, i % 3, "write", arg=rng.randint(0, 2),
                                 start=start, end=end)
                else:
                    op = make_op(i, i % 3, "read", ret=rng.randint(0, 2),
                                 start=start, end=end)
                ops.append(op)
            result = run_ops(ops, "register")
            self.assertIn(result.verdict,
                          (Verdict.LINEARIZABLE, Verdict.NON_LINEARIZABLE))
            expected = brute_force_linearizable(ops)
            actual = result.verdict == Verdict.LINEARIZABLE
            self.assertEqual(actual, expected,
                             f"trial {trial}: mismatch for {ops}")


class TestQueuePending(unittest.TestCase):
    """Acceptance B: queue history with a lost pending return is UNKNOWN."""

    PENDING_HISTORY = [
        make_op(0, 0, "enqueue", arg=1, start=0, end=1),
        make_op(1, 1, "dequeue", ret=1, start=2, end=3),
        make_op(2, 2, "dequeue", ret=1, start=4, end=5),
        make_op(3, 0, "enqueue", arg=1, start=6, end=None),  # pending
    ]

    def test_pending_lost_return_is_unknown_not_fail(self):
        result = run_ops(self.PENDING_HISTORY, "queue")
        self.assertEqual(result.verdict, Verdict.UNKNOWN)

    def test_pending_cli_exit_code(self):
        proc = run_cli(self.PENDING_HISTORY, "queue")
        self.assertEqual(proc.returncode, 5, proc.stderr)
        self.assertEqual(proc.stdout.splitlines()[0], "UNKNOWN")

    def test_same_history_without_pending_is_non_linearizable(self):
        completed = [dict(op, end=op["end"] if op["end"] is not None else 7)
                     for op in self.PENDING_HISTORY]
        result = run_ops(completed, "queue")
        self.assertEqual(result.verdict, Verdict.NON_LINEARIZABLE)

    def test_pending_can_rescue_linearization(self):
        ops = [
            make_op(0, 0, "enqueue", arg=1, start=0, end=1),
            make_op(1, 1, "dequeue", ret=1, start=2, end=3),
            make_op(2, 2, "dequeue", ret=1, start=4, end=5),
            make_op(3, 0, "enqueue", arg=1, start=3, end=None),  # overlaps
        ]
        result = run_ops(ops, "queue")
        self.assertEqual(result.verdict, Verdict.LINEARIZABLE)


class TestNonLinearizableABA(unittest.TestCase):
    """Acceptance C: an obviously illegal ABA history is NON_LINEARIZABLE."""

    ABA_HISTORY = [
        make_op(0, 0, "write", arg=1, start=0, end=1),
        make_op(1, 1, "write", arg=0, start=2, end=3),
        make_op(2, 2, "read", ret=1, start=4, end=5),
    ]

    def test_aba_verdict(self):
        result = run_ops(self.ABA_HISTORY, "register")
        self.assertEqual(result.verdict, Verdict.NON_LINEARIZABLE)
        self.assertTrue(result.conflict_prefix)
        self.assertEqual(set(result.conflict_prefix), {0, 1, 2})

    def test_aba_cli(self):
        proc = run_cli(self.ABA_HISTORY, "register")
        self.assertEqual(proc.returncode, 1, proc.stderr)
        lines = proc.stdout.splitlines()
        self.assertEqual(lines[0], "NON_LINEARIZABLE")
        details = json.loads("\n".join(lines[1:]))
        self.assertIn("conflict_prefix", details)

    def test_minimal_conflict_prefix_is_minimal(self):
        ops = [
            make_op(0, 0, "write", arg=1, start=0, end=1),
            make_op(1, 1, "read", ret=1, start=2, end=3),
            make_op(2, 2, "read", ret=0, start=4, end=5),  # first conflict
            make_op(3, 0, "write", arg=2, start=6, end=7),
        ]
        result = run_ops(ops, "register")
        self.assertEqual(result.verdict, Verdict.NON_LINEARIZABLE)
        self.assertEqual(result.conflict_prefix, [0, 1, 2])


class TestResourceLimit(unittest.TestCase):
    """Acceptance D: exceeding max-states yields UNKNOWN_RESOURCE, never FAIL."""

    def _explosive_history(self, n=10):
        ops = [make_op(i, i % 3, "write", arg=i + 1, start=0, end=100)
               for i in range(n)]
        ops.append(make_op(n, 0, "read", ret=999, start=50, end=150))
        return ops

    def test_unknown_resource(self):
        result = run_ops(self._explosive_history(), "register", max_states=500)
        self.assertEqual(result.verdict, Verdict.UNKNOWN_RESOURCE)
        self.assertNotEqual(result.verdict, Verdict.NON_LINEARIZABLE)

    def test_unknown_resource_cli_exit_code(self):
        proc = run_cli(self._explosive_history(), "register", max_states=500)
        self.assertEqual(proc.returncode, 5, proc.stderr)
        self.assertEqual(proc.stdout.splitlines()[0], "UNKNOWN_RESOURCE")

    def test_same_history_with_large_budget_decides(self):
        result = run_ops(self._explosive_history(), "register",
                         max_states=MAX_STATES)
        self.assertEqual(result.verdict, Verdict.NON_LINEARIZABLE)


class TestCliAndParsing(unittest.TestCase):
    def test_linearizable_cli_output(self):
        ops = [
            make_op(0, 0, "write", arg=1, start=0, end=2),
            make_op(1, 1, "read", ret=1, start=3, end=4),
        ]
        proc = run_cli(ops, "register")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = proc.stdout.splitlines()
        self.assertEqual(lines[0], "LINEARIZABLE")
        details = json.loads("\n".join(lines[1:]))
        self.assertEqual([e["id"] for e in details["linearization"]], [0, 1])

    def test_events_form_with_thread_id_matching(self):
        history = {"events": [
            {"type": "call", "id": 1, "thread": 0, "op": "write", "arg": 7,
             "time": 0},
            {"type": "call", "id": 2, "thread": 1, "op": "read", "time": 1},
            {"type": "return", "id": 1, "thread": 0, "time": 3},
            {"type": "return", "id": 2, "thread": 1, "ret": 7, "time": 4},
        ]}
        proc = run_cli(history, "register")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.splitlines()[0], "LINEARIZABLE")

    def test_queue_linearizable(self):
        ops = [
            make_op(0, 0, "enqueue", arg=1, start=0, end=1),
            make_op(1, 1, "enqueue", arg=2, start=0, end=2),
            make_op(2, 2, "dequeue", ret=1, start=3, end=4),
            make_op(3, 0, "dequeue", ret=2, start=5, end=6),
            make_op(4, 1, "dequeue", ret=None, start=7, end=8),
        ]
        result = run_ops(ops, "queue")
        self.assertEqual(result.verdict, Verdict.LINEARIZABLE)

    def test_invalid_json_exit_2(self):
        proc = run_cli("{not json", "register")
        self.assertEqual(proc.returncode, 2)

    def test_unknown_op_exit_2(self):
        proc = run_cli([make_op(0, 0, "frobnicate", start=0, end=1)],
                       "register")
        self.assertEqual(proc.returncode, 2)

    def test_end_before_start_exit_2(self):
        proc = run_cli([make_op(0, 0, "read", ret=0, start=5, end=1)],
                       "register")
        self.assertEqual(proc.returncode, 2)

    def test_unmatched_return_event_exit_2(self):
        history = {"events": [
            {"type": "return", "id": 9, "thread": 0, "ret": 1, "time": 1},
        ]}
        proc = run_cli(history, "register")
        self.assertEqual(proc.returncode, 2)

    def test_missing_file_exit_2(self):
        proc = subprocess.run(
            [sys.executable, "-m", "lincheck", "verify",
             "/nonexistent/history.json", "--impl", "queue"],
            capture_output=True, text=True, cwd=REPO_ROOT)
        self.assertEqual(proc.returncode, 2)

    def test_bad_max_states_exit_2(self):
        proc = run_cli([make_op(0, 0, "read", ret=0, start=0, end=1)],
                       "register", max_states=0)
        self.assertEqual(proc.returncode, 2)


if __name__ == "__main__":
    unittest.main()
