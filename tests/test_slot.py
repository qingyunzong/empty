import json
import random
import subprocess
import sys
import unittest

from slot import BAD_INPUT, BAD_SLOT, SlotError, find_slots


def oracle_minutes(busy, d, s, e, prefer):
    """Brute-force minute-by-minute reference implementation."""
    free_minutes = []
    for minute in range(s, e):
        if all(not (a <= minute < b) for person in busy for a, b in person):
            free_minutes.append(minute)

    runs = []
    for minute in free_minutes:
        if runs and minute == runs[-1][1]:
            runs[-1][1] += 1
        else:
            runs.append([minute, minute + 1])

    feasible = [tuple(run) for run in runs if run[1] - run[0] >= d]
    if not feasible:
        return {"status": "none", "slots": []}

    prefer_minutes = set()
    for a, b in prefer:
        prefer_minutes.update(range(a, b))

    def score(slot):
        return sum(1 for m in range(slot[0], slot[1]) if m in prefer_minutes)

    best = max(score(slot) for slot in feasible)
    tied = sorted(slot for slot in feasible if score(slot) == best)
    return {"status": "ok", "slots": [[a, b] for a, b in tied]}


class TestFindSlots(unittest.TestCase):
    def test_tied_best_slots_all_returned(self):
        # Two free intervals [0,4) and [6,10), each overlapping prefer by 2.
        result = find_slots(
            busy=[[[4, 6]]],
            d=1,
            window=[0, 10],
            prefer=[[0, 2], [7, 9]],
        )
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["slots"], [[0, 4], [6, 10]])

    def test_overlapping_prefer_counted_once(self):
        # Slot A [0,8): prefer [[0,5],[3,8]] overlaps itself on [3,5).
        # True score 8; double-counting would give 11 and wrongly beat B.
        # Slot B [10,20): score 10. Correct winner is B only.
        result = find_slots(
            busy=[[[8, 10]]],
            d=1,
            window=[0, 20],
            prefer=[[0, 5], [3, 8], [10, 20]],
        )
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["slots"], [[10, 20]])

    def test_busy_edge_allows_immediate_start(self):
        # Busy ends exactly at window start; slot must begin at s.
        result = find_slots(busy=[[[5, 10]]], d=5, window=[10, 20])
        self.assertEqual(result, {"status": "ok", "slots": [[10, 20]]})
        # Busy starts exactly at window end; slot must end at e.
        result = find_slots(busy=[[[20, 30]]], d=5, window=[10, 20])
        self.assertEqual(result, {"status": "ok", "slots": [[10, 20]]})
        # Adjacent busy intervals inside the window leave no gap.
        result = find_slots(busy=[[[0, 5], [5, 10]]], d=1, window=[0, 10])
        self.assertEqual(result["status"], "none")

    def test_no_feasible_slot_returns_none(self):
        result = find_slots(busy=[[[0, 6]]], d=5, window=[0, 10])
        self.assertEqual(result, {"status": "none", "slots": []})
        # Fully busy window.
        result = find_slots(busy=[[[0, 10]], [[3, 7]]], d=1, window=[0, 10])
        self.assertEqual(result, {"status": "none", "slots": []})

    def test_multiple_people_union(self):
        busy = [[[0, 10], [40, 60]], [[5, 20]], [[55, 70]]]
        result = find_slots(busy=busy, d=15, window=[0, 100])
        # Common free: [20,40) len 20 and [70,100) len 30, both feasible.
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["slots"], [[20, 40], [70, 100]])

    def test_tie_break_prefers_earlier_and_shorter(self):
        # Three free slots, scores 1, 1, 2 -> only the score-2 slot wins.
        result = find_slots(
            busy=[[[3, 4], [8, 9]]],
            d=1,
            window=[0, 12],
            prefer=[[0, 1], [4, 5], [9, 12]],
        )
        self.assertEqual(result["slots"], [[9, 12]])

    def test_error_d_non_positive(self):
        for bad in (0, -3):
            with self.assertRaises(SlotError) as ctx:
                find_slots(busy=[], d=bad, window=[0, 10])
            self.assertEqual(ctx.exception.code, BAD_SLOT)

    def test_error_window_inverted(self):
        for window in ([10, 10], [20, 10]):
            with self.assertRaises(SlotError) as ctx:
                find_slots(busy=[], d=1, window=window)
            self.assertEqual(ctx.exception.code, BAD_SLOT)

    def test_error_inverted_intervals(self):
        with self.assertRaises(SlotError) as ctx:
            find_slots(busy=[[[10, 5]]], d=1, window=[0, 20])
        self.assertEqual(ctx.exception.code, BAD_SLOT)
        with self.assertRaises(SlotError) as ctx:
            find_slots(busy=[], d=1, window=[0, 20], prefer=[[9, 2]])
        self.assertEqual(ctx.exception.code, BAD_SLOT)

    def test_error_malformed_input_is_bad_input(self):
        with self.assertRaises(SlotError) as ctx:
            find_slots(busy=[[[0]]], d=1, window=[0, 10])
        self.assertEqual(ctx.exception.code, BAD_INPUT)
        with self.assertRaises(SlotError) as ctx:
            find_slots(busy=[], d="x", window=[0, 10])
        self.assertEqual(ctx.exception.code, BAD_INPUT)

    def test_random_three_people_against_minute_oracle(self):
        rng = random.Random(20260927)
        for trial in range(300):
            s = rng.randint(0, 5)
            e = s + rng.randint(8, 48)
            busy = []
            for _ in range(3):
                person = []
                for _ in range(rng.randint(0, 4)):
                    a = rng.randint(s - 5, e)
                    b = a + rng.randint(0, 10)
                    person.append([a, b])
                busy.append(person)
            prefer = []
            for _ in range(rng.randint(0, 3)):
                a = rng.randint(s - 5, e)
                b = a + rng.randint(0, 12)
                prefer.append([a, b])
            d = rng.randint(1, 12)
            expected = oracle_minutes(busy, d, s, e, prefer)
            got = find_slots(busy, d, [s, e], prefer)
            self.assertEqual(
                got,
                expected,
                msg=f"trial {trial}: busy={busy} d={d} window=[{s},{e}) prefer={prefer}",
            )


