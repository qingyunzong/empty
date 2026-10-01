import random
import unittest

from arrangement import Arrangement
from arrangement.geom import to_frac


def _pt(x, y):
    return (to_frac(x), to_frac(y))


def edge_keys(arr):
    """Geometry-keyed edge set: {(u_point, v_point)} with sorted pairs."""
    pts = {v["id"]: _pt(v["x"], v["y"]) for v in arr.vertices()}
    keys = set()
    for e in arr.edges():
        a, b = pts[e["u"]], pts[e["v"]]
        keys.add(tuple(sorted([a, b])))
    return keys


def face_sigs(arr):
    """Geometry-based face signatures, independent of ids."""
    pts = {v["id"]: _pt(v["x"], v["y"]) for v in arr.vertices()}

    def norm(cycle):
        p = [pts[v] for v in cycle]
        return min(tuple(p[i:] + p[:i]) for i in range(len(p)))

    sigs = set()
    for f in arr.faces():
        outer = norm(f["outer"]) if f["outer"] else None
        holes = tuple(sorted(norm(h) for h in f["holes"]))
        iso = tuple(sorted(pts[v] for v in f["isolated"]))
        sigs.add((outer, holes, iso))
    return sigs


class TestArrangementCases(unittest.TestCase):
    def test_t_junction(self):
        arr = Arrangement([
            [(0, 0), (4, 0)],
            [(4, 0), (4, 4)],
            [(0, 0), (0, 4)],
            [(0, 4), (4, 4)],
            [(2, 0), (2, 4)],   # T-junctions at (2,0) and (2,4)
        ])
        self.assertEqual(arr.stats()["vertices"], 6)
        self.assertEqual(arr.stats()["edges"], 7)
        self.assertEqual(arr.stats()["faces"], 3)
        arr.verify()

    def test_cross_multi_point(self):
        arr = Arrangement([
            [(0, 0), (4, 4)],
            [(0, 4), (4, 0)],
            [(2, 0), (2, 4)],
            [(0, 2), (4, 2)],
        ])
        # 8 outer endpoints + 1 central crossing point; each of the
        # 4 segments is split in two at the common point.
        self.assertEqual(arr.stats()["vertices"], 9)
        self.assertEqual(arr.stats()["edges"], 8)
        arr.verify()

    def test_overlap_chain(self):
        arr = Arrangement([
            [(0, 0), (4, 0)],
            [(2, 0), (6, 0)],
            [(5, 0), (8, 0)],
        ])
        edges = arr.edges()
        self.assertEqual(len(edges), 5)
        sources = sorted(tuple(e["sources"]) for e in edges)
        self.assertEqual(
            sources, [(1,), (1, 2), (2,), (2, 3), (3,)]
        )
        arr.verify()

    def test_nested_closed_loops(self):
        outer = [[(0, 0), (10, 0)], [(10, 0), (10, 10)],
                 [(10, 10), (0, 10)], [(0, 10), (0, 0)]]
        inner = [[(2, 2), (4, 2)], [(4, 2), (4, 4)],
                 [(4, 4), (2, 4)], [(2, 4), (2, 2)]]
        arr = Arrangement(outer + inner)
        self.assertEqual(arr.stats()["faces"], 3)
        bounded = [f for f in arr.faces() if not f["is_outer"]]
        self.assertEqual(len(bounded), 2)
        ring = [f for f in bounded if f["holes"]]
        self.assertEqual(len(ring), 1)
        self.assertEqual(len(ring[0]["holes"]), 1)
        arr.verify()

    def test_delete_edge_merges_faces(self):
        square = [[(0, 0), (4, 0)], [(4, 0), (4, 4)],
                  [(4, 4), (0, 4)], [(0, 4), (0, 0)]]
        arr = Arrangement(square)
        (diag,) = arr.add_segments([[(0, 0), (4, 4)]])
        self.assertEqual(arr.stats()["faces"], 3)
        arr.verify()
        arr.remove_segments([diag])
        self.assertEqual(arr.stats()["faces"], 2)
        arr.verify()

    def test_zero_length_point_segments(self):
        arr = Arrangement([
            [(0, 0), (6, 0)],
            [(3, 0), (3, 0)],      # point on an edge -> splits it
            [(10, 10), (10, 10)],  # isolated point
        ])
        self.assertEqual(arr.stats()["vertices"], 4)
        self.assertEqual(arr.stats()["edges"], 2)
        outer = [f for f in arr.faces() if f["is_outer"]][0]
        self.assertEqual(len(outer["isolated"]), 1)
        arr.verify()

    def test_isolated_point_inside_loop_assigned_to_face(self):
        arr = Arrangement([
            [(0, 0), (4, 0)], [(4, 0), (4, 4)],
            [(4, 4), (0, 4)], [(0, 4), (0, 0)],
            [(2, 2), (2, 2)],
        ])
        bounded = [f for f in arr.faces() if not f["is_outer"]][0]
        self.assertEqual(len(bounded["isolated"]), 1)
        arr.verify()

    def test_vertical_and_shared_endpoints(self):
        arr = Arrangement([
            [(2, 0), (2, 6)],
            [(0, 3), (2, 3)],
            [(2, 3), (5, 3)],
            [(5, 3), (5, 6)],
            [(2, 6), (5, 6)],
        ])
        arr.verify()
        self.assertEqual(arr.stats()["faces"], 2)

    def test_exact_rational_intersection(self):
        arr = Arrangement([
            [(0, 0), (3, 1)],
            [(0, 1), (3, 0)],
        ])
        xs = {to_frac(v["x"]) for v in arr.vertices()}
        ys = {to_frac(v["y"]) for v in arr.vertices()}
        from fractions import Fraction
        self.assertIn(Fraction(3, 2), xs)
        self.assertIn(Fraction(1, 2), ys)
        arr.verify()


