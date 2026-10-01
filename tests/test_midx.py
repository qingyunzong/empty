import hashlib
import os
import random
import subprocess
import sys
import tempfile
import unittest

from midx import core


def reference_levels(leaves):
    """Independent brute-force recompute of the full sha256 tree."""
    levels = [list(leaves)]
    while len(levels[-1]) > 1:
        cur = levels[-1]
        nxt = []
        for i in range(0, len(cur), 2):
            left = cur[i]
            right = cur[i + 1] if i + 1 < len(cur) else left
            nxt.append(hashlib.sha256(left + right).digest())
        levels.append(nxt)
    return levels


def run_cli(*args, cwd=None):
    return subprocess.run([sys.executable, "-m", "midx", *args],
                          capture_output=True, text=True, cwd=cwd)


class MidxTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = self.tmp.name

    def write_file(self, name, data):
        path = os.path.join(self.dir, name)
        with open(path, "wb") as f:
            f.write(data)
        return path

    def make_4mib(self, block_size=65536):
        rng = random.Random(20261001)
        data = rng.randbytes(4 * 1024 * 1024)
        path = self.write_file("data.bin", data)
        index, index_path = core.build(path, block_size)
        return path, index_path, index, bytearray(data)


class TestFullVerify(MidxTestCase):
    def test_4mib_build_and_full_verify(self):
        path, index_path, index, _ = self.make_4mib()
        self.assertEqual(index.leaf_count, 64)
        bad = core.verify_range(index, path)
        self.assertEqual(bad, [])
        proc = run_cli("verify", path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("OK", proc.stdout)
        proc = run_cli("root", index_path)
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout.strip(), index.root.hex())


class TestLocalVerify(MidxTestCase):
    def test_corrupt_block_17_local_verify(self):
        path, index_path, index, data = self.make_4mib()
        bs = index.block_size
        data[17 * bs] ^= 0xFF  # flip one byte in block 17
        self.write_file("data.bin", bytes(data))

        # local verify covering only block 17 must report block 17
        bad = core.verify_range(index, path, offset=17 * bs, length=bs)
        self.assertEqual(bad, [17])
        proc = run_cli("verify", path, "--offset", str(17 * bs),
                       "--length", str(bs))
        self.assertEqual(proc.returncode, 1, proc.stderr)
        self.assertIn("17", proc.stdout)

        # a range not covering block 17 stays OK (no full-file scan)
        bad = core.verify_range(index, path, offset=0, length=10 * bs)
        self.assertEqual(bad, [])

        # smallest bad block wins when several are bad
        data[5 * bs] ^= 0x01
        self.write_file("data.bin", bytes(data))
        bad = core.verify_range(index, path, offset=0, length=20 * bs)
        self.assertEqual(bad[0], 5)
        self.assertEqual(bad, [5, 17])

    def test_tail_block_actual_length(self):
        bs = 1000  # non power of two
        data = random.Random(7).randbytes(3 * bs + 123)
        path = self.write_file("tail.bin", data)
        index, _ = core.build(path, bs)
        self.assertEqual(index.leaf_count, 4)
        self.assertEqual(index.levels[0][3], hashlib.sha256(data[-123:]).digest())
        self.assertEqual(core.verify_range(index, path), [])


class TestIndexCorruption(MidxTestCase):
    def test_truncated_index_cli_exit_4(self):
        path, index_path, _, _ = self.make_4mib()
        with open(index_path, "rb+") as f:
            f.truncate(os.path.getsize(index_path) - 1)
        proc = run_cli("verify", path)
        self.assertEqual(proc.returncode, 4, proc.stderr)
        proc = run_cli("root", index_path)
        self.assertEqual(proc.returncode, 4)

    def test_crc_mismatch_raises_indexerror(self):
        path, index_path, _, _ = self.make_4mib()
        with open(index_path, "rb") as f:
            raw = bytearray(f.read())
        raw[core.HEADER.size + 5] ^= 0xFF  # corrupt a leaf hash byte
        with self.assertRaises(IndexError):
            core.parse(bytes(raw))

    def test_bad_magic_raises_indexerror(self):
        with self.assertRaises(IndexError):
            core.parse(b"NOPE" + b"\x00" * 64)


class TestReferenceTree(MidxTestCase):
    def test_leaf_counts_1_to_40_against_brute_force(self):
        bs = 64
        rng = random.Random(99)
        for n in range(1, 41):
            with self.subTest(leaves=n):
                # vary tail length so non-full last blocks are covered
                size = n * bs - (n % 5)
                data = rng.randbytes(size)
                path = self.write_file(f"ref{n}.bin", data)
                index, index_path = core.build(path, bs)
                self.assertEqual(index.leaf_count, n)

                leaves = [hashlib.sha256(
                    data[i * bs:(i + 1) * bs]).digest() for i in range(n)]
                expected = reference_levels(leaves)
                self.assertEqual(index.levels, expected)
                self.assertEqual(len(index.root), 32)

                # round-trip through the serialized file
                loaded = core.load_index(index_path)
                self.assertEqual(loaded.levels, expected)
                self.assertEqual(loaded.block_size, bs)
                self.assertEqual(loaded.file_size, size)


if __name__ == "__main__":
    unittest.main()
