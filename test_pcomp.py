"""Acceptance tests for pcomp (Python 3.11 stdlib unittest)."""

import os
import random
import subprocess
import sys
import tempfile
import unittest

import pcomp

PCOMP_PY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pcomp.py")


def run_cli(*argv):
    """Run the pcomp CLI as a subprocess; return CompletedProcess."""
    return subprocess.run(
        [sys.executable, PCOMP_PY, *argv],
        capture_output=True, text=True)


class PcompTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = self.tmp.name

    def path(self, name):
        return os.path.join(self.dir, name)

    def build(self, terms, name="idx.bin"):
        out = self.path(name)
        pcomp.build_index(terms, out)
        return out


class TestRandomRoundTrip(PcompTestBase):
    """A: random term sets fully compared against an in-memory dict."""

    def test_random_terms_match_in_memory_dict(self):
        rng = random.Random(20261001)
        terms = {}
        for i in range(200):
            term = "term_%d" % rng.randrange(500)
            n = rng.choice([1, 2, 5, 100, 127, 128, 129, 300, 1000])
            docids = [rng.randrange(0, 2 ** 32) for _ in range(n)]
            terms.setdefault(term, []).extend(docids)
        expected = {t: sorted(set(d)) for t, d in terms.items() if d}

        idx = self.build(terms)
        # every term in the index must match the in-memory dict exactly
        for term, docids in expected.items():
            self.assertEqual(pcomp.lookup(idx, term), docids, term)
        # absent terms must return empty
        for i in range(50):
            missing = "nope_%d" % i
            self.assertEqual(pcomp.lookup(idx, missing), [])
        # scan agrees on totals
        term_count, total = pcomp.scan(idx)
        self.assertEqual(term_count, len(expected))
        self.assertEqual(total, sum(len(d) for d in expected.values()))

    def test_lookup_reads_only_relevant_blocks(self):
        # Corrupt a block belonging to term "aaa"; lookup of "zzz" (whose
        # blocks are untouched) must still succeed, proving lookup does not
        # decompress the whole index. scan() must still fail.
        terms = {"aaa": list(range(500)), "zzz": list(range(500))}
        idx = self.build(terms)
        with open(idx, "rb") as fh:
            dict_offset = int.from_bytes(fh.read(24)[12:20], "little")
        # postings for "aaa" start right after the 24-byte header
        with open(idx, "r+b") as fh:
            fh.seek(24 + 6)  # inside aaa's first block payload
            byte = fh.read(1)
            fh.seek(24 + 6)
            fh.write(bytes([byte[0] ^ 0xFF]))
        self.assertEqual(pcomp.lookup(idx, "zzz"), list(range(500)))
        with self.assertRaises(pcomp.Corrupt):
            pcomp.lookup(idx, "aaa")
        with self.assertRaises(pcomp.Corrupt):
            pcomp.scan(idx)
        self.assertGreater(dict_offset, 24)


class TestBoundaries(PcompTestBase):
    """B: boundary docids and block-size edges."""

    def test_docid_zero_and_max(self):
        idx = self.build({"t": [0, 2 ** 32 - 1]})
        self.assertEqual(pcomp.lookup(idx, "t"), [0, 2 ** 32 - 1])

    def test_single_element(self):
        idx = self.build({"solo": [42]})
        self.assertEqual(pcomp.lookup(idx, "solo"), [42])

    def test_exactly_128_and_129(self):
        idx = self.build({
            "b128": list(range(128)),
            "b129": list(range(129)),
        })
        self.assertEqual(pcomp.lookup(idx, "b128"), list(range(128)))
        self.assertEqual(pcomp.lookup(idx, "b129"), list(range(129)))

    def test_block_structure_marks_short_final_block(self):
        idx = self.build({"b129": list(range(129))})
        with open(idx, "rb") as fh:
            raw = fh.read()
        # first block: count=128, second block: count=1 (short final block)
        self.assertEqual(raw[24], 128)
        # locate second block: skip header(5) + payload + crc(4)
        import struct
        _, payload_len = struct.unpack_from("<BI", raw, 24)
        second = 24 + 5 + payload_len + 4
        self.assertEqual(raw[second], 1)


