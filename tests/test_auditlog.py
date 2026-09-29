"""Acceptance tests for auditlog.

A. three simulated crash points -> lost tail / recovered tail / ignored
   half snapshot
B. tampered middle record -> E_CHAIN at the first bad offset
C. empty log verifies OK
D. replay from a snapshot point equals full replay
E. <=100 random fault injections agree with a reference sequential scanner
"""

from __future__ import annotations

import base64
import hashlib
import json
import random
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from auditlog import AuditLog, PolicyError, ZERO_HASH
from auditlog.core import (
    HEAD_NAME,
    LOG_NAME,
    LOG_TMP_NAME,
    SNAP_NAME,
    SNAP_TMP_NAME,
    SNAP_BAK_NAME,
    compute_hash,
    encode_record,
    load_snapshot,
    read_head,
)


def reference_scan(log_path: Path):
    """Independent sequential scanner: returns (payloads, first_bad_offset).

    first_bad_offset is None when the whole file is a valid chain.
    """
    data = log_path.read_bytes() if log_path.exists() else b""
    payloads = []
    prev = ZERO_HASH
    offset = 0
    for line in data.splitlines(keepends=True):
        ok = False
        if line.endswith(b"\n"):
            parts = line[:-1].split(b"|")
            if len(parts) == 4:
                try:
                    length = int(parts[0])
                    payload = base64.b64decode(parts[1], validate=True)
                    prev_field = parts[2].decode("ascii")
                    hash_field = parts[3].decode("ascii")
                    digest = hashlib.sha256(
                        str(length).encode() + b"|" + payload + b"|"
                        + prev_field.encode()).hexdigest()
                    ok = (len(payload) == length and prev_field == prev
                          and digest == hash_field)
                except (ValueError, UnicodeDecodeError):
                    ok = False
        if not ok:
            return payloads, offset
        payloads.append(payload)
        prev = hash_field
        offset += len(line)
    return payloads, None


def model_state(payloads):
    state = {}
    for payload in payloads:
        key, _, value = payload.decode("utf-8").partition("=")
        state[key] = value
    return state


class AuditLogTestBase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)

    def chain_hashes(self, payloads):
        hashes = []
        prev = ZERO_HASH
        for payload in payloads:
            prev = compute_hash(payload, prev)
            hashes.append(prev)
        return hashes


class TestCrashRecovery(AuditLogTestBase):
    """Acceptance A: the three defined crash points."""

    def test_crash_before_rename_loses_tail(self):
        log = AuditLog(self.dir)
        for i in range(3):
            log.append(f"k{i}=v{i}".encode())

        # Simulate crash after writing the temp record file but before rename.
        staged = (self.dir / LOG_NAME).read_bytes() + encode_record(
            b"k3=v3", self.chain_hashes([b"k0=v0", b"k1=v1", b"k2=v2"])[-1])
        (self.dir / LOG_TMP_NAME).write_bytes(staged)

        recovered = AuditLog(self.dir)
        self.assertEqual(recovered.verify(), 3)  # tail record lost
        self.assertFalse((self.dir / LOG_TMP_NAME).exists())
        self.assertEqual(recovered.replay(), {"k0": "v0", "k1": "v1",
                                              "k2": "v2"})
        self.assertEqual(read_head(self.dir)[0], 3)

    def test_crash_after_rename_rebuilds_head(self):
        log = AuditLog(self.dir)
        for i in range(3):
            log.append(f"k{i}=v{i}".encode())
        head_before = read_head(self.dir)

        # Simulate crash after atomic rename but before HEAD update.
        hashes = self.chain_hashes([b"k0=v0", b"k1=v1", b"k2=v2", b"k3=v3"])
        new_data = (self.dir / LOG_NAME).read_bytes() + encode_record(
            b"k3=v3", hashes[-2])
        (self.dir / LOG_NAME).write_bytes(new_data)
        self.assertEqual(read_head(self.dir), head_before)  # stale HEAD

        recovered = AuditLog(self.dir)
        self.assertEqual(recovered.verify(), 4)  # tail record recovered
        self.assertEqual(read_head(self.dir), (4, hashes[-1]))
        self.assertEqual(recovered.replay()["k3"], "v3")

    def test_half_snapshot_discarded_with_fallback(self):
        log = AuditLog(self.dir, snapshot_every=2)
        for i in range(4):
            log.append(f"k{i}=v{i}".encode())
        # snapshot.json = @4, snapshot.json.bak = @2
        self.assertEqual(load_snapshot(self.dir)["count"], 4)

        # Crash point 3a: staged half snapshot left behind.
        (self.dir / SNAP_TMP_NAME).write_bytes(b"partial-snapshot")
        recovered = AuditLog(self.dir)
        self.assertFalse((self.dir / SNAP_TMP_NAME).exists())
        self.assertEqual(load_snapshot(self.dir)["count"], 4)
        self.assertEqual(recovered.replay(),
                         {f"k{i}": f"v{i}" for i in range(4)})

        # Crash point 3b: snapshot file itself truncated/corrupt.
        snap = self.dir / SNAP_NAME
        snap.write_bytes(snap.read_bytes()[:17])
        recovered = AuditLog(self.dir)
        self.assertEqual(load_snapshot(self.dir)["count"], 2)  # fell back
        self.assertFalse((self.dir / SNAP_BAK_NAME).exists())
        self.assertEqual(recovered.replay(),
                         {f"k{i}": f"v{i}" for i in range(4)})


