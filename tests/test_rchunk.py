"""Tests for rchunk content-defined chunking."""
import copy
import json
import os
import random
import subprocess
import sys
import tempfile
import unittest
from collections import deque

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from rchunk import core  # noqa: E402
from rchunk.core import Chunker, CorruptError  # noqa: E402


def reference_chunks(data):
    """One-shot reference implementation.

    Simulates the rolling state byte by byte over the whole input with
    an explicitly managed deque window. Written independently from
    ``core.Chunker`` (which uses a ring buffer) so the two cross-check
    each other. Cut rule: fingerprint hit at len >= 64 first, forced
    cut at len == 4096; whichever condition is reached first wins.
    """
    window = deque()
    h = 0
    chunks = []
    start = 0
    pow_hi = pow(core.BASE, core.WINDOW - 1, core.MOD)
    for i, byte in enumerate(data):
        if len(window) == core.WINDOW:
            oldest = window.popleft()
            h = ((h - oldest * pow_hi) * core.BASE + byte) % core.MOD
        else:
            h = (h * core.BASE + byte) % core.MOD
        window.append(byte)
        clen = i + 1 - start
        if clen >= core.MIN_CHUNK and (h & core.MASK) == core.MASK:
            chunks.append((start, clen))
            start = i + 1
        elif clen == core.MAX_CHUNK:
            chunks.append((start, clen))
            start = i + 1
    if start < len(data):
        chunks.append((start, len(data) - start))
    return chunks


