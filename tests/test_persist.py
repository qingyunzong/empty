"""Tests for csp_persist: nogood log persistence, recovery, solver pruning."""

import json
import os
import random
import stat
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from csp_persist import CSPSolver, NogoodLog  # noqa: E402
from csp_persist.log import encode_entry  # noqa: E402


def naive_parse(path):
    """Naive reference log parser, written independently of csp_persist.

    Sequentially reads [len u32][payload][crc32 u32] records and stops at
    the first record that is incomplete or fails its checksum.
    """
    clauses = []
    if not os.path.exists(path):
        return clauses
    with open(path, "rb") as handle:
        data = handle.read()
    pos = 0
    while pos < len(data):
        if pos + 4 > len(data):
            break
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        pos += 4
        if pos + length + 4 > len(data):
            break
        payload = data[pos:pos + length]
        pos += length
        (crc,) = struct.unpack(">I", data[pos:pos + 4])
        pos += 4
        if zlib.crc32(payload) & 0xFFFFFFFF != crc:
            break
        clauses.append(json.loads(payload.decode("utf-8")))
    return clauses


CLAUSE_1 = [{"var": "x", "value": 1}, {"var": "y", "value": 1}]
CLAUSE_2 = [{"var": "x", "value": 2}, {"var": "y", "value": 2}]
CLAUSE_3 = [{"var": "z", "value": 0}]


class TempLogMixin(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmpdir.cleanup)
        self.log_path = os.path.join(self.tmpdir.name, "nogoods.log")
        self.log = NogoodLog(self.log_path)


class TestWriteLoadRoundTrip(TempLogMixin):
    def test_three_nogoods_roundtrip_and_pruning(self):
        clauses = [CLAUSE_1, CLAUSE_2, CLAUSE_3]
        for clause in clauses:
            self.log.append(clause)

        loaded = self.log.load()
        self.assertEqual(loaded, clauses)

        solver = CSPSolver({"x": [1, 2, 3], "y": [1, 2, 3], "z": [0, 1]})
        added = solver.add_nogoods(loaded)
        self.assertEqual(added, 3)
        self.assertEqual(len(solver.nogoods), 3)

        solutions = solver.solve()
        # Brute-force cross-check: 18 raw assignments minus those covered
        # by any nogood ({x=1,y=1}, {x=2,y=2}, {z=0}) -> 7 solutions.
        import itertools
        expected = [
            dict(zip("xyz", values)) for values in itertools.product(
                [1, 2, 3], [1, 2, 3], [0, 1])
            if not any(all(dict(zip("xyz", values))[var] == value
                           for var, value in nogood)
                       for nogood in solver.nogoods)
        ]
        self.assertEqual(len(expected), 7)
        self.assertEqual(solutions, expected)
        self.assertGreater(solver.pruned_nodes, 0)
        for solution in solutions:
            for nogood in solver.nogoods:
                self.assertFalse(
                    all(solution[var] == value for var, value in nogood))

    def test_nogoods_deduplicated(self):
        solver = CSPSolver({"x": [1, 2]})
        self.assertTrue(solver.add_nogood(CLAUSE_1))
        self.assertFalse(solver.add_nogood(CLAUSE_1))
        self.assertFalse(solver.add_nogood(list(reversed(CLAUSE_1))))
        self.assertEqual(len(solver.nogoods), 1)

    def test_pruning_matches_brute_force(self):
        solver = CSPSolver({"x": [1, 2], "y": [1, 2]})
        solver.add_nogoods([CLAUSE_1, CLAUSE_2])
        solutions = solver.solve()
        self.assertEqual(solutions,
                         [{"x": 1, "y": 2}, {"x": 2, "y": 1}])
        self.assertEqual(solver.pruned_nodes, 2)


class TestCrashRecovery(TempLogMixin):
    def _write_entries(self, clauses):
        blob = b""
        offsets = []
        for clause in clauses:
            offsets.append(len(blob))
            blob += encode_entry(clause)
        return blob, offsets

    def test_truncated_second_entry_recovers_first_only(self):
        blob, offsets = self._write_entries([CLAUSE_1, CLAUSE_2, CLAUSE_3])
        # Simulate a crash mid-write of entry 2: keep entry 1 plus a
        # partial slice of entry 2 (header + half its payload).
        entry2_size = offsets[2] - offsets[1]
        cut = offsets[1] + 4 + entry2_size // 2
        with open(self.log_path, "wb") as handle:
            handle.write(blob[:cut])
        self.assertEqual(self.log.load(), [CLAUSE_1])

    def test_truncated_header_and_checksum(self):
        blob, offsets = self._write_entries([CLAUSE_1, CLAUSE_2])
        for cut in (offsets[1] + 2, len(blob) - 1):  # partial header / crc
            with open(self.log_path, "wb") as handle:
                handle.write(blob[:cut])
            self.assertEqual(self.log.load(), [CLAUSE_1])

    def test_corrupted_byte_invalidates_entry_and_all_after(self):
        blob, offsets = self._write_entries([CLAUSE_1, CLAUSE_2, CLAUSE_3])
        # Flip one byte inside entry 2's payload.
        flip_at = offsets[1] + 6
        corrupted = bytearray(blob)
        corrupted[flip_at] ^= 0xFF
        with open(self.log_path, "wb") as handle:
            handle.write(corrupted)
        self.assertEqual(self.log.load(), [CLAUSE_1])

    def test_missing_and_empty_log_load_empty(self):
        self.assertEqual(self.log.load(), [])
        Path(self.log_path).touch()
        self.assertEqual(self.log.load(), [])


