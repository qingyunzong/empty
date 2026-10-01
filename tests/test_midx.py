"""Acceptance tests for midx (run: python -m unittest discover -s tests -v)."""

from __future__ import annotations

import hashlib
import os
import random
import subprocess
import sys
import tempfile
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from midx import core  # noqa: E402

MIB = 1 << 20


def run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "midx", *args],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
    )


def reference_levels(blocks):
    """Independent brute-force Merkle tree: hash every block, pair bottom-up,
    duplicating the odd tail node.  Returns all levels, root last."""
    level = [hashlib.sha256(b).digest() for b in blocks]
    levels = [level]
    while len(level) > 1:
        if len(level) % 2 == 1:
            level = level + [level[-1]]
        level = [
            hashlib.sha256(level[i] + level[i + 1]).digest()
            for i in range(0, len(level), 2)
        ]
        levels.append(level)
    return levels


class MidxCliTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = self.tmp.name

    def path(self, name):
        return os.path.join(self.dir, name)

    def write_file(self, name, data):
        p = self.path(name)
        with open(p, "wb") as f:
            f.write(data)
        return p


class TestFullVerify4MiB(MidxCliTestBase):
    def test_build_then_full_verify(self):
        data = random.Random(20241001).randbytes(4 * MIB)
        f = self.write_file("data.bin", data)
        r = run_cli("build", f, "--block-size", "65536")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(os.path.exists(f + ".index"))
        r = run_cli("verify", f)
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        self.assertIn("OK", r.stdout)
        r = run_cli("root", f)
        self.assertEqual(r.returncode, 0, r.stderr)
        index = core.load_index(f + ".index")
        self.assertEqual(r.stdout.strip(), index.root.hex())
        self.assertEqual(index.leaf_count, 64)


class TestLocalVerifyFindsBlock17(MidxCliTestBase):
    def test_corrupt_block_17_local_verify(self):
        bs = 65536
        data = random.Random(7).randbytes(4 * MIB)
        f = self.write_file("data.bin", data)
        self.assertEqual(run_cli("build", f, "--block-size", str(bs)).returncode, 0)
        with open(f, "r+b") as fh:  # flip one byte inside block 17, after indexing
            fh.seek(17 * bs + 123)
            fh.write(bytes([data[17 * bs + 123] ^ 0xFF]))

        # Local verify over blocks 16..18 only: must report block 17.
        r = run_cli("verify", f, "--offset", str(16 * bs), "--length", str(3 * bs))
        self.assertEqual(r.returncode, 1, r.stderr + r.stdout)
        self.assertIn("first bad block 17", r.stdout)

        # Local verify of an untouched range passes.
        r = run_cli("verify", f, "--offset", "0", "--length", str(2 * bs))
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)

        # Full verify reports 17 as the first (smallest) bad block.
        r = run_cli("verify", f)
        self.assertEqual(r.returncode, 1, r.stderr + r.stdout)
        self.assertIn("first bad block 17", r.stdout)

    def test_first_bad_block_is_smallest(self):
        bs = 4096
        data = random.Random(11).randbytes(64 * bs)
        f = self.write_file("data.bin", data)
        self.assertEqual(run_cli("build", f, "--block-size", str(bs)).returncode, 0)
        with open(f, "r+b") as fh:  # corrupt several blocks, out of order
            for b in (40, 9, 23):
                fh.seek(b * bs)
                fh.write(bytes([data[b * bs] ^ 0x01]))
        r = run_cli("verify", f)
        self.assertEqual(r.returncode, 1, r.stderr + r.stdout)
        self.assertIn("first bad block 9", r.stdout)
        self.assertIn("9 23 40", r.stdout)  # ascending order


class TestIndexCorruption(MidxCliTestBase):
    def _build(self):
        data = random.Random(3).randbytes(300000)
        f = self.write_file("data.bin", data)
        self.assertEqual(run_cli("build", f, "--block-size", "70000").returncode, 0)
        return f, f + ".index"

    def test_truncated_last_byte_exit_4(self):
        f, idx = self._build()
        os.truncate(idx, os.path.getsize(idx) - 1)
        r = run_cli("verify", f)
        self.assertEqual(r.returncode, 4, r.stderr + r.stdout)
        r = run_cli("root", f)
        self.assertEqual(r.returncode, 4, r.stderr + r.stdout)

    def test_crc_mismatch_exit_4(self):
        f, idx = self._build()
        with open(idx, "r+b") as fh:  # corrupt a leaf-level hash byte
            fh.seek(core.HEADER_LEN + 5)
            b = fh.read(1)
            fh.seek(core.HEADER_LEN + 5)
            fh.write(bytes([b[0] ^ 0xFF]))
        r = run_cli("verify", f)
        self.assertEqual(r.returncode, 4, r.stderr + r.stdout)

    def test_bad_magic_exit_4(self):
        f, idx = self._build()
        with open(idx, "r+b") as fh:
            fh.write(b"XXXX")
        r = run_cli("verify", f)
        self.assertEqual(r.returncode, 4, r.stderr + r.stdout)


