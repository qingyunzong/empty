"""Acceptance tests for bitsetix.

A: random sets cross-checked against Python set for and/or/andnot
B: edge cases: empty, full, single element, 65536-block boundary
C: tampered length/CRC -> CLI exit 4
D: save/load round-trip preserves expression results
"""
import hashlib
import os
import random
import subprocess
import sys
import tempfile
import unittest

import bitsetix
from bitsetix import Bitsetix, CorruptFileError, DocidRangeError, ExprError

HERE = os.path.dirname(os.path.abspath(__file__))
CLI = [sys.executable, os.path.join(HERE, "bitsetix.py")]


def run_cli(script: str):
    return subprocess.run(
        CLI, input=script, capture_output=True, text=True, cwd=HERE
    )


class TestARandomVsPythonSet(unittest.TestCase):
    """A: random sets vs Python set semantics for all three operators."""

    def setUp(self):
        rng = random.Random(20261001)
        self.n = 200_000  # crosses several 65536 blocks
        self.bx = Bitsetix()
        self.bx.set_maxdoc(self.n)
        self.expected = {}
        sizes = [0, 1, 3, 50, 1_000, 20_000, 150_000]
        for i, size in enumerate(sizes):
            term = f"t{i}"
            docs = set(rng.sample(range(self.n), size))
            self.bx.add(term, docs)
            self.expected[term] = docs

    def check(self, expr, expected):
        got = self.bx.evaluate(expr)
        self.assertEqual(got, expected, expr)
        self.assertEqual(list(sorted(got)), sorted(expected), expr)

    def test_pairwise_ops(self):
        names = sorted(self.expected)
        for a in names:
            for b in names:
                ea, eb = self.expected[a], self.expected[b]
                self.check(f"{a} and {b}", ea & eb)
                self.check(f"{a} or {b}", ea | eb)
                self.check(f"{a} andnot {b}", ea - eb)

    def test_random_nested_expressions(self):
        rng = random.Random(7)
        names = sorted(self.expected) + ["ghost"]  # unknown term = empty set
        ops = ["and", "or", "andnot"]
        for _ in range(200):
            def build(depth):
                if depth == 0 or rng.random() < 0.4:
                    t = rng.choice(names)
                    return t, self.expected.get(t, set())
                op = rng.choice(ops)
                la, ea = build(depth - 1)
                lb, eb = build(depth - 1)
                la, ea = f"({la})", ea
                lb, eb = f"({lb})", eb
                if op == "and":
                    return f"{la} and {lb}", ea & eb
                if op == "or":
                    return f"{la} or {lb}", ea | eb
                return f"{la} andnot {lb}", ea - eb

            expr, expected = build(3)
            self.check(expr, expected)

    def test_unknown_term_semantics(self):
        a = self.expected["t3"]
        self.check("t3 and ghost", set())
        self.check("t3 or ghost", a)
        self.check("t3 andnot ghost", a)  # unknown on right = empty
        self.check("ghost andnot t3", set())
        self.check("ghost or ghost", set())

    def test_repeated_query_no_side_effect(self):
        first = self.bx.evaluate("t5 andnot (t2 or t6)")
        for _ in range(5):
            self.assertEqual(self.bx.evaluate("t5 andnot (t2 or t6)"), first)
        self.assertEqual(self.bx.get("t5"), self.expected["t5"])


class TestBEdgeCases(unittest.TestCase):
    """B: empty, full, singleton, 65536-block boundary."""

    def test_empty_and_full(self):
        bx = Bitsetix()
        bx.set_maxdoc(1000)
        bx.add("empty", [])
        bx.add("full", range(1000))
        self.assertEqual(bx.evaluate("empty or empty"), set())
        self.assertEqual(bx.evaluate("full and full"), set(range(1000)))
        self.assertEqual(bx.evaluate("full andnot full"), set())
        self.assertEqual(bx.evaluate("full andnot empty"), set(range(1000)))
        self.assertEqual(bx.evaluate("empty andnot full"), set())
        self.assertEqual(bx.evaluate("empty and full"), set())

    def test_single_element(self):
        bx = Bitsetix()
        bx.set_maxdoc(10)
        bx.add("one", [5])
        bx.add("two", [5])
        bx.add("three", [6])
        self.assertEqual(bx.evaluate("one and two"), {5})
        self.assertEqual(bx.evaluate("one andnot two"), set())
        self.assertEqual(bx.evaluate("one or three"), {5, 6})
        self.assertEqual(bx.evaluate("one and three"), set())

    def test_block_boundary(self):
        n = 3 * 65536 + 7
        bx = Bitsetix()
        bx.set_maxdoc(n)
        boundary = [0, 1, 65535, 65536, 65537, 131071, 131072, n - 1]
        bx.add("edge", boundary)
        bx.add("full", range(n))
        self.assertEqual(bx.evaluate("edge"), set(boundary))
        self.assertEqual(bx.evaluate("edge and full"), set(boundary))
        self.assertEqual(bx.evaluate("full andnot edge"), set(range(n)) - set(boundary))
        self.assertEqual(bx.evaluate("edge andnot full"), set())

    def test_out_of_range_add_exit2(self):
        proc = run_cli("maxdoc 10\nadd t 0 9 10\n")
        self.assertEqual(proc.returncode, 2, proc.stderr)
        proc = run_cli("maxdoc 10\nadd t -1\n")
        self.assertEqual(proc.returncode, 2, proc.stderr)

    def test_paren_error_exit3(self):
        for bad in ["query (a and b\n", "query a and b)\n", "query (a\n",
                    "query a and\n", "query and a\n", "query ()\n"]:
            proc = run_cli("maxdoc 10\nadd a 1\nadd b 2\n" + bad)
            self.assertEqual(proc.returncode, 3, (bad, proc.stderr))


