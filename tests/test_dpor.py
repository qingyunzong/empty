import json
import os
import subprocess
import sys
import tempfile
import unittest

from dpor import semantics as sem
from dpor.explorer import Explorer, fingerprint
from dpor.model import ProgramError, validate_program

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def explore(program_dict, max_schedules=5000):
    program = validate_program(program_dict)
    return Explorer(program, max_schedules=max_schedules).run()


def brute_force_class_count(program_dict):
    """Enumerate every interleaving and count Mazurkiewicz classes."""
    program = validate_program(program_dict)
    classes = set()

    def rec(prefix):
        state, trace = sem.replay(program, prefix)
        if state.error is not None:
            classes.add(fingerprint(trace))
            return
        enabled = sem.enabled_threads(program, state)
        if not enabled:
            classes.add(fingerprint(trace))
            return
        for tid in enabled:
            rec(prefix + (tid,))

    rec(())
    return len(classes)


# Acceptance A: two writes and one read racing on the same address.
RACE_PROGRAM = {
    "threads": [
        [{"op": "write", "addr": "x", "value": 1}],
        [{"op": "write", "addr": "x", "value": 2}],
        [{"op": "read", "addr": "x", "dst": "r0"}],
    ]
}

# Acceptance B: independent reads only.
INDEPENDENT_READS = {
    "threads": [
        [{"op": "read", "addr": "x", "dst": "a"}],
        [{"op": "read", "addr": "x", "dst": "b"}],
        [{"op": "read", "addr": "y", "dst": "c"}],
    ]
}

# Acceptance C: unlock of a lock not held by the thread.
BAD_UNLOCK = {
    "threads": [
        [{"op": "lock", "lock": "L"}],
        [{"op": "unlock", "lock": "L"}],
    ]
}

STALE_READ_ASSERT = {
    "threads": [
        [{"op": "write", "addr": "x", "value": 1}],
        [{"op": "read", "addr": "x", "dst": "r"},
         {"op": "assert", "var": "r", "equals": 1}],
    ]
}

LOCKED_COUNTER = {
    "threads": [
        [{"op": "lock", "lock": "L"},
         {"op": "read", "addr": "x", "dst": "r"},
         {"op": "write", "addr": "x", "value": 1},
         {"op": "unlock", "lock": "L"}],
        [{"op": "lock", "lock": "L"},
         {"op": "read", "addr": "x", "dst": "r"},
         {"op": "write", "addr": "x", "value": 2},
         {"op": "unlock", "lock": "L"}],
    ]
}

REENTRANT_LOCK = {
    "threads": [
        [{"op": "lock", "lock": "L"},
         {"op": "lock", "lock": "L"},
         {"op": "unlock", "lock": "L"},
         {"op": "unlock", "lock": "L"}],
    ]
}


class AcceptanceTests(unittest.TestCase):
    def test_a_race_schedule_count_matches_hand_enumeration(self):
        # All three ops are pairwise dependent, so every one of the 3! = 6
        # interleavings is a distinct equivalence class.
        explorer = explore(RACE_PROGRAM)
        self.assertEqual(explorer.status, "OK")
        self.assertEqual(explorer.schedules, 6)
        self.assertEqual(explorer.schedules,
                         brute_force_class_count(RACE_PROGRAM))

    def test_b_swapping_independent_reads_adds_no_schedules(self):
        explorer = explore(INDEPENDENT_READS)
        self.assertEqual(explorer.status, "OK")
        self.assertEqual(explorer.schedules, 1)
        self.assertEqual(explorer.executions, 1)

    def test_c_unlock_without_ownership_is_e_lock(self):
        explorer = explore(BAD_UNLOCK)
        self.assertEqual(explorer.status, "E_LOCK")
        self.assertIsNotNone(explorer.witness)
        last = explorer.witness[-1]
        self.assertEqual(last["op"]["op"], "unlock")
        self.assertEqual(last["thread"], 1)

    def test_d_bound_reached_with_max_schedules_1(self):
        explorer = explore(RACE_PROGRAM, max_schedules=1)
        self.assertEqual(explorer.status, "BOUND_REACHED")
        self.assertNotEqual(explorer.status, "OK")
        self.assertEqual(explorer.schedules, 1)


