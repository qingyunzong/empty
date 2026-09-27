"""Acceptance tests A-E for the audit log package."""

from __future__ import annotations

import json
import os
import random
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import auditlog
from auditlog import GENESIS_HASH, PolicyError, SimulatedCrash
from auditlog.core import decode_record

REPO_ROOT = Path(__file__).resolve().parent.parent
CRASH = auditlog.core.CRASH_ENV if hasattr(auditlog, "core") else "AUDITLOG_CRASH_AT"


def records_dir(d):
    return Path(d) / "records"


def record_file(d, seq):
    return records_dir(d) / f"{seq:08d}.rec"


def reference_scan(d):
    """Independent reference scanner: longest valid chain prefix from genesis."""
    prev = GENESIS_HASH
    count = 0
    while record_file(d, count + 1).exists():
        path = record_file(d, count + 1)
        try:
            _, prev_hash, rec_hash = decode_record(path.read_bytes())
        except ValueError:
            break
        if prev_hash != prev:
            break
        prev = rec_hash
        count += 1
    return count, prev


class CrashRecoveryTests(unittest.TestCase):
    # --- A: the three modelled crash points ---

    def test_a1_crash_before_rename_loses_tail(self):
        with tempfile.TemporaryDirectory() as d:
            auditlog.append(d, "SET a 1")
            with mock.patch.dict(os.environ, {CRASH: "before_rename"}):
                with self.assertRaises(SimulatedCrash):
                    auditlog.append(d, "SET b 2")
            # temp record left on disk from the crash
            self.assertTrue((Path(d) / ".pending_record").exists())

            count, head = auditlog.verify(d)  # verify triggers recovery
            self.assertEqual(count, 1)  # tail record lost
            self.assertEqual(auditlog.read_head(d), (1, head))
            self.assertFalse((Path(d) / ".pending_record").exists())
            state = auditlog.replay(d)
            self.assertEqual(state["data"], {"a": "1"})
            # appending again reuses the lost sequence number
            seq, _ = auditlog.append(d, "SET c 3")
            self.assertEqual(seq, 2)
            self.assertEqual(auditlog.verify(d)[0], 2)

    def test_a2_crash_after_rename_recovers_tail(self):
        with tempfile.TemporaryDirectory() as d:
            auditlog.append(d, "SET a 1")
            with mock.patch.dict(os.environ, {CRASH: "after_rename"}):
                with self.assertRaises(SimulatedCrash):
                    auditlog.append(d, "SET b 2")
            # record 2 committed but HEAD still at 1
            self.assertTrue(record_file(d, 2).exists())
            self.assertEqual(auditlog.read_head(d)[0], 1)

            count, head = auditlog.verify(d)  # recovery rebuilds HEAD
            self.assertEqual(count, 2)  # tail recovered
            self.assertEqual(auditlog.read_head(d), (2, head))
            state = auditlog.replay(d)
            self.assertEqual(state["data"], {"a": "1", "b": "2"})

    def test_a3_half_snapshot_ignored_falls_back(self):
        with tempfile.TemporaryDirectory() as d:
            for i in range(2):
                auditlog.append(d, f"SET k{i} v{i}")
            auditlog.snapshot(d)  # complete snapshot at seq 2
            auditlog.append(d, "SET k2 v2")
            with mock.patch.dict(os.environ, {CRASH: "mid_snapshot"}):
                with self.assertRaises(SimulatedCrash):
                    auditlog.snapshot(d)  # half snapshot at seq 3

            snaps = sorted((Path(d) / "snapshots").glob("*.snap"))
            # recovery deletes the half snapshot; the seq-2 one survives
            auditlog.recover(d)
            self.assertEqual([p.name for p in snaps if p.exists()], ["00000002.snap"])
            count, _ = auditlog.verify(d)
            self.assertEqual(count, 3)
            state_fast = auditlog.replay(d)
            state_full = auditlog.replay(d, use_snapshot=False)
            self.assertEqual(state_fast, state_full)
            self.assertEqual(state_fast["data"], {"k0": "v0", "k1": "v1", "k2": "v2"})
            snap = auditlog.latest_snapshot(d)
            self.assertEqual(snap["seq"], 2)


class TamperTests(unittest.TestCase):
    # --- B: tampering reports the first bad record at its offset ---

    def test_b1_tamper_middle_record_reports_first_offset(self):
        with tempfile.TemporaryDirectory() as d:
            for i in range(5):
                auditlog.append(d, f"SET k{i} v{i}")
            sizes = [len(record_file(d, i).read_bytes()) for i in range(1, 6)]
            offset_3 = sum(sizes[:2])
            # tamper record 3 and record 4; only the first (3) must be reported
            for bad in (3, 4):
                path = record_file(d, bad)
                line = bytearray(path.read_bytes())
                line[10] = ord("X") if line[10] != ord("X") else ord("Y")
                path.write_bytes(bytes(line))

            with self.assertRaises(PolicyError) as ctx:
                auditlog.verify(d)
            err = ctx.exception
            self.assertEqual(err.code, "E_CHAIN")
            self.assertIn(f"record 3 at offset {offset_3}", err.message)

    def test_b2_tamper_with_rehash_reports_first_broken_link(self):
        # record 3 rewritten with a correct local hash but new content:
        # its own hash is fine, so the first break is record 4's prev_hash
        with tempfile.TemporaryDirectory() as d:
            for i in range(5):
                auditlog.append(d, f"SET k{i} v{i}")
            from auditlog.core import encode_record
            path = record_file(d, 3)
            _, prev_hash, _ = decode_record(path.read_bytes())
            path.write_bytes(encode_record(b"SET k9 v9", prev_hash))

            with self.assertRaises(PolicyError) as ctx:
                auditlog.verify(d)
            self.assertEqual(ctx.exception.code, "E_CHAIN")
            self.assertIn("record 4", ctx.exception.message)


