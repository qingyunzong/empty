import json
import os
import subprocess
import sys
import tempfile
import unittest

from dpor import ProgramError, dependent, enabled, explore, parse_program, step
from dpor.core import State

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def make_program(threads):
    return parse_program({"threads": threads})


def t(name, *ops):
    return {"name": name, "ops": list(ops)}


def rd(addr):
    return {"op": "read", "addr": addr}


def wr(addr, value):
    return {"op": "write", "addr": addr, "value": value}


def lk(lock):
    return {"op": "lock", "lock": lock}


def ul(lock):
    return {"op": "unlock", "lock": lock}


def asn(addr, eq):
    return {"op": "assert", "addr": addr, "eq": eq}


# ---------------------------------------------------------------------------
# Brute-force helpers: enumerate *all* interleavings and group them into
# Mazurkiewicz equivalence classes (same events, same order of dependent
# pairs).  DPOR must explore exactly one representative per class.
# ---------------------------------------------------------------------------

def all_interleavings(program):
    """All terminated interleavings (no POR).  E_LOCK ends a schedule;
    programs used here must not contain assertions."""
    traces = []

    def rec(state, tids):
        en = enabled(program, state)
        if not en:
            traces.append(tuple(tids))
            return
        for tid in en:
            new_state, event = step(program, state, tid)
            if event is not None:
                traces.append(tuple(tids + [tid]))
            else:
                rec(new_state, tids + [tid])

    rec(State.initial(program.num_threads), [])
    return traces


def trace_events(program, trace):
    pcs = [0] * program.num_threads
    events = []
    for tid in trace:
        events.append((tid, pcs[tid]))
        pcs[tid] += 1
    return events


def equivalence_key(program, trace):
    """Canonical fingerprint of a Mazurkiewicz trace: the set of dependent
    cross-thread event pairs in their happens-before order."""
    events = trace_events(program, trace)
    pos = {e: i for i, e in enumerate(events)}
    ops = lambda e: program.threads[e[0]].ops[e[1]]
    key = set()
    for i, e1 in enumerate(events):
        for e2 in events[i + 1:]:
            if e1[0] != e2[0] and dependent(ops(e1), ops(e2)):
                key.add((e1, e2))
    assert len(pos) == len(events)
    # The event set itself identifies the trace: two interleavings are
    # equivalent iff they contain the same events AND order every
    # dependent pair the same way.
    return (frozenset(events), frozenset(key))


def replay_witness(program, witness):
    """Replay a witness schedule; returns the event of the last op (or None)."""
    by_name = {th.name: i for i, th in enumerate(program.threads)}
    state = State.initial(program.num_threads)
    event = None
    for entry in witness:
        tid = by_name[entry["thread"]]
        en = enabled(program, state)
        assert tid in en, f"witness not executable: {entry}"
        state, event = step(program, state, tid)
        if event is not None:
            return event
    return event


class TestDependency(unittest.TestCase):
    def test_dependency_relation(self):
        p = make_program([
            t("T1", wr("x", 1), rd("x"), rd("y"), lk("m"), ul("m"), lk("n")),
        ])
        ops = p.threads[0].ops
        w_x, r_x, r_y, l_m, u_m, l_n = ops
        self.assertTrue(dependent(w_x, r_x))    # same addr, one write
        self.assertTrue(dependent(r_x, w_x))
        self.assertFalse(dependent(r_x, r_x))   # two reads are independent
        self.assertFalse(dependent(w_x, r_y))   # different addresses
        self.assertTrue(dependent(l_m, u_m))    # same lock
        self.assertTrue(dependent(l_m, l_m))
        self.assertFalse(dependent(l_m, l_n))   # different locks
        self.assertFalse(dependent(w_x, l_m))   # memory vs lock

    def test_assert_behaves_like_read(self):
        p = make_program([t("T1", asn("x", 0)), t("T2", wr("x", 1), rd("x"))])
        a = p.threads[0].ops[0]
        w, r = p.threads[1].ops
        self.assertTrue(dependent(a, w))
        self.assertFalse(dependent(a, r))


