import unittest

from reorder.seqnum import Region, classify, forward_distance


class TestSeqNum(unittest.TestCase):
    def test_forward_distance_wraps(self):
        self.assertEqual(forward_distance(6, 1, 8), 3)
        self.assertEqual(forward_distance(1, 6, 8), 5)
        self.assertEqual(forward_distance(3, 3, 8), 0)

    def test_classify_current(self):
        # window [6,7,0) with modulus 8, window 3
        self.assertIs(classify(6, 6, 3, 8), Region.CURRENT)
        self.assertIs(classify(7, 6, 3, 8), Region.CURRENT)
        self.assertIs(classify(0, 6, 3, 8), Region.CURRENT)

    def test_classify_old_behind_window(self):
        # 5,4,3 are behind base 6 (distances 7,6,5 >= 8-3=5)
        self.assertIs(classify(5, 6, 3, 8), Region.OLD)
        self.assertIs(classify(4, 6, 3, 8), Region.OLD)
        self.assertIs(classify(3, 6, 3, 8), Region.OLD)

    def test_classify_future_beyond_window(self):
        # 1,2 are ahead of base 6 but outside the window (distances 3,4)
        self.assertIs(classify(1, 6, 3, 8), Region.FUTURE)
        self.assertIs(classify(2, 6, 3, 8), Region.FUTURE)

    def test_plain_integer_comparison_would_be_wrong(self):
        # seq 0 > seq 7 numerically, yet 0 is *ahead* of 7 on the cycle
        # when the base is 6: the classifier, not `<`, decides.
        self.assertGreater(0, -1)  # sanity: ints compare normally
        self.assertIs(classify(0, 6, 3, 8), Region.CURRENT)
        self.assertIs(classify(7, 6, 3, 8), Region.CURRENT)
        self.assertIs(classify(5, 6, 3, 8), Region.OLD)

    def test_invalid_window_rejected(self):
        with self.assertRaises(ValueError):
            classify(0, 0, 0, 8)
        with self.assertRaises(ValueError):
            classify(0, 0, 5, 8)   # 2*window > modulus
        with self.assertRaises(ValueError):
            classify(0, 0, 2, 7)   # modulus not a power of two


if __name__ == "__main__":
    unittest.main()
