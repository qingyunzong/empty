import tempfile
import unittest

from reorder.engine import Engine
from reorder.messages import make_close_frame, make_message_frames
from reorder.vnet import (_outputs_equal, find_failing_schedule,
                          minimize_schedule, run_schedule)


def frames_of(*specs):
    """specs: (seq, content, frag_count, copies)"""
    frames = []
    for seq, content, frag_count, copies in specs:
        for frame in make_message_frames("s", 0, seq, content, frag_count):
            frames.append((frame, copies))
    return frames


def no_journal_factory(modulus, window):
    return lambda: Engine(modulus, window)


class TestExhaustiveSchedules(unittest.TestCase):
    def assert_no_failure(self, frames, modulus, window, depth,
                          allow_crash=True, engine_factory=None):
        failure = find_failing_schedule(
            frames, modulus, window, depth,
            allow_crash=allow_crash, engine_factory=engine_factory)
        self.assertIsNone(failure, f"failing schedule: {failure}")

    def test_reorder_and_duplicates(self):
        frames = frames_of((0, "a", 1, 2), (1, "b", 1, 1), (2, "c", 1, 1))
        self.assert_no_failure(frames, 8, 3, depth=5, allow_crash=False,
                               engine_factory=no_journal_factory(8, 3))

    def test_wraparound_cycle(self):
        # modulus 4, window 2: five messages force the cursor past the wrap.
        frames = frames_of((0, "m0", 1, 1), (1, "m1", 1, 1), (2, "m2", 1, 1),
                           (3, "m3", 1, 1), (0, "m4", 1, 1))
        self.assert_no_failure(frames, 4, 2, depth=6, allow_crash=False,
                               engine_factory=no_journal_factory(4, 2))

    def test_fragments_and_conflicting_retransmit(self):
        good = make_message_frames("s", 0, 0, "good", frag_count=2)
        evil = make_message_frames("s", 0, 0, "evil", frag_count=2)[1]
        frames = [(good[0], 1), (good[1], 1), (evil, 1)] + \
                 frames_of((1, "next", 1, 1))
        self.assert_no_failure(frames, 8, 3, depth=5, allow_crash=False,
                               engine_factory=no_journal_factory(8, 3))

    def test_crash_before_and_after_ack(self):
        frames = frames_of((0, "x", 1, 2), (1, "y", 2, 1))
        self.assert_no_failure(frames, 8, 3, depth=5, allow_crash=True)

    def test_close_with_duplicates_and_crash(self):
        close = make_close_frame("s", 0, 1)
        frames = frames_of((0, "only", 1, 1)) + [(close, 2)]
        self.assert_no_failure(frames, 8, 3, depth=5, allow_crash=True)


class ForgetfulEngine(Engine):
    """Deliberately broken: recovery loses the ack set and ready buffer."""

    def recover(self):
        super().recover()
        for receiver in self.streams.values():
            receiver.ready.clear()
            receiver.acked.clear()


class TestMinimalFailingSchedule(unittest.TestCase):
    def test_shortest_failing_schedule_is_replayable(self):
        modulus, window = 8, 3
        frames = frames_of((0, "x", 1, 3))
        factory = lambda: ForgetfulEngine(modulus, window)  # noqa: E731

        failure = find_failing_schedule(frames, modulus, window, max_depth=4,
                                        allow_crash=True,
                                        engine_factory=factory)
        self.assertIsNotNone(failure)
        # Shortest witness: deliver, crash (ack set forgotten), redeliver ->
        # the business output contains "x" twice while the reference has one.
        self.assertEqual([a[0] for a in failure["schedule"]],
                         ["deliver", "crash", "deliver"])
        contents = [r["content"] for r in failure["engine_output"]]
        self.assertEqual(contents, ["x", "x"])

        def is_failure(schedule):
            with tempfile.TemporaryDirectory() as tmp:
                eng, ref = run_schedule(schedule, frames, modulus, window,
                                        tmp, engine_factory=factory)
            return not _outputs_equal(eng, ref)

        # The reported schedule replays deterministically...
        self.assertTrue(is_failure(failure["schedule"]))
        # ...and a longer noisy schedule minimizes back to the short witness.
        noisy = [["deliver", 0], ["deliver", 0], ["crash"], ["deliver", 0]]
        self.assertTrue(is_failure(noisy))
        minimized = minimize_schedule(noisy, is_failure)
        self.assertTrue(is_failure(minimized))
        self.assertLessEqual(len(minimized), 3)


if __name__ == "__main__":
    unittest.main()
