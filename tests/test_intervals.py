import unittest

from reassembler.intervals import IntervalSet


class TestIntervalSet(unittest.TestCase):
    def test_add_merges_and_keeps_evidence(self):
        s = IntervalSet()
        s.add(0, 4, "a")
        s.add(2, 6, "b")
        self.assertEqual(len(s), 1)
        span = s.spans[0]
        self.assertEqual((span.start, span.end), (0, 6))
        self.assertEqual(sorted(span.evidence), ["a", "b"])

    def test_disjoint_spans_and_gaps(self):
        s = IntervalSet()
        s.add(0, 2, "a")
        s.add(5, 8, "b")
        self.assertEqual(s.gaps(0, 10), [(2, 5), (8, 10)])
        self.assertEqual(s.covered_bytes(), 5)
        self.assertFalse(s.is_complete(0, 10))

    def test_complete_when_single_span_covers(self):
        s = IntervalSet()
        s.add(3, 5, "x")
        s.add(0, 3, "y")
        s.add(5, 9, "z")
        self.assertTrue(s.is_complete(0, 9))
        self.assertEqual(s.gaps(0, 9), [])

    def test_evidence_at(self):
        s = IntervalSet()
        s.add(10, 20, "frag-9")
        span = s.evidence_at(15)
        self.assertIsNotNone(span)
        self.assertIn("frag-9", span.evidence)
        self.assertIsNone(s.evidence_at(25))

    def test_zero_length_add_is_noop(self):
        s = IntervalSet()
        s.add(4, 4, "noop")
        self.assertEqual(len(s), 0)


if __name__ == "__main__":
    unittest.main()
