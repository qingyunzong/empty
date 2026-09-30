import hashlib
import os
import random
import re
import subprocess
import sys
import tempfile
import unittest
import zlib

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

import rollsync
from rollsync import (
    HashMismatchError,
    PatchCorruptError,
    apply_patch,
    delta,
    parse_patch,
    serialize_patch,
    summarize,
)

SEED = 17
STATS_RE = re.compile(rb"^copy_bytes=(\d+) literal_bytes=(\d+)\s*$")


def mutate(rng, data, edits=8):
    buf = bytearray(data)
    for _ in range(edits):
        if not buf:
            break
        op = rng.randint(0, 2)
        pos = rng.randrange(len(buf))
        ln = rng.randint(1, 2000)
        if op == 0:
            buf[pos:pos + ln] = rng.randbytes(ln)
        elif op == 1:
            del buf[pos:pos + ln]
        else:
            buf[pos:pos] = rng.randbytes(ln)
    return bytes(buf)


def naive_lcs(a, b):
    """Naive O(n*m) longest-common-substring reference."""
    best = (0, 0, 0)
    prev = [0] * (len(b) + 1)
    for i in range(1, len(a) + 1):
        cur = [0] * (len(b) + 1)
        ai = a[i - 1]
        for j in range(1, len(b) + 1):
            if ai == b[j - 1]:
                cur[j] = prev[j - 1] + 1
                if cur[j] > best[2]:
                    best = (i - cur[j], j - cur[j], cur[j])
        prev = cur
    return best


def reference_delta(old, new):
    """Reference patch: literal + copy of the naive LCS + literal."""
    oa, ob, ln = naive_lcs(old, new)
    ops = []
    if ob:
        ops.append(("literal", 0, new[:ob]))
    if ln:
        ops.append(("copy", ob, oa, ln))
    if ob + ln < len(new):
        ops.append(("literal", ob + ln, new[ob + ln:]))
    return ops


def reference_apply(old, ops):
    out = bytearray()
    for op in sorted(ops, key=lambda o: o[1]):
        if op[0] == "copy":
            out += old[op[2]:op[2] + op[3]]
        else:
            out += op[2]
    return bytes(out)


def run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "rollsync", *args],
        cwd=REPO_ROOT, capture_output=True)


class TestRollingAdler(unittest.TestCase):
    def test_rolling_matches_zlib(self):
        rng = random.Random(1234)
        data = rng.randbytes(6000)
        for size in (1, 2, 7, 64, 1024):
            roll = rollsync.RollingAdler(data[:size], seed=SEED)
            self.assertEqual(roll.digest, zlib.adler32(data[:size], SEED))
            for i in range(1, len(data) - size + 1):
                roll.roll(data[i - 1], data[i + size - 1])
                self.assertEqual(roll.digest, zlib.adler32(data[i:i + size], SEED),
                                 f"size={size} i={i}")

    def test_block_size_rules(self):
        self.assertEqual(rollsync.derive_block_size(0), 0)
        for ln in (1, 16, 17, 100, 65536, 10 ** 6, 10 ** 7):
            bs = rollsync.derive_block_size(ln)
            self.assertTrue(1 <= bs <= 65536, (ln, bs))
            self.assertEqual(bs, rollsync.derive_block_size(ln, SEED))
        self.assertEqual(rollsync.derive_block_size(17 * 65536), 65536)


class TestRoundTripRandom(unittest.TestCase):
    """Acceptance A: random small files (<=1MB) round-trip to exact bytes."""

    def test_random_roundtrip(self):
        rng = random.Random(20260930)
        for case in range(40):
            old = rng.randbytes(rng.randint(0, 200_000))
            mode = case % 3
            if mode == 0:
                new = rng.randbytes(rng.randint(0, 200_000))
            elif mode == 1:
                new = mutate(rng, old)
            else:
                new = old
            patch = delta(old, new)
            self.assertEqual(apply_patch(old, patch), new, f"case {case}")

    def test_one_megabyte_roundtrip(self):
        rng = random.Random(1_000_000)
        for _ in range(2):
            old = rng.randbytes(1_000_000)
            new = mutate(rng, old, edits=12)
            self.assertEqual(apply_patch(old, delta(old, new)), new)


class TestNaiveLCSReference(unittest.TestCase):
    """Acceptance A: final bytes match a naive LCS reference implementation."""

    def test_final_bytes_match_reference(self):
        rng = random.Random(99)
        for case in range(15):
            old = rng.randbytes(rng.randint(0, 300))
            if rng.random() < 0.7:
                new = mutate(rng, old, edits=3)
            else:
                new = rng.randbytes(rng.randint(0, 300))
            ours = apply_patch(old, delta(old, new))
            ref = reference_apply(old, reference_delta(old, new))
            self.assertEqual(ref, new, f"reference broken, case {case}")
            self.assertEqual(ours, ref, f"final bytes differ, case {case}")