class TestReferenceTreeLeafCounts(MidxCliTestBase):
    def test_leaf_counts_1_to_40_against_brute_force(self):
        bs = 1000  # deliberately not a power of two
        rng = random.Random(99)
        for n in range(1, 41):
            with self.subTest(leaf_count=n):
                payload = rng.randbytes((n - 1) * bs + 13)  # short tail block
                blocks = [payload[i * bs : (i + 1) * bs] for i in range(n)]
                ref = reference_levels(blocks)

                leaves = [core.sha256(b) for b in blocks]
                blob = core.build_index_bytes(bs, len(payload), leaves)
                index = core.parse(blob)

                self.assertEqual(index.leaf_count, n)
                self.assertEqual(index.levels, ref)
                self.assertEqual(index.root, ref[-1][0])
                self.assertEqual(len(index.root), 32)
                # Every leaf path verifies against the brute-force root.
                for i, blk in enumerate(blocks):
                    self.assertTrue(core.verify_leaf_path(index, i, core.sha256(blk)))
                # Tampered leaf must fail.
                self.assertFalse(
                    core.verify_leaf_path(index, 0, core.sha256(b"tampered"))
                )

    def test_cli_root_matches_reference(self):
        bs = 1000
        rng = random.Random(5)
        for n in (1, 2, 3, 17, 40):
            with self.subTest(leaf_count=n):
                payload = rng.randbytes((n - 1) * bs + 13)
                f = self.write_file(f"d{n}.bin", payload)
                self.assertEqual(
                    run_cli("build", f, "--block-size", str(bs)).returncode, 0
                )
                blocks = [payload[i * bs : (i + 1) * bs] for i in range(n)]
                ref_root = reference_levels(blocks)[-1][0].hex()
                r = run_cli("root", f)
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertEqual(r.stdout.strip(), ref_root)
                r = run_cli("verify", f)
                self.assertEqual(r.returncode, 0, r.stderr + r.stdout)


class TrackingFile:
    """File wrapper that records how many bytes are actually read."""

    def __init__(self, path):
        self._f = open(path, "rb")
        self.bytes_read = 0

    def seek(self, off):
        self._f.seek(off)

    def read(self, n=-1):
        data = self._f.read(n)
        self.bytes_read += len(data)
        return data

    def close(self):
        self._f.close()


class TestLocalReadsOnly(MidxCliTestBase):
    def test_verify_range_reads_only_covered_blocks(self):
        bs = 4096
        data = random.Random(21).randbytes(64 * bs)
        f = self.write_file("data.bin", data)
        self.assertEqual(run_cli("build", f, "--block-size", str(bs)).returncode, 0)
        index = core.load_index(f + ".index")

        tf = TrackingFile(f)
        bad = core.verify_range(tf, index, 16 * bs, 3 * bs)
        tf.close()
        self.assertEqual(bad, [])
        self.assertEqual(tf.bytes_read, 3 * bs)  # exactly blocks 16..18, no full scan

        tf = TrackingFile(f)
        bad = core.verify_range(tf, index, 16 * bs + 100, 2 * bs)  # unaligned range
        tf.close()
        self.assertEqual(bad, [])
        self.assertEqual(tf.bytes_read, 3 * bs)  # still only blocks 16..18

    def test_tail_block_hashed_by_actual_length(self):
        bs = 1000
        payload = random.Random(31).randbytes(3 * bs + 1)  # 1-byte tail block
        f = self.write_file("data.bin", payload)
        self.assertEqual(run_cli("build", f, "--block-size", str(bs)).returncode, 0)
        index = core.load_index(f + ".index")
        self.assertEqual(index.leaf_count, 4)
        self.assertEqual(index.levels[0][3], hashlib.sha256(payload[-1:]).digest())
        tf = TrackingFile(f)
        self.assertEqual(core.verify_range(tf, index, 3 * bs, 1), [])
        tf.close()
        self.assertEqual(tf.bytes_read, 1)


if __name__ == "__main__":
    unittest.main()