class SemanticsTests(unittest.TestCase):
    def test_assert_violation_reports_witness(self):
        explorer = explore(STALE_READ_ASSERT)
        self.assertEqual(explorer.status, "VIOLATION")
        self.assertIsNotNone(explorer.witness)
        self.assertEqual(explorer.witness[-1]["op"]["op"], "assert")
        # The failing schedule reads x before the write lands.
        self.assertEqual(explorer.witness[0]["thread"], 1)

    def test_reentrant_lock_same_thread_is_allowed(self):
        explorer = explore(REENTRANT_LOCK)
        self.assertEqual(explorer.status, "OK")
        self.assertEqual(explorer.schedules, 1)

    def test_unlock_of_free_lock_is_e_lock(self):
        program = {"threads": [[{"op": "unlock", "lock": "L"}]]}
        explorer = explore(program)
        self.assertEqual(explorer.status, "E_LOCK")

    def test_dpor_matches_brute_force_on_locked_counter(self):
        # Lock discipline forces the critical sections to run atomically:
        # exactly 2 non-equivalent schedules.
        self.assertEqual(brute_force_class_count(LOCKED_COUNTER), 2)
        explorer = explore(LOCKED_COUNTER)
        self.assertEqual(explorer.status, "OK")
        self.assertEqual(explorer.schedules, 2)

    def test_dpor_matches_brute_force_on_mixed_program(self):
        program = {
            "threads": [
                [{"op": "write", "addr": "x", "value": 1},
                 {"op": "read", "addr": "y", "dst": "a"}],
                [{"op": "read", "addr": "x", "dst": "b"},
                 {"op": "write", "addr": "y", "value": 7}],
                [{"op": "read", "addr": "x", "dst": "c"}],
            ]
        }
        expected = brute_force_class_count(program)
        explorer = explore(program)
        self.assertEqual(explorer.status, "OK")
        self.assertEqual(explorer.schedules, expected)

    def test_invalid_programs_are_rejected(self):
        bad_programs = [
            {},  # no threads
            {"threads": []},  # zero threads
            {"threads": [[]] * 5},  # too many threads
            {"threads": [[{"op": "read", "addr": "x"}] * 9]},  # >8 ops
            {"threads": [[{"op": "jump"}]]},  # unknown op
            {"threads": [[{"op": "write", "addr": "x"}]]},  # no value
            {"threads": [[{"op": "assert", "var": "r"}]]},  # no equals
        ]
        for bad in bad_programs:
            with self.assertRaises(ProgramError, msg=repr(bad)):
                validate_program(bad)


class CliTests(unittest.TestCase):
    def run_cli(self, args, cwd=REPO_ROOT):
        return subprocess.run(
            [sys.executable, "-m", "dpor"] + args,
            cwd=cwd, capture_output=True, text=True)

    def test_cli_explore_writes_report(self):
        with tempfile.TemporaryDirectory() as tmp:
            program_path = os.path.join(tmp, "program.json")
            report_path = os.path.join(tmp, "report.json")
            with open(program_path, "w") as handle:
                json.dump(RACE_PROGRAM, handle)
            result = self.run_cli(
                ["explore", program_path,
                 "--max-schedules", "5000", "--out", report_path])
            self.assertEqual(result.returncode, 0, result.stderr)
            with open(report_path) as handle:
                report = json.load(handle)
            self.assertEqual(report["status"], "OK")
            self.assertEqual(report["schedules"], 6)
            self.assertIn("explored", report)
            self.assertIsNone(report["witness"])

    def test_cli_invalid_program_exits_2(self):
        with tempfile.TemporaryDirectory() as tmp:
            program_path = os.path.join(tmp, "bad.json")
            with open(program_path, "w") as handle:
                json.dump({"threads": [[{"op": "jump"}]]}, handle)
            result = self.run_cli(["explore", program_path])
            self.assertEqual(result.returncode, 2)

    def test_cli_bound_reached(self):
        with tempfile.TemporaryDirectory() as tmp:
            program_path = os.path.join(tmp, "program.json")
            with open(program_path, "w") as handle:
                json.dump(RACE_PROGRAM, handle)
            result = self.run_cli(
                ["explore", program_path, "--max-schedules", "1"])
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(result.stdout)
            self.assertEqual(report["status"], "BOUND_REACHED")


if __name__ == "__main__":
    unittest.main()
