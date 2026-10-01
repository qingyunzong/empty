import io
import json
import unittest

from ssi import Engine, SerializationFailure, WriteConflict
from ssi.cli import serve


class WriteSkewTest(unittest.TestCase):
    """(a) Classic write skew: A reads x writes y, B reads y writes x.
    Exactly one of the two commits must fail with SERIALIZATION_FAILURE."""

    def run_skew(self, commit_order):
        engine = Engine({"x": 0, "y": 0})
        a = engine.begin()
        b = engine.begin()
        engine.read(a, "x")
        engine.write(a, "y", 1)
        engine.read(b, "y")
        engine.write(b, "x", 1)
        results = {}
        for tid, name in commit_order:
            try:
                engine.commit(tid)
                results[name] = "OK"
            except SerializationFailure:
                results[name] = "SERIALIZATION_FAILURE"
        return results

    def test_skew_a_commits_first(self):
        results = self.run_skew([(1, "A"), (2, "B")])
        self.assertEqual(results, {"A": "OK", "B": "SERIALIZATION_FAILURE"})

    def test_skew_b_commits_first(self):
        results = self.run_skew([(2, "B"), (1, "A")])
        self.assertEqual(results, {"B": "OK", "A": "SERIALIZATION_FAILURE"})

    def test_exactly_one_survives(self):
        for order in ([(1, "A"), (2, "B")], [(2, "B"), (1, "A")]):
            results = self.run_skew(order)
            self.assertEqual(sorted(results.values()),
                             ["OK", "SERIALIZATION_FAILURE"])


class NoConflictTest(unittest.TestCase):
    """(b) Concurrent transactions without conflicts all succeed."""

    def test_disjoint_keys(self):
        engine = Engine({"x": 0, "y": 0})
        a = engine.begin()
        b = engine.begin()
        engine.write(a, "x", 1)
        engine.write(b, "y", 2)
        self.assertEqual(engine.commit(a), "OK")
        self.assertEqual(engine.commit(b), "OK")
        self.assertEqual(engine.dump(), {"x": 1, "y": 2})

    def test_shared_read_disjoint_writes(self):
        engine = Engine({"x": 0, "y": 0, "z": 0})
        a = engine.begin()
        b = engine.begin()
        engine.read(a, "z")
        engine.write(a, "x", 1)
        engine.read(b, "z")
        engine.write(b, "y", 2)
        self.assertEqual(engine.commit(a), "OK")
        self.assertEqual(engine.commit(b), "OK")


class ReadOnlyTest(unittest.TestCase):
    """(c) A read-only transaction concurrent with a writer never aborts."""

    def test_read_only_never_aborts(self):
        engine = Engine({"x": 0})
        reader = engine.begin()
        writer = engine.begin()
        self.assertEqual(engine.read(reader, "x"), 0)
        engine.write(writer, "x", 1)
        self.assertEqual(engine.commit(writer), "OK")
        # Snapshot: reader still sees the old value.
        self.assertEqual(engine.read(reader, "x"), 0)
        self.assertEqual(engine.commit(reader), "OK")

    def test_read_only_in_cycle_shape_still_commits(self):
        # Reader's reads overlap the writer's writes, but the reader has no
        # writes, so no dangerous structure can exist.
        engine = Engine({"x": 0, "y": 0})
        reader = engine.begin()
        writer = engine.begin()
        engine.read(reader, "x")
        engine.read(reader, "y")
        engine.read(writer, "x")
        engine.write(writer, "y", 1)
        self.assertEqual(engine.commit(reader), "OK")
        self.assertEqual(engine.commit(writer), "OK")


class WriteWriteConflictTest(unittest.TestCase):
    """Write/write conflicts are first-committer-wins -> WRITE_CONFLICT."""

    def test_first_committer_wins(self):
        engine = Engine({"x": 0})
        a = engine.begin()
        b = engine.begin()
        engine.write(a, "x", 1)
        engine.write(b, "x", 2)
        self.assertEqual(engine.commit(a), "OK")
        with self.assertRaises(WriteConflict):
            engine.commit(b)
        self.assertEqual(engine.dump(), {"x": 1})

    def test_loser_may_retry(self):
        engine = Engine({"x": 0})
        a = engine.begin()
        b = engine.begin()
        engine.write(a, "x", 1)
        engine.write(b, "x", 2)
        engine.commit(a)
        with self.assertRaises(WriteConflict):
            engine.commit(b)
        c = engine.begin()
        engine.write(c, "x", 2)
        self.assertEqual(engine.commit(c), "OK")
        self.assertEqual(engine.dump(), {"x": 2})


