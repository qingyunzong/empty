"""Core semantics tests for bandjoin.BandJoin."""

import itertools
import random
import unittest

from bandjoin import BandJoin
from bandjoin.cli import run_join


def reference_join(left, right, bound):
    """Nested-loop reference: dedup by id (first wins), then full join."""

    def dedup(events):
        seen = set()
        out = []
        for event in events:
            if event[0] not in seen:
                seen.add(event[0])
                out.append(event)
        return out

    pairs = []
    for l_id, l_key, l_ts in dedup(left):
        for r_id, r_key, r_ts in dedup(right):
            if l_key == r_key and abs(l_ts - r_ts) <= bound:
                pairs.append(
                    {
                        "l_id": l_id,
                        "r_id": r_id,
                        "key": l_key,
                        "ts_l": l_ts,
                        "ts_r": r_ts,
                    }
                )
    pairs.sort(
        key=lambda p: (p["key"], p["ts_l"], p["ts_r"], p["l_id"], p["r_id"])
    )
    return pairs


class PermutationTest(unittest.TestCase):
    """n<=12: every interleaving of both sides must equal the nested loop.

    ts values stay within ``bound`` of each other so no event can ever be
    late regardless of arrival order; the expected result is then exactly
    the nested-loop join over deduplicated events.
    """

    def test_all_permutations_small(self):
        left = [("l0", "a", 0), ("l1", "b", 1), ("l2", "a", 3)]
        right = [("r0", "a", 3), ("r1", "a", 0), ("r2", "b", 2)]
        bound = 3
        expected = reference_join(left, right, bound)
        self.assertTrue(expected)  # sanity: reference is non-trivial
        for lp in itertools.permutations(left):
            for rp in itertools.permutations(right):
                joiner = run_join(list(lp), list(rp), bound)
                self.assertEqual(joiner.finalize(), expected, (lp, rp))
                self.assertEqual(joiner.stats["left_late"], 0)
                self.assertEqual(joiner.stats["right_late"], 0)

    def test_all_permutations_four_per_side(self):
        left = [
            ("l0", "a", 0),
            ("l1", "b", 1),
            ("l2", "a", 2),
            ("l3", "b", 3),
        ]
        right = [
            ("r0", "a", 3),
            ("r1", "a", 0),
            ("r2", "b", 2),
            ("r3", "b", 1),
        ]
        bound = 3
        expected = reference_join(left, right, bound)
        for lp in itertools.permutations(left):
            for rp in itertools.permutations(right):
                joiner = run_join(list(lp), list(rp), bound)
                self.assertEqual(joiner.finalize(), expected, (lp, rp))

    def test_random_permutations_up_to_12(self):
        rng = random.Random(20261004)
        bound = 3
        for _ in range(300):
            n_left = rng.randint(0, 12)
            n_right = rng.randint(0, 12)
            left = [
                (f"l{i}", rng.choice("ab"), rng.randint(0, 3))
                for i in range(n_left)
            ]
            right = [
                (f"r{i}", rng.choice("ab"), rng.randint(0, 3))
                for i in range(n_right)
            ]
            rng.shuffle(left)
            rng.shuffle(right)
            joiner = run_join(left, right, bound)
            self.assertEqual(
                joiner.finalize(), reference_join(left, right, bound)
            )


class BoundEdgeTest(unittest.TestCase):
    """bound=5000: |diff| == 5000 matches, 5001 does not (both directions)."""

    BOUND = 5000

    def pairs(self, left, right):
        return run_join(left, right, self.BOUND).finalize()

    def test_right_newer_exactly_at_bound_matches(self):
        self.assertEqual(
            self.pairs([("l", "k", 0)], [("r", "k", 5000)]),
            [{"l_id": "l", "r_id": "r", "key": "k", "ts_l": 0, "ts_r": 5000}],
        )

    def test_right_newer_beyond_bound_excluded(self):
        self.assertEqual(self.pairs([("l", "k", 0)], [("r", "k", 5001)]), [])

    def test_right_older_exactly_at_bound_matches(self):
        self.assertEqual(len(self.pairs([("l", "k", 0)], [("r", "k", -5000)])), 1)

    def test_left_newer_exactly_at_bound_matches(self):
        self.assertEqual(len(self.pairs([("l", "k", 5000)], [("r", "k", 0)])), 1)

    def test_left_newer_beyond_bound_excluded(self):
        self.assertEqual(self.pairs([("l", "k", 5001)], [("r", "k", 0)]), [])

    def test_left_older_exactly_at_bound_matches(self):
        self.assertEqual(len(self.pairs([("l", "k", -5000)], [("r", "k", 0)])), 1)

    def test_bound_zero_requires_equal_ts(self):
        joiner = run_join(
            [("l1", "k", 5), ("l2", "k", 6)],
            [("r1", "k", 5), ("r2", "k", 7)],
            0,
        )
        self.assertEqual(
            joiner.finalize(),
            [{"l_id": "l1", "r_id": "r1", "key": "k", "ts_l": 5, "ts_r": 5}],
        )

    def test_wrong_key_never_matches(self):
        self.assertEqual(self.pairs([("l", "a", 0)], [("r", "b", 0)]), [])


