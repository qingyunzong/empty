import unittest
from datetime import datetime

from billcal.tztable import get_table


class TestFixedTable(unittest.TestCase):
    def test_fixed_offset(self):
        table = get_table("Asia/Shanghai")
        res = table.resolve(datetime(2021, 6, 1, 9, 0))
        self.assertEqual(res.utc_ts, 1622509200)  # 2021-06-01T01:00:00Z

    def test_utc_identity(self):
        table = get_table("UTC")
        res = table.resolve(datetime(2021, 1, 1, 0, 0))
        self.assertEqual(res.utc_ts, 1609459200)


class TestNewYorkDST(unittest.TestCase):
    def setUp(self):
        self.table = get_table("America/New_York")

    def test_overlap_first_and_second(self):
        # 2021-11-07 01:30 happens twice: EDT (-4) then EST (-5).
        local = datetime(2021, 11, 7, 1, 30)
        first = self.table.resolve(local, overlap="first")
        second = self.table.resolve(local, overlap="second")
        self.assertEqual(first.utc_ts, 1636263000)   # 05:30:00Z (EDT)
        self.assertEqual(second.utc_ts, 1636266600)  # 06:30:00Z (EST)
        self.assertEqual(second.utc_ts - first.utc_ts, 3600)
        self.assertIn("overlap", first.steps[0])

    def test_gap_reject(self):
        # 2021-03-14 02:30 never happens (spring forward).
        res = self.table.resolve(datetime(2021, 3, 14, 2, 30), gap="reject")
        self.assertIsNone(res.utc_ts)
        self.assertIn("reject", res.steps[0])

    def test_gap_next_valid(self):
        res = self.table.resolve(datetime(2021, 3, 14, 2, 30),
                                 gap="next_valid")
        # First valid local time is 03:00 EDT -> 07:00:00Z.
        self.assertEqual(res.utc_ts, 1615705200)
        self.assertIn("next_valid", res.steps[0])

    def test_normal_time(self):
        res = self.table.resolve(datetime(2021, 6, 15, 12, 0))
        self.assertEqual(res.utc_ts, 1623772800)  # 16:00:00Z, EDT


if __name__ == "__main__":
    unittest.main()
