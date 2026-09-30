#!/usr/bin/env python3
"""Acceptance tests for bitsetix.

A: random sets cross-checked against Python set for and/or/andnot
B: edge cases: empty, full, single element, 65536-block boundaries
C: tampered length/CRC -> exit 4, original file untouched
D: expression results identical before/after save/load
"""

import hashlib
import os
import random
import subprocess
import sys
import tempfile
import unittest

import bitsetix
from bitsetix import BitsetIndex, CorruptFileError, ExpressionError

HERE = os.path.dirname(os.path.abspath(__file__))
CLI = [sys.executable, os.path.join(HERE, "bitsetix.py")]


def run_cli(script, cwd=None):
    return subprocess.run(CLI, input=script, capture_output=True, text=True, cwd=cwd)


class TestARandomVsPythonSet(unittest.TestCase):
    """A: random sets vs Python set semantics for all three operators."""

    N = 200_000  # spans multiple 65536-blocks

    @classmethod
    def setUpClass(cls):
        rng = random.Random(20260930)
        cls.terms = {}
        sizes = [0, 1, 2, 7, 100, 5_000, 150_000, cls.N]
        for i, size in enumerate(sizes):
            cls.terms["t%02d" % i] = set(rng.sample(range(cls.N), min(size, cls.N)))
        # dense clustered sets to stress bitmap encoding
        for i in range(3):
            base = rng.randrange(0, cls.N - 20_000)
            cls.terms["c%d" % i] = {base + j for j in range(20_000) if rng.random() < 0.7}
        cls.idx = BitsetIndex()
        cls.idx.set_maxdoc(cls.N)
        for name, docs in cls.terms.items():
            cls.idx.add(name, docs)

    def check(self, expr, expected):
        got = self.idx.query(expr)
        self.assertEqual(got, sorted(expected), expr)
        # repeated queries are side-effect free
        self.assertEqual(self.idx.query(expr), got, expr + " (repeat)")

    def test_and(self):
        t = self.terms
        self.check("and(t03, t04)", t["t03"] & t["t04"])
        self.check("and(t05, t06, c0)", t["t05"] & t["t06"] & t["c0"])
        self.check("and(t00, t07)", set())  # empty & full -> empty
        self.check("and(t01, nosuchterm)", set())  # unknown term == empty set

    def test_or(self):
        t = self.terms
        self.check("or(t01, t02)", t["t01"] | t["t02"])
        self.check("or(c0, c1, c2, t03)", t["c0"] | t["c1"] | t["c2"] | t["t03"])
        self.check("or(nosuchterm, t01)", t["t01"])  # unknown term == empty set
        self.check("or(t07, t00)", t["t07"])

    def test_andnot(self):
        t = self.terms
        self.check("andnot(t06, t05)", t["t06"] - t["t05"])
        self.check("andnot(t07, t07)", set())  # a - a == empty, legal
        self.check("andnot(t04, nosuchterm)", t["t04"])  # unknown rhs == empty
        self.check("andnot(nosuchterm, t04)", set())

    def test_nested(self):
        t = self.terms
        expr = "andnot(or(c0, t03), and(t06, or(c1, t02)))"
        expected = (t["c0"] | t["t03"]) - (t["t06"] & (t["c1"] | t["t02"]))
        self.check(expr, expected)


class TestBEdgeCases(unittest.TestCase):
    """B: empty / full / single-element / block-boundary sets."""

    N = 3 * 65536 + 5  # docids cross two block boundaries

    def setUp(self):
        self.idx = BitsetIndex()
        self.idx.set_maxdoc(self.N)
        self.idx.add("empty", [])
        self.idx.add("full", range(self.N))
        self.idx.add("single", [65536])  # first docid of block 1
        self.idx.add("boundary", [0, 65535, 65536, 131071, 131072, self.N - 1])

    def test_empty(self):
        self.assertEqual(self.idx.query("empty"), [])
        self.assertEqual(self.idx.query("and(empty, full)"), [])
        self.assertEqual(self.idx.query("andnot(empty, full)"), [])

    def test_full(self):
        self.assertEqual(self.idx.query("full"), list(range(self.N)))
        self.assertEqual(self.idx.query("andnot(full, full)"), [])
        self.assertEqual(self.idx.query("or(full, empty)"), list(range(self.N)))

    def test_single(self):
        self.assertEqual(self.idx.query("single"), [65536])
        self.assertEqual(self.idx.query("and(single, full)"), [65536])
        self.assertEqual(self.idx.query("andnot(single, full)"), [])

    def test_block_boundary(self):
        expect = [0, 65535, 65536, 131071, 131072, self.N - 1]
        self.assertEqual(self.idx.query("boundary"), expect)
        self.assertEqual(self.idx.query("and(boundary, single)"), [65536])
        self.assertEqual(self.idx.query("andnot(boundary, single)"),
                         [0, 65535, 131071, 131072, self.N - 1])
        # round-trip through both encodings keeps boundary docids exact
        data = self.idx.to_bytes()
        idx2 = BitsetIndex.from_bytes(data)
        self.assertEqual(idx2.query("boundary"), expect)
        self.assertEqual(idx2.query("full"), list(range(self.N)))

    def test_encodings_indistinguishable(self):
        # 'full' must be bitmap-encoded, 'single' list-encoded; same results.
        data = self.idx.to_bytes()
        self.assertIn(bytes([bitsetix.ENC_BITMAP]), data)
        self.assertIn(bytes([bitsetix.ENC_LIST]), data)
        idx2 = BitsetIndex.from_bytes(data)
        for expr in ("or(full, single)", "andnot(full, boundary)",
                     "and(full, boundary)"):
            self.assertEqual(idx2.query(expr), self.idx.query(expr), expr)


