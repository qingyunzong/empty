"""Unit tests for preemption legality and the no-return rule."""
import unittest

from gpupack.model import parse_problem
from gpupack.scheduler import (
    DONE,
    END,
    FGPU,
    GPU,
    NEEDS_RS,
    PREEMPTS,
    PREV,
    REM,
    RESTARTING,
    START,
    Engine,
)


def make_engine():
    spec = {
        "gpus": [
            {"id": "g0", "mem": 10, "sm": 10},
            {"id": "g1", "mem": 10, "sm": 10},
        ],
        "requests": [
            {"id": "vic", "mem": 4, "sm": 4, "shareable": True,
             "preemptible": True, "arrival": 0, "duration": 8},
            {"id": "sq", "mem": 6, "sm": 6, "shareable": True,
             "preemptible": False, "arrival": 0, "duration": 30},
        ],
    }
    return Engine(parse_problem(spec))


# Entry layout: (REM, NEEDS_RS, RESTARTING, GPU, PREV, DONE, END, START, PREEMPTS, FGPU)
VIC_WAITING = (5, 1, 0, -1, 0, 0, -1, 0, 1, -1)   # evicted from g0, 5 ticks left
SQ_RUNNING = (20, 0, 0, 0, -1, 0, -1, 0, 0, -1)   # running on g0
SQ_DONE = (0, 0, 0, -1, 0, 1, 24, 0, 0, 0)        # completed on g0


class TestNoReturnRule(unittest.TestCase):
    def test_cannot_return_to_occupied_original_gpu(self):
        engine = make_engine()
        state = (5, (VIC_WAITING, SQ_RUNNING))
        actions = engine.actions(state)
        # vic (index 0) fits on g0 capacity-wise (4+6 <= 10), but g0 is its
        # original GPU and still occupied by sq, so no action may start it there.
        self.assertFalse(
            any(starts.get(0) == 0 for _, starts in actions),
            "job returned to its original GPU while occupied",
        )
        # The other GPU is free and must be offered.
        self.assertTrue(any(starts.get(1) == 0 for _, starts in actions))

    def test_can_return_once_original_gpu_is_free(self):
        engine = make_engine()
        state = (24, (VIC_WAITING, SQ_DONE))
        actions = engine.actions(state)
        self.assertTrue(any(starts.get(0) == 0 for _, starts in actions))


class TestEvictionJustification(unittest.TestCase):
    def test_no_eviction_without_higher_priority_starter(self):
        spec = {
            "gpus": [{"id": "g0", "mem": 10, "sm": 10}],
            "requests": [
                {"id": "low", "mem": 4, "sm": 4, "shareable": True,
                 "preemptible": True, "arrival": 0, "duration": 5},
                {"id": "late", "mem": 4, "sm": 4, "shareable": True,
                 "preemptible": False, "arrival": 9, "duration": 2},
            ],
        }
        engine = Engine(parse_problem(spec))
        # t=2: low running on g0, late has not arrived -> nobody may evict low.
        low_running = (3, 0, 0, 0, -1, 0, -1, 0, 0, -1)
        late_waiting = (2, 0, 0, -1, -1, 0, -1, -1, 0, -1)
        state = (2, (low_running, late_waiting))
        actions = engine.actions(state)
        self.assertTrue(actions)
        self.assertTrue(all(ev == frozenset() for ev, _ in actions))

    def test_eviction_requires_same_gpu_higher_priority_start(self):
        spec = {
            "gpus": [{"id": "g0", "mem": 10, "sm": 10}],
            "requests": [
                {"id": "low", "mem": 4, "sm": 4, "shareable": True,
                 "preemptible": True, "arrival": 0, "duration": 5},
                {"id": "hi", "mem": 4, "sm": 4, "shareable": True,
                 "preemptible": False, "arrival": 2, "duration": 2},
            ],
        }
        engine = Engine(parse_problem(spec))
        # t=2: low running on g0 (3 left), hi just arrived (higher priority).
        low_running = (3, 0, 0, 0, -1, 0, -1, 0, 0, -1)
        hi_waiting = (2, 0, 0, -1, -1, 0, -1, -1, 0, -1)
        state = (2, (low_running, hi_waiting))
        actions = engine.actions(state)
        # Both jobs are shareable and fit together, so eviction is optional;
        # but every action that evicts low must start hi on g0 in the same tick.
        evicting = [(ev, starts) for ev, starts in actions if ev]
        self.assertTrue(evicting)
        for ev, starts in evicting:
            self.assertEqual(ev, frozenset({0}))
            self.assertEqual(starts.get(0), 1)


if __name__ == "__main__":
    unittest.main()
