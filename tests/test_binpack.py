import hashlib
import itertools
import json
import os
import random
import subprocess
import sys
import tempfile
import unittest

from binpack import core

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def brute_force_min_bins(items, bins):
    """Independent backtracking enumeration of the minimum bin count.

    For k = 1, 2, ... tries every assignment of items to k labelled bin
    copies and every insertion order, placing each rect at a corner point.
    Returns the minimum feasible k, or None if infeasible.
    """
    slots = [(bt.W, bt.H) for bt in bins for _ in range(bt.count)]
    items = list(items)
    n = len(items)
    if n == 0:
        return 0

    def fits(placed, x, y, w, h, W, H):
        if x + w > W or y + h > H:
            return False
        return all(
            not (x < px + pw and px < x + w and y < py + ph and py < y + h)
            for px, py, pw, ph in placed
        )

    def try_pack(order, assignment, chosen):
        bins_placed = [[] for _ in chosen]
        for idx in order:
            it = items[idx]
            b = assignment[idx]
            W, H = chosen[b]
            placed_rects = bins_placed[b]
            xs = {0} | {r[0] + r[2] for r in placed_rects}
            ys = {0} | {r[1] + r[3] for r in placed_rects}
            orientations = [(it.w, it.h)]
            if it.rotate and it.w != it.h:
                orientations.append((it.h, it.w))
            for x in sorted(xs):
                for y in sorted(ys):
                    for w, h in orientations:
                        if fits(placed_rects, x, y, w, h, W, H):
                            placed_rects.append((x, y, w, h))
                            break
                    else:
                        continue
                    break
                else:
                    continue
                break
            else:
                return False
        return True

    for k in range(1, min(n, len(slots)) + 1):
        for chosen in itertools.combinations(slots, k):
            for assignment in itertools.product(range(k), repeat=n):
                if set(assignment) != set(range(max(assignment) + 1)):
                    continue
                for order in itertools.permutations(range(n)):
                    if try_pack(order, assignment, chosen):
                        return k
    return None


class ExactBasicTests(unittest.TestCase):
    def test_a_four_items_need_two_bins(self):
        # 4 rects of 4x2 in 4x4 bins: exactly 2 per bin.
        items = core.parse_items(
            [{"id": f"i{d}", "w": 4, "h": 2, "rotate": False} for d in range(4)]
        )
        bins = core.parse_bins([{"id": "B", "W": 4, "H": 4, "count": 4}])

        status, placements, _ = core.exact(items, bins)
        self.assertEqual(status, "OK")
        exact_bins = len({p[0] for p in placements.values()})
        self.assertEqual(exact_bins, 2)

        ff_placements, _ = core.firstfit(items, bins)
        self.assertIsNotNone(ff_placements)
        firstfit_bins = len({p[0] for p in ff_placements.values()})
        self.assertEqual(firstfit_bins, 2)

    def test_b_rotation_required(self):
        bins = core.parse_bins([{"id": "B", "W": 2, "H": 3, "count": 1}])

        no_rot = core.parse_items([{"id": "a", "w": 3, "h": 2, "rotate": False}])
        status, _, _ = core.exact(no_rot, bins)
        self.assertEqual(status, "INFEASIBLE")

        rot = core.parse_items([{"id": "a", "w": 3, "h": 2, "rotate": True}])
        status, placements, _ = core.exact(rot, bins)
        self.assertEqual(status, "OK")
        self.assertEqual(placements["a"][3], True)  # placed rotated

    def test_c_area_65_too_large(self):
        items = core.parse_items([{"id": "big", "w": 65, "h": 1, "rotate": False}])
        bins = core.parse_bins([{"id": "B", "W": 65, "H": 1, "count": 1}])
        status, placements, _ = core.exact(items, bins)
        self.assertEqual(status, "TOO_LARGE")
        self.assertIsNone(placements)

    def test_too_many_items_too_large(self):
        items = core.parse_items(
            [{"id": i, "w": 1, "h": 1, "rotate": False} for i in range(11)]
        )
        bins = core.parse_bins([{"id": "B", "W": 4, "H": 4, "count": 11}])
        status, _, _ = core.exact(items, bins)
        self.assertEqual(status, "TOO_LARGE")

    def test_tie_break_prefers_smaller_bin_id(self):
        items = core.parse_items([{"id": "a", "w": 2, "h": 2, "rotate": False}])
        bins = core.parse_bins(
            [
                {"id": "Z", "W": 4, "H": 4, "count": 1},
                {"id": "A", "W": 4, "H": 4, "count": 1},
            ]
        )
        status, placements, slots = core.exact(items, bins)
        self.assertEqual(status, "OK")
        slot = placements["a"][0]
        self.assertEqual(slots[slot][0], "A")
        self.assertEqual(placements["a"][1:], (0, 0, False))

    def test_tie_break_smallest_placement_vector(self):
        # Two 2x2 items in one 4x4 bin: lexicographically smallest placement
        # vector packs them at (0,0) and (0,2) rather than (0,0) and (2,0)
        # because (0,2) < (2,0) in (x,y) order... x dominates: (0,2) < (2,0).
        items = core.parse_items(
            [{"id": "a", "w": 2, "h": 2}, {"id": "b", "w": 2, "h": 2}]
        )
        bins = core.parse_bins([{"id": "B", "W": 4, "H": 4, "count": 1}])
        status, placements, _ = core.exact(items, bins)
        self.assertEqual(status, "OK")
        self.assertEqual(placements["a"][1:3], (0, 0))
        self.assertEqual(placements["b"][1:3], (0, 2))

    def test_infeasible_when_nothing_fits(self):
        items = core.parse_items([{"id": "a", "w": 5, "h": 5}])
        bins = core.parse_bins([{"id": "B", "W": 4, "H": 4, "count": 2}])
        status, _, _ = core.exact(items, bins)
        self.assertEqual(status, "INFEASIBLE")
        placements, _ = core.firstfit(items, bins)
        self.assertIsNone(placements)


