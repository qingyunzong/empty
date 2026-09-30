"""Exhaustive enumeration: short byte strings x fragmentations x delivery
permutations, cross-checked against the independent per-byte model."""
from __future__ import annotations

import itertools
import tempfile
import unittest

from ftgateway import Fragment, Gateway, Reassembler, sha256_hex
from tests.model import ByteModel

ALPHABET = b"ab"


def all_strings(max_len: int):
    for n in range(max_len + 1):
        for tup in itertools.product(ALPHABET, repeat=n):
            yield bytes(tup)


def compositions(n: int):
    """All ways to split a length-n buffer into contiguous non-empty parts."""
    if n == 0:
        yield []
        return
    for cuts in itertools.product([0, 1], repeat=n - 1):
        parts, start = [], 0
        for i, cut in enumerate(cuts):
            if cut:
                parts.append((start, i + 1))
                start = i + 1
        parts.append((start, n))
        yield parts


def overlapped(parts, data):
    """Add one duplicate/overlapping fragment derived from existing parts."""
    frags = [(s, data[s:e]) for s, e in parts]
    if not frags:
        frags.append((0, b""))                 # zero-length transfer marker
    if len(data) >= 2:
        frags.append((0, data[:2]))            # exact re-send of the head
        frags.append((len(data) - 1, data[-1:]))  # 1-byte tail overlap
    return frags


class EnumerationTest(unittest.TestCase):
    def run_case(self, data: bytes, frags, perm) -> None:
        th = sha256_hex(data)
        r = Reassembler("t", 0)
        model = ByteModel()
        model.total_length = len(data)
        for idx in perm:
            off, chunk = frags[idx]
            fid = f"f{idx}"
            status = r.add(Fragment("t", 0, fid, off, chunk,
                                    total_length=len(data), total_hash=th))
            self.assertIsNone(model.add(fid, off, chunk))
            self.assertEqual(r.gaps(), model.gaps(),
                             f"gap mismatch data={data!r} perm={perm}")
        self.assertTrue(r.is_complete())
        self.assertTrue(model.complete())
        self.assertEqual(r.assemble(), data)
        self.assertEqual(model.assemble(), data)
        self.assertTrue(r.verify())

    def test_all_short_strings_all_splits_all_permutations(self):
        cases = 0
        for data in all_strings(4):
            for parts in compositions(len(data)):
                frags = overlapped(parts, data)
                perms = (itertools.permutations(range(len(frags)))
                         if len(frags) <= 5
                         else itertools.islice(
                             itertools.permutations(range(len(frags))), 120))
                for perm in perms:
                    self.run_case(data, frags, perm)
                    cases += 1
        self.assertGreater(cases, 500)

    def test_tail_first_and_duplicates(self):
        data = b"abba"
        th = sha256_hex(data)
        r = Reassembler("t", 0)
        # tail fragment arrives first, then a duplicate of it, then the head
        self.assertEqual(r.add(Fragment("t", 0, "tail", 2, data[2:],
                                        total_length=4, total_hash=th)),
                         "stored")
        self.assertEqual(r.add(Fragment("t", 0, "tail", 2, data[2:],
                                        total_length=4, total_hash=th)),
                         "duplicate")
        self.assertEqual(r.add(Fragment("t", 0, "head", 0, data[:2],
                                        total_length=4, total_hash=th)),
                         "complete")
        self.assertEqual(r.assemble(), data)

    def test_zero_length_file(self):
        data = b""
        th = sha256_hex(data)
        with tempfile.TemporaryDirectory() as d:
            gw = Gateway(f"{d}/w", f"{d}/p")
            res = gw.add_fragment(Fragment("z", 0, "only", 0, b"",
                                           total_length=0, total_hash=th))
            self.assertTrue(res["committed"])
            with open(f"{d}/p/z", "rb") as fh:
                self.assertEqual(fh.read(), b"")


if __name__ == "__main__":
    unittest.main()