class TestIncremental(unittest.TestCase):
    def test_unchanged_edges_keep_ids(self):
        arr = Arrangement([
            [(0, 0), (4, 0)], [(4, 0), (4, 4)],
            [(4, 4), (0, 4)], [(0, 4), (0, 0)],
        ])
        before = {(e["u"], e["v"]): e["id"] for e in arr.edges()}
        arr.add_segments([[(10, 10), (12, 10)]])  # disjoint, far away
        after = {(e["u"], e["v"]): e["id"] for e in arr.edges()}
        # Vertex ids are stable, so keyed-by-vertex-id comparison works.
        for key, eid in before.items():
            self.assertEqual(after[key], eid)
        arr.verify()

    def test_ids_stable_across_remove(self):
        arr = Arrangement([
            [(0, 0), (4, 0)], [(4, 0), (4, 4)],
            [(4, 4), (0, 4)], [(0, 4), (0, 0)],
            [(10, 10), (12, 10)],
        ])
        keep = {e["id"] for e in arr.edges()[:4]}
        arr.remove_segments([5])
        remaining = {e["id"] for e in arr.edges()}
        self.assertEqual(remaining, keep)
        arr.verify()

    def test_incremental_matches_full_rebuild(self):
        rng = random.Random(7)
        segs = []
        for _ in range(10):
            while True:
                p = (rng.randint(-5, 5), rng.randint(-5, 5))
                q = (rng.randint(-5, 5), rng.randint(-5, 5))
                if p != q:
                    break
            segs.append([p, q])
        inc = Arrangement()
        for s in segs[:6]:
            inc.add_segments([s])
        inc.add_segments(segs[6:])
        full = Arrangement(segs)
        self.assertEqual(edge_keys(inc), edge_keys(full))
        self.assertEqual(face_sigs(inc), face_sigs(full))
        inc.verify()
        full.verify()

    def test_failed_input_preserves_topology(self):
        arr = Arrangement([[(0, 0), (4, 0)], [(0, 1), (4, 1)]])
        snapshot = (edge_keys(arr), face_sigs(arr), arr.stats())
        with self.assertRaises(ValueError):
            arr.add_segments([[(0, 0), (1.5, 2)]])       # float rejected
        with self.assertRaises(ValueError):
            arr.add_segments([[(0, 0)]])                  # malformed
        with self.assertRaises(ValueError):
            arr.add_segments([[(0, 0), ("x", 1)]])        # bad coordinate
        with self.assertRaises(ValueError):
            arr.remove_segments([999])                    # unknown id
        self.assertEqual((edge_keys(arr), face_sigs(arr), arr.stats()),
                         snapshot)
        arr.verify()

    def test_partial_failure_is_atomic(self):
        arr = Arrangement([[(0, 0), (4, 0)]])
        n = arr.stats()["segments"]
        with self.assertRaises(ValueError):
            arr.add_segments([[(1, 1), (2, 2)], [(0, 0), (0.5, 0.5)]])
        self.assertEqual(arr.stats()["segments"], n)