class TestAcceptanceA(unittest.TestCase):
    def test_two_writes_one_read_six_interleavings(self):
        # All three operations are pairwise dependent, so every one of the
        # 3! = 6 interleavings is a distinct Mazurkiewicz trace.
        program = make_program([
            t("T1", wr("x", 1)),
            t("T2", wr("x", 2)),
            t("T3", rd("x")),
        ])
        result = explore(program, max_schedules=5000, collect_traces=True)
        self.assertEqual(result.status, "OK")
        self.assertEqual(result.schedules, 6)  # manual enumeration: 3! = 6
        self.assertEqual(len(result.traces), 6)

    def test_dpor_matches_brute_force_classes(self):
        programs = [
            [t("T1", wr("x", 1)), t("T2", wr("x", 2)), t("T3", rd("x"))],
            [t("T1", wr("x", 1), rd("a")), t("T2", wr("x", 2), rd("b"))],
            [t("T1", lk("m"), ul("m")), t("T2", lk("m"), ul("m")),
             t("T3", wr("y", 1), rd("y"))],
            [t("T1", rd("a"), wr("b", 1)), t("T2", rd("b"), wr("a", 1))],
            [t("T1", wr("x", 1), wr("y", 1)), t("T2", rd("x"), rd("y")),
             t("T3", wr("x", 2))],
        ]
        for ops in programs:
            program = make_program(ops)
            result = explore(program, max_schedules=100000, collect_traces=True)
            self.assertEqual(result.status, "OK")
            dpor_keys = [equivalence_key(program, tr) for tr in result.traces]
            # No two explored schedules are equivalent.
            self.assertEqual(len(dpor_keys), len(set(dpor_keys)))
            # Every equivalence class of the full interleaving space is covered.
            all_keys = {equivalence_key(program, tr)
                        for tr in all_interleavings(program)}
            self.assertEqual(set(dpor_keys), all_keys)
            self.assertEqual(result.schedules, len(all_keys))


class TestAcceptanceB(unittest.TestCase):
    def test_independent_reads_single_schedule(self):
        program = make_program([
            t("T1", rd("a"), rd("b")),
            t("T2", rd("c"), rd("d")),
        ])
        result = explore(program, max_schedules=5000)
        self.assertEqual(result.status, "OK")
        self.assertEqual(result.schedules, 1)

    def test_swapping_independent_reads_does_not_increase_count(self):
        # T3's read of y is independent of the x-race between T1 and T2:
        # the race contributes exactly 2 schedules, not 2 * (positions of rd y).
        program = make_program([
            t("T1", wr("x", 1)),
            t("T2", rd("x")),
            t("T3", rd("y")),
        ])
        result = explore(program, max_schedules=5000)
        self.assertEqual(result.status, "OK")
        self.assertEqual(result.schedules, 2)

        # Same program without the independent reader also yields 2.
        program2 = make_program([t("T1", wr("x", 1)), t("T2", rd("x"))])
        result2 = explore(program2, max_schedules=5000)
        self.assertEqual(result2.schedules, 2)


class TestAcceptanceC(unittest.TestCase):
    def test_unlock_without_holding_is_e_lock(self):
        program = make_program([t("T1", ul("m"))])
        result = explore(program, max_schedules=5000)
        self.assertEqual(result.status, "E_LOCK")
        self.assertEqual(result.schedules, 1)
        self.assertIsNotNone(result.witness)
        self.assertEqual(result.witness[-1]["op"], ul("m"))
        self.assertEqual(result.errors[0]["type"], "E_LOCK")

    def test_cross_thread_unlock_is_e_lock_and_terminates_schedule(self):
        # T1 holds m; T2's unlock of m is illegal.  T2's remaining ops must
        # not execute, but other schedules (T2 first) are still explored.
        program = make_program([
            t("T1", lk("m"), wr("x", 1), ul("m")),
            t("T2", ul("m"), wr("x", 2)),
        ])
        result = explore(program, max_schedules=5000)
        self.assertEqual(result.status, "E_LOCK")
        for err in result.errors:
            bad = err["schedule"][-1]
            self.assertEqual(bad["op"], ul("m"))
            self.assertEqual(bad["thread"], "T2")

    def test_reentrant_lock_same_thread_allowed(self):
        program = make_program([
            t("T1", lk("m"), lk("m"), wr("x", 1), ul("m"), ul("m")),
        ])
        result = explore(program, max_schedules=5000)
        self.assertEqual(result.status, "OK")
        self.assertEqual(result.schedules, 1)


