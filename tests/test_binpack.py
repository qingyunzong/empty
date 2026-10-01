"""Acceptance tests for the binpack CLI and core algorithms."""

from __future__ import annotations

import itertools
import json
import random
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from binpack.core import (BinType, Item, pack, pack_exact, pack_firstfit,
                          parse_bins, parse_items, InputError)


def run_cli(items, bins, mode, out_dir):
    items_path = Path(out_dir) / "items.json"
    bins_path = Path(out_dir) / "bins.json"
    out_path = Path(out_dir) / "plan.json"
    items_path.write_text(json.dumps(items))
    bins_path.write_text(json.dumps(bins))
    proc = subprocess.run(
        [sys.executable, "-m", "binpack", "pack", str(items_path),
         "--bins", str(bins_path), "--out", str(out_path), "--mode", mode],
        cwd=ROOT, capture_output=True, text=True)
    plan = json.loads(out_path.read_text()) if out_path.exists() else None
    return proc.returncode, plan


def assert_no_overlap(testcase, plan, bins):
    dims = {b["id"]: (b["W"], b["H"]) for b in bins}
    rects = []
    for p in plan["placements"]:
        W, H = dims[p["bin"]]
        testcase.assertLessEqual(p["x"] + p["w"], W)
        testcase.assertLessEqual(p["y"] + p["h"], H)
        rects.append((p["bin"], p["copy"], p["x"], p["y"], p["w"], p["h"]))
    for r1, r2 in itertools.combinations(rects, 2):
        if (r1[0], r1[1]) != (r2[0], r2[1]):
            continue
        _, _, x1, y1, w1, h1 = r1
        _, _, x2, y2, w2, h2 = r2
        testcase.assertTrue(
            x1 + w1 <= x2 or x2 + w2 <= x1 or y1 + h1 <= y2 or y2 + h2 <= y1,
            f"overlap: {r1} vs {r2}")


class TestAExactVsFirstfit(unittest.TestCase):
    """A: 4 items needing exactly 2 bins; exact and firstfit differ."""

    ITEMS = [
        {"id": "a", "w": 2, "h": 2, "rotate": False},
        {"id": "b", "w": 4, "h": 4, "rotate": False},
        {"id": "c", "w": 4, "h": 1, "rotate": False},
        {"id": "d", "w": 2, "h": 4, "rotate": False},
    ]
    BINS = [{"id": "B", "W": 4, "H": 5, "count": 4}]

    def test_exact_uses_two_bins(self):
        plan = pack(parse_items(self.ITEMS), parse_bins(self.BINS), "exact")
        self.assertEqual(plan["status"], "OK")
        self.assertEqual(len(plan["used_bins"]), 2)
        assert_no_overlap(self, plan, self.BINS)

    def test_firstfit_uses_three_bins(self):
        # Same input: firstfit's greedy lex-first choices spread the items
        # over 3 bins, demonstrating the strict exact/heuristic split.
        plan = pack(parse_items(self.ITEMS), parse_bins(self.BINS), "firstfit")
        self.assertEqual(plan["status"], "OK")
        self.assertEqual(len(plan["used_bins"]), 3)
        assert_no_overlap(self, plan, self.BINS)

    def test_cli_both_modes(self):
        with tempfile.TemporaryDirectory() as d:
            code, plan = run_cli(self.ITEMS, self.BINS, "exact", d)
            self.assertEqual(code, 0)
            self.assertEqual(plan["status"], "OK")
            self.assertEqual(len(plan["used_bins"]), 2)
            code, plan = run_cli(self.ITEMS, self.BINS, "firstfit", d)
            self.assertEqual(code, 0)
            self.assertEqual(plan["status"], "OK")
            self.assertEqual(len(plan["used_bins"]), 3)


class TestBRotation(unittest.TestCase):
    """B: rotate=false fails, rotate=true succeeds."""

    BINS = [{"id": "B", "W": 2, "H": 3, "count": 1}]

    def test_no_rotate_infeasible(self):
        items = [{"id": "a", "w": 3, "h": 1, "rotate": False}]
        for mode in ("exact", "firstfit"):
            plan = pack(parse_items(items), parse_bins(self.BINS), mode)
            self.assertEqual(plan["status"], "INFEASIBLE", mode)

    def test_rotate_feasible(self):
        items = [{"id": "a", "w": 3, "h": 1, "rotate": True}]
        for mode in ("exact", "firstfit"):
            plan = pack(parse_items(items), parse_bins(self.BINS), mode)
            self.assertEqual(plan["status"], "OK", mode)
            self.assertEqual(len(plan["used_bins"]), 1)
            p = plan["placements"][0]
            self.assertTrue(p["rotated"])
            self.assertEqual((p["w"], p["h"]), (1, 3))
            assert_no_overlap(self, plan, self.BINS)