class TestAdlerCollision(unittest.TestCase):
    """Acceptance B: an Adler-32 collision must be intercepted by sha256."""

    @staticmethod
    def colliding_pair():
        # 64 KiB blocks X and Y: equal adler32 (seed 17), different sha256.
        # Y differs from X by +1 at offset 0 and -1 at offset 65521, so
        # delta_a = 0 and delta_b = 65536 - 15 = 65521 == 0 (mod 65521).
        rng = random.Random(SEED)
        x = bytearray(rng.randbytes(65536))
        assert x[0] < 255 and x[65521] > 0
        y = bytearray(x)
        y[0] += 1
        y[65521] -= 1
        x, y = bytes(x), bytes(y)
        assert zlib.adler32(x, SEED) == zlib.adler32(y, SEED)
        assert hashlib.sha256(x).digest() != hashlib.sha256(y).digest()
        return x, y

    def test_strong_check_intercepts_false_hit(self):
        x, y = self.colliding_pair()
        old = x * 17  # block size is exactly 64 KiB for this size
        self.assertEqual(rollsync.derive_block_size(len(old)), 65536)
        new = y + x * 16
        patch = delta(old, new)
        _, ops = parse_patch(patch)
        # The weak checksum of window NEW[0:65536] (== Y) collides with X,
        # so without the sha256 arbitration a false copy would start at 0.
        bad = [op for op in ops if op[0] == "copy" and op[1] < 65536]
        self.assertEqual(bad, [])
        # Every emitted copy must be a genuine, byte-identical match.
        for op in ops:
            if op[0] == "copy":
                _, noff, ooff, ln = op
                self.assertEqual(new[noff:noff + ln], old[ooff:ooff + ln])
        copy_bytes, literal_bytes = summarize(ops)
        self.assertGreaterEqual(literal_bytes, 65536)
        self.assertEqual(copy_bytes, 16 * 65536)
        # And the patch still applies to the exact NEW bytes.
        self.assertEqual(apply_patch(old, patch), new)


class TestBoundaries(unittest.TestCase):
    """Acceptance C: empty OLD, empty NEW, identical inputs."""

    def test_empty_old(self):
        new = b"hello world" * 100
        patch = delta(b"", new)
        _, ops = parse_patch(patch)
        self.assertEqual(summarize(ops), (0, len(new)))
        self.assertEqual(apply_patch(b"", patch), new)

    def test_empty_new(self):
        old = b"x" * 100000
        patch = delta(old, b"")
        _, ops = parse_patch(patch)
        self.assertEqual(ops, [])
        self.assertEqual(summarize(ops), (0, 0))
        self.assertEqual(apply_patch(old, patch), b"")

    def test_both_empty(self):
        patch = delta(b"", b"")
        self.assertEqual(apply_patch(b"", patch), b"")

    def test_identical(self):
        rng = random.Random(7)
        data = rng.randbytes(150_000)
        patch = delta(data, data)
        self.assertEqual(apply_patch(data, patch), data)
        _, ops = parse_patch(patch)
        copy_bytes, literal_bytes = summarize(ops)
        self.assertEqual(copy_bytes, len(data))
        self.assertEqual(literal_bytes, 0)


class TestPatchSemantics(unittest.TestCase):
    """Rules 3 and 5: order-independent application, idempotent replay."""

    def setUp(self):
        rng = random.Random(11)
        self.old = rng.randbytes(50_000)
        self.new = mutate(rng, self.old, edits=10)
        self.patch = delta(self.old, self.new)

    def test_op_order_irrelevant(self):
        meta, ops = parse_patch(self.patch)
        shuffled = list(ops)
        random.Random(3).shuffle(shuffled)
        patch2 = serialize_patch(meta, shuffled)
        self.assertEqual(apply_patch(self.old, patch2), self.new)
        self.assertEqual(apply_patch(self.old, self.patch),
                         apply_patch(self.old, patch2))

    def test_replay_idempotent(self):
        first = apply_patch(self.old, self.patch)
        second = apply_patch(self.old, self.patch)
        self.assertEqual(first, second)
        self.assertEqual(first, self.new)