class DuplicateAndDisorderTest(unittest.TestCase):
    def test_duplicate_ids_are_one_logical_event(self):
        left = [("l1", "a", 10), ("l1", "a", 10), ("l1", "a", 20)]
        right = [("r1", "a", 10), ("r1", "a", 12)]
        joiner = run_join(left, right, 5)
        self.assertEqual(
            joiner.finalize(),
            [{"l_id": "l1", "r_id": "r1", "key": "a", "ts_l": 10, "ts_r": 10}],
        )
        self.assertEqual(joiner.stats["left_dup"], 2)
        self.assertEqual(joiner.stats["right_dup"], 1)

    def test_extreme_disorder_drops_late_events(self):
        # bound=10, skew=0.  Left ts=100 arrives first (LWM=100), then a
        # right ts=95 (RWM=95); the lateness threshold becomes 90.
        left = [("l1", "a", 100), ("l2", "a", 50)]
        right = [("r1", "a", 95), ("r2", "a", 80), ("r3", "a", 105)]
        joiner = run_join(left, right, 10)
        # l2 (ts=50 < 90) and r2 (ts=80 < 90) are late and dropped.
        self.assertEqual(joiner.stats["left_late"], 1)
        self.assertEqual(joiner.stats["right_late"], 1)
        self.assertEqual(
            joiner.finalize(),
            [
                {"l_id": "l1", "r_id": "r1", "key": "a",
                 "ts_l": 100, "ts_r": 95},
                {"l_id": "l1", "r_id": "r3", "key": "a",
                 "ts_l": 100, "ts_r": 105},
            ],
        )

    def test_skew_relaxes_lateness(self):
        # Same disorder as above but with left_skew=50: LWM=50, so the
        # threshold while l2 arrives is max(50, -inf)-10 = 40 and l2 (ts=50)
        # is accepted.
        left = [("l1", "a", 100), ("l2", "a", 50)]
        right = [("r1", "a", 55)]
        joiner = run_join(left, right, 10, left_skew=50)
        self.assertEqual(joiner.stats["left_late"], 0)
        self.assertIn(
            {"l_id": "l2", "r_id": "r1", "key": "a", "ts_l": 50, "ts_r": 55},
            joiner.finalize(),
        )

    def test_not_yet_due_is_not_unsatisfiable(self):
        # A left event with no right events yet must still match a right
        # event that arrives later within its window.
        joiner = run_join([("l1", "a", 100)], [("r1", "a", 108)], 10)
        self.assertEqual(
            joiner.finalize(),
            [{"l_id": "l1", "r_id": "r1", "key": "a",
              "ts_l": 100, "ts_r": 108}],
        )


class EmptyStreamTest(unittest.TestCase):
    def test_empty_right_still_finalizes(self):
        joiner = run_join([("l1", "a", 1), ("l2", "b", 2)], [], 5)
        self.assertEqual(joiner.finalize(), [])
        self.assertEqual(joiner.stats["left_total"], 2)

    def test_empty_left_still_finalizes(self):
        joiner = run_join([], [("r1", "a", 1)], 5)
        self.assertEqual(joiner.finalize(), [])
        self.assertEqual(joiner.stats["right_total"], 1)

    def test_both_empty(self):
        self.assertEqual(run_join([], [], 5).finalize(), [])


class OrderingTest(unittest.TestCase):
    def test_output_sorted_by_key_ts_l_ts_r_ids(self):
        left = [("l2", "b", 3), ("l1", "a", 5), ("l3", "a", 5)]
        right = [("r2", "a", 5), ("r1", "a", 4), ("r3", "b", 3)]
        pairs = run_join(left, right, 5).finalize()
        keys = [
            (p["key"], p["ts_l"], p["ts_r"], p["l_id"], p["r_id"])
            for p in pairs
        ]
        self.assertEqual(keys, sorted(keys))
        self.assertEqual(len(pairs), 5)  # l1/l3 x r1/r2 plus l2 x r3


if __name__ == "__main__":
    unittest.main()