class SnapshotTest(unittest.TestCase):
    def test_snapshot_isolation_reads(self):
        engine = Engine({"x": 0})
        a = engine.begin()
        b = engine.begin()
        engine.write(b, "x", 1)
        engine.commit(b)
        self.assertEqual(engine.read(a, "x"), 0)
        c = engine.begin()
        self.assertEqual(engine.read(c, "x"), 1)

    def test_read_own_writes(self):
        engine = Engine({"x": 0})
        a = engine.begin()
        engine.write(a, "x", 5)
        self.assertEqual(engine.read(a, "x"), 5)
        engine.commit(a)

    def test_non_overlapping_intervals_are_not_concurrent(self):
        # T2 begins after T1 commits: no concurrency, no false positive even
        # though the rw pattern matches the dangerous structure.
        engine = Engine({"x": 0, "y": 0})
        a = engine.begin()
        engine.read(a, "x")
        engine.write(a, "y", 1)
        engine.commit(a)
        b = engine.begin()
        engine.read(b, "y")
        engine.write(b, "x", 1)
        self.assertEqual(engine.commit(b), "OK")


class CliTest(unittest.TestCase):
    def run_cli(self, lines):
        stdin = io.StringIO("\n".join(json.dumps(x) for x in lines) + "\n")
        stdout = io.StringIO()
        serve(Engine(), stdin, stdout)
        return [json.loads(line) for line in stdout.getvalue().splitlines()]

    def test_json_lines_protocol(self):
        responses = self.run_cli([
            {"cmd": "set", "key": "x", "value": 0},
            {"cmd": "set", "key": "y", "value": 0},
            {"cmd": "begin"},                       # tid 1
            {"cmd": "begin"},                       # tid 2
            {"cmd": "read", "tid": 1, "key": "x"},
            {"cmd": "write", "tid": 1, "key": "y", "value": 1},
            {"cmd": "read", "tid": 2, "key": "y"},
            {"cmd": "write", "tid": 2, "key": "x", "value": 1},
            {"cmd": "commit", "tid": 1},
            {"cmd": "commit", "tid": 2},
            {"cmd": "dump"},
        ])
        self.assertEqual(responses[2], {"ok": True, "tid": 1})
        self.assertEqual(responses[4], {"ok": True, "value": 0})
        self.assertEqual(responses[8], {"ok": True})
        self.assertEqual(responses[9]["ok"], False)
        self.assertEqual(responses[9]["error"], "SERIALIZATION_FAILURE")
        self.assertEqual(responses[10], {"ok": True, "data": {"x": 0, "y": 1}})

    def test_write_conflict_via_cli(self):
        responses = self.run_cli([
            {"cmd": "begin"},
            {"cmd": "begin"},
            {"cmd": "write", "tid": 1, "key": "x", "value": 1},
            {"cmd": "write", "tid": 2, "key": "x", "value": 2},
            {"cmd": "commit", "tid": 1},
            {"cmd": "commit", "tid": 2},
        ])
        self.assertEqual(responses[4], {"ok": True})
        self.assertEqual(responses[5]["ok"], False)
        self.assertEqual(responses[5]["error"], "WRITE_CONFLICT")

    def test_bad_input(self):
        stdin = io.StringIO('not json\n{"cmd": "commit", "tid": 99}\n'
                            '{"cmd": "nope"}\n')
        stdout = io.StringIO()
        serve(Engine(), stdin, stdout)
        errors = [json.loads(line)["error"] for line in
                  stdout.getvalue().splitlines()]
        self.assertEqual(errors,
                         ["BAD_JSON", "UNKNOWN_TRANSACTION", "UNKNOWN_COMMAND"])


if __name__ == "__main__":
    unittest.main()