class TestNaiveReferenceCrossCheck(TempLogMixin):
    def test_random_logs_match_naive_parser(self):
        rng = random.Random(20261001)
        for _ in range(25):
            clauses = [
                [{"var": f"v{rng.randrange(4)}",
                  "value": rng.randrange(4)}
                 for _ in range(rng.randrange(1, 4))]
                for _ in range(rng.randrange(1, 6))
            ]
            blob = b"".join(encode_entry(c) for c in clauses)
            mode = rng.randrange(4)
            if mode == 1 and blob:  # truncate at a random point
                blob = blob[:rng.randrange(len(blob))]
            elif mode == 2 and blob:  # flip a random byte
                blob = bytearray(blob)
                blob[rng.randrange(len(blob))] ^= 1 << rng.randrange(8)
                blob = bytes(blob)
            elif mode == 3:  # append random garbage
                blob += bytes(rng.randrange(256)
                              for _ in range(rng.randrange(1, 10)))
            with open(self.log_path, "wb") as handle:
                handle.write(blob)
            self.assertEqual(self.log.load(), naive_parse(self.log_path))


class TestReadOnlyLogPath(TempLogMixin):
    def test_write_failure_does_not_break_solver(self):
        readonly_dir = os.path.join(self.tmpdir.name, "readonly")
        os.mkdir(readonly_dir)
        os.chmod(readonly_dir, stat.S_IRUSR | stat.S_IXUSR)
        self.addCleanup(os.chmod, readonly_dir,
                        stat.S_IRWXU)
        bad_log = NogoodLog(os.path.join(readonly_dir, "nogoods.log"))

        solver = CSPSolver({"x": [1, 2], "y": [1, 2]})
        ok = solver.persist_nogood(bad_log, CLAUSE_1)
        self.assertFalse(ok)  # persistence failed, no exception escaped

        # In-memory search logic is unaffected by the persistence failure.
        solver.add_nogood(CLAUSE_1)
        solutions = solver.solve()
        self.assertNotIn({"x": 1, "y": 1}, solutions)
        self.assertEqual(len(solutions), 3)

    def test_append_raises_oserror_on_readonly_path(self):
        readonly_dir = os.path.join(self.tmpdir.name, "ro2")
        os.mkdir(readonly_dir)
        os.chmod(readonly_dir, stat.S_IRUSR | stat.S_IXUSR)
        self.addCleanup(os.chmod, readonly_dir, stat.S_IRWXU)
        bad_log = NogoodLog(os.path.join(readonly_dir, "nogoods.log"))
        with self.assertRaises(OSError):
            bad_log.append(CLAUSE_1)


class TestCLI(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmpdir.cleanup)
        self.log_path = os.path.join(self.tmpdir.name, "nogoods.log")

    def run_cli(self, *args):
        return subprocess.run(
            [sys.executable, "-m", "csp_persist", *args],
            capture_output=True, text=True, cwd=REPO_ROOT)

    def test_write_then_load_via_cli(self):
        for clause in (CLAUSE_1, CLAUSE_2, CLAUSE_3):
            result = self.run_cli("write", "--log", self.log_path,
                                  "--clause", json.dumps(clause))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["status"], "committed")

        result = self.run_cli("load", "--log", self.log_path)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout),
                         [CLAUSE_1, CLAUSE_2, CLAUSE_3])

    def test_load_missing_log_returns_empty_list(self):
        result = self.run_cli("load", "--log", self.log_path)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [])

    def test_invalid_clause_json_returns_nonzero(self):
        for bad in ("not json", "[]", '{"var": "x"}',
                    '[{"var": "x"}]', '[{"var": 1, "value": 2}]',
                    '[{"var": "x", "value": [1]}]'):
            result = self.run_cli("write", "--log", self.log_path,
                                  "--clause", bad)
            self.assertNotEqual(result.returncode, 0, bad)
            self.assertFalse(os.path.exists(self.log_path))

    def test_unwritable_log_path_returns_nonzero(self):
        readonly_dir = os.path.join(self.tmpdir.name, "readonly")
        os.mkdir(readonly_dir)
        os.chmod(readonly_dir, stat.S_IRUSR | stat.S_IXUSR)
        self.addCleanup(os.chmod, readonly_dir, stat.S_IRWXU)
        result = self.run_cli(
            "write", "--log", os.path.join(readonly_dir, "nogoods.log"),
            "--clause", json.dumps(CLAUSE_1))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("error", result.stderr)


if __name__ == "__main__":
    unittest.main()
