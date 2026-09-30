import copy
import random
import unittest

from rknni import Index, VerificationError, verify

from helpers import make_index


class VerifyBase(unittest.TestCase):
    def setUp(self):
        rng = random.Random(777)
        self.idx = make_index(rng, 200, dim=2, capacity=4, fanout=4)
        self.q = [7, -3]
        self.k = 5
        self.res = self.idx.query(self.q, self.k)
        self.assertEqual(self.res.status, "exact")
        self.assertGreater(len(self.res.cert_entries), 0)
        self.partial = self.idx.query(self.q, self.k, budget=2)
        self.assertEqual(self.partial.status, "partial")
        self.assertGreater(len(self.partial.cert_entries), 0)

    def assertRejected(self, result_dict):
        with self.assertRaises(VerificationError):
            verify(self.idx.points(), self.q, self.k, None, result_dict)


class TestHonestResults(VerifyBase):
    def test_exact_result_verifies(self):
        self.assertTrue(verify(self.idx.points(), self.q, self.k, None, self.res))

    def test_exact_result_verifies_from_dict(self):
        self.assertTrue(
            verify(self.idx.points(), self.q, self.k, None, self.res.to_dict())
        )

    def test_partial_result_verifies(self):
        self.assertTrue(
            verify(self.idx.points(), self.q, self.k, None, self.partial)
        )

    def test_filtered_result_verifies(self):
        filt = {"or": [{"tag": "a"}, {"not": {"tag": "b"}}]}
        res = self.idx.query(self.q, 4, filter=filt)
        self.assertTrue(verify(self.idx.points(), self.q, 4, filt, res))


class TestTamperedResults(VerifyBase):
    def test_tampered_bound_rejected(self):
        rd = self.res.to_dict()
        entry = rd["certificate"]["entries"][0]
        entry["bound"] = "0"  # lower than the true mindist
        self.assertRejected(rd)

    def test_tampered_bbox_rejected(self):
        rd = self.res.to_dict()
        entry = rd["certificate"]["entries"][0]
        # Move the bbox far away: the recomputed mindist no longer
        # matches the claimed bound.
        entry["bbox"][0] = ["1000000", "1000001"]
        self.assertRejected(rd)

    def test_tampered_distance_rejected(self):
        rd = self.res.to_dict()
        rd["results"][0]["distance"] = "0"
        self.assertRejected(rd)

    def test_swapped_hits_rejected(self):
        rd = self.res.to_dict()
        rd["results"][0], rd["results"][1] = rd["results"][1], rd["results"][0]
        self.assertRejected(rd)

    def test_unknown_id_rejected(self):
        rd = self.res.to_dict()
        rd["results"][0]["id"] = "no-such-point"
        self.assertRejected(rd)

    def test_dropped_hit_rejected(self):
        rd = self.res.to_dict()
        rd["results"] = rd["results"][:-1]
        self.assertRejected(rd)

    def test_partial_masquerading_as_exact_rejected(self):
        # "unknown" must not pass as an exact KNN answer.
        rd = self.partial.to_dict()
        rd["status"] = "exact"
        rd["complete"] = True
        self.assertRejected(rd)

    def test_complete_flag_inconsistent_rejected(self):
        rd = self.partial.to_dict()
        rd["complete"] = True
        self.assertRejected(rd)

    def test_removed_certificate_entry_rejected(self):
        rd = self.partial.to_dict()
        rd["certificate"]["entries"] = []
        self.assertRejected(rd)

    def test_bogus_certificate_entry_rejected(self):
        rd = self.res.to_dict()
        rd["certificate"]["entries"].append(
            {
                "node_id": 999999,
                "bbox": [["-1000", "1000"], ["-1000", "1000"]],
                "bound": "0",
            }
        )
        # bound 0 <= k-th distance violates the exact-search invariant.
        self.assertRejected(rd)

    def test_extra_result_rejected(self):
        rd = self.res.to_dict()
        rd["results"].append(copy.deepcopy(rd["results"][-1]))
        self.assertRejected(rd)


class TestVerifyEdgeCases(unittest.TestCase):
    def test_empty_dataset_exact(self):
        idx = Index(2)
        res = idx.query([0, 0], 3)
        self.assertTrue(verify(idx.points(), [0, 0], 3, None, res))

    def test_zero_budget_partial_verifies(self):
        rng = random.Random(5)
        idx = make_index(rng, 50, dim=2)
        res = idx.query([1, 1], 4, budget=0)
        self.assertEqual(res.status, "partial")
        self.assertTrue(verify(idx.points(), [1, 1], 4, None, res))

    def test_verify_rejects_bad_status(self):
        idx = Index(2)
        idx.insert("a", [0, 0])
        res = idx.query([0, 0], 1).to_dict()
        res["status"] = "unknown"
        with self.assertRaises(VerificationError):
            verify(idx.points(), [0, 0], 1, None, res)


if __name__ == "__main__":
    unittest.main()
