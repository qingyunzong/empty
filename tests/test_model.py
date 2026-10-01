import unittest

import _support  # noqa: F401  (sys.path setup)
from pncounter import Cluster, ClusterError, PNCounter


def err_code(fn, *args):
    try:
        fn(*args)
    except ClusterError as exc:
        return exc.code
    return None


class TestPNCounterAlgebra(unittest.TestCase):
    def make(self, p=None, n=None):
        c = PNCounter()
        c.p = dict(p or {})
        c.n = dict(n or {})
        return c

    def test_merge_commutative(self):
        a = self.make({"x": 3, "y": 1}, {"x": 2})
        b = self.make({"x": 1, "y": 5}, {"z": 4})
        ab = a.copy().merge(b.copy())
        ba = b.copy().merge(a.copy())
        self.assertEqual(ab.p, ba.p)
        self.assertEqual(ab.n, ba.n)

    def test_merge_associative(self):
        a = self.make({"x": 3}, {"y": 1})
        b = self.make({"y": 2}, {"x": 9})
        c = self.make({"z": 7}, {})
        left = a.copy().merge(b.copy()).merge(c.copy())
        right = a.copy().merge(b.copy().merge(c.copy()))
        self.assertEqual((left.p, left.n), (right.p, right.n))

    def test_merge_idempotent(self):
        a = self.make({"x": 3}, {"y": 2})
        b = self.make({"x": 9}, {"y": 1})
        once = a.copy().merge(b.copy())
        twice = once.copy().merge(b.copy())
        self.assertEqual((once.p, once.n), (twice.p, twice.n))

    def test_value_is_p_minus_n(self):
        c = self.make({"a": 10, "b": 2}, {"a": 3, "c": 4})
        self.assertEqual(c.value(), 5)


class TestClusterRules(unittest.TestCase):
    def boot(self, *nodes):
        c = Cluster()
        for node in nodes:
            c.inc(node, 1)
        return c

    def test_bad_delta_zero_negative_nonint(self):
        c = Cluster()
        self.assertEqual(err_code(c.inc, "A", 0), "BAD_DELTA")
        self.assertEqual(err_code(c.inc, "A", -3), "BAD_DELTA")
        self.assertEqual(err_code(c.dec, "A", 1.5), "BAD_DELTA")
        self.assertEqual(err_code(c.dec, "A", True), "BAD_DELTA")
        self.assertEqual(err_code(c.inc, "A", "2"), "BAD_DELTA")

    def test_first_write_joins_node(self):
        c = Cluster()
        self.assertEqual(c.inc("N1", 4), 4)
        self.assertIn("N1", c.alive)

    def test_remove_requires_majority(self):
        c = self.boot("A", "B")
        self.assertEqual(err_code(c.remove, "A"), "NO_MAJORITY")
        c2 = self.boot("A", "B", "C")
        c2.remove("A")
        self.assertNotIn("A", c2.alive)
        self.assertIn("A", c2.retired)

    def test_remove_unknown_node(self):
        c = self.boot("A", "B", "C")
        self.assertEqual(err_code(c.remove, "ZZ"), "NOT_FOUND")

    def test_double_remove_is_id_retired(self):
        c = self.boot("A", "B", "C")
        c.remove("A")
        self.assertEqual(err_code(c.remove, "A"), "ID_RETIRED")

    def test_write_after_remove_is_removed_and_state_unchanged(self):
        c = self.boot("A", "B", "C")
        c.inc("A", 5)
        before = (dict(c.replicas["A"].p), dict(c.replicas["A"].n))
        c.remove("A")
        self.assertEqual(err_code(c.inc, "A", 1), "REMOVED")
        self.assertEqual(err_code(c.dec, "A", 1), "REMOVED")
        after = (dict(c.replicas["A"].p), dict(c.replicas["A"].n))
        self.assertEqual(before, after)

    def test_tombstone_never_resurrects(self):
        c = self.boot("A", "B", "C")
        c.remove("A")
        c.merge("B", "A")
        c.merge("C", "B")
        self.assertNotIn("A", c.alive)
        self.assertIn("A", c.retired)
        self.assertEqual(err_code(c.inc, "A", 1), "REMOVED")

    def test_value_and_merge_unknown_node(self):
        c = self.boot("A")
        self.assertEqual(err_code(c.value, "ZZ"), "NOT_FOUND")
        self.assertEqual(err_code(c.merge, "A", "ZZ"), "NOT_FOUND")
        self.assertEqual(err_code(c.merge, "ZZ", "A"), "NOT_FOUND")

    def test_max_ten_nodes(self):
        c = Cluster()
        for i in range(10):
            c.inc(f"N{i}", 1)
        self.assertEqual(err_code(c.inc, "N10", 1), "TOO_MANY_NODES")


if __name__ == "__main__":
    unittest.main()
