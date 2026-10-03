import hashlib
import unittest

from sessionize import Sessionizer, compute_sessions, ids_hash


class TestIdsHash(unittest.TestCase):
    def test_known_vector(self):
        self.assertEqual(ids_hash(["b", "a", "c"]),
                         hashlib.sha256(b"abc").hexdigest())

    def test_sorted_before_hashing(self):
        self.assertEqual(ids_hash(["c", "a", "b"]), ids_hash(["a", "b", "c"]))


class TestBasics(unittest.TestCase):
    def test_same_ts_events_counted_individually(self):
        (s,) = compute_sessions("k", [(5, "x"), (5, "y"), (5, "x")], gap=10)
        self.assertEqual((s.start, s.end, s.count), (5, 5, 3))
        self.assertEqual(s.ids, hashlib.sha256(b"xxy").hexdigest())

    def test_session_dict_shape(self):
        (s,) = compute_sessions("k", [(1, "a")], gap=10)
        self.assertEqual(set(s.to_dict()),
                         {"key", "start", "end", "count", "ids"})

    def test_gap_and_late_must_be_non_negative(self):
        with self.assertRaises(ValueError):
            Sessionizer(gap=-1, late=0)
        with self.assertRaises(ValueError):
            Sessionizer(gap=0, late=-1)


if __name__ == "__main__":
    unittest.main()
