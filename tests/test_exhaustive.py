"""Exhaustive enumeration: for short byte strings, enumerate fragment
splits and delivery permutations, and cross-check the reassembler
against an independent per-byte source model.
"""

import itertools
import tempfile
import unittest

from reassembler import Fragment, Gateway, GatewayConfig, SubmitStatus
from reassembler.fragments import sha256_hex


def sources():
    out = [b""]
    for n in (1, 2, 3):
        for bits in itertools.product(b"ab", repeat=n):
            out.append(bytes(bits))
    return out


def compositions(n, k):
    if k == 1:
        yield (n,)
        return
    for first in range(1, n - k + 2):
        for rest in compositions(n - first, k - 1):
            yield (first,) + rest


def contiguous_splits(source):
    n = len(source)
    for k in range(1, min(3, n) + 1):
        for comp in compositions(n, k):
            frags, off = [], 0
            for size in comp:
                frags.append((off, source[off:off + size]))
                off += size
            yield frags


def interval_coverings(source):
    """Overlapping interval subsets (size 2..3) fully covering the source."""
    n = len(source)
    if n == 0:
        return
    intervals = [(i, j) for i in range(n) for j in range(i + 1, n + 1)]
    for size in (2, 3):
        for combo in itertools.combinations(intervals, size):
            covered = [False] * n
            for a, b in combo:
                for p in range(a, b):
                    covered[p] = True
            if all(covered):
                yield [(a, source[a:b]) for a, b in combo]


def fragmentations(source):
    """Each fragmentation is a list of (frag_id, offset, data)."""
    seen = set()
    out = []

    def emit(items):
        key = tuple((o, d) for _, o, d in items)
        if key not in seen:
            seen.add(key)
            out.append(items)

    n = len(source)
    if n == 0:
        return [[("f0", 0, b"")]]
    for split in contiguous_splits(source):
        base = [(f"f{i}", o, d) for i, (o, d) in enumerate(split)]
        emit(base)
        if len(split) <= 2:
            # duplicated delivery of the first fragment (same frag id)
            emit(base + [base[0]])
            # identical content redelivered under a new frag id
            o, d = split[-1]
            emit(base + [(f"f{len(base)}", o, d)])
    for covering in interval_coverings(source):
        emit([(f"f{i}", o, d) for i, (o, d) in enumerate(covering)])
    return out


class ByteModel:
    """Independent per-byte source model."""

    def __init__(self):
        self.bytes = {}

    def apply(self, offset, data):
        """Returns True if the fragment is consistent with the model."""
        for i, b in enumerate(data):
            pos = offset + i
            if pos in self.bytes and self.bytes[pos] != b:
                return False
        for i, b in enumerate(data):
            self.bytes[offset + i] = b
        return True

    def assembled(self, n):
        return bytes(self.bytes[i] for i in range(n))


class TestExhaustiveReassembly(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        cls.gw = Gateway(GatewayConfig(workdir=cls._tmp.name))
        cls.counter = 0

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def next_tid(self):
        TestExhaustiveReassembly.counter += 1
        return f"x{TestExhaustiveReassembly.counter}"

    def run_case(self, source, spec, perm):
        tid = self.next_tid()
        n = len(source)
        thash = sha256_hex(source)
        model = ByteModel()
        for step, idx in enumerate(perm):
            fid, off, data = spec[idx]
            self.assertTrue(model.apply(off, data))
            result = self.gw.submit(
                Fragment(
                    transfer_id=tid,
                    epoch=0,
                    frag_id=fid,
                    offset=off,
                    data=data,
                    total_length=n,
                    total_hash=thash if step == 0 else None,
                )
            )
            self.assertIn(
                result.status,
                (SubmitStatus.ACCEPTED, SubmitStatus.DUPLICATE),
                msg=f"{source!r} {spec} {perm}",
            )
        state = self.gw.get(tid)
        self.assertTrue(state.complete, msg=f"{source!r} {spec} {perm}")
        self.assertEqual(state.assembled(), source)
        self.assertEqual(model.assembled(n), source)
        self.assertEqual(state.assembled(), model.assembled(n))
        out = self.gw.finalize(tid)
        self.assertEqual(out["status"], "published")
        self.assertEqual(out["sha256"], thash)
        with open(out["path"], "rb") as fh:
            self.assertEqual(fh.read(), source)

    def test_all_splits_and_permutations(self):
        cases = 0
        for source in sources():
            for spec in fragmentations(source):
                for perm in itertools.permutations(range(len(spec))):
                    self.run_case(source, spec, perm)
                    cases += 1
        # sanity: the enumeration is genuinely exhaustive, not vacuous
        self.assertGreater(cases, 1000)


class TestExhaustiveConflicts(unittest.TestCase):
    """Every pair of distinct same-length sources, every overlapping
    interval pair with differing bytes: the second fragment must be
    rejected with the minimal conflict interval and both frag ids."""

    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        cls.gw = Gateway(GatewayConfig(workdir=cls._tmp.name))
        cls.counter = 0

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def test_all_conflict_pairs(self):
        checked = 0
        for n in (1, 2, 3):
            srcs = [bytes(bits) for bits in itertools.product(b"ab", repeat=n)]
            intervals = [(i, j) for i in range(n) for j in range(i + 1, n + 1)]
            for s1, s2 in itertools.permutations(srcs, 2):
                for a1, b1 in intervals:
                    for a2, b2 in intervals:
                        lo, hi = max(a1, a2), min(b1, b2)
                        if lo >= hi:
                            continue
                        d1 = s1[a1:b1]
                        d2 = s2[a2:b2]
                        diffs = [
                            p
                            for p in range(lo, hi)
                            if d1[p - a1] != d2[p - a2]
                        ]
                        if not diffs:
                            continue
                        TestExhaustiveConflicts.counter += 1
                        tid = f"c{TestExhaustiveConflicts.counter}"
                        r1 = self.gw.submit(
                            Fragment(tid, 0, "first", a1, d1, total_length=n)
                        )
                        self.assertEqual(r1.status, SubmitStatus.ACCEPTED)
                        r2 = self.gw.submit(
                            Fragment(tid, 0, "second", a2, d2, total_length=n)
                        )
                        self.assertEqual(r2.status, SubmitStatus.CONFLICT)
                        self.assertEqual(r2.conflict_start, diffs[0])
                        self.assertEqual(r2.conflict_end, diffs[-1] + 1)
                        self.assertEqual(r2.conflict_frag_incoming, "second")
                        self.assertEqual(r2.conflict_frag_existing, "first")
                        # verified data unpolluted by the rejected fragment
                        st = self.gw.get(tid)
                        self.assertEqual(st.storage.read(a1, b1 - a1), d1)
                        self.assertNotIn("second", st.fragments)
                        checked += 1
        self.assertGreater(checked, 100)


if __name__ == "__main__":
    unittest.main()