class TestTamperDetection(AuditLogTestBase):
    """Acceptance B: tampering a middle record reports the first bad offset."""

    def test_tampered_middle_record_reports_first_offset(self):
        log = AuditLog(self.dir)
        for i in range(6):
            log.append(f"key{i}=value{i}".encode())

        log_file = self.dir / LOG_NAME
        data = bytearray(log_file.read_bytes())
        # Flip a payload byte inside record 3 (0-based), a middle record.
        lines = bytes(data).splitlines(keepends=True)
        target_offset = sum(len(l) for l in lines[:3])
        b64_start = target_offset + lines[3].index(b"|") + 1
        data[b64_start] = ord("A") if data[b64_start] != ord("A") else ord("B")
        log_file.write_bytes(bytes(data))

        _, expected_offset = reference_scan(log_file)
        self.assertIsNotNone(expected_offset)

        with self.assertRaises(PolicyError) as ctx:
            AuditLog(self.dir).verify()
        self.assertEqual(ctx.exception.code, "E_CHAIN")
        self.assertEqual(ctx.exception.offset, expected_offset)
        self.assertEqual(ctx.exception.index, 3)

        # CLI exits with code 2 and reports E_CHAIN.
        result = subprocess.run(
            [sys.executable, "-m", "auditlog", "--dir", str(self.dir),
             "verify"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("E_CHAIN", result.stderr)
        self.assertIn(f"offset {expected_offset}", result.stderr)


class TestEmptyLog(AuditLogTestBase):
    """Acceptance C: empty log verifies OK."""

    def test_empty_log_verifies(self):
        self.assertEqual(AuditLog(self.dir).verify(), 0)
        self.assertEqual(AuditLog(self.dir).replay(), {})

    def test_empty_log_cli(self):
        result = subprocess.run(
            [sys.executable, "-m", "auditlog", "--dir", str(self.dir),
             "verify"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("OK: 0", result.stdout)


class TestSnapshotReplay(AuditLogTestBase):
    """Acceptance D: replay from a snapshot point equals full replay."""

    def test_snapshot_replay_matches_full_replay(self):
        log = AuditLog(self.dir, snapshot_every=4)
        for i in range(11):
            log.append(f"key{i % 5}=value{i}".encode())
        self.assertIsNotNone(load_snapshot(self.dir))

        with_snapshot = log.replay()

        # Full replay with snapshots disabled on a pristine copy of the log.
        raw_dir = self.dir / "raw"
        raw_dir.mkdir()
        raw_dir.joinpath(LOG_NAME).write_bytes(
            (self.dir / LOG_NAME).read_bytes())
        full = AuditLog(raw_dir, snapshot_every=0).replay()

        self.assertEqual(with_snapshot, full)
        # Explicit expected state: last write wins per key.
        expected = {}
        for i in range(11):
            expected[f"key{i % 5}"] = f"value{i}"
        self.assertEqual(with_snapshot, expected)


class TestRandomFaultInjection(AuditLogTestBase):
    """Acceptance E: random faults agree with the reference scanner."""

    def test_random_fault_injection(self):
        rng = random.Random(20260929)
        log_dir = self.dir / "fuzz"
        model: list[bytes] = []          # payloads expected to survive
        prev_hash = ZERO_HASH
        tampered = False

        for step in range(100):
            log = AuditLog(log_dir, snapshot_every=3)  # triggers recovery
            action = rng.random()
            if action < 0.45:
                # Normal append through the public API.
                payload = f"k{step}=v{step}".encode()
                log.append(payload)
                model.append(payload)
                prev_hash = compute_hash(payload, prev_hash)
            elif action < 0.65:
                # Fault 1: crash before rename -> staged record lost.
                payload = f"lost{step}=x".encode()
                staged = (log_dir / LOG_NAME).read_bytes() if (
                    log_dir / LOG_NAME).exists() else b""
                staged += encode_record(payload, prev_hash)
                (log_dir / LOG_TMP_NAME).write_bytes(staged)
            elif action < 0.85:
                # Fault 2: crash after rename, stale HEAD -> tail recovered.
                payload = f"kept{step}=y".encode()
                data = (log_dir / LOG_NAME).read_bytes() if (
                    log_dir / LOG_NAME).exists() else b""
                (log_dir / LOG_NAME).write_bytes(
                    data + encode_record(payload, prev_hash))
                model.append(payload)
                prev_hash = compute_hash(payload, prev_hash)
            elif not tampered and step > 40 and len(model) >= 4:
                # One-time tamper of a middle record.
                tampered = True
                log_file = log_dir / LOG_NAME
                data = bytearray(log_file.read_bytes())
                lines = bytes(data).splitlines(keepends=True)
                mid = len(lines) // 2
                pos = sum(len(l) for l in lines[:mid])
                pos += lines[mid].index(b"|") + 1
                data[pos] = ord("A") if data[pos] != ord("A") else ord("B")
                log_file.write_bytes(bytes(data))
            else:
                # Fault 3: half-written snapshot (staged tmp or corrupt file).
                if rng.random() < 0.5:
                    (log_dir / SNAP_TMP_NAME).write_bytes(b"half")
                elif (log_dir / SNAP_NAME).exists():
                    snap = log_dir / SNAP_NAME
                    snap.write_bytes(snap.read_bytes()[:11])

            ref_payloads, ref_bad = reference_scan(log_dir / LOG_NAME)
            if tampered:
                self.assertIsNotNone(ref_bad)
                # The broken chain is detected either during recovery in the
                # constructor or by verify; both must report E_CHAIN at the
                # reference scanner's first bad offset.
                with self.assertRaises(PolicyError) as ctx:
                    AuditLog(log_dir).verify()
                self.assertEqual(ctx.exception.code, "E_CHAIN")
                self.assertEqual(ctx.exception.offset, ref_bad)
                break
            log = AuditLog(log_dir, snapshot_every=3)
            self.assertIsNone(ref_bad)
            self.assertEqual([r.payload for r in log.records()], model)
            self.assertEqual([p for p in ref_payloads], model)
            self.assertEqual(log.verify(), len(model))
            self.assertEqual(log.replay(), model_state(model))
            self.assertFalse((log_dir / LOG_TMP_NAME).exists())
            self.assertFalse((log_dir / SNAP_TMP_NAME).exists())
        else:
            self.fail("tamper was never injected; adjust the seed")


class TestCli(AuditLogTestBase):
    def test_append_verify_replay_roundtrip(self):
        base = [sys.executable, "-m", "auditlog", "--dir", str(self.dir)]
        r1 = subprocess.run(base + ["append", "a=1", "b=2"],
                            capture_output=True, text=True)
        self.assertEqual(r1.returncode, 0, r1.stderr)
        r2 = subprocess.run(base + ["verify"], capture_output=True, text=True)
        self.assertEqual(r2.returncode, 0, r2.stderr)
        self.assertIn("OK: 2", r2.stdout)
        r3 = subprocess.run(base + ["replay"], capture_output=True, text=True)
        self.assertEqual(r3.returncode, 0, r3.stderr)
        self.assertEqual(json.loads(r3.stdout), {"a": "1", "b": "2"})

    def test_append_rejects_non_key_value(self):
        result = subprocess.run(
            [sys.executable, "-m", "auditlog", "--dir", str(self.dir),
             "append", "not-a-pair"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("E_PAYLOAD", result.stderr)


if __name__ == "__main__":
    unittest.main()
