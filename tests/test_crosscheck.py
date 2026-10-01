"""Acceptance test D: cross-check finish_t and starved against an
independently written per-event reference simulator."""

import random
import unittest
from collections import Counter, defaultdict
from fractions import Fraction

from fairq import simulate

STARVE_WINDOW = 100


def reference_simulate(events):
    """Independent re-implementation used only by this test.

    Returns (finish_times, starved_ids, units_per_tick_and_flow).
    """
    order = {"submit": 0, "capacity": 1, "tick": 2}
    indexed = list(enumerate(events))
    indexed.sort(
        key=lambda p: (
            p[1]["t"],
            order[p[1]["type"]],
            p[1].get("flow", 0),
            p[0],
        )
    )
    capacity = 1
    flows = {}
    finish = {}
    served_times = defaultdict(list)
    ticks = []
    for _, ev in indexed:
        t = ev["t"]
        if ev["type"] == "submit":
            flows[ev["flow"]] = {
                "left": ev["size"],
                "w": max(1, ev["prio"]),
                "got": 0,
                "born": t,
            }
            if ev["size"] == 0:
                finish[ev["flow"]] = t
        elif ev["type"] == "capacity":
            capacity = ev["c"]
        else:
            ticks.append(t)
            for _ in range(capacity):
                ready = [
                    fid
                    for fid, st in flows.items()
                    if st["left"] > 0 and st["born"] < t
                ]
                if not ready:
                    break
                pick = min(
                    ready,
                    key=lambda fid: (Fraction(flows[fid]["got"], flows[fid]["w"]), fid),
                )
                st = flows[pick]
                st["got"] += 1
                st["left"] -= 1
                served_times[pick].append(t)
                if st["left"] == 0:
                    finish[pick] = t

    starved = set()
    last_t = ticks[-1] if ticks else None
    for fid, st in flows.items():
        marks = [st["born"]] + served_times[fid]
        ends = served_times[fid] + [finish.get(fid, last_t)]
        for a, b in zip(marks, ends):
            if b is not None and b - a > STARVE_WINDOW:
                starved.add(fid)

    units = {}
    for fid, times in served_times.items():
        for t, n in Counter(times).items():
            units[(t, fid)] = n
    return finish, starved, units


def make_scenario(rng):
    """Random scenario: n<=6 flows, 20 ticks, non-decreasing input times."""
    n = rng.randint(1, 6)
    flow_ids = rng.sample(range(1, 20), n)
    events = []
    for fid in flow_ids:
        events.append(
            {
                "type": "submit",
                "t": rng.randint(0, 5),
                "flow": fid,
                "size": rng.randint(0, 8),
                "prio": rng.randint(-1, 4),
            }
        )
    if rng.random() < 0.5:
        events.append(
            {"type": "capacity", "t": rng.randint(0, 2), "c": rng.randint(1, 3)}
        )
    if rng.random() < 0.5:
        tick_times = list(range(1, 21))
    else:
        # tick desert: forces starvation gaps beyond W=100
        tick_times = list(range(1, 11)) + list(range(200, 210))
    events += [{"type": "tick", "t": t} for t in tick_times]
    # Legal input order: non-decreasing t, arbitrary order within same t.
    by_t = defaultdict(list)
    for ev in events:
        by_t[ev["t"]].append(ev)
    ordered = []
    for t in sorted(by_t):
        group = by_t[t]
        rng.shuffle(group)
        ordered.extend(group)
    return ordered


class TestDCrossCheck(unittest.TestCase):
    def test_finish_times_and_starved_match_reference(self):
        for seed in range(60):
            rng = random.Random(seed)
            events = make_scenario(rng)
            with self.subTest(seed=seed):
                result, _ = simulate(events)
                exp_finish, exp_starved, exp_units = reference_simulate(events)

                got_finish = {f["flow"]: f["finish_t"] for f in result["flows"]}
                want_finish = {
                    f["flow"]: exp_finish.get(f["flow"]) for f in result["flows"]
                }
                self.assertEqual(got_finish, want_finish)
                self.assertEqual(set(result["starved"]), exp_starved)

                got_units = {(s["t"], s["flow"]): s["units"] for s in result["service"]}
                self.assertEqual(got_units, exp_units)

    def test_starvation_actually_observed(self):
        # Guard against a trivially-passing cross-check: at least one seed
        # must produce a non-empty starved set in both simulators.
        seen = False
        for seed in range(60):
            events = make_scenario(random.Random(seed))
            result, _ = simulate(events)
            if result["starved"]:
                seen = True
                break
        self.assertTrue(seen, "no scenario produced a starved flow")


if __name__ == "__main__":
    unittest.main()
