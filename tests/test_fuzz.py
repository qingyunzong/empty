"""Randomised cross-checking against an independent brute-force reference.

After *every* update of a small point set we compare the dynamic hull with
full supporting-line enumeration, run the independent checker, and compare
extreme / tangent / classification queries against brute force.

The reference works on exact integers (all random coordinates are generated
as sixths, so scaling by 6 is exact); the library under test always sees
reduced ``Fraction`` coordinates.
"""

import random
import unittest
from fractions import Fraction

from rational_hull import DynamicConvexHull
from rational_hull.checker import verify

DEN = 6  # every generated rational has a denominator dividing 6


def brute_hull_coords(coords):
    """Full supporting-line enumeration over integer (x, y) coordinates."""
    coords = sorted(set(coords))
    if len(coords) <= 1:
        return coords

    def cross(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

    nxt = {}
    for a in coords:
        for b in coords:
            if a != b and all(cross(a, b, c) >= 0 for c in coords):
                nxt.setdefault(a, []).append(b)
    start = coords[0]
    out = [start]
    cur = start
    while True:
        far = max(
            nxt[cur],
            key=lambda v: (v[0] - cur[0]) ** 2 + (v[1] - cur[1]) ** 2,
        )
        if far == start:
            return out
        out.append(far)
        cur = far


def reps_min_id(active):
    reps = {}
    for pid, coord in active.items():
        if coord not in reps or pid < reps[coord]:
            reps[coord] = pid
    return reps


def brute_hull_ids(active):
    reps = reps_min_id(active)
    return [reps[c] for c in brute_hull_coords(list(reps))]


def brute_extreme(active, dx, dy):
    best = None
    best_key = None
    for pid, (x, y) in active.items():
        key = (dx * x + dy * y, -dy * x + dx * y)
        if best is None or key > best_key or (key == best_key and pid < best):
            best = pid
            best_key = key
    return best


def brute_tangent(active, qx, qy):
    reps = reps_min_id(active)
    coords = sorted(reps)

    def cross(t, p):
        return (t[0] - qx) * (p[1] - qy) - (t[1] - qy) * (p[0] - qx)

    def pick(sign):
        cands = [
            t for t in coords if all(sign * cross(t, c) >= 0 for c in coords)
        ]
        # Nearest to q wins; the nearest collinear active point on a tangent
        # edge is always its endpoint vertex.  Same coord => smallest id.
        near = min(cands, key=lambda t: ((t[0] - qx) ** 2 + (t[1] - qy) ** 2))
        return reps[near]

    return pick(1), pick(-1)


def brute_classify(vert_coords, qx, qy):
    def cross(a, b):
        return (b[0] - a[0]) * (qy - a[1]) - (b[1] - a[1]) * (qx - a[0])

    zero = False
    m = len(vert_coords)
    for i in range(m):
        c = cross(vert_coords[i], vert_coords[(i + 1) % m])
        if c < 0:
            return "outside"
        if c == 0:
            zero = True
    return "boundary" if zero else "inside"


class TestFuzz(unittest.TestCase):
    def run_trial(self, rng, trial, steps=60, max_live=40):
        h = DynamicConvexHull()
        active = {}  # pid -> (ix, iy) integer sixths
        for step in range(steps):
            if not active or (rng.random() < 0.6 and len(active) < max_live):
                pid = f"t{trial}s{step}"
                roll = rng.random()
                if active and roll < 0.15:
                    coord = rng.choice(list(active.values()))  # duplicate
                elif roll < 0.30:
                    ix = rng.randint(-48, 48)
                    coord = (ix, 2 * ix + DEN)  # collinear family y = 2x + 1
                else:
                    coord = (rng.randint(-72, 72), rng.randint(-72, 72))
                h.insert(pid, Fraction(coord[0], DEN), Fraction(coord[1], DEN))
                active[pid] = coord
            else:
                pid = rng.choice(list(active))
                h.delete(pid)
                del active[pid]

            # 1. Hull matches full supporting-line enumeration.
            want_ids = brute_hull_ids(active)
            got_ids = [v.id for v in h.hull().vertices]
            self.assertEqual(
                got_ids, want_ids, f"trial {trial} step {step}: hull mismatch"
            )

            # 2. Independent checker: containment + vertices real + evidence.
            self.assertTrue(verify(h))

            if not active:
                continue

            # 3. Directional extremes match brute force.
            for _ in range(3):
                dx = rng.randint(-3, 3)
                dy = rng.randint(-3, 3)
                if dx == 0 and dy == 0:
                    continue
                want = brute_extreme(active, dx, dy)
                got = h.extreme(dx, dy)
                self.assertEqual(
                    got.id, want, f"extreme({dx},{dy}) mismatch at step {step}"
                )

            # 4. Tangents from an exterior point match brute force.
            vert_coords = brute_hull_coords(list(reps_min_id(active)))
            if len(vert_coords) >= 3:
                qx = max(c[0] for c in vert_coords) + DEN
                qy = rng.randint(-90, 90)
                self.assertEqual(
                    h.contains_point(Fraction(qx, DEN), Fraction(qy, DEN)),
                    "outside",
                )
                want_left, want_right = brute_tangent(active, qx, qy)
                got_left, got_right = h.tangent(
                    Fraction(qx, DEN), Fraction(qy, DEN)
                )
                self.assertEqual(
                    (got_left.id, got_right.id),
                    (want_left, want_right),
                    f"tangent mismatch at step {step}",
                )
                # 5. Point classification matches brute force.
                for _ in range(3):
                    rx = rng.randint(-84, 84)
                    ry = rng.randint(-84, 84)
                    want_cls = brute_classify(vert_coords, rx, ry)
                    got_cls = h.contains_point(
                        Fraction(rx, DEN), Fraction(ry, DEN)
                    )
                    self.assertEqual(got_cls, want_cls)

    def test_random_trials(self):
        rng = random.Random(20261003)
        for trial in range(4):
            with self.subTest(trial=trial):
                self.run_trial(rng, trial)


if __name__ == "__main__":
    unittest.main()