class TestSerialization(unittest.TestCase):
    def test_save_restore_roundtrip(self):
        arr = Arrangement([
            [(0, 0), (4, 0)], [(4, 0), (4, 4)],
            [(4, 4), (0, 4)], [(0, 4), (0, 0)],
            [(0, 0), (4, 4)],
            [(2, 2), (2, 2)],
        ])
        arr.verify()
        data = arr.to_dict()
        # Must be JSON-serializable.
        import json
        restored = Arrangement.from_dict(json.loads(json.dumps(data)))
        self.assertEqual(edge_keys(arr), edge_keys(restored))
        self.assertEqual(face_sigs(arr), face_sigs(restored))
        # Ids survive the roundtrip.
        self.assertEqual(
            sorted(e["id"] for e in arr.edges()),
            sorted(e["id"] for e in restored.edges()),
        )
        self.assertEqual(
            sorted(v["id"] for v in arr.vertices()),
            sorted(v["id"] for v in restored.vertices()),
        )
        # Further edits after restore keep working and stay stable.
        restored.add_segments([[(10, 10), (12, 10)]])
        arr.add_segments([[(10, 10), (12, 10)]])
        self.assertEqual(edge_keys(arr), edge_keys(restored))
        self.assertEqual(
            sorted(e["id"] for e in arr.edges()),
            sorted(e["id"] for e in restored.edges()),
        )
        restored.verify()


class TestRandomizedVerify(unittest.TestCase):
    def test_random_arrangements_verify(self):
        rng = random.Random(1234)
        for trial in range(40):
            n = rng.randint(1, 12)
            segs = []
            for _ in range(n):
                p = (rng.randint(-6, 6), rng.randint(-6, 6))
                q = (rng.randint(-6, 6), rng.randint(-6, 6))
                segs.append([p, q])  # may include zero-length segments
            arr = Arrangement(segs)
            checks = arr.verify()
            self.assertTrue(checks["coverage"])
            self.assertTrue(checks["half_edges_paired"])
            self.assertTrue(checks["face_loops_closed"])
            self.assertTrue(checks["euler"])

    def test_random_incremental_vs_rebuild(self):
        rng = random.Random(99)
        for trial in range(15):
            n = rng.randint(2, 8)
            segs = []
            for _ in range(n):
                while True:
                    p = (rng.randint(-4, 4), rng.randint(-4, 4))
                    q = (rng.randint(-4, 4), rng.randint(-4, 4))
                    if p != q:
                        break
                segs.append([p, q])
            inc = Arrangement()
            for s in segs:
                inc.add_segments([s])
            # Delete a random subset incrementally.
            ids = list(range(1, n + 1))
            rng.shuffle(ids)
            for sid in ids[: n // 2]:
                inc.remove_segments([sid])
            full = Arrangement([s for i, s in enumerate(segs, 1)
                                if i not in ids[: n // 2]])
            self.assertEqual(edge_keys(inc), edge_keys(full), trial)
            self.assertEqual(face_sigs(inc), face_sigs(full), trial)
            inc.verify()


if __name__ == "__main__":
    unittest.main()
