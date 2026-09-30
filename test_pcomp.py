#!/usr/bin/env python3
"""Acceptance tests for pcomp (unittest, stdlib only)."""

import os
import random
import struct
import subprocess
import sys
import tempfile
import unittest
import zlib

import pcomp

HERE = os.path.dirname(os.path.abspath(__file__))
PCOMP_PY = os.path.join(HERE, "pcomp.py")


def run_cli(*args):
    return subprocess.run(
        [sys.executable, PCOMP_PY, *args],
        capture_output=True, text=True,
    )


class PcompTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def path(self, name):
        return os.path.join(self.tmp.name, name)

    def build_index(self, terms, name="idx.pcf"):
        path = self.path(name)
        with open(path, "wb") as fh:
            fh.write(pcomp.build_bytes(terms))
        return path


class TestRandomRoundTrip(PcompTestBase):
    """A: random term sets compared fully against an in-memory dict."""

    def test_random_roundtrip(self):
        rng = random.Random(20261001)
        for trial in range(30):
            terms = {}
            for _ in range(rng.randint(0, 40)):
                term = "t%d" % rng.randint(0, 10**6)
                n = rng.choice([0, 1, 2, 5, 127, 128, 129, 300, 1000])
                docids = [rng.randint(0, 2**32 - 1) for _ in range(n)]
                terms.setdefault(term, []).extend(docids)
            path = self.build_index(terms, "rand%d.pcf" % trial)
            expected = {t: sorted(set(d)) for t, d in terms.items()}
            for term, want in expected.items():
                got = pcomp.lookup(path, term)
                self.assertEqual(got, want, "term %r mismatch" % term)
            self.assertEqual(pcomp.lookup(path, "no-such-term"), [])
            num_terms, total = pcomp.scan(path)
            self.assertEqual(num_terms, len(expected))
            self.assertEqual(total, sum(len(v) for v in expected.values()))


class TestBoundaries(PcompTestBase):
    """B: boundary docids and block sizes."""

    def test_boundary_docids(self):
        terms = {
            "zero": [0],
            "max": [2**32 - 1],
            "both": [0, 2**32 - 1],
            "edges": [0, 1, 2**32 - 2, 2**32 - 1],
        }
        path = self.build_index(terms)
        for term, want in terms.items():
            self.assertEqual(pcomp.lookup(path, term), sorted(want))

    def test_block_sizes(self):
        terms = {
            "single": [42],
            "exact128": list(range(128)),
            "exact129": list(range(129)),
            "exact256": list(range(256)),
            "exact257": list(range(257)),
        }
        path = self.build_index(terms)
        for term, want in terms.items():
            self.assertEqual(pcomp.lookup(path, term), want)

    def test_empty_index(self):
        path = self.build_index({})
        self.assertEqual(pcomp.lookup(path, "anything"), [])
        self.assertEqual(pcomp.scan(path), (0, 0))

    def test_term_with_empty_postings(self):
        path = self.build_index({"empty": [], "full": [1, 2, 3]})
        self.assertEqual(pcomp.lookup(path, "empty"), [])
        self.assertEqual(pcomp.lookup(path, "full"), [1, 2, 3])


