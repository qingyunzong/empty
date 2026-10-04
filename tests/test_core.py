import unittest

from asofjoin import Dim, Fact, join


def dims(*rows):
    return [Dim(did=d, key=k, ts=t, attr=a) for d, k, t, a in rows]


def facts(*rows):
    return [Fact(fid=f, key=k, ts=t) for f, k, t in rows]


class TestTieBreak(unittest.TestCase):
    def test_equal_ts_picks_smallest_did(self):
        ds = dims(("d2", "k", 100, "two"), ("d1", "k", 100, "one"))
        fs = facts(("f1", "k", 150))
        [r] = join(fs, ds, tol=100)
        self.assertEqual(r.did, "d1")
        self.assertEqual(r.attr, "one")
        self.assertIsNone(r.reason)

    def test_latest_ts_wins_over_did_order(self):
        ds = dims(("d1", "k", 90, "old"), ("d9", "k", 100, "new"))
        fs = facts(("f1", "k", 150))
        [r] = join(fs, ds, tol=100)
        self.assertEqual((r.did, r.attr), ("d9", "new"))


class TestStaleVsNoDim(unittest.TestCase):
    def test_stale_when_same_key_dim_too_old(self):
        ds = dims(("d1", "k", 10, "old"), ("d2", "other", 5000, "pusher"))
        fs = facts(("f1", "k", 1000))
        [r] = join(fs, ds, tol=100)
        self.assertIsNone(r.did)
        self.assertIsNone(r.attr)
        self.assertEqual(r.reason, "stale")

    def test_no_dim_when_key_absent(self):
        ds = dims(("d1", "other", 10, "x"), ("d2", "other2", 5000, "pusher"))
        fs = facts(("f1", "k", 1000))
        [r] = join(fs, ds, tol=100)
        self.assertEqual(r.reason, "no_dim")

    def test_no_dim_when_dim_is_in_future(self):
        ds = dims(("d1", "k", 5000, "future"))
        fs = facts(("f1", "k", 1000))
        [r] = join(fs, ds, tol=100)
        self.assertEqual(r.reason, "no_dim")

    def test_stale_and_no_dim_coexist(self):
        ds = dims(("d1", "k", 10, "old"), ("d2", "other", 5000, "pusher"))
        fs = facts(("f1", "k", 1000), ("f2", "missing", 1000))
        rs = join(fs, ds, tol=100)
        self.assertEqual([r.reason for r in rs], ["stale", "no_dim"])


class TestDimUpdates(unittest.TestCase):
    def test_higher_ts_rearrival_overrides(self):
        ds = dims(("d1", "k", 100, "v1"), ("d1", "k", 200, "v2"))
        fs = facts(("f1", "k", 250))
        [r] = join(fs, ds, tol=100)
        self.assertEqual((r.did, r.attr), ("d1", "v2"))

    def test_same_ts_rearrival_is_invalid(self):
        ds = dims(("d1", "k", 100, "v1"), ("d1", "k", 100, "v2"))
        fs = facts(("f1", "k", 150))
        [r] = join(fs, ds, tol=100)
        self.assertEqual(r.attr, "v1")

    def test_lower_ts_rearrival_is_invalid(self):
        ds = dims(("d1", "k", 200, "v2"), ("d1", "k", 100, "v1"))
        fs = facts(("f1", "k", 250))
        [r] = join(fs, ds, tol=100)
        self.assertEqual(r.attr, "v2")

    def test_override_moves_key(self):
        ds = dims(("d1", "old_key", 100, "v1"), ("d1", "new_key", 200, "v2"))
        fs = facts(("f1", "old_key", 150), ("f2", "new_key", 250))
        rs = join(fs, ds, tol=100)
        self.assertEqual(rs[0].reason, "no_dim")  # old_key no longer has any dim
        self.assertEqual(rs[1].attr, "v2")

    def test_out_of_order_dims_all_apply(self):
        ds = dims(("d1", "k", 300, "c"), ("d2", "k", 100, "a"), ("d3", "k", 200, "b"))
        fs = facts(("f1", "k", 350))
        [r] = join(fs, ds, tol=100)
        self.assertEqual((r.did, r.attr), ("d1", "c"))


class TestWatermarks(unittest.TestCase):
    def test_late_fact_is_dropped(self):
        ds = dims(("d1", "k", 100, "v"))
        fs = facts(("f1", "k", 1000), ("f2", "k", 500))  # f2 arrives after FWM=1000
        rs = join(fs, ds, tol=10000)
        self.assertEqual([r.fid for r in rs], ["f1"])

    def test_fact_at_watermark_is_kept(self):
        ds = dims(("d1", "k", 100, "v"))
        fs = facts(("f1", "k", 1000), ("f2", "k", 1000))
        rs = join(fs, ds, tol=10000)
        self.assertEqual([r.fid for r in rs], ["f1", "f2"])

    def test_no_output_until_dwm_passes_lookback(self):
        ds = dims(("d1", "k", 100, "v"))  # DWM = 100
        fs = facts(("f1", "k", 150), ("f2", "k", 1000))
        rs = join(fs, ds, tol=100)
        # f1: 150-100=50 < DWM -> emitted; f2: 1000-100=900 >= DWM -> pending, no output
        self.assertEqual([r.fid for r in rs], ["f1"])

    def test_no_dims_means_no_output(self):
        fs = facts(("f1", "k", 1000))
        self.assertEqual(join(fs, [], tol=100), [])

    def test_late_dim_within_tol_changes_result(self):
        # d2 arrives late (out of order) but inside the tolerance window.
        ds = dims(("d1", "k", 100, "early"), ("d2", "k", 180, "late"))
        fs = facts(("f1", "k", 200))
        [r] = join(fs, ds, tol=50)
        self.assertEqual((r.did, r.attr), ("d2", "late"))

    def test_late_override_within_tol_changes_result(self):
        ds = dims(("d1", "k", 100, "v1"), ("d1", "k", 190, "v2"))
        fs = facts(("f1", "k", 200))
        [r] = join(fs, ds, tol=50)
        self.assertEqual(r.attr, "v2")


class TestOutputOrder(unittest.TestCase):
    def test_sorted_by_ts_then_fid(self):
        ds = dims(("d1", "k", 1, "v"))
        fs = facts(("f2", "k", 100), ("f1", "k", 100), ("f3", "k", 300))
        rs = join(fs, ds, tol=10000)
        self.assertEqual([(r.ts, r.fid) for r in rs],
                         [(100, "f1"), (100, "f2"), (300, "f3")])

    def test_boundary_tol_inclusive(self):
        ds = dims(("d1", "k", 100, "v"), ("d2", "other", 1000, "p"))
        fs = facts(("f1", "k", 300))
        [r] = join(fs, ds, tol=200)
        self.assertEqual(r.attr, "v")

    def test_boundary_tol_exclusive(self):
        ds = dims(("d1", "k", 100, "v"), ("d2", "other", 1000, "p"))
        fs = facts(("f1", "k", 301))
        [r] = join(fs, ds, tol=200)
        self.assertEqual(r.reason, "stale")

    def test_zero_tol_matches_exact_ts(self):
        ds = dims(("d1", "k", 100, "v"), ("d2", "other", 1000, "p"))
        fs = facts(("f1", "k", 100), ("f2", "k", 101))
        rs = join(fs, ds, tol=0)
        self.assertEqual(rs[0].attr, "v")
        self.assertEqual(rs[1].reason, "stale")


if __name__ == "__main__":
    unittest.main()