class ExactVsBruteForceTests(unittest.TestCase):
    def test_d_matches_backtracking_enumeration(self):
        rng = random.Random(20261001)
        for case in range(25):
            n = rng.randint(1, 5)
            items = [
                core.Item(
                    id=i,
                    w=rng.randint(1, 3),
                    h=rng.randint(1, 3),
                    rotate=rng.random() < 0.5,
                )
                for i in range(n)
            ]
            bins = [
                core.BinType(id="A", W=rng.randint(2, 4), H=rng.randint(2, 4), count=2),
                core.BinType(id="B", W=rng.randint(2, 3), H=rng.randint(2, 4), count=1),
            ]
            status, placements, _ = core.exact(items, bins)
            expected = brute_force_min_bins(items, bins)
            if expected is None:
                self.assertEqual(
                    status, "INFEASIBLE", f"case {case}: {items} {bins}"
                )
            else:
                self.assertEqual(status, "OK", f"case {case}: {items} {bins}")
                used = len({p[0] for p in placements.values()})
                self.assertEqual(used, expected, f"case {case}: {items} {bins}")


class CliTests(unittest.TestCase):
    def run_cli(self, items, bins, mode, extra_args=None):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        items_path = os.path.join(tmp.name, "items.json")
        bins_path = os.path.join(tmp.name, "bins.json")
        out_path = os.path.join(tmp.name, "plan.json")
        with open(items_path, "w") as fh:
            json.dump(items, fh)
        with open(bins_path, "w") as fh:
            json.dump(bins, fh)
        cmd = [
            sys.executable, "-m", "binpack", "pack", items_path,
            "--bins", bins_path, "--out", out_path, "--mode", mode,
        ]
        if extra_args:
            cmd.extend(extra_args)
        proc = subprocess.run(
            cmd, cwd=REPO_ROOT, capture_output=True, text=True
        )
        plan = None
        if os.path.exists(out_path):
            with open(out_path, "rb") as fh:
                plan = fh.read()
        return proc, plan, out_path

    def test_cli_exact_and_firstfit(self):
        items = [{"id": f"i{d}", "w": 4, "h": 2, "rotate": False} for d in range(4)]
        bins = [{"id": "B", "W": 4, "H": 4, "count": 4}]
        for mode in ("exact", "firstfit"):
            proc, raw, _ = self.run_cli(items, bins, mode)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            plan = json.loads(raw)
            self.assertEqual(plan["status"], "OK")
            self.assertEqual(len(plan["used_bins"]), 2)
            self.assertEqual(len(plan["placements"]), 4)

    def test_cli_too_large_exit_0(self):
        items = [{"id": "big", "w": 65, "h": 1}]
        bins = [{"id": "B", "W": 65, "H": 1, "count": 1}]
        proc, raw, _ = self.run_cli(items, bins, "exact")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(raw)["status"], "TOO_LARGE")

    def test_cli_infeasible_exit_0(self):
        items = [{"id": "a", "w": 5, "h": 5}]
        bins = [{"id": "B", "W": 4, "H": 4, "count": 1}]
        proc, raw, _ = self.run_cli(items, bins, "exact")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(raw)["status"], "INFEASIBLE")

    def test_e_exact_is_byte_deterministic(self):
        items = [
            {"id": f"i{d}", "w": 2 + d % 3, "h": 1 + d % 2, "rotate": d % 2 == 0}
            for d in range(6)
        ]
        bins = [
            {"id": "A", "W": 4, "H": 4, "count": 3},
            {"id": "B", "W": 3, "H": 5, "count": 2},
        ]
        hashes = set()
        for _ in range(5):
            proc, raw, _ = self.run_cli(items, bins, "exact")
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(json.loads(raw)["status"], "OK")
            hashes.add(hashlib.sha256(raw).hexdigest())
        self.assertEqual(len(hashes), 1)

    def test_error_exit_code_2(self):
        bad_cases = [
            ([{"id": "a", "w": 0, "h": 2}], [{"id": "B", "W": 4, "H": 4, "count": 1}], "exact"),
            ([{"id": "a", "w": 2, "h": -1}], [{"id": "B", "W": 4, "H": 4, "count": 1}], "exact"),
            ([{"id": "a", "w": 2, "h": 2}], [{"id": "B", "W": 0, "H": 4, "count": 1}], "exact"),
            ([{"id": "a", "w": 2, "h": 2}], [{"id": "B", "W": 4, "H": 4, "count": -1}], "exact"),
            ([{"id": "a", "w": 2, "h": 2}], [{"id": "B", "W": 4, "H": 4, "count": 1}], "bogus"),
        ]
        for items, bins, mode in bad_cases:
            proc, raw, _ = self.run_cli(items, bins, mode)
            self.assertEqual(proc.returncode, 2, (items, bins, mode, proc.stderr))
            self.assertIsNone(raw)


if __name__ == "__main__":
    unittest.main()
