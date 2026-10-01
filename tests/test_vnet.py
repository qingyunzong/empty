import itertools
import json
import os
import tempfile
import unittest

from msdeliv import vnet
from msdeliv.frames import message_frames


def unique_permutations(frames):
    return set(itertools.permutations(frames))


def check_all(schedules, mod, window, capacity=None, prefix=()):
    checked = 0
    for sched in schedules:
        mismatches = vnet.compare(list(sched), mod, window, capacity, prefix)
        if mismatches:
            minimal = vnet.minimize_failing(
                list(sched),
                lambda s: bool(vnet.compare(s, mod, window, capacity, prefix)),
            )
            doc = {
                "mod": mod,
                "window": window,
                "capacity": capacity,
                "prefix": [f.to_dict() for f in prefix],
                "schedule": [f.to_dict() for f in minimal],
            }
            raise AssertionError(
                "engine/reference divergence; minimal replayable schedule:\n"
                + json.dumps(doc, indent=1)
            )
        checked += 1
    return checked


class TestEnumeration(unittest.TestCase):
    def test_fragmented_schedules_with_duplicate(self):
        mod, window, capacity = 16, 4, 2
        frames = (
            message_frames("s", 0, 0, "aaa", frags=2)
            + message_frames("s", 0, 1, "b")
            + message_frames("s", 0, 2, "c")
            + message_frames("s", 0, 3, "d")
        )
        frames.append(frames[2])  # duplicate of message 1
        checked = check_all(unique_permutations(frames), mod, window, capacity)
        self.assertGreater(checked, 100)

    def test_wraparound_schedules(self):
        mod, window, capacity = 8, 3, 2
        prefix = []
        for seq in range(5):  # deliver 0..4 up front, next_seq = 5
            prefix += message_frames("s", 0, seq, f"pre{seq}")
        frames = []
        for i, seq in enumerate((5, 6, 7, 0, 1)):  # crosses the wrap point
            frames += message_frames("s", 0, seq, f"post{i}")
        frames.append(frames[1])  # duplicate of seq 6
        checked = check_all(
            unique_permutations(frames), mod, window, capacity, prefix
        )
        self.assertGreater(checked, 100)

    def test_conflicting_retransmit_schedules(self):
        mod, window = 16, 4
        good = message_frames("s", 0, 0, "good-content", frags=2)
        (evil_template,) = message_frames("s", 0, 0, "evil-content")
        evil = type(evil_template)(
            evil_template.stream, evil_template.epoch, evil_template.seq,
            0, 2, "evil-", evil_template.hash,
        )
        (b,) = message_frames("s", 0, 1, "b")
        frames = good + [evil, b]
        checked = check_all(unique_permutations(frames), mod, window)
        self.assertGreater(checked, 10)

    def test_close_schedules(self):
        mod, window = 16, 4
        (m0,) = message_frames("s", 0, 0, "zero")
        (fin,) = message_frames("s", 0, 1, "bye", close=True)
        frames = [m0, fin, fin, m0]  # duplicate close and duplicate message
        checked = check_all(unique_permutations(frames), mod, window)
        self.assertGreater(checked, 5)


class TestScenarios(unittest.TestCase):
    def test_window_full_then_gap_fill_via_vnet(self):
        mod, window, capacity = 16, 4, 2
        gap = message_frames("s", 0, 0, "g")
        m1 = message_frames("s", 0, 1, "one")
        m2 = message_frames("s", 0, 2, "two")
        m3 = message_frames("s", 0, 3, "three")
        schedule = m1 + m2 + m3 + gap  # gap arrives last
        outputs, engine, parked = vnet.run_schedule(
            schedule, mod, window, capacity
        )
        self.assertEqual(parked, [])
        self.assertEqual(
            [o["content"] for o in outputs], ["g", "one", "two", "three"]
        )

    def test_missing_last_fragment_parks_overflow(self):
        mod, window, capacity = 16, 4, 2
        frags = message_frames("s", 0, 0, "abcdef", frags=3)
        m1 = message_frames("s", 0, 1, "one")
        m2 = message_frames("s", 0, 2, "two")
        m3 = message_frames("s", 0, 3, "three")
        # last fragment of message 0 never arrives
        schedule = frags[:2] + m1 + m2 + m3
        outputs, engine, parked = vnet.run_schedule(
            schedule, mod, window, capacity
        )
        self.assertEqual(outputs, [])  # head gap: nothing deliverable
        self.assertEqual(len(parked), 2)  # m2 and m3 could not be buffered
        acks = engine.acks("s", 0)
        self.assertEqual(acks["retransmit"], [0])

    def test_minimize_failing_shrinks_schedule(self):
        frames = message_frames("s", 0, 0, "a") + message_frames("s", 0, 1, "b")
        target = frames[0]

        def is_failing(sched):
            return target in sched

        minimal = vnet.minimize_failing(frames, is_failing)
        self.assertEqual(minimal, [target])

    def test_replay_file_roundtrip(self):
        mod, window, capacity = 16, 4, 2
        frames = (
            message_frames("s", 0, 1, "one")
            + message_frames("s", 0, 0, "zero")
            + message_frames("s", 0, 2, "two")
        )
        doc = {
            "mod": mod,
            "window": window,
            "capacity": capacity,
            "prefix": [],
            "schedule": [f.to_dict() for f in frames],
        }
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "schedule.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(doc, fh)
            result = vnet.replay_file(path, mod, window)
        self.assertEqual(
            [o["content"] for o in result["outputs"]], ["zero", "one", "two"]
        )


if __name__ == "__main__":
    unittest.main()
