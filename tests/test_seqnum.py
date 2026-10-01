import unittest

from msdeliv.seqnum import (
    AMBIGUOUS,
    PAST,
    WINDOW,
    check_window_params,
    classify,
    fwd_dist,
)


class TestSeqNum(unittest.TestCase):
    def test_window_params_validated(self):
        check_window_params(16, 4)
        with self.assertRaises(ValueError):
            check_window_params(16, 8)   # 2*window must be < mod
        with self.assertRaises(ValueError):
            check_window_params(15, 4)   # mod must be a power of two
        with self.assertRaises(ValueError):
            check_window_params(16, 0)

    def test_fwd_dist_wraps(self):
        self.assertEqual(fwd_dist(14, 2, 16), 4)
        self.assertEqual(fwd_dist(2, 14, 16), 12)
        self.assertEqual(fwd_dist(5, 5, 16), 0)

    def test_classify_distinguishes_old_from_future(self):
        # base=14, mod=16, window=4:
        #   window    = {14, 15, 0, 1}   (offsets 0..3)
        #   ambiguous = {2, ..., 9}      (offsets 4..11)
        #   past      = {10, 11, 12, 13} (offsets 12..15)
        for seq in (14, 15, 0, 1):
            self.assertEqual(classify(seq, 14, 16, 4), WINDOW, seq)
        for seq in (2, 5, 9):
            self.assertEqual(classify(seq, 14, 16, 4), AMBIGUOUS, seq)
        for seq in (10, 11, 12, 13):
            self.assertEqual(classify(seq, 14, 16, 4), PAST, seq)

    def test_boundaries(self):
        # offset exactly window -> ambiguous; offset exactly mod-window -> past
        self.assertEqual(classify(4, 0, 16, 4), AMBIGUOUS)
        self.assertEqual(classify(12, 0, 16, 4), PAST)
        self.assertEqual(classify(3, 0, 16, 4), WINDOW)

    def test_no_plain_integer_wraparound_compare(self):
        # seq 1 < seq 13 as integers, but relative to base 14 the "smaller"
        # 1 is in-window future while the "larger" 13 is old past.
        self.assertEqual(classify(1, 14, 16, 4), WINDOW)
        self.assertEqual(classify(13, 14, 16, 4), PAST)


if __name__ == "__main__":
    unittest.main()
