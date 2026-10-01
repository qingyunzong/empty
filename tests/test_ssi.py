import json
import os
import subprocess
import sys
import unittest
from itertools import product

from ssi import SERIALIZATION_FAILURE, WRITE_CONFLICT, Engine
from ssi.reference import RefTx, is_serializable

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class WriteSkewTest(unittest.TestCase):
    """(a) Classic write skew: A reads x writes y, B reads y writes x."""

    def run_skew(self, first, second):
        eng = Engine()
        eng.begin("A")
        eng.begin("B")
        eng.read("A", "x")
        eng.write("A", "y", 1)
        eng.read("B", "y")
        eng.write("B", "x", 2)
        return eng.commit(first), eng.commit(second)

    def test_one_side_fails_with_serialization_failure(self):
        for first, second in (("A", "B"), ("B", "A")):
            with self.subTest(first=first):
                r_first, r_second = self.run_skew(first, second)
                self.assertIsNone(r_first)
                self.assertEqual(r_second, SERIALIZATION_FAILURE)

    def test_exactly_one_aborts(self):
        for first, second in (("A", "B"), ("B", "A")):
            results = self.run_skew(first, second)
            self.assertEqual(sorted(r is None for r in results), [False, True])


class ConflictFreeTest(unittest.TestCase):
    """(b) Concurrent transactions without conflicts all succeed."""

    def test_disjoint_read_write_sets(self):
        eng = Engine()
        eng.begin("A")
        eng.begin("B")
        eng.read("A", "x")
        eng.write("A", "a", 1)
        eng.read("B", "y")
        eng.write("B", "b", 2)
        self.assertIsNone(eng.commit("A"))
        self.assertIsNone(eng.commit("B"))
        self.assertEqual(eng.snapshot(), {"a": 1, "b": 2})

    def test_shared_read_only_key_disjoint_writes(self):
        eng = Engine()
        eng.begin("A")
        eng.begin("B")
        eng.read("A", "x")
        eng.write("A", "a", 1)
        eng.read("B", "x")
        eng.write("B", "b", 2)
        self.assertIsNone(eng.commit("A"))
        self.assertIsNone(eng.commit("B"))


class ReadOnlyTest(unittest.TestCase):
    """(c) A read-only transaction concurrent with a writer never aborts."""

    def test_read_only_commits_before_and_after_writer(self):
        for order in (("R", "W"), ("W", "R")):
            with self.subTest(order=order):
                eng = Engine()
                eng.begin("R")
                eng.begin("W")
                eng.read("R", "x")
                eng.read("R", "y")
                eng.write("W", "x", 10)
                eng.write("W", "y", 20)
                results = {tx: eng.commit(tx) for tx in order}
                self.assertIsNone(results["R"])
                self.assertIsNone(results["W"])

    def test_read_only_never_aborts_even_with_rw_antidependency(self):
        # R reads keys W overwrites; W committed first. R still commits.
        eng = Engine()
        eng.begin("R")
        eng.begin("W")
        eng.read("R", "x")
        eng.write("W", "x", 1)
        self.assertIsNone(eng.commit("W"))
        self.assertIsNone(eng.commit("R"))


class WriteConflictTest(unittest.TestCase):
    """Write-write conflicts: first-committer-wins."""

    def test_concurrent_writers_same_key(self):
        eng = Engine()
        eng.begin("A")
        eng.begin("B")
        eng.write("A", "x", 1)
        eng.write("B", "x", 2)
        self.assertIsNone(eng.commit("A"))
        self.assertEqual(eng.commit("B"), WRITE_CONFLICT)
        self.assertEqual(eng.snapshot(), {"x": 1})

    def test_sequential_writers_no_conflict(self):
        eng = Engine()
        eng.begin("A")
        eng.write("A", "x", 1)
        self.assertIsNone(eng.commit("A"))
        eng.begin("B")  # begins after A committed: not concurrent
        eng.write("B", "x", 2)
        self.assertIsNone(eng.commit("B"))
        self.assertEqual(eng.snapshot(), {"x": 2})


class SnapshotTest(unittest.TestCase):
    def test_snapshot_reads_and_read_own_writes(self):
        eng = Engine()
        eng.begin("S")
        eng.write("S", "x", 1)
        self.assertIsNone(eng.commit("S"))
        eng.begin("R")
        eng.begin("W")
        eng.write("W", "x", 2)
        self.assertIsNone(eng.commit("W"))
        # R's snapshot predates W's commit.
        self.assertEqual(eng.read("R", "x"), 1)
        # Read-your-own-writes.
        eng.write("R", "z", 99)
        self.assertEqual(eng.read("R", "z"), 99)
        self.assertIsNone(eng.commit("R"))


# ---------------------------------------------------------------------------
# (d) Exhaustive comparison against the reference serializability checker.
# ---------------------------------------------------------------------------

KEYS = ("x", "y")
OPS = [("read", k) for k in KEYS] + [("write", k) for k in KEYS]