class TestCTamperDetection(unittest.TestCase):
    """C: tampering with length fields or CRC -> exit 4, file untouched."""

    def _make_file(self, path):
        bx = Bitsetix()
        bx.set_maxdoc(100_000)
        bx.add("sparse", [1, 2, 3, 65536])
        bx.add("dense", range(0, 100_000, 2))
        bx.save(path)
        with open(path, "rb") as fh:
            return bytearray(fh.read())

    def _assert_exit4(self, data: bytearray, tmpdir, name):
        path = os.path.join(tmpdir, name)
        with open(path, "wb") as fh:
            fh.write(bytes(data))
        before = open(path, "rb").read()
        proc = run_cli(f"load {path}\n")
        self.assertEqual(proc.returncode, 4, (name, proc.stderr))
        self.assertEqual(open(path, "rb").read(), before, "file must not be modified")

    def test_tamper_cases(self):
        with tempfile.TemporaryDirectory() as tmp:
            good = self._make_file(os.path.join(tmp, "good.bsx"))

            # flip one byte inside the first term's CRC field (last 4 bytes
            # of the file belong to the last term's CRC; flip anywhere in
            # either term's CRC-covered payload too)
            for name, offset in [
                ("crc_last.bsx", len(good) - 1),          # last CRC byte
                ("payload_mid.bsx", len(good) // 2),      # payload byte
                ("header_len.bsx", 16),                   # term name length
            ]:
                data = bytearray(good)
                data[offset] ^= 0xFF
                self._assert_exit4(data, tmp, name)

            # truncated file (broken length)
            self._assert_exit4(bytearray(good[:-3]), tmp, "truncated.bsx")

            # bad version
            data = bytearray(good)
            data[4] = 0xEE
            self._assert_exit4(data, tmp, "version.bsx")

            # bad magic
            data = bytearray(good)
            data[0] = 0x00
            self._assert_exit4(data, tmp, "magic.bsx")

    def test_library_raises_corrupt(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "x.bsx")
            good = self._make_file(path)
            good[-2] ^= 0x01
            with open(path, "wb") as fh:
                fh.write(bytes(good))
            with self.assertRaises(CorruptFileError):
                Bitsetix().load(path)


class TestDSaveLoadRoundTrip(unittest.TestCase):
    """D: expression results identical before save and after load."""

    def test_roundtrip_mixed_encodings(self):
        rng = random.Random(99)
        n = 150_000
        bx = Bitsetix()
        bx.set_maxdoc(n)
        bx.add("sparse", rng.sample(range(n), 10))          # -> list encoding
        bx.add("dense", rng.sample(range(n), 120_000))      # -> bitmap encoding
        bx.add("empty", [])
        bx.add("boundary", [0, 65535, 65536, n - 1])
        exprs = [
            "sparse or dense",
            "dense andnot sparse",
            "(sparse and boundary) or (dense andnot boundary)",
            "empty or sparse",
            "dense andnot (sparse or boundary)",
        ]
        before = {e: bx.evaluate(e) for e in exprs}
        # confirm both encodings actually occur
        encs = {bx._encode_term(bx.get(t))[0] for t in ("sparse", "dense")}
        self.assertEqual(encs, {bitsetix.ENC_LIST, bitsetix.ENC_BITMAP})
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "rt.bsx")
            bx.save(path)
            bx2 = Bitsetix()
            bx2.load(path)
            self.assertEqual(bx2.maxdoc, n)
            for t in bx.terms:
                self.assertEqual(bx2.get(t), bx.get(t), t)
            for e in exprs:
                self.assertEqual(bx2.evaluate(e), before[e], e)
            # via CLI as well
            script = f"maxdoc {n}\nload {path}\n" + "".join(
                f"query {e}\n" for e in exprs
            )
            proc = run_cli(script)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            lines = proc.stdout.splitlines()
            for line, e in zip(lines, exprs):
                got = set(map(int, line.split())) if line.strip() else set()
                self.assertEqual(got, before[e], e)
                self.assertEqual(
                    line.split(), [str(d) for d in sorted(before[e])],
                    "output must be ascending",
                )

    def test_save_load_via_cli(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "cli.bsx")
            setup = f"maxdoc 70000\nadd a 1 2 3 65536\nadd b 3 4 65536\nsave {path}\n"
            p1 = run_cli(setup + "query a or b\nquery a andnot b\n")
            self.assertEqual(p1.returncode, 0, p1.stderr)
            p2 = run_cli(f"load {path}\nquery a or b\nquery a andnot b\n")
            self.assertEqual(p2.returncode, 0, p2.stderr)
            self.assertEqual(p1.stdout, p2.stdout)
            self.assertEqual(p2.stdout.splitlines(), ["1 2 3 4 65536", "1 2"])


class TestResultHash(unittest.TestCase):
    """Deterministic set hash used for RESULTS.md (sanity anchor)."""

    def test_hash_stable(self):
        bx = Bitsetix()
        bx.set_maxdoc(8)
        bx.add("a", [1, 2, 3])
        digest = hashlib.sha256(
            " ".join(map(str, sorted(bx.evaluate("a")))).encode()
        ).hexdigest()
        self.assertEqual(
            digest,
            hashlib.sha256(b"1 2 3").hexdigest(),
        )


if __name__ == "__main__":
    unittest.main()