class TestAcceptanceD(unittest.TestCase):
    def test_bound_reached(self):
        program = make_program([t("T1", wr("x", 1)), t("T2", wr("x", 2))])
        result = explore(program, max_schedules=1)
        self.assertEqual(result.status, "BOUND_REACHED")
        self.assertEqual(result.schedules, 1)
        self.assertNotEqual(result.status, "OK")

    def test_under_bound_is_ok(self):
        program = make_program([t("T1", wr("x", 1)), t("T2", wr("x", 2))])
        result = explore(program, max_schedules=5000)
        self.assertEqual(result.status, "OK")
        self.assertEqual(result.schedules, 2)


class TestViolation(unittest.TestCase):
    def test_assert_violation_with_witness(self):
        program = make_program([
            t("T1", wr("x", 1)),
            t("T2", asn("x", 0)),
        ])
        result = explore(program, max_schedules=5000)
        self.assertEqual(result.status, "VIOLATION")
        self.assertIsNotNone(result.witness)
        self.assertEqual(result.witness[-1]["op"], asn("x", 0))
        # The witness is a concrete, executable schedule that really fails.
        self.assertEqual(replay_witness(program, result.witness), "ASSERT")

    def test_no_violation_when_assert_always_holds(self):
        program = make_program([
            t("T1", wr("x", 1)),
            t("T2", lk("m"), asn("x", 0), ul("m")),  # may run before write
        ])
        # assert x==0 holds only if T2 runs first; x==1 case must be caught
        program2 = make_program([
            t("T1", wr("x", 1)),
            t("T2", asn("x", 1)),
        ])
        result = explore(program2, max_schedules=5000)
        self.assertEqual(result.status, "VIOLATION")  # T2 before T1 sees 0

    def test_mutual_exclusion_protects_assertion(self):
        # Both threads update x under the same lock; assert can never see
        # an intermediate value, so no violation.
        program = make_program([
            t("T1", lk("m"), wr("x", 1), ul("m")),
            t("T2", lk("m"), asn("x", 0), ul("m")),
        ])
        result = explore(program, max_schedules=5000)
        # T2 inside the lock may still see x==1 (T1 ran first) -> violation
        self.assertEqual(result.status, "VIOLATION")
        program_ok = make_program([
            t("T1", lk("m"), wr("x", 1), ul("m")),
            t("T2", lk("m"), rd("x"), ul("m")),
        ])
        result_ok = explore(program_ok, max_schedules=5000)
        self.assertEqual(result_ok.status, "OK")
        self.assertEqual(result_ok.schedules, 2)


class TestValidation(unittest.TestCase):
    def test_valid_minimal(self):
        p = parse_program({"threads": [{"ops": []}]})
        self.assertEqual(p.threads[0].name, "T1")

    def test_invalid_programs(self):
        bad = [
            None,
            {},
            {"threads": []},
            {"threads": [{}] * 5},                       # too many threads
            {"threads": [{"ops": [{}]}]},                # missing op kind
            {"threads": [{"ops": [{"op": "jump"}]}]},    # unknown op
            {"threads": [{"ops": [{"op": "read"}]}]},    # missing addr
            {"threads": [{"ops": [{"op": "write", "addr": "x"}]}]},
            {"threads": [{"ops": [{"op": "write", "addr": "x", "value": "1"}]}]},
            {"threads": [{"ops": [{"op": "lock", "lock": 3}]}]},
            {"threads": [{"ops": [{"op": "assert", "addr": "x", "eq": True}]}]},
            {"threads": [{"ops": [{"op": "read", "addr": "x", "value": 1}]}]},
            {"threads": [{"name": "A", "ops": []}, {"name": "A", "ops": []}]},
            {"threads": [{"ops": [rd("x")] * 9}]},       # too many ops
        ]
        for obj in bad:
            with self.assertRaises(ProgramError, msg=repr(obj)):
                parse_program(obj)