def op_sequences(max_len=3):
    seqs = [()]
    for n in range(1, max_len + 1):
        seqs.extend(product(OPS, repeat=n))
    return seqs


def read_set(ops):
    return {k for op, k in ops if op == "read"}


def write_set(ops):
    return {k for op, k in ops if op == "write"}


def run_scenario(ops1, ops2, order):
    """Run both transactions under the engine; commit in `order`.

    Returns (engine, {tx_id: commit result or None}).
    """
    eng = Engine()
    eng.begin("T1")
    eng.begin("T2")
    for tx, ops in (("T1", ops1), ("T2", ops2)):
        for op, key in ops:
            if op == "read":
                eng.read(tx, key)
            else:
                eng.write(tx, key, "%s:%s" % (tx, key))
    results = {}
    for tx in order:
        results[tx] = eng.commit(tx)
    return eng, results


def expected_results(ops_first, ops_second):
    """Expected commit outcomes when the first transaction commits first.

    (err_first, err_second) where None means a successful commit.
    """
    rs_f, ws_f = read_set(ops_first), write_set(ops_first)
    rs_s, ws_s = read_set(ops_second), write_set(ops_second)
    if ws_f and ws_s and ws_f & ws_s:
        # First-committer-wins on the overlapping write sets.
        return None, WRITE_CONFLICT
    t_f = RefTx("F", begin_ts=0, commit_ts=1, read_set=rs_f, write_set=ws_f)
    t_s = RefTx("S", begin_ts=0, commit_ts=2, read_set=rs_s, write_set=ws_s)
    if is_serializable([t_f, t_s]):
        return None, None
    # Not serializable: exactly one side must abort, and under SSI the
    # later committer is the one that closes the dangerous cycle.
    return None, SERIALIZATION_FAILURE


class ExhaustiveComparisonTest(unittest.TestCase):
    """(d) Exhaustive 2-transaction scenarios (<=3 ops each) compared
    decision-by-decision against the reference checker."""

    def test_all_small_scenarios(self):
        sequences = op_sequences(max_len=3)
        checked = 0
        for ops1 in sequences:
            for ops2 in sequences:
                for order in (("T1", "T2"), ("T2", "T1")):
                    with self.subTest(ops1=ops1, ops2=ops2, order=order):
                        self.check_scenario(ops1, ops2, order)
                    checked += 1
        self.assertEqual(checked, len(sequences) ** 2 * 2)

    def check_scenario(self, ops1, ops2, order):
        eng, results = run_scenario(ops1, ops2, order)
        first, second = order
        ops = {"T1": ops1, "T2": ops2}
        exp_first, exp_second = expected_results(ops[first], ops[second])
        self.assertEqual(results[first], exp_first,
                         "first committer %s" % first)
        self.assertEqual(results[second], exp_second,
                         "second committer %s" % second)
        # The committed set must always be serializable per the reference.
        committed = [t for t in (eng._txs["T1"], eng._txs["T2"])
                     if t.status == "committed"]
        self.assertTrue(is_serializable(committed),
                        "committed set not serializable: %r" %
                        ([(t.id, t.read_set, t.write_set) for t in committed],))
        # At most one abort in a two-transaction scenario.
        aborts = sum(r is not None for r in results.values())
        self.assertLessEqual(aborts, 1)


class CLITest(unittest.TestCase):
    def run_cli(self, commands):
        payload = "\n".join(json.dumps(c) for c in commands) + "\n"
        proc = subprocess.run(
            [sys.executable, "-m", "ssi"],
            input=payload, capture_output=True, text=True, cwd=REPO_ROOT)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return [json.loads(line) for line in proc.stdout.splitlines()]

    def test_write_skew_over_json_lines(self):
        resp = self.run_cli([
            {"cmd": "begin", "tx": "A"},
            {"cmd": "begin", "tx": "B"},
            {"cmd": "read", "tx": "A", "key": "x"},
            {"cmd": "read", "tx": "B", "key": "y"},
            {"cmd": "write", "tx": "A", "key": "y", "value": 1},
            {"cmd": "write", "tx": "B", "key": "x", "value": 2},
            {"cmd": "commit", "tx": "A"},
            {"cmd": "commit", "tx": "B"},
            {"cmd": "dump"},
        ])
        self.assertTrue(all(r["ok"] for r in resp[:6]))
        self.assertEqual(resp[6], {"ok": True, "committed": True})
        self.assertEqual(resp[7], {"ok": False, "committed": False,
                                   "error": SERIALIZATION_FAILURE})
        self.assertEqual(resp[8], {"ok": True, "store": {"y": 1}})

    def test_error_responses(self):
        resp = self.run_cli([
            {"cmd": "read", "tx": "ghost", "key": "x"},
            {"cmd": "nonsense"},
        ])
        self.assertFalse(resp[0]["ok"])
        self.assertIn("unknown transaction", resp[0]["error"])
        self.assertFalse(resp[1]["ok"])
        self.assertIn("unknown command", resp[1]["error"])


if __name__ == "__main__":
    unittest.main()
