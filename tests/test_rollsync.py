"""Acceptance tests for rollsync.

A. Random small files (<= 1 MiB): final bytes compared against a naive
   longest-common-substring reference patcher over <= 200 samples.
B. A hand-built Adler-32 collision proves the SHA-256 strong check
   intercepts weak false hits.
C. Boundary cases: OLD empty, NEW empty, OLD == NEW.
D. Truncated patches fail to apply and the target keeps its original bytes.
"""

import os
import random
import re
import subprocess
import sys
import tempfile
import unittest
import zlib
import hashlib

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import rollsync
from rollsync import (ChecksumMismatchError, CorruptPatchError, apply_patch,
                      block_size_for, delta, parse_patch, serialize_patch)

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.setrecursionlimit(100000)


# ---------------------------------------------------------------------------
# Naive longest-common-substring reference implementation (acceptance A).
# ---------------------------------------------------------------------------

def _lcs(old, new, o_lo, o_hi, n_lo, n_hi):
    """Longest common substring of the two slices; O(len*len) DP."""
    width = n_hi - n_lo
    best = 0
    best_o = best_n = 0
    prev = [0] * (width + 1)
    for i in range(o_lo, o_hi):
        cur = [0] * (width + 1)
        byte = old[i]
        for j in range(n_lo, n_hi):
            if byte == new[j]:
                value = prev[j - n_lo] + 1
                cur[j - n_lo + 1] = value
                if value > best:
                    best = value
                    best_o = i - value + 1
                    best_n = j - value + 1
        prev = cur
    return best_o, best_n, best


def naive_lcs_reconstruct(old, new):
    """Rebuild ``new`` from ``old`` using a naive recursive LCS patcher."""
    buffer = bytearray(len(new))

    def rec(o_lo, o_hi, n_lo, n_hi):
        if n_lo >= n_hi:
            return
        best_o, best_n, best = _lcs(old, new, o_lo, o_hi, n_lo, n_hi)
        if best == 0:
            buffer[n_lo:n_hi] = new[n_lo:n_hi]
            return
        rec(o_lo, best_o, n_lo, best_n)
        buffer[best_n:best_n + best] = old[best_o:best_o + best]
        rec(best_o + best, o_hi, best_n + best, n_hi)

    rec(0, len(old), 0, len(new))
    return bytes(buffer)


def mutate(old, rng):
    data = bytearray(old)
    for _ in range(rng.randrange(1, 6)):
        op = rng.randrange(4)
        if op == 0 and data:
            pos = rng.randrange(len(data))
            data[pos] = rng.randrange(256)
        elif op == 1:
            pos = rng.randrange(len(data) + 1)
            data[pos:pos] = rng.randbytes(rng.randrange(1, 33))
        elif op == 2 and data:
            pos = rng.randrange(len(data))
            del data[pos:pos + rng.randrange(1, 33)]
        elif op == 3 and len(data) > 4:
            start = rng.randrange(len(data) - 2)
            length = rng.randrange(1, len(data) - start)
            chunk = bytes(data[start:start + length])
            del data[start:start + length]
            pos = rng.randrange(len(data) + 1)
            data[pos:pos] = chunk
    return bytes(data)


def roundtrip(old, new):
    patch = delta(old, new)
    blob = serialize_patch(patch)
    reparsed = parse_patch(blob)
    assert reparsed.old_size == len(old)
    assert reparsed.new_size == len(new)
    result, copy_bytes, literal_bytes = apply_patch(old, blob)
    return result, copy_bytes, literal_bytes, blob


class TestRandomRoundTrip(unittest.TestCase):
    """Acceptance A: random small files vs naive LCS reference, n <= 200."""

    def test_random_samples_against_naive_lcs(self):
        rng = random.Random(20260927)
        samples = 0
        for trial in range(200):
            if trial < 150:
                old_len = rng.randrange(0, 301)
            else:
                old_len = rng.randrange(0, 100 * 1024)
            old = rng.randbytes(old_len)
            mode = rng.randrange(5)
            if mode == 0:
                new = old
            elif mode == 1:
                new = rng.randbytes(rng.randrange(0, max(2, old_len + 1)))
            elif mode == 2:
                new = b""
            elif mode == 3:
                new = mutate(old, rng)
            else:
                new = mutate(old, rng) + rng.randbytes(rng.randrange(0, 64))

            result, copy_bytes, literal_bytes, _ = roundtrip(old, new)
            self.assertEqual(result, new, f"trial {trial}: roundtrip mismatch")
            self.assertEqual(copy_bytes + literal_bytes, len(new))

            # Naive LCS reference comparison on tractable sizes.
            if len(old) * max(1, len(new)) <= 120_000:
                reference = naive_lcs_reconstruct(old, new)
                self.assertEqual(reference, new,
                                 f"trial {trial}: naive LCS reference broken")
                self.assertEqual(result, reference,
                                 f"trial {trial}: final bytes differ from reference")
            samples += 1
        self.assertEqual(samples, 200)

    def test_one_mebibyte_roundtrip(self):
        rng = random.Random(7)
        old = rng.randbytes(1024 * 1024)
        new = mutate(old, rng)
        result, copy_bytes, literal_bytes, _ = roundtrip(old, new)
        self.assertEqual(result, new)
        self.assertGreater(copy_bytes, 0)

    def test_segment_order_independent_and_replay_idempotent(self):
        rng = random.Random(99)
        old = rng.randbytes(4096)
        new = mutate(old, rng)
        patch = delta(old, new)
        blob = serialize_patch(patch)
        first, _, _ = apply_patch(old, blob)
        second, _, _ = apply_patch(old, blob)
        self.assertEqual(first, second)
        self.assertEqual(first, new)
        # Apply segments in reversed order: deterministic identical result.
        parsed = parse_patch(blob)
        parsed.segments = list(reversed(parsed.segments))
        shuffled = serialize_patch(parsed)
        third, _, _ = apply_patch(old, shuffled)
        self.assertEqual(third, new)


