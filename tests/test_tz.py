import unittest
from datetime import datetime

from billcycle import get_zone
from billcycle.tztable import (available_zones, iso_utc, resolve_local,
                               to_epoch)


class TestOfflineTable(unittest.TestCase):
    def test_builtin_zones_available_offline(self):
        self.assertEqual(available_zones(), ["America/New_York",
                                             "Asia/Shanghai",
                                             "Europe/London", "UTC"])

    def test_unknown_zone_rejected(self):
        with self.assertRaises(ValueError):
            get_zone("Mars/Olympus")

    def test_fixed_offset_zone(self):
        sh = get_zone("Asia/Shanghai")
        ts, steps = resolve_local(sh, datetime(2024, 1, 1, 9, 0),
                                  "reject", "earlier")
        self.assertEqual(iso_utc(ts), "2024-01-01T01:00:00Z")
        self.assertIn("+08:00", steps[0])

    def test_utc_roundtrip(self):
        ny = get_zone("America/New_York")
        for stamp in ("2024-01-15T12:00:00Z", "2024-07-15T12:00:00Z"):
            ts = to_epoch(datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ"))
            local = ny.utc_to_local(ts)
            back, _ = resolve_local(ny, local, "reject", "earlier")
            self.assertEqual(back, ts)

    def test_new_york_offsets_follow_dst(self):
        ny = get_zone("America/New_York")
        winter = to_epoch(datetime(2024, 1, 15, 12, 0))
        summer = to_epoch(datetime(2024, 7, 15, 12, 0))
        self.assertEqual(ny.offset_at(winter), -5 * 3600)
        self.assertEqual(ny.offset_at(summer), -4 * 3600)


class TestRepeatedLocalTime(unittest.TestCase):
    # 2024-11-03 01:30 happens twice in America/New_York (fall-back).
    def setUp(self):
        self.ny = get_zone("America/New_York")
        self.local = datetime(2024, 11, 3, 1, 30)

    def test_repeat_requires_explicit_choice_earlier(self):
        ts, steps = resolve_local(self.ny, self.local, "reject", "earlier")
        self.assertEqual(iso_utc(ts), "2024-11-03T05:30:00Z")  # EDT leg
        self.assertTrue(any("occurs twice" in s and "earlier" in s
                            for s in steps))

    def test_repeat_explicit_choice_later(self):
        ts, steps = resolve_local(self.ny, self.local, "reject", "later")
        self.assertEqual(iso_utc(ts), "2024-11-03T06:30:00Z")  # EST leg
        self.assertTrue(any("occurs twice" in s and "later" in s
                            for s in steps))

    def test_repeat_reject(self):
        ts, steps = resolve_local(self.ny, self.local, "reject", "reject")
        self.assertIsNone(ts)
        self.assertTrue(any("rejected" in s for s in steps))


class TestNonexistentLocalTime(unittest.TestCase):
    # 2024-03-10 02:30 does not exist in America/New_York (spring-forward).
    def setUp(self):
        self.ny = get_zone("America/New_York")
        self.local = datetime(2024, 3, 10, 2, 30)

    def test_gap_shift_forward_finds_first_valid_time(self):
        ts, steps = resolve_local(self.ny, self.local,
                                  "shift_forward", "earlier")
        self.assertEqual(iso_utc(ts), "2024-03-10T07:00:00Z")  # 03:00 EDT
        self.assertTrue(any("does not exist" in s and "03:00" in s
                            for s in steps))

    def test_gap_reject(self):
        ts, steps = resolve_local(self.ny, self.local, "reject", "earlier")
        self.assertIsNone(ts)
        self.assertTrue(any("does not exist" in s and "rejected" in s
                            for s in steps))

    def test_invalid_policies_rejected(self):
        with self.assertRaises(ValueError):
            resolve_local(self.ny, self.local, "guess", "earlier")
        with self.assertRaises(ValueError):
            resolve_local(self.ny, self.local, "reject", "whatever")


if __name__ == "__main__":
    unittest.main()
