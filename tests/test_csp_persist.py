"""Tests for csp_persist: nogood log persistence, crash recovery, CLI, solver."""

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

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from csp_persist import (
    CSPSolver,
    NogoodStore,
    append_clause,
    load_clauses,
    parse_clause_text,
    ClauseFormatError,
)
from csp_persist.log import encode_entry

REPO_ROOT = Path(__file__).resolve().parent.parent


def naive_parse_log(data: bytes) -> list:
    """Naive reference parser: sequential scan, stop at first bad entry."""
    clauses = []
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


def run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "csp_persist", *args],
        capture_output=True, text=True, cwd=REPO_ROOT,
    )


class TempLogTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.log_path = os.path.join(self.tmp.name, "nogoods.log")


class TestWriteLoadRoundtrip(TempLogTestCase):
    CLAUSES = [
        [["x", 1], ["y", 2]],
        [["x", 2], ["z", 3]],
        [["y", 1], ["z", 1], ["w", 4]],
    ]

    def test_cli_write_three_then_cli_load(self):
        for clause in self.CLAUSES:
            proc = run_cli("write", "--log", self.log_path,
                           "--clause", json.dumps(clause))
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertTrue(json.loads(proc.stdout)["committed"])

        proc = run_cli("load", "--log", self.log_path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        loaded = json.loads(proc.stdout)["clauses"]
        self.assertEqual(loaded, self.CLAUSES)

    def test_loaded_clauses_match_memory_and_prune(self):
        store = NogoodStore()
        for clause in self.CLAUSES:
            append_clause(self.log_path, clause)
            store.add(clause)

        loaded = load_clauses(self.log_path)
        loaded_store = NogoodStore()
        for clause in loaded:
            self.assertTrue(loaded_store.add(clause))

        # Loaded clauses are exactly the in-memory clause set.
        self.assertEqual(
            {frozenset(map(tuple, c)) for c in loaded},
            {frozenset(map(tuple, c)) for c in store.clauses()},
        )

        domains = {"x": [1, 2], "y": [1, 2], "z": [1, 2, 3], "w": [4, 5]}
        sol_mem = CSPSolver(domains, store).solve()
        sol_loaded = CSPSolver(domains, loaded_store).solve()
        self.assertIsNotNone(sol_loaded)
        self.assertEqual(sol_mem, sol_loaded)
        # Solution must not subsume any nogood.
        for nogood in self.CLAUSES:
            self.assertFalse(all(sol_loaded[v] == val for v, val in nogood))

    def test_pruning_behavior_with_loaded_nogoods(self):
        domains = {"a": [1, 2], "b": [1, 2], "c": [1, 2]}
        clause = [["a", 1], ["b", 1]]
        append_clause(self.log_path, clause)
        store = NogoodStore()
        for loaded in load_clauses(self.log_path):
            store.add(loaded)

        plain = CSPSolver(domains)
        pruned = CSPSolver(domains, store)
        sol_plain = plain.solve()
        sol_pruned = pruned.solve()
        # Without nogoods the forbidden combination is the first solution.
        self.assertEqual(sol_plain, {"a": 1, "b": 1, "c": 1})
        # With the loaded nogood the conflict is pruned during search.
        self.assertGreaterEqual(pruned.pruned, 1)
        self.assertIsNotNone(sol_pruned)
        self.assertFalse(all(sol_pruned[v] == val for v, val in clause))

        # Nogoods covering every assignment make the problem unsatisfiable.
        full_store = NogoodStore()
        for a in (1, 2):
            for b in (1, 2):
                for c in (1, 2):
                    full_store.add([["a", a], ["b", b], ["c", c]])
        self.assertIsNone(CSPSolver(domains, full_store).solve())

    def test_no_duplicate_derivation_on_reload(self):
        store = NogoodStore()
        for clause in self.CLAUSES:
            append_clause(self.log_path, clause)
            store.add(clause)
        # Simulate a restart that loads the same clauses again.
        for clause in load_clauses(self.log_path):
            self.assertFalse(store.add(clause))
        self.assertEqual(len(store), len(self.CLAUSES))


class TestCrashRecovery(TempLogTestCase):
    CLAUSES = [[["x", 1]], [["y", 2], ["z", 5]], [["w", 9]]]

    def _write_all(self):
        for clause in self.CLAUSES:
            append_clause(self.log_path, clause)
        return os.path.getsize(self.log_path)

    def test_truncated_second_entry_returns_first_only(self):
        entry1 = len(encode_entry(self.CLAUSES[0]))
        entry2 = len(encode_entry(self.CLAUSES[1]))
        self._write_all()
        # Simulate crash mid-write of entry 2: keep entry 1 + half of entry 2.
        with open(self.log_path, "r+b") as fh:
            fh.truncate(entry1 + entry2 // 2)
        self.assertEqual(load_clauses(self.log_path), [self.CLAUSES[0]])

    def test_truncated_checksum_returns_first_only(self):
        entry1 = len(encode_entry(self.CLAUSES[0]))
        entry2 = len(encode_entry(self.CLAUSES[1]))
        self._write_all()
        # Keep full payload of entry 2 but only part of its CRC.
        with open(self.log_path, "r+b") as fh:
            fh.truncate(entry1 + entry2 - 2)
        self.assertEqual(load_clauses(self.log_path), [self.CLAUSES[0]])

    def test_bit_flip_in_second_entry_stops_loading(self):
        entry1 = len(encode_entry(self.CLAUSES[0]))
        self._write_all()
        # Flip one byte inside entry 2's payload -> CRC mismatch.
        with open(self.log_path, "r+b") as fh:
            fh.seek(entry1 + 6)
            original = fh.read(1)
            fh.seek(entry1 + 6)
            fh.write(bytes([original[0] ^ 0xFF]))
        # Entry 2 and everything after it (entry 3) must be dropped.
        self.assertEqual(load_clauses(self.log_path), [self.CLAUSES[0]])

    def test_missing_and_empty_log_load_empty(self):
        self.assertEqual(load_clauses(self.log_path), [])
        Path(self.log_path).touch()
        self.assertEqual(load_clauses(self.log_path), [])
        # Solver is unaffected by an empty log.
        solver = CSPSolver({"x": [1, 2]})
        self.assertEqual(solver.solve(), {"x": 1})


class TestNaiveParserCrossCheck(TempLogTestCase):
    def test_random_logs_match_naive_reference(self):
        rng = random.Random(20261001)
        for trial in range(50):
            clauses = [
                [[f"v{rng.randrange(5)}", rng.randrange(4)]
                 for _ in range(rng.randrange(1, 4))]
                for _ in range(rng.randrange(0, 6))
            ]
            # Deduplicate variables within each clause.
            for clause in clauses:
                seen = {}
                for var, val in clause:
                    seen[var] = val
                clause[:] = [[v, val] for v, val in seen.items()]
            blob = b"".join(encode_entry(c) for c in clauses)
            mode = rng.randrange(4)
            if mode == 1 and blob:          # random truncation
                blob = blob[:rng.randrange(len(blob))]
            elif mode == 2 and blob:        # random single-byte corruption
                idx = rng.randrange(len(blob))
                blob = blob[:idx] + bytes([blob[idx] ^ 0x01]) + blob[idx + 1:]
            elif mode == 3:                 # random garbage appended
                blob += bytes(rng.randrange(256) for _ in range(rng.randrange(1, 9)))
            with open(self.log_path, "wb") as fh:
                fh.write(blob)
            expected = naive_parse_log(blob)
            self.assertEqual(load_clauses(self.log_path), expected,
                             f"trial {trial}: mode {mode}")


class TestErrorHandling(TempLogTestCase):
    def test_readonly_directory_write_fails_gracefully(self):
        if os.geteuid() == 0:
            self.skipTest("root ignores directory permission bits")
        ro_dir = os.path.join(self.tmp.name, "readonly")
        os.mkdir(ro_dir)
        os.chmod(ro_dir, stat.S_IRUSR | stat.S_IXUSR)  # r-x, no write
        log_path = os.path.join(ro_dir, "nogoods.log")
        try:
            proc = run_cli("write", "--log", log_path,
                           "--clause", '[["x", 1]]')
            self.assertNotEqual(proc.returncode, 0)
            self.assertEqual(proc.returncode, 2)
            self.assertIn("error", proc.stderr)
            # Library-level: raises LogWriteError, never a fatal crash.
            from csp_persist import LogWriteError
            with self.assertRaises(LogWriteError):
                append_clause(log_path, [["x", 1]])
            # In-memory search logic is unaffected by the failure.
            store = NogoodStore()
            store.add([["x", 1]])
            solver = CSPSolver({"x": [1, 2]}, store)
            self.assertEqual(solver.solve(), {"x": 2})
        finally:
            os.chmod(ro_dir, stat.S_IRWXU)

    def test_invalid_clause_rejected_with_nonzero_exit(self):
        bad_clauses = [
            "not json at all",
            '{"x": 1}',                    # not an array
            '[["x"]]',                     # literal not a pair
            '[["x", 1, 2]]',
            '[[1, 2]]',                    # var not a string
            '[["x", "1"]]',                # value not an int
            '[["x", true]]',               # bool is not an int
            '[["x", 1], ["x", 2]]',        # duplicate variable
        ]
        for bad in bad_clauses:
            with self.subTest(clause=bad):
                proc = run_cli("write", "--log", self.log_path, "--clause", bad)
                self.assertEqual(proc.returncode, 3, proc.stderr)
                self.assertFalse(os.path.exists(self.log_path))
        with self.assertRaises(ClauseFormatError):
            parse_clause_text('[["x", 1], ["x", 1]]')

    def test_load_missing_log_via_cli_returns_empty_list(self):
        proc = run_cli("load", "--log", self.log_path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertEqual(payload["clauses"], [])
        self.assertEqual(payload["count"], 0)


if __name__ == "__main__":
    unittest.main()