class TestCorruption(PcompTestBase):
    """C: flipping one byte in header / dictionary / postings -> exit 4."""

    def _flipped_copy(self, src, offset, name):
        dst = self.path(name)
        with open(src, "rb") as fh:
            data = bytearray(fh.read())
        data[offset] ^= 0x01
        with open(dst, "wb") as fh:
            fh.write(data)
        return dst

    def setUp(self):
        super().setUp()
        self.idx = self.build(
            {"alpha": list(range(300)), "beta": [7, 9, 11]}, "good.bin")
        with open(self.idx, "rb") as fh:
            header = fh.read(24)
        self.dict_offset = int.from_bytes(header[12:20], "little")
        self.size = os.path.getsize(self.idx)

    def test_flip_header_byte_exit4(self):
        bad = self._flipped_copy(self.idx, 3, "bad_header.bin")
        for cmd in (["lookup", bad, "alpha"], ["scan", bad]):
            res = run_cli(*cmd)
            self.assertEqual(res.returncode, 4, (cmd, res.stderr))
            self.assertIn("Corrupt", res.stderr)
            self.assertEqual(res.stdout, "")

    def test_flip_dictionary_byte_exit4(self):
        bad = self._flipped_copy(self.idx, self.dict_offset + 6, "bad_dict.bin")
        for cmd in (["lookup", bad, "alpha"], ["scan", bad]):
            res = run_cli(*cmd)
            self.assertEqual(res.returncode, 4, (cmd, res.stderr))
            self.assertIn("Corrupt", res.stderr)
            self.assertEqual(res.stdout, "")

    def test_flip_posting_byte_exit4(self):
        # inside the first posting block payload (offset 24 + 5-byte blk hdr)
        bad = self._flipped_copy(self.idx, 24 + 5, "bad_post.bin")
        for cmd in (["lookup", bad, "alpha"], ["scan", bad]):
            res = run_cli(*cmd)
            self.assertEqual(res.returncode, 4, (cmd, res.stderr))
            self.assertIn("Corrupt", res.stderr)
            self.assertEqual(res.stdout, "")

    def test_truncated_file_exit4(self):
        dst = self.path("trunc.bin")
        with open(self.idx, "rb") as fh:
            data = fh.read()
        with open(dst, "wb") as fh:
            fh.write(data[:self.size - 10])
        res = run_cli("scan", dst)
        self.assertEqual(res.returncode, 4)
        self.assertIn("Corrupt", res.stderr)


class TestDuplicatesAndEmpty(PcompTestBase):
    """D: duplicate docids, unsorted input, empty term table."""

    def test_duplicate_docids_deduped_and_sorted(self):
        idx = self.build({"t": [5, 1, 5, 3, 3, 1, 2 ** 32 - 1, 0]})
        self.assertEqual(pcomp.lookup(idx, "t"), [0, 1, 3, 5, 2 ** 32 - 1])

    def test_empty_index_build_lookup_scan(self):
        idx = self.build({})
        self.assertEqual(pcomp.lookup(idx, "anything"), [])
        self.assertEqual(pcomp.scan(idx), (0, 0))
        res = run_cli("lookup", idx, "anything")
        self.assertEqual(res.returncode, 0)
        self.assertEqual(res.stdout, "")
        res = run_cli("scan", idx)
        self.assertEqual(res.returncode, 0)
        self.assertIn("0 terms, 0 docids", res.stdout)

    def test_term_with_no_docids_is_dropped(self):
        idx = self.build({"empty": [], "full": [1, 2, 3]})
        self.assertEqual(pcomp.lookup(idx, "empty"), [])
        self.assertEqual(pcomp.lookup(idx, "full"), [1, 2, 3])
        self.assertEqual(pcomp.scan(idx), (1, 3))


class TestCliEndToEnd(PcompTestBase):
    """CLI: build from text input, lookup, scan; missing term exits 0."""

    def test_build_lookup_scan_roundtrip(self):
        src = self.path("input.txt")
        with open(src, "w") as fh:
            fh.write("apple 3 1 2 2\n")
            fh.write("banana 4294967295 0\n")
            fh.write("apple 7\n")  # same term across lines merges
        idx = self.path("cli.bin")
        res = run_cli("build", src, idx)
        self.assertEqual(res.returncode, 0, res.stderr)

        res = run_cli("lookup", idx, "apple")
        self.assertEqual(res.returncode, 0)
        self.assertEqual(res.stdout.strip(), "1 2 3 7")

        res = run_cli("lookup", idx, "banana")
        self.assertEqual(res.returncode, 0)
        self.assertEqual(res.stdout.strip(), "0 4294967295")

        res = run_cli("lookup", idx, "cherry")
        self.assertEqual(res.returncode, 0)
        self.assertEqual(res.stdout, "")

        res = run_cli("scan", idx)
        self.assertEqual(res.returncode, 0)
        self.assertIn("2 terms, 6 docids", res.stdout)


if __name__ == "__main__":
    unittest.main()