class TestAdlerCollisionIntercept(unittest.TestCase):
    """Acceptance B: an Adler-32 collision must be stopped by SHA-256."""

    def test_strong_check_rejects_weak_collision(self):
        block = rollsync.MAX_BLOCK_SIZE  # 64 KiB window
        old_len = rollsync.SEED * block  # forces block_size == 64 KiB
        self.assertEqual(block_size_for(old_len), block)
        rng = random.Random(31337)
        old = rng.randbytes(old_len)

        victim_off = 3 * block
        victim = bytearray(old[victim_off:victim_off + block])
        # Classic Adler-32 collision: bump byte i, drop byte i + 65521.
        # s1 unchanged (deltas cancel); s2 shifts by 65521 * delta == 0 (mod 65521).
        evil = bytearray(victim)
        placed = False
        for i in range(0, block - 65521):
            if victim[i] < 255 and victim[i + 65521] > 0:
                evil[i] = victim[i] + 1
                evil[i + 65521] = victim[i + 65521] - 1
                placed = True
                break
        self.assertTrue(placed, "could not place collision deltas")
        evil = bytes(evil)
        self.assertNotEqual(evil, bytes(victim))
        self.assertEqual(zlib.adler32(evil), zlib.adler32(bytes(victim)))
        self.assertNotEqual(hashlib.sha256(evil).digest(),
                            hashlib.sha256(bytes(victim)).digest())

        new = old[:victim_off] + evil + old[victim_off + block:]
        patch = delta(old, new)
        blob = serialize_patch(patch)
        parsed = parse_patch(blob)

        # No copy segment may reference the tampered OLD block: every weak
        # hit against it was a false hit and had to be rejected by SHA-256.
        for segment in parsed.segments:
            if isinstance(segment, rollsync.CopySegment):
                self.assertFalse(
                    segment.old_offset < victim_off + block
                    and victim_off < segment.old_offset + segment.length,
                    "false weak hit slipped past the strong check")
        copy_total = sum(s.length for s in parsed.segments
                         if isinstance(s, rollsync.CopySegment))
        literal_total = sum(len(s.data) for s in parsed.segments
                            if isinstance(s, rollsync.LiteralSegment))
        self.assertGreaterEqual(literal_total, block)
        self.assertGreater(copy_total, 0)  # untouched blocks still matched

        result, copy_bytes, literal_bytes = apply_patch(old, blob)
        self.assertEqual(result, new)
        self.assertEqual(copy_bytes, copy_total)
        self.assertEqual(literal_bytes, literal_total)


class TestBoundaries(unittest.TestCase):
    """Acceptance C: OLD empty, NEW empty, OLD == NEW."""

    def test_both_empty(self):
        result, copy_bytes, literal_bytes, _ = roundtrip(b"", b"")
        self.assertEqual(result, b"")
        self.assertEqual((copy_bytes, literal_bytes), (0, 0))

    def test_old_empty(self):
        new = b"brand new contents" * 10
        result, copy_bytes, literal_bytes, _ = roundtrip(b"", new)
        self.assertEqual(result, new)
        self.assertEqual(copy_bytes, 0)
        self.assertEqual(literal_bytes, len(new))

    def test_new_empty(self):
        old = b"some old contents" * 10
        result, copy_bytes, literal_bytes, _ = roundtrip(old, b"")
        self.assertEqual(result, b"")
        self.assertEqual((copy_bytes, literal_bytes), (0, 0))

    def test_identical_files(self):
        old = bytes(range(256)) * 40
        result, copy_bytes, literal_bytes, _ = roundtrip(old, old)
        self.assertEqual(result, old)
        self.assertEqual(copy_bytes, len(old))
        self.assertEqual(literal_bytes, 0)