class TestCTooLarge(unittest.TestCase):
    """C: total area 65 triggers TOO_LARGE in exact mode."""

    def test_area_65_too_large(self):
        items = [{"id": "big", "w": 13, "h": 5, "rotate": False}]
        bins = [{"id": "B", "W": 20, "H": 20, "count": 1}]
        plan = pack(parse_items(items), parse_bins(bins), "exact")
        self.assertEqual(plan["status"], "TOO_LARGE")

    def test_area_65_firstfit_still_runs(self):
        # TOO_LARGE only applies to exact; firstfit is a heuristic and packs.
        items = [{"id": "big", "w": 13, "h": 5, "rotate": False}]
        bins = [{"id": "B", "W": 20, "H": 20, "count": 1}]
        plan = pack(parse_items(items), parse_bins(bins), "firstfit")
        self.assertEqual(plan["status"], "OK")

    def test_more_than_10_items_too_large(self):
        items = [{"id": f"i{i}", "w": 1, "h": 1, "rotate": False}
                 for i in range(11)]
        bins = [{"id": "B", "W": 4, "H": 4, "count": 2}]
        plan = pack(parse_items(items), parse_bins(bins), "exact")
        self.assertEqual(plan["status"], "TOO_LARGE")


def brute_force_min_bins(items, bins):
    """Independent reference: exhaustive backtracking over every integer
    position of every bin copy; returns the minimal feasible bin count."""
    copies = [(b.id, c, b.W, b.H)
              for b in sorted(bins, key=lambda b: b.id)
              for c in range(b.count)]
    total_area = sum(i.w * i.h for i in items)

    def orientations(it):
        dims = {(it.w, it.h)}
        if it.rotate:
            dims.add((it.h, it.w))
        return dims

    def try_pack(k):
        for combo in itertools.combinations(range(len(copies)), k):
            if sum(copies[i][2] * copies[i][3] for i in combo) < total_area:
                continue
            placed = [[] for _ in combo]

            def rec(idx):
                if idx == len(items):
                    return True
                it = items[idx]
                for slot, ci in enumerate(combo):
                    _, _, W, H = copies[ci]
                    for (w, h) in orientations(it):
                        for x in range(0, W - w + 1):
                            for y in range(0, H - h + 1):
                                ok = all(
                                    x + w <= px or px + pw <= x or
                                    y + h <= py or py + ph <= y
                                    for (px, py, pw, ph) in placed[slot])
                                if ok:
                                    placed[slot].append((x, y, w, h))
                                    if rec(idx + 1):
                                        return True
                                    placed[slot].pop()
                return False

            if rec(0):
                return k
        return None

    for k in range(1, min(len(copies), len(items)) + 1):
        if try_pack(k):
            return k
    return None


class TestDExactMatchesBruteForce(unittest.TestCase):
    """D: exact bin count matches an independent brute-force enumerator
    on random small cases (items <= 8)."""

    def test_random_small_cases(self):
        rng = random.Random(20261001)
        cases = 0
        trials = 0
        while cases < 12 and trials < 4000:
            trials += 1
            n_bins = rng.randint(1, 2)
            bins = []
            for bi in range(n_bins):
                bins.append(BinType(id=f"B{bi}",
                                    W=rng.randint(2, 4),
                                    H=rng.randint(2, 4),
                                    count=rng.randint(1, 2)))
            n_items = rng.randint(1, 8)
            items = []
            for ii in range(n_items):
                items.append(Item(id=f"i{ii}",
                                  w=rng.randint(1, 3),
                                  h=rng.randint(1, 3),
                                  rotate=rng.random() < 0.3))
            area = sum(i.w * i.h for i in items)
            if area > 64:
                continue
            capacity = sum(b.W * b.H * b.count for b in bins)
            if capacity > 40:  # keep the brute force cheap
                continue
            expected = brute_force_min_bins(items, bins)
            plan = pack_exact(items, bins)
            if expected is None:
                self.assertEqual(plan["status"], "INFEASIBLE",
                                 f"items={items} bins={bins}")
            else:
                self.assertEqual(plan["status"], "OK",
                                 f"items={items} bins={bins}")
                self.assertEqual(len(plan["used_bins"]), expected,
                                 f"items={items} bins={bins}")
            cases += 1
        self.assertGreaterEqual(cases, 12)