class ChunkSemanticsTest(unittest.TestCase):
    def test_all_zero_1mib_cuts_only_at_max(self):
        data = bytes(1 << 20)
        chunks = core.chunk_bytes(data)
        self.assertEqual(len(chunks), (1 << 20) // core.MAX_CHUNK)
        for i, (offset, length) in enumerate(chunks):
            self.assertEqual(offset, i * core.MAX_CHUNK)
            self.assertEqual(length, core.MAX_CHUNK)

    def test_buffer_size_independence(self):
        rng = random.Random(1234)
        data = rng.randbytes(1 << 20)
        results = []
        for buf_size in (8, 4096, 65536):
            chunker = Chunker()
            for i in range(0, len(data), buf_size):
                chunker.feed(data[i:i + buf_size])
            results.append(chunker.finish())
        self.assertEqual(results[0], results[1])
        self.assertEqual(results[1], results[2])
        self.assertEqual(results[0], core.chunk_bytes(data))
        # sanity: chunks form a contiguous ascending cover of the data
        expected = 0
        for offset, length in results[0]:
            self.assertEqual(offset, expected)
            expected = offset + length
        self.assertEqual(expected, len(data))

    def test_empty_input(self):
        self.assertEqual(core.chunk_bytes(b""), [])
        index = core.build_index(b"")
        core.verify_index(b"", index)

    def test_locate_and_verify_after_one_byte_change(self):
        rng = random.Random(7)
        data = bytearray(rng.randbytes(1 << 20))
        index = core.build_index(bytes(data))
        core.verify_index(bytes(data), index)

        for off in (0, 1, 63, 64, 123456, len(data) - 1):
            expected = core.locate_chunk(index, off)
            self.assertLessEqual(expected["offset"], off)
            self.assertLess(off, expected["offset"] + expected["len"])

            mutated = bytearray(data)
            mutated[off] ^= 0xFF
            with self.assertRaises(CorruptError) as ctx:
                core.verify_index(bytes(mutated), index)
            # first bad chunk reported with the minimal offset: exactly
            # the chunk covering the modified byte
            self.assertEqual(ctx.exception.offset, expected["offset"])

    def test_locate_out_of_range(self):
        index = core.build_index(random.Random(3).randbytes(10000))
        with self.assertRaises(CorruptError):
            core.locate_chunk(index, 10000)
        with self.assertRaises(CorruptError):
            core.locate_chunk(index, -1)

    def test_reference_comparison_up_to_3000(self):
        datasets = [
            random.Random(99).randbytes(3000),
            bytes((i * 7 + 3) % 256 for i in range(3000)),
            bytes(3000),  # all zeros: never hits the fingerprint
        ]
        for data in datasets:
            for n in range(0, 3001):
                with self.subTest(n=n, head=data[:4].hex()):
                    self.assertEqual(core.chunk_bytes(data[:n]),
                                     reference_chunks(data[:n]))

    def test_forced_cut_tie_and_precedence(self):
        # Construct a chunk whose fingerprint hits exactly at len 4096:
        # forced cut and fingerprint coincide; cut must happen there.
        rng = random.Random(2024)
        tie_data = None
        while tie_data is None:
            prefix = bytearray(rng.randbytes(core.MAX_CHUNK - 1))
            if reference_chunks(bytes(prefix)) != [(0, len(prefix))]:
                continue  # fingerprint hit too early; retry
            # replay the rolling state over the prefix
            window = deque()
            h = 0
            pow_hi = pow(core.BASE, core.WINDOW - 1, core.MOD)
            for b in prefix:
                if len(window) == core.WINDOW:
                    h = ((h - window.popleft() * pow_hi) * core.BASE
                         + b) % core.MOD
                else:
                    h = (h * core.BASE + b) % core.MOD
                window.append(b)
            oldest = window[0]
            base_val = ((h - oldest * pow_hi) * core.BASE) % core.MOD
            for cand in range(256):
                if ((base_val + cand) % core.MOD) & core.MASK == core.MASK:
                    tie_data = bytes(prefix) + bytes([cand])
                    break
        chunks = core.chunk_bytes(tie_data)
        self.assertEqual(chunks[0], (0, core.MAX_CHUNK))
        self.assertEqual(chunks, reference_chunks(tie_data))

        # Fingerprint hit one byte before the max wins over the forced
        # cut: the condition reached first decides the boundary.
        hit_at = None
        while hit_at is None:
            prefix = bytearray(rng.randbytes(core.MAX_CHUNK - 2))
            if reference_chunks(bytes(prefix)) != [(0, len(prefix))]:
                continue
            window = deque()
            h = 0
            pow_hi = pow(core.BASE, core.WINDOW - 1, core.MOD)
            for b in prefix:
                if len(window) == core.WINDOW:
                    h = ((h - window.popleft() * pow_hi) * core.BASE
                         + b) % core.MOD
                else:
                    h = (h * core.BASE + b) % core.MOD
                window.append(b)
            oldest = window[0]
            base_val = ((h - oldest * pow_hi) * core.BASE) % core.MOD
            for cand in range(256):
                if ((base_val + cand) % core.MOD) & core.MASK == core.MASK:
                    hit_at = bytes(prefix) + bytes([cand])
                    break
        self.assertEqual(len(hit_at), core.MAX_CHUNK - 1)
        chunks = core.chunk_bytes(hit_at)
        self.assertEqual(chunks[0], (0, core.MAX_CHUNK - 1))
        self.assertEqual(chunks, reference_chunks(hit_at))


class IndexValidationTest(unittest.TestCase):
    def setUp(self):
        self.data = random.Random(42).randbytes(200000)
        self.index = core.build_index(self.data)

    def test_roundtrip_and_verify(self):
        text = json.dumps(self.index)
        loaded = json.loads(text)
        core.verify_index(self.data, loaded)

    def test_gap_is_corrupt(self):
        bad = copy.deepcopy(self.index)
        bad["chunks"][1]["offset"] += 1
        with self.assertRaises(CorruptError) as ctx:
            core.verify_index(self.data, bad)
        self.assertIn("gap", str(ctx.exception))

    def test_overlap_is_corrupt(self):
        bad = copy.deepcopy(self.index)
        bad["chunks"][1]["offset"] -= 1
        with self.assertRaises(CorruptError) as ctx:
            core.verify_index(self.data, bad)
        self.assertIn("overlap", str(ctx.exception))

    def test_unsorted_is_corrupt(self):
        bad = copy.deepcopy(self.index)
        bad["chunks"][0], bad["chunks"][1] = \
            bad["chunks"][1], bad["chunks"][0]
        with self.assertRaises(CorruptError):
            core.verify_index(self.data, bad)

    def test_size_mismatch_is_corrupt(self):
        with self.assertRaises(CorruptError):
            core.verify_index(self.data + b"x", self.index)
        bad = copy.deepcopy(self.index)
        bad["size"] += 1
        with self.assertRaises(CorruptError):
            core.verify_index(self.data, bad)

    def test_first_bad_chunk_reports_min_offset(self):
        bad = copy.deepcopy(self.index)
        # corrupt two chunk digests; the smaller offset must be reported
        i, j = 2, 5
        for k in (i, j):
            bad["chunks"][k]["sha256"] = "0" * 64
        with self.assertRaises(CorruptError) as ctx:
            core.verify_index(self.data, bad)
        self.assertEqual(ctx.exception.offset,
                         self.index["chunks"][i]["offset"])


class CliTest(unittest.TestCase):
    def _run_cli(self, *args):
        env = dict(os.environ)
        env["PYTHONPATH"] = REPO_ROOT + os.pathsep + env.get("PYTHONPATH", "")
        return subprocess.run(
            [sys.executable, "-m", "rchunk", *args],
            capture_output=True, text=True, cwd=REPO_ROOT, env=env)

    def test_chunk_locate_verify_roundtrip(self):
        data = random.Random(11).randbytes(300000)
        with tempfile.TemporaryDirectory() as tmp:
            data_path = os.path.join(tmp, "data.bin")
            index_path = os.path.join(tmp, "data.bin.chunk")
            with open(data_path, "wb") as fh:
                fh.write(data)

            proc = self._run_cli("chunk", data_path, index_path)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertTrue(os.path.exists(index_path))

            proc = self._run_cli("verify", data_path, index_path)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn("OK", proc.stdout)

            with open(index_path) as fh:
                index = json.load(fh)
            entry = core.locate_chunk(index, 150000)
            proc = self._run_cli("locate", index_path, "150000")
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn("offset=%d" % entry["offset"], proc.stdout)
            self.assertIn("len=%d" % entry["len"], proc.stdout)

            # corrupt one byte: verify must fail and report the offset
            with open(data_path, "r+b") as fh:
                fh.seek(150000)
                b = fh.read(1)
                fh.seek(150000)
                fh.write(bytes([b[0] ^ 0xFF]))
            proc = self._run_cli("verify", data_path, index_path)
            self.assertEqual(proc.returncode, 1)
            self.assertIn("Corrupt", proc.stderr)
            self.assertIn("offset %d" % entry["offset"], proc.stderr)


if __name__ == "__main__":
    unittest.main()