class TestCliAndFailureModes(unittest.TestCase):
    """Acceptance D plus CLI contract (exit codes, stdout, idempotence)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = self.tmp.name
        self.old_path = os.path.join(root, "old.bin")
        self.new_path = os.path.join(root, "new.bin")
        self.patch_path = os.path.join(root, "patch.bin")
        self.out_path = os.path.join(root, "out.bin")
        rng = random.Random(4242)
        self.old = rng.randbytes(5000)
        self.new = mutate(self.old, rng) + b"tail-marker"
        with open(self.old_path, "wb") as fh:
            fh.write(self.old)
        with open(self.new_path, "wb") as fh:
            fh.write(self.new)

    def _run(self, *argv):
        env = dict(os.environ)
        env["PYTHONPATH"] = REPO_ROOT + os.pathsep + env.get("PYTHONPATH", "")
        return subprocess.run([sys.executable, "-m", "rollsync", *argv],
                              capture_output=True, text=True, cwd=REPO_ROOT,
                              env=env)

    def _make_patch(self):
        proc = self._run("delta", self.old_path, self.new_path,
                         "--out", self.patch_path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        with open(self.patch_path, "rb") as fh:
            return fh.read()

    def test_cli_roundtrip_stdout_and_replay(self):
        self._make_patch()
        expected_copy = expected_literal = None
        for _ in range(2):  # replay must be idempotent
            proc = self._run("apply", self.old_path, self.patch_path,
                             "--out", self.out_path)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            match = re.fullmatch(r"copy=(\d+) literal=(\d+)\n", proc.stdout)
            self.assertIsNotNone(match, f"unexpected stdout: {proc.stdout!r}")
            copy_bytes, literal_bytes = int(match.group(1)), int(match.group(2))
            if expected_copy is None:
                expected_copy, expected_literal = copy_bytes, literal_bytes
            else:
                self.assertEqual((copy_bytes, literal_bytes),
                                 (expected_copy, expected_literal))
            with open(self.out_path, "rb") as fh:
                self.assertEqual(fh.read(), self.new)
        self.assertEqual(expected_copy + expected_literal, len(self.new))

    def test_truncated_patch_fails_and_target_untouched(self):
        blob = self._make_patch()
        sentinel = b"ORIGINAL-TARGET-BYTES"
        with open(self.out_path, "wb") as fh:
            fh.write(sentinel)
        for cut in (1, len(blob) // 2, len(blob) - 1):
            with open(self.patch_path, "wb") as fh:
                fh.write(blob[:cut])
            proc = self._run("apply", self.old_path, self.patch_path,
                             "--out", self.out_path)
            self.assertNotEqual(proc.returncode, 0, f"cut={cut} unexpectedly ok")
            with open(self.out_path, "rb") as fh:
                self.assertEqual(fh.read(), sentinel,
                                 f"cut={cut} clobbered the target")

    def test_truncated_patch_does_not_create_target(self):
        blob = self._make_patch()
        with open(self.patch_path, "wb") as fh:
            fh.write(blob[:len(blob) // 2])
        proc = self._run("apply", self.old_path, self.patch_path,
                         "--out", self.out_path)
        self.assertNotEqual(proc.returncode, 0)
        self.assertFalse(os.path.exists(self.out_path))

    def test_tampered_output_hash_exits_6_and_target_untouched(self):
        blob = bytearray(self._make_patch())
        blob[24] ^= 0xFF  # first byte of the stored new_sha256
        with open(self.patch_path, "wb") as fh:
            fh.write(blob)
        sentinel = b"DO-NOT-TOUCH"
        with open(self.out_path, "wb") as fh:
            fh.write(sentinel)
        proc = self._run("apply", self.old_path, self.patch_path,
                         "--out", self.out_path)
        self.assertEqual(proc.returncode, 6, proc.stderr)
        with open(self.out_path, "rb") as fh:
            self.assertEqual(fh.read(), sentinel)

    def test_tampered_old_exits_6_via_copy_segment_hash(self):
        self._make_patch()
        with open(self.old_path, "r+b") as fh:
            first = fh.read(1)
            fh.seek(0)
            fh.write(bytes([first[0] ^ 0xFF]))
        proc = self._run("apply", self.old_path, self.patch_path,
                         "--out", self.out_path)
        self.assertEqual(proc.returncode, 6, proc.stderr)
        self.assertFalse(os.path.exists(self.out_path))

    def test_library_raises_on_corrupt_and_checksum(self):
        blob = self._make_patch()
        with self.assertRaises(CorruptPatchError):
            apply_patch(self.old, blob[:len(blob) // 2])
        tampered = bytearray(blob)
        tampered[24] ^= 0x01
        with self.assertRaises(ChecksumMismatchError):
            apply_patch(self.old, bytes(tampered))


if __name__ == "__main__":
    unittest.main()