class TestCorruption(PcompTestBase):
    """C: flip one byte in header / dictionary / postings -> exit 4."""

    def _flip(self, data, pos):
        mutated = bytearray(data)
        mutated[pos] ^= 0xFF
        return bytes(mutated)

    def _write_and_assert_exit4(self, blob, name):
        path = self.path(name)
        with open(path, "wb") as fh:
            fh.write(blob)
        for cmd in (["lookup", path, "alpha"], ["scan", path]):
            proc = run_cli(*cmd)
            self.assertEqual(proc.returncode, 4,
                             "cmd %r rc=%d stderr=%r" % (cmd, proc.returncode, proc.stderr))
            self.assertIn("Corrupt", proc.stderr)
            self.assertEqual(proc.stdout, "", "must not partially return")

    def _base_blob(self):
        return pcomp.build_bytes({
            "alpha": list(range(200)),
            "beta": [0, 5, 2**32 - 1],
            "gamma": [7],
        })

    def test_flip_header_magic(self):
        self._write_and_assert_exit4(self._flip(self._base_blob(), 0), "bad_magic.pcf")

    def test_flip_header_version(self):
        self._write_and_assert_exit4(self._flip(self._base_blob(), 4), "bad_ver.pcf")

    def test_flip_header_dict_offset(self):
        self._write_and_assert_exit4(self._flip(self._base_blob(), 10), "bad_off.pcf")

    def test_flip_header_crc(self):
        self._write_and_assert_exit4(self._flip(self._base_blob(), 17), "bad_crc.pcf")

    def test_flip_postings_byte(self):
        blob = self._base_blob()
        self._write_and_assert_exit4(self._flip(blob, 25), "bad_post.pcf")

    def test_flip_dictionary_byte(self):
        blob = self._base_blob()
        dict_offset = struct.unpack_from("<Q", blob, 8)[0]
        self._write_and_assert_exit4(
            self._flip(blob, dict_offset + 10), "bad_dict.pcf")

    def test_truncated_file(self):
        blob = self._base_blob()
        self._write_and_assert_exit4(blob[:len(blob) // 2], "trunc.pcf")

    def test_length_out_of_bounds(self):
        # Craft an index whose dict entry length runs past the postings region.
        blob = bytearray(pcomp.build_bytes({"a": [1, 2, 3]}))
        dict_offset = struct.unpack_from("<Q", blob, 8)[0]
        # entry layout: num_terms(4) term_len(2) term(1) offset(8) length(8) num(4)
        length_pos = dict_offset + 4 + 2 + 1 + 8
        struct.pack_into("<Q", blob, length_pos, 10**9)
        crc = zlib.crc32(bytes(blob[20:])) & 0xFFFFFFFF
        struct.pack_into("<I", blob, 16, crc)
        self._write_and_assert_exit4(bytes(blob), "bad_len.pcf")


class TestDuplicatesAndEmpty(PcompTestBase):
    """D: duplicate docids and empty term table."""

    def test_duplicate_docids_deduped(self):
        terms = {"dup": [5, 5, 5, 1, 1, 9, 9, 3]}
        path = self.build_index(terms)
        self.assertEqual(pcomp.lookup(path, "dup"), [1, 3, 5, 9])

    def test_unsorted_input_sorted(self):
        terms = {"unsorted": [100, 3, 55, 0, 2**32 - 1, 7]}
        path = self.build_index(terms)
        self.assertEqual(pcomp.lookup(path, "unsorted"),
                         [0, 3, 7, 55, 100, 2**32 - 1])

    def test_empty_term_table_cli(self):
        src = self.path("empty.txt")
        with open(src, "w") as fh:
            fh.write("")
        idx = self.path("empty.pcf")
        proc = run_cli("build", src, idx)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        proc = run_cli("lookup", idx, "ghost")
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout, "")
        proc = run_cli("scan", idx)
        self.assertEqual(proc.returncode, 0)
        self.assertIn("terms=0", proc.stdout)


class TestCliEndToEnd(PcompTestBase):
    def test_build_lookup_scan_cli(self):
        src = self.path("in.txt")
        with open(src, "w") as fh:
            fh.write("apple 3 1 2 2\nbanana 9\napple 4\ncherry\n")
        idx = self.path("cli.pcf")
        proc = run_cli("build", src, idx)
        self.assertEqual(proc.returncode, 0, proc.stderr)

        proc = run_cli("lookup", idx, "apple")
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout.split(), ["1", "2", "3", "4"])

        proc = run_cli("lookup", idx, "banana")
        self.assertEqual(proc.stdout.split(), ["9"])

        proc = run_cli("lookup", idx, "cherry")
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout, "")

        proc = run_cli("lookup", idx, "missing")
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout, "")

        proc = run_cli("scan", idx)
        self.assertEqual(proc.returncode, 0)
        self.assertIn("terms=3", proc.stdout)
        self.assertIn("docs=5", proc.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
