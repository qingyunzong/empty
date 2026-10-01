import unittest
from fractions import Fraction

from arrangement import Arrangement, ArrangementError, verify_all


def two_cells():
    """Rectangle split into two squares by a middle segment."""
    return Arrangement([
        [(0, 0), (4, 0)],   # 1 bottom
        [(4, 0), (4, 2)],   # 2 right
        [(4, 2), (0, 2)],   # 3 top
        [(0, 2), (0, 0)],   # 4 left
        [(2, 0), (2, 2)],   # 5 divider
    ])


class TestInsertDelete(unittest.TestCase):
    def test_insert_keeps_unchanged_edge_ids(self):
        arr = two_cells()
        before = arr.edge_id_map()
        arr.insert([[(0, 0), (4, 2)]])  # diagonal crossing the divider
        after = arr.edge_id_map()
        # the left square's untouched edges keep their ids
        left_edges = {
            k for k, (p, q, s) in before.items()
            if max(p[0], q[0]) <= 2 and (p, q, s) == after.get(k)
        }
        self.assertTrue(left_edges)
        for eid in left_edges:
            self.assertEqual(before[eid], after[eid])
        self.assertTrue(arr.last_affected["added"])
        self.assertTrue(verify_all(arr)["ok"])

    def test_delete_edge_merges_faces(self):
        arr = two_cells()
        self.assertEqual(len([f for f in arr.faces if not f.is_outer]), 2)
        arr.delete([5])  # remove the divider: two faces merge into one
        inner = [f for f in arr.faces if not f.is_outer]
        self.assertEqual(len(inner), 1)
        self.assertEqual(inner[0].area, Fraction(8))
        self.assertTrue(verify_all(arr)["ok"])
        # removed edges reported; surviving edges keep ids
        self.assertTrue(arr.last_affected["removed"])

    def test_delete_segment_that_splits_face_region(self):
        # triangle fan: delete one spoke and watch the face count drop
        arr = Arrangement([
            [(0, 0), (4, 0)], [(4, 0), (2, 3)], [(2, 3), (0, 0)],
            [(2, 3), (2, 0)],  # spoke splitting the triangle
        ])
        self.assertEqual(len([f for f in arr.faces if not f.is_outer]), 2)
        arr.delete([4])
        self.assertEqual(len([f for f in arr.faces if not f.is_outer]), 1)
        self.assertTrue(verify_all(arr)["ok"])

    def test_affected_region_report(self):
        arr = two_cells()
        arr.insert([[(1, 1), (3, 1)]])  # crosses the divider at (2,1)
        affected = arr.last_affected
        self.assertTrue(affected["added"])
        self.assertIn(2, arr.segments)  # sanity
        touching = arr.segments_touching([6])
        self.assertIn(5, touching)      # divider meets the new segment
        self.assertNotIn(1, touching)   # bottom edge is untouched
        self.assertTrue(verify_all(arr)["ok"])

    def test_failed_insert_preserves_topology(self):
        arr = two_cells()
        before = arr.edge_id_map()
        before_faces = len(arr.faces)
        with self.assertRaises(ArrangementError):
            arr.insert([[("x", 0), (1, 1)]])
        with self.assertRaises(ArrangementError):
            arr.insert([[(0, 0)]])  # malformed
        with self.assertRaises(ArrangementError):
            arr.insert([[(0, 0), (1, 1)], [("bad", 2), (3, 3)]])
        self.assertEqual(arr.edge_id_map(), before)
        self.assertEqual(len(arr.faces), before_faces)
        self.assertTrue(verify_all(arr)["ok"])

    def test_failed_delete_preserves_topology(self):
        arr = two_cells()
        before = arr.edge_id_map()
        with self.assertRaises(ArrangementError):
            arr.delete([999])
        self.assertEqual(arr.edge_id_map(), before)

    def test_insert_then_delete_roundtrip_ids(self):
        arr = two_cells()
        baseline = arr.edge_id_map()
        sid = arr.insert([[(0, 0), (4, 2)]])[0]
        arr.delete([sid])
        self.assertEqual(arr.edge_id_map(), baseline)
        self.assertTrue(verify_all(arr)["ok"])

    def test_zero_length_segment_updates(self):
        arr = two_cells()
        n_vertices = len(arr.vertices)
        sid = arr.insert([[(1, 1), (1, 1)]])[0]
        self.assertEqual(len(arr.vertices), n_vertices + 1)
        self.assertTrue(verify_all(arr)["ok"])
        arr.delete([sid])
        self.assertEqual(len(arr.vertices), n_vertices)
        self.assertTrue(verify_all(arr)["ok"])


if __name__ == "__main__":
    unittest.main()