class EmptyLogTests(unittest.TestCase):
    # --- C: empty log verifies ---

    def test_c_empty_log_verifies(self):
        with tempfile.TemporaryDirectory() as d:
            count, head = auditlog.verify(d)
            self.assertEqual(count, 0)
            self.assertEqual(head, GENESIS_HASH)
            state = auditlog.replay(d)
            self.assertEqual(state, {"count": 0, "head": GENESIS_HASH, "data": {}})

    def test_c_empty_log_created_from_scratch(self):
        with tempfile.TemporaryDirectory() as root:
            d = str(Path(root) / "nested" / "fresh")
            count, _ = auditlog.verify(d)
            self.assertEqual(count, 0)


class SnapshotReplayTests(unittest.TestCase):
    # --- D: replay from snapshot point equals full replay ---

    def test_d_snapshot_replay_equals_full_replay(self):
        with tempfile.TemporaryDirectory() as d:
            ops = ["SET a 1", "SET b 2", "DEL a", "SET c hello world", "SET a 9"]
            for op in ops:
                auditlog.append(d, op)
            auditlog.snapshot(d)  # at seq 5
            more = ["SET a 10", "SET d | pipe | ok", "DEL b"]
            for op in more:
                auditlog.append(d, op)

            self.assertEqual(auditlog.verify(d)[0], 8)
            fast = auditlog.replay(d)
            full = auditlog.replay(d, use_snapshot=False)
            self.assertEqual(fast, full)
            self.assertEqual(fast["count"], 8)
            self.assertEqual(fast["data"], {"a": "10", "c": "hello world",
                                            "d": "| pipe | ok"})
            snap = auditlog.latest_snapshot(d)
            self.assertEqual(snap["state"]["data"],
                             {"a": "9", "b": "2", "c": "hello world"})

    def test_d_multiple_snapshots(self):
        with tempfile.TemporaryDirectory() as d:
            for i in range(4):
                auditlog.append(d, f"SET k{i} v{i}")
                auditlog.snapshot(d)
            self.assertEqual(auditlog.latest_snapshot(d)["seq"], 4)
            self.assertEqual(auditlog.replay(d), auditlog.replay(d, use_snapshot=False))


class RandomFaultInjectionTests(unittest.TestCase):
    # --- E: <=100 random crash injections, cross-checked with reference scanner ---

    def test_e_random_injection_100_trials(self):
        rng = random.Random(20260927)
        for trial in range(100):
            with tempfile.TemporaryDirectory() as d:
                actions = rng.randint(1, 12)
                for _ in range(actions):
                    point = rng.choice([None, None, "before_rename",
                                        "after_rename", "mid_snapshot"])
                    env = {} if point is None else {CRASH: point}
                    do_snapshot = rng.random() < 0.25
                    with mock.patch.dict(os.environ, env):
                        try:
                            if do_snapshot:
                                auditlog.snapshot(d)
                            else:
                                auditlog.append(d, f"SET k{rng.randrange(5)} t{trial}")
                        except SimulatedCrash:
                            pass
                # after recovery, library view must agree with independent scanner
                auditlog.recover(d)
                ref_count, ref_head = reference_scan(d)
                self.assertEqual(auditlog.verify(d), (ref_count, ref_head),
                                 f"trial {trial}: verify disagrees")
                self.assertEqual(auditlog.read_head(d), (ref_count, ref_head),
                                 f"trial {trial}: HEAD disagrees")
                fast = auditlog.replay(d)
                full = auditlog.replay(d, use_snapshot=False)
                self.assertEqual(fast, full, f"trial {trial}: replay mismatch")
                self.assertEqual(fast["count"], ref_count,
                                 f"trial {trial}: replay count mismatch")
                self.assertEqual(fast["head"], ref_head)


class CliTests(unittest.TestCase):
    def run_cli(self, d, cmd, *args):
        return subprocess.run(
            [sys.executable, "-m", "auditlog", cmd, "--dir", d, *args],
            cwd=REPO_ROOT, capture_output=True, text=True,
        )

    def test_cli_happy_path(self):
        with tempfile.TemporaryDirectory() as d:
            r = self.run_cli(d, "append", "SET a 1")
            self.assertEqual(r.returncode, 0, r.stderr)
            r = self.run_cli(d, "verify")
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("OK: 1 records", r.stdout)
            r = self.run_cli(d, "replay")
            self.assertEqual(r.returncode, 0, r.stderr)
            state = json.loads(r.stdout)
            self.assertEqual(state["data"], {"a": "1"})

    def test_cli_chain_error_exit_code_2(self):
        with tempfile.TemporaryDirectory() as d:
            for i in range(3):
                self.run_cli(d, "append", f"SET k{i} v{i}")
            path = record_file(d, 2)
            line = bytearray(path.read_bytes())
            line[10] ^= 0x01
            path.write_bytes(bytes(line))
            r = self.run_cli(d, "verify")
            self.assertEqual(r.returncode, 2)
            self.assertIn("E_CHAIN", r.stderr)
            self.assertIn("record 2", r.stderr)


if __name__ == "__main__":
    unittest.main()
