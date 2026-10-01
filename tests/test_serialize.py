import json
import unittest

from arrangement import Arrangement, from_json, to_json, verify_all


def describe(arr):
    topo = arr.topology
    point_of = {v.id: v.point for v in topo.vertices}
    return {
        "vertices": sorted((v.id, v.point) for v in topo.vertices),
        "edges": sorted(
            (e.id, point_of[e.v0], point_of[e.v1], e.sources)
            for e in topo.edges
        ),
        "faces": sorted(
            (f.id, f.is_outer, tuple(h.id for h in f.halfedges))
            for f in topo.faces
        ),
    }


class TestSaveRestore(unittest.TestCase):
    def _roundtrip(self, arr):
        data = to_json(arr)
        json.dumps(data)  # must be JSON-serializable
        restored = from_json(json.loads(json.dumps(data)))
        self.assertEqual(describe(restored), describe(arr))
        self.assertTrue(verify_all(restored)["ok"])
        return restored

    def test_basic_roundtrip(self):
        arr = Arrangement([
            [(0, 0), (4, 0)], [(4, 0), (4, 4)], [(4, 4), (0, 4)],
            [(0, 4), (0, 0)], [(0, 0), (4, 4)], [(2, -1), (2, 5)],
            [(7, 7), (7, 7)],
        ])
        self._roundtrip(arr)

    def test_roundtrip_preserves_ids_after_updates(self):
        arr = Arrangement([[(0, 0), (4, 0)], [(0, 2), (4, 2)]])
        arr.insert([[(2, -1), (2, 3)]])
        arr.insert([[(1, 0), (1, 2)]])
        arr.delete([2])
        restored = self._roundtrip(arr)
        self.assertEqual(restored.edge_id_map(), arr.edge_id_map())
        # restored arrangement stays incremental: ids remain stable
        before = restored.edge_id_map()
        restored.insert([[(0, 1), (4, 1)]])
        after = restored.edge_id_map()
        common = set(before) & set(after)
        self.assertTrue(common)
        for eid in common:
            self.assertEqual(before[eid], after[eid])

    def test_rational_coordinates_roundtrip(self):
        arr = Arrangement([
            [("1/3", "2/7"), ("5/9", "11/13")],
            [("0.1", 0), ("0.3", "0.2")],
        ])
        self._roundtrip(arr)


if __name__ == "__main__":
    unittest.main()
