import unittest

from arrangement import Arrangement, verify_all
from arrangement.verify import (
    verify_coverage,
    verify_euler,
    verify_faces,
    verify_halfedges,
)


def sample():
    return Arrangement([
        [(0, 0), (4, 0)], [(4, 0), (4, 4)], [(4, 4), (0, 4)], [(0, 4), (0, 0)],
        [(0, 0), (4, 4)], [(2, -1), (2, 5)],
    ])


class TestVerifyAll(unittest.TestCase):
    def test_clean_arrangement_passes(self):
        report = verify_all(sample())
        self.assertTrue(report["ok"])
        for name, errors in report["checks"].items():
            self.assertEqual(errors, [], name)

    def test_detects_broken_twin(self):
        arr = sample()
        h = arr.halfedges[0]
        h.twin, other = arr.halfedges[2], h.twin
        self.assertFalse(verify_all(arr)["ok"])
        h.twin = other  # restore

    def test_detects_broken_next(self):
        arr = sample()
        h = arr.halfedges[0]
        saved = h.next
        h.next = h.twin
        self.assertTrue(verify_halfedges(arr) or verify_faces(arr)
                        or verify_all(arr)["checks"]["stitching"])
        h.next = saved

    def test_detects_coverage_loss(self):
        arr = sample()
        # corrupt the segment table: pretend a segment is longer than built
        sid = next(iter(arr._segments))
        p, q = arr._segments[sid]
        arr._segments[sid] = (p, (q[0] + 10, q[1]))
        self.assertTrue(verify_coverage(arr))
        arr._segments[sid] = (p, q)
        self.assertEqual(verify_coverage(arr), [])

    def test_euler_catches_face_loss(self):
        arr = sample()
        topo = arr.topology
        topo.faces.pop()
        self.assertTrue(verify_euler(arr))


if __name__ == "__main__":
    unittest.main()