class TestEDeterminism(unittest.TestCase):
    """E: identical exact input -> byte-identical plan, 5 repetitions."""

    ITEMS = [
        {"id": "a", "w": 2, "h": 2, "rotate": True},
        {"id": "b", "w": 4, "h": 4, "rotate": False},
        {"id": "c", "w": 4, "h": 1, "rotate": False},
        {"id": "d", "w": 2, "h": 4, "rotate": True},
    ]
    BINS = [{"id": "B", "W": 4, "H": 5, "count": 4},
            {"id": "A", "W": 3, "H": 3, "count": 2}]

    def test_five_identical_runs(self):
        payloads = []
        for _ in range(5):
            with tempfile.TemporaryDirectory() as d:
                code, _ = run_cli(self.ITEMS, self.BINS, "exact", d)
                self.assertEqual(code, 0)
                payloads.append((Path(d) / "plan.json").read_bytes())
        for payload in payloads[1:]:
            self.assertEqual(payload, payloads[0])


class TestValidation(unittest.TestCase):
    """Bad dimensions / count / mode -> exit code 2."""

    GOOD_ITEMS = [{"id": "a", "w": 1, "h": 1, "rotate": False}]
    GOOD_BINS = [{"id": "B", "W": 2, "H": 2, "count": 1}]

    def _assert_exit2(self, items, bins, mode="exact"):
        with tempfile.TemporaryDirectory() as d:
            code, plan = run_cli(items, bins, mode, d)
            self.assertEqual(code, 2)
            self.assertIsNone(plan)

    def test_zero_width(self):
        self._assert_exit2([{"id": "a", "w": 0, "h": 1}], self.GOOD_BINS)

    def test_negative_height(self):
        self._assert_exit2([{"id": "a", "w": 1, "h": -2}], self.GOOD_BINS)

    def test_zero_bin_dimension(self):
        self._assert_exit2(self.GOOD_ITEMS,
                           [{"id": "B", "W": 0, "H": 2, "count": 1}])

    def test_negative_count(self):
        self._assert_exit2(self.GOOD_ITEMS,
                           [{"id": "B", "W": 2, "H": 2, "count": -1}])

    def test_invalid_mode(self):
        self._assert_exit2(self.GOOD_ITEMS, self.GOOD_BINS, mode="bestfit")

    def test_parse_errors_raise_input_error(self):
        with self.assertRaises(InputError):
            parse_items([{"id": "a", "w": 0, "h": 1}])
        with self.assertRaises(InputError):
            parse_bins([{"id": "B", "W": 1, "H": 1, "count": -1}])


class TestTieBreakDeterminism(unittest.TestCase):
    """Exact tie-break: smallest bin-id sequence, then smallest placement."""

    def test_prefers_smaller_bin_id_sequence(self):
        # One 2x2 item fits in either bin type; exact must pick id "A".
        items = [Item("a", 2, 2, False)]
        bins = [BinType("Z", 2, 2, 1), BinType("A", 2, 2, 1)]
        plan = pack_exact(items, bins)
        self.assertEqual(plan["status"], "OK")
        self.assertEqual(plan["used_bins"], [{"id": "A", "copy": 0}])
        self.assertEqual(plan["placements"][0]["bin"], "A")

    def test_placement_lexicographic_minimum(self):
        # Two 1x1 items in one 2x2 bin: minimal placement is
        # a@(0,0), b@(0,1) under (x, y) lexicographic position order.
        items = [Item("a", 1, 1, False), Item("b", 1, 1, False)]
        bins = [BinType("B", 2, 2, 1)]
        plan = pack_exact(items, bins)
        self.assertEqual(plan["status"], "OK")
        coords = [(p["item"], p["x"], p["y"]) for p in plan["placements"]]
        self.assertEqual(coords, [("a", 0, 0), ("b", 0, 1)])


if __name__ == "__main__":
    unittest.main()
