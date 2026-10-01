import json
import os
import random
import subprocess
import sys
import tempfile
import unittest

from ticketpool import serve

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def reference_serve(cfg, stream):
    """Independent event-loop implementation (advance event to event).

    Used only to cross-check the tick-driven simulator in ticketpool.sim.
    """
    workers = cfg["workers"]
    step = cfg["aging_step"]
    boost = cfg["boost"]
    quota = cfg["base_quota"]

    def id_order(value):
        return (0, value, "") if isinstance(value, int) else (1, 0, str(value))

    pending = [
        {
            "id": t["id"],
            "group": t["group"],
            "arrival": t["arrival"],
            "cost": t["cost"],
            "base": t.get("priority", 0),
        }
        for t in stream
    ]
    waiting = []
    running = []  # each has free_tick = first tick the worker is reusable
    done = []
    tick = 0
    while pending or waiting or running:
        done.extend(r for r in running if r["free_tick"] <= tick)
        running = [r for r in running if r["free_tick"] > tick]
        while pending and pending[0]["arrival"] <= tick:
            waiting.append(pending.pop(0))

        usage = {}
        for r in running:
            usage[r["group"]] = usage.get(r["group"], 0) + 1
        free = workers - len(running)
        while free > 0:
            best = None
            best_key = None
            for w in waiting:
                if usage.get(w["group"], 0) >= quota[w["group"]]:
                    continue
                eff = w["base"] + boost * ((tick - w["arrival"]) // step)
                key = (-eff, w["arrival"], id_order(w["id"]))
                if best_key is None or key < best_key:
                    best_key = key
                    best = w
            if best is None:
                break
            waiting.remove(best)
            running.append(
                {
                    "id": best["id"],
                    "group": best["group"],
                    "arrival": best["arrival"],
                    "start": tick,
                    "end": tick + best["cost"] - 1,
                    "free_tick": tick + best["cost"],
                }
            )
            usage[best["group"]] = usage.get(best["group"], 0) + 1
            free -= 1

        future = [p["arrival"] for p in pending] + [r["free_tick"] for r in running]
        if not future:
            break
        tick = min(future)

    out = {r["id"]: (r["start"], r["end"], r["start"] - r["arrival"]) for r in done}
    return out


def run_cli(cfg, stream, out_path):
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(cfg, fh)
        cfg_path = fh.name
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(stream, fh)
        stream_path = fh.name
    try:
        proc = subprocess.run(
            [sys.executable, "-m", "ticketpool", "serve", cfg_path, stream_path,
             "--out", out_path],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )
    finally:
        os.unlink(cfg_path)
        os.unlink(stream_path)
    return proc


class TestAlternation(unittest.TestCase):
    """A: single worker, two groups with quota 1:1 -> exact alternation."""

    def test_exact_alternation(self):
        cfg = {"workers": 1, "aging_step": 1, "boost": 1,
               "base_quota": {"A": 1, "B": 1}}
        stream = [
            {"id": i, "arrival": 0, "cost": 1, "group": "A" if i % 2 == 1 else "B"}
            for i in range(1, 7)
        ]
        result = serve(cfg, stream)
        by_id = {t["id"]: t for t in result["tickets"]}
        for i in range(1, 7):
            self.assertEqual(by_id[i]["start"], i - 1)
            self.assertEqual(by_id[i]["end"], i - 1)
            self.assertEqual(by_id[i]["waits"], i - 1)
        groups_in_order = [
            next(t["group"] for t in result["tickets"] if t["start"] == s)
            for s in range(6)
        ]
        self.assertEqual(groups_in_order, ["A", "B", "A", "B", "A", "B"])


class TestAgingBoost(unittest.TestCase):
    """B: an old low-priority ticket overtakes newer high-priority ones."""

    def test_aging_overtake(self):
        cfg = {"workers": 1, "aging_step": 1, "boost": 3,
               "base_quota": {"g": 4}}
        stream = [
            {"id": "old", "arrival": 0, "cost": 1, "group": "g", "priority": 0},
            {"id": "h1", "arrival": 0, "cost": 1, "group": "g", "priority": 5},
            {"id": "h2", "arrival": 1, "cost": 1, "group": "g", "priority": 5},
            {"id": "h3", "arrival": 2, "cost": 1, "group": "g", "priority": 5},
        ]
        result = serve(cfg, stream)
        by_id = {t["id"]: t for t in result["tickets"]}
        self.assertEqual(by_id["h1"]["start"], 0)
        self.assertEqual(by_id["h2"]["start"], 1)
        # At tick 2: old has effective priority 6 > h3's 5 -> aging wins.
        self.assertEqual(by_id["old"]["start"], 2)
        self.assertEqual(by_id["h3"]["start"], 3)
        self.assertEqual(by_id["old"]["waits"], 2)


class TestNoStarvation(unittest.TestCase):
    """C: high-arrival-rate group cannot starve a finite stream."""

    def test_finite_stream_all_complete_bounded(self):
        cfg = {"workers": 2, "aging_step": 2, "boost": 3,
               "base_quota": {"bulk": 1, "burst": 1}}
        stream = []
        for i in range(50):
            stream.append({"id": f"bulk-{i}", "arrival": i, "cost": 3,
                           "group": "bulk", "priority": 0})
        for i in range(10):
            stream.append({"id": f"burst-{i}", "arrival": 5 * i, "cost": 1,
                           "group": "burst", "priority": 1})
        stream.sort(key=lambda t: t["arrival"])
        result = serve(cfg, stream)
        tickets = result["tickets"]
        self.assertEqual(len(tickets), 60)
        self.assertEqual(result["summary"]["completed"], 60)
        max_arrival = max(t["arrival"] for t in stream)
        total_cost = sum(t["cost"] for t in stream)
        worst = max(t["end"] for t in tickets)
        # Finite stream + finite costs => bounded completion.
        self.assertLessEqual(worst, max_arrival + total_cost)
        # Every ticket waited a finite, recorded number of ticks.
        for t in tickets:
            self.assertGreaterEqual(t["waits"], 0)
            self.assertEqual(t["waits"], t["start"] - t["arrival"])


class TestReferenceCrossCheck(unittest.TestCase):
    """D: <=8 tickets, 2 workers, tick sim vs independent event loop."""

    def test_random_cross_check(self):
        rng = random.Random(20261001)
        for case in range(300):
            groups = ["g0", "g1", "g2"][: rng.randint(1, 3)]
            cfg = {
                "workers": 2,
                "aging_step": rng.randint(1, 3),
                "boost": rng.randint(0, 3),
                "base_quota": {g: rng.randint(1, 2) for g in groups},
            }
            n = rng.randint(1, 8)
            arrivals = sorted(rng.randint(0, 6) for _ in range(n))
            ids = rng.sample(range(100), n)
            stream = [
                {
                    "id": ids[i],
                    "arrival": arrivals[i],
                    "cost": rng.randint(1, 4),
                    "group": rng.choice(groups),
                    "priority": rng.randint(0, 3),
                }
                for i in range(n)
            ]
            got = serve(cfg, stream)
            got_map = {t["id"]: (t["start"], t["end"], t["waits"])
                       for t in got["tickets"]}
            want = reference_serve(cfg, stream)
            self.assertEqual(got_map, want, f"case {case}: {cfg} {stream}")


class TestDeterminism(unittest.TestCase):
    """E: identical input -> byte-identical output across 5 runs."""

    def test_five_runs_byte_identical(self):
        cfg = {"workers": 2, "aging_step": 2, "boost": 3,
               "base_quota": {"api": 1, "batch": 1}}
        stream = [
            {"id": f"t{i}", "arrival": i // 2, "cost": (i % 3) + 1,
             "group": "api" if i % 2 else "batch", "priority": i % 2}
            for i in range(12)
        ]
        outputs = []
        with tempfile.TemporaryDirectory() as tmp:
            for run in range(5):
                out_path = os.path.join(tmp, f"served-{run}.json")
                proc = run_cli(cfg, stream, out_path)
                self.assertEqual(proc.returncode, 0, proc.stderr)
                with open(out_path, "rb") as fh:
                    outputs.append(fh.read())
        for other in outputs[1:]:
            self.assertEqual(outputs[0], other)


class TestValidationErrors(unittest.TestCase):
    """Unknown group / cost<=0 / non-monotone arrival -> exit code 2."""

    def _expect_exit_2(self, cfg, stream):
        with tempfile.TemporaryDirectory() as tmp:
            proc = run_cli(cfg, stream, os.path.join(tmp, "out.json"))
        self.assertEqual(proc.returncode, 2, proc.stderr)
        self.assertIn("error:", proc.stderr)

    def test_unknown_group(self):
        cfg = {"workers": 1, "aging_step": 1, "boost": 1, "base_quota": {"a": 1}}
        stream = [{"id": 1, "arrival": 0, "cost": 1, "group": "nope"}]
        self._expect_exit_2(cfg, stream)

    def test_non_positive_cost(self):
        cfg = {"workers": 1, "aging_step": 1, "boost": 1, "base_quota": {"a": 1}}
        stream = [{"id": 1, "arrival": 0, "cost": 0, "group": "a"}]
        self._expect_exit_2(cfg, stream)

    def test_decreasing_arrival(self):
        cfg = {"workers": 1, "aging_step": 1, "boost": 1, "base_quota": {"a": 1}}
        stream = [
            {"id": 1, "arrival": 3, "cost": 1, "group": "a"},
            {"id": 2, "arrival": 2, "cost": 1, "group": "a"},
        ]
        self._expect_exit_2(cfg, stream)


if __name__ == "__main__":
    unittest.main()