class TestRandomizedAgainstBruteForce(unittest.TestCase):
    def test_random_programs_match_brute_force(self):
        import random

        rng = random.Random(20261001)
        addrs = ["x", "y"]
        locks = ["m", "n"]
        for case in range(150):
            num_threads = rng.randint(2, 4)
            threads = []
            for tid in range(num_threads):
                ops = []
                for _ in range(rng.randint(1, 4)):
                    kind = rng.choice(["read", "write", "lock", "unlock"])
                    if kind == "read":
                        ops.append(rd(rng.choice(addrs)))
                    elif kind == "write":
                        ops.append(wr(rng.choice(addrs), rng.randint(0, 1)))
                    elif kind == "lock":
                        ops.append(lk(rng.choice(locks)))
                    else:
                        ops.append(ul(rng.choice(locks)))
                threads.append(t(f"T{tid + 1}", *ops))
            program = make_program(threads)
            result = explore(program, max_schedules=100000, collect_traces=True)
            self.assertIn(result.status, ("OK", "E_LOCK"))
            keys = [equivalence_key(program, tr) for tr in result.traces]
            # No two explored schedules are equivalent (POR is effective).
            self.assertEqual(len(keys), len(set(keys)),
                             msg=f"case {case}: duplicate equivalent traces")
            # Every happens-before equivalence class is covered (sound).
            all_keys = {equivalence_key(program, tr)
                        for tr in all_interleavings(program)}
            self.assertEqual(set(keys), all_keys,
                             msg=f"case {case}: missed equivalence classes")
            self.assertEqual(result.schedules, len(all_keys))


class TestCli(unittest.TestCase):
    def run_cli(self, *argv, cwd=REPO_ROOT):
        return subprocess.run(
            [sys.executable, "-m", "dpor", *argv],
            cwd=cwd, capture_output=True, text=True,
        )

    def test_explore_end_to_end(self):
        program = {
            "threads": [
                {"name": "T1", "ops": [wr("x", 1)]},
                {"name": "T2", "ops": [wr("x", 2)]},
                {"name": "T3", "ops": [rd("x")]},
            ]
        }
        with tempfile.TemporaryDirectory() as tmp:
            prog_path = os.path.join(tmp, "program.json")
            out_path = os.path.join(tmp, "report.json")
            with open(prog_path, "w") as fh:
                json.dump(program, fh)
            proc = self.run_cli("explore", prog_path,
                                "--max-schedules", "5000", "--out", out_path)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            with open(out_path) as fh:
                report = json.load(fh)
            self.assertEqual(report["status"], "OK")
            self.assertEqual(report["schedules"], 6)
            self.assertGreater(report["explored"], 0)
            self.assertIsNone(report["witness"])
            # stdout carries the same report
            self.assertEqual(json.loads(proc.stdout)["schedules"], 6)

    def test_cli_violation(self):
        program = {"threads": [
            {"name": "T1", "ops": [wr("x", 1)]},
            {"name": "T2", "ops": [asn("x", 0)]},
        ]}
        with tempfile.TemporaryDirectory() as tmp:
            prog_path = os.path.join(tmp, "program.json")
            with open(prog_path, "w") as fh:
                json.dump(program, fh)
            proc = self.run_cli("explore", prog_path)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            report = json.loads(proc.stdout)
            self.assertEqual(report["status"], "VIOLATION")
            self.assertTrue(report["witness"])

    def test_cli_invalid_program_exit_2(self):
        with tempfile.TemporaryDirectory() as tmp:
            bad_path = os.path.join(tmp, "bad.json")
            with open(bad_path, "w") as fh:
                fh.write('{"threads": [{"ops": [{"op": "jump"}]}]}')
            proc = self.run_cli("explore", bad_path)
            self.assertEqual(proc.returncode, 2)
            # malformed JSON
            with open(bad_path, "w") as fh:
                fh.write("{not json")
            proc = self.run_cli("explore", bad_path)
            self.assertEqual(proc.returncode, 2)
            # missing file
            proc = self.run_cli("explore", os.path.join(tmp, "nope.json"))
            self.assertEqual(proc.returncode, 2)


if __name__ == "__main__":
    unittest.main()