class TestCTamper(unittest.TestCase):
    """C: tampered length / CRC -> exit 4, original file not modified."""

    def setUp(self):
        idx = BitsetIndex()
        idx.set_maxdoc(100_000)
        idx.add("alpha", [1, 2, 3, 65536, 99_999])
        idx.add("beta", range(0, 100_000, 3))
        self.data = idx.to_bytes()
        self.tmpdir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmpdir.name, "idx.bsx")
        with open(self.path, "wb") as fh:
            fh.write(self.data)

    def tearDown(self):
        self.tmpdir.cleanup()

    def sha(self):
        with open(self.path, "rb") as fh:
            return hashlib.sha256(fh.read()).hexdigest()

    def assert_exit4_and_untouched(self, blob):
        before = self.sha()
        with open(self.path, "wb") as fh:
            fh.write(blob)
        proc = run_cli("load %s\n" % self.path)
        self.assertEqual(proc.returncode, 4, proc.stderr)
        self.assertIn("corrupt", proc.stderr)
        # restore, then confirm load itself never modifies the file
        with open(self.path, "wb") as fh:
            fh.write(self.data)
        before = self.sha()
        proc = run_cli("load %s\n" % self.path)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(self.sha(), before)

    def test_tamper_crc(self):
        blob = bytearray(self.data)
        blob[-1] ^= 0xFF  # last byte of final CRC
        self.assert_exit4_and_untouched(bytes(blob))

    def test_tamper_payload(self):
        blob = bytearray(self.data)
        mid = len(blob) // 2
        blob[mid] ^= 0x01  # corrupt payload without fixing CRC
        self.assert_exit4_and_untouched(bytes(blob))

    def test_tamper_length(self):
        blob = bytearray(self.data)
        # term-count field in the header (offset 4+4+8)
        blob[16] ^= 0x01
        self.assert_exit4_and_untouched(bytes(blob))
        # truncated file (broken length framing)
        self.assert_exit4_and_untouched(self.data[:-10])
        # trailing garbage
        self.assert_exit4_and_untouched(self.data + b"junk")

    def test_tamper_magic_and_version(self):
        blob = bytearray(self.data)
        blob[0] ^= 0xFF
        self.assert_exit4_and_untouched(bytes(blob))
        blob = bytearray(self.data)
        blob[4] = 0xEE  # version
        self.assert_exit4_and_untouched(bytes(blob))

    def test_library_raises(self):
        blob = bytearray(self.data)
        blob[-1] ^= 0xFF
        with self.assertRaises(CorruptFileError):
            BitsetIndex.from_bytes(bytes(blob))


class TestDSaveLoadConsistency(unittest.TestCase):
    """D: expression results identical before and after save/load."""

    def test_roundtrip(self):
        rng = random.Random(7)
        n = 150_000
        idx = BitsetIndex()
        idx.set_maxdoc(n)
        idx.add("sparse", rng.sample(range(n), 50))
        idx.add("dense", rng.sample(range(n), 120_000))
        idx.add("empty", [])
        exprs = [
            "and(sparse, dense)",
            "or(sparse, dense)",
            "andnot(dense, sparse)",
            "andnot(sparse, dense)",
            "andnot(or(sparse, dense), and(sparse, dense))",
            "or(sparse, ghost)",
            "andnot(sparse, ghost)",
        ]
        before = {e: idx.query(e) for e in exprs}
        with tempfile.TemporaryDirectory() as td:
            path = os.path.join(td, "idx.bsx")
            idx.save(path)
            # CLI-level: save, load, re-query in one session
            script = "maxdoc %d\n" % n
            for name in ("sparse", "dense"):
                script += "add %s %s\n" % (name, " ".join(map(str, sorted(idx.get(name)))))
            script += "save %s\n" % path
            for e in exprs:
                script += "query %s\n" % e
            script += "load %s\n" % path
            for e in exprs:
                script += "query %s\n" % e
            proc = run_cli(script)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            lines = proc.stdout.splitlines()
            pre, post = lines[:len(exprs)], lines[len(exprs):]
            self.assertEqual(pre, post, "results differ after load")
            for e, line in zip(exprs, pre):
                got = [int(x) for x in line.split()] if line.strip() else []
                self.assertEqual(got, before[e], e)
            # library-level round trip
            idx2 = BitsetIndex.load(path)
            for e in exprs:
                self.assertEqual(idx2.query(e), before[e], e)


class TestExitCodes(unittest.TestCase):
    """CLI exit codes 2 and 3."""

    def test_out_of_range_add_exit2(self):
        proc = run_cli("maxdoc 10\nadd t 0 5 10\n")
        self.assertEqual(proc.returncode, 2)
        proc = run_cli("maxdoc 10\nadd t -1\n")
        self.assertEqual(proc.returncode, 2)
        # boundary: 9 is fine
        proc = run_cli("maxdoc 10\nadd t 9\nquery t\n")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.strip(), "9")

    def test_bad_parentheses_exit3(self):
        for bad in ("query and(a, b\n",
                    "query and(a, b))\n",
                    "query or(a,,b)\n",
                    "query andnot(a)\n",
                    "query andnot(a, b, c)\n",
                    "query (a)\n",
                    "query and()\n",
                    "query a b\n"):
            proc = run_cli("maxdoc 10\n" + bad)
            self.assertEqual(proc.returncode, 3, bad)
        # well-formed nested expression is fine
        proc = run_cli("maxdoc 10\nadd a 1 2\nadd b 2 3\nquery and(a, or(b, a))\n")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.strip(), "1 2")


if __name__ == "__main__":
    unittest.main(verbosity=2)