class TestCli(unittest.TestCase):
    def run_cli(self, payload):
        proc = subprocess.run(
            [sys.executable, "-m", "slot.cli"],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
        )
        return proc.returncode, json.loads(proc.stdout)

    def test_cli_ok_with_ties(self):
        code, out = self.run_cli(
            {
                "busy": [[[4, 6]]],
                "d": 1,
                "window": [0, 10],
                "prefer": [[0, 2], [7, 9]],
            }
        )
        self.assertEqual(code, 0)
        self.assertEqual(out, {"status": "ok", "slots": [[0, 4], [6, 10]]})

    def test_cli_none(self):
        code, out = self.run_cli({"busy": [[[0, 10]]], "d": 5, "window": [0, 10]})
        self.assertEqual(code, 0)
        self.assertEqual(out, {"status": "none", "slots": []})

    def test_cli_bad_slot_exit_2(self):
        for payload in (
            {"busy": [], "d": 0, "window": [0, 10]},
            {"busy": [], "d": 1, "window": [10, 10]},
            {"busy": [[[9, 3]]], "d": 1, "window": [0, 10]},
            {"busy": [], "d": 1, "window": [0, 10], "prefer": [[8, 8.5, 9]]},
        ):
            code, out = self.run_cli(payload)
            self.assertEqual(code, 2, msg=out)
            self.assertIn(out["error"]["code"], (BAD_SLOT, BAD_INPUT))

    def test_cli_bad_slot_code_exact(self):
        code, out = self.run_cli({"busy": [], "d": -1, "window": [0, 10]})
        self.assertEqual(code, 2)
        self.assertEqual(out["error"]["code"], BAD_SLOT)

    def test_cli_invalid_json_exit_2(self):
        proc = subprocess.run(
            [sys.executable, "-m", "slot.cli"],
            input="not json",
            capture_output=True,
            text=True,
        )
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(json.loads(proc.stdout)["error"]["code"], BAD_INPUT)


if __name__ == "__main__":
    unittest.main()