class TestCorruption(unittest.TestCase):
    """Acceptance D and rule 4: truncated/corrupt patches fail safely."""

    @classmethod
    def setUpClass(cls):
        rng = random.Random(5)
        cls.old = rng.randbytes(5000)
        cls.new = mutate(rng, cls.old, edits=5)
        cls.patch = delta(cls.old, cls.new)

    def test_truncated_patch_rejected_api(self):
        cuts = {0, 1, 10, rollsync.HEADER_SIZE - 1, rollsync.HEADER_SIZE,
                rollsync.HEADER_SIZE + 1, len(self.patch) // 2,
                len(self.patch) - 1}
        for cut in sorted(cuts):
            with self.assertRaises(PatchCorruptError, msg=f"cut={cut}"):
                apply_patch(self.old, self.patch[:cut])

    def test_truncated_patch_cli_preserves_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            old_p = os.path.join(tmp, "old.bin")
            out_p = os.path.join(tmp, "out.bin")
            with open(old_p, "wb") as fh:
                fh.write(self.old)
            sentinel = b"ORIGINAL-TARGET-BYTES"
            with open(out_p, "wb") as fh:
                fh.write(sentinel)
            for cut in (0, rollsync.HEADER_SIZE, len(self.patch) // 2,
                        len(self.patch) - 1):
                patch_p = os.path.join(tmp, "trunc.bin")
                with open(patch_p, "wb") as fh:
                    fh.write(self.patch[:cut])
                proc = run_cli("apply", old_p, patch_p, "--out", out_p)
                self.assertEqual(proc.returncode, 5, (cut, proc.stderr))
                with open(out_p, "rb") as fh:
                    self.assertEqual(fh.read(), sentinel, f"cut={cut}")

    def test_hash_mismatch_exit_6(self):
        # Flip one bit inside the stored sha256 of NEW (header bytes 32..64).
        bad = bytearray(self.patch)
        bad[40] ^= 0x01
        with self.assertRaises(HashMismatchError):
            apply_patch(self.old, bytes(bad))
        with tempfile.TemporaryDirectory() as tmp:
            old_p = os.path.join(tmp, "old.bin")
            patch_p = os.path.join(tmp, "patch.bin")
            out_p = os.path.join(tmp, "out.bin")
            with open(old_p, "wb") as fh:
                fh.write(self.old)
            with open(patch_p, "wb") as fh:
                fh.write(bytes(bad))
            sentinel = b"KEEP-ME"
            with open(out_p, "wb") as fh:
                fh.write(sentinel)
            proc = run_cli("apply", old_p, patch_p, "--out", out_p)
            self.assertEqual(proc.returncode, 6, proc.stderr)
            with open(out_p, "rb") as fh:
                self.assertEqual(fh.read(), sentinel)

    def test_corrupt_literal_payload_exit_6(self):
        # OLD empty -> patch is a single literal op; corrupt its payload.
        new = mutate(random.Random(21), b"payload seed data" * 40, edits=2)
        patch = delta(b"", new)
        data_off = rollsync.HEADER_SIZE + 17  # header + literal op header
        bad = bytearray(patch)
        bad[data_off] ^= 0xFF
        with self.assertRaises(HashMismatchError):
            apply_patch(b"", bytes(bad))
        with tempfile.TemporaryDirectory() as tmp:
            old_p = os.path.join(tmp, "old.bin")
            patch_p = os.path.join(tmp, "patch.bin")
            out_p = os.path.join(tmp, "out.bin")
            for path, blob in ((old_p, b""), (patch_p, bytes(bad))):
                with open(path, "wb") as fh:
                    fh.write(blob)
            proc = run_cli("apply", old_p, patch_p, "--out", out_p)
            self.assertEqual(proc.returncode, 6, proc.stderr)
            self.assertFalse(os.path.exists(out_p))


class TestCLI(unittest.TestCase):
    def test_delta_apply_end_to_end(self):
        rng = random.Random(42)
        old = rng.randbytes(80_000)
        new = mutate(rng, old, edits=6)
        with tempfile.TemporaryDirectory() as tmp:
            old_p = os.path.join(tmp, "old.bin")
            new_p = os.path.join(tmp, "new.bin")
            patch_p = os.path.join(tmp, "patch.bin")
            out_p = os.path.join(tmp, "out.bin")
            for path, blob in ((old_p, old), (new_p, new)):
                with open(path, "wb") as fh:
                    fh.write(blob)
            proc = run_cli("delta", old_p, new_p, "--out", patch_p)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            m1 = STATS_RE.match(proc.stdout)
            self.assertIsNotNone(m1, proc.stdout)
            proc = run_cli("apply", old_p, patch_p, "--out", out_p)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            m2 = STATS_RE.match(proc.stdout)
            self.assertIsNotNone(m2, proc.stdout)
            self.assertEqual(m1.groups(), m2.groups())
            with open(out_p, "rb") as fh:
                self.assertEqual(fh.read(), new)
            # Replay: applying again yields the identical bytes (idempotent).
            proc = run_cli("apply", old_p, patch_p, "--out", out_p)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            with open(out_p, "rb") as fh:
                self.assertEqual(fh.read(), new)


if __name__ == "__main__":
    unittest.main()
