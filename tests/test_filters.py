import random
import unittest

from rknni.filters import match_tags, may_match, validate_filter


class TestFilterEval(unittest.TestCase):
    def test_match_tags(self):
        tags = {"a", "b"}
        self.assertTrue(match_tags(None, tags))
        self.assertTrue(match_tags({"tag": "a"}, tags))
        self.assertFalse(match_tags({"tag": "z"}, tags))
        self.assertTrue(match_tags({"and": [{"tag": "a"}, {"tag": "b"}]}, tags))
        self.assertFalse(match_tags({"and": [{"tag": "a"}, {"tag": "z"}]}, tags))
        self.assertTrue(match_tags({"or": [{"tag": "z"}, {"tag": "b"}]}, tags))
        self.assertFalse(match_tags({"not": {"tag": "a"}}, tags))
        self.assertTrue(
            match_tags(
                {
                    "and": [
                        {"or": [{"tag": "z"}, {"tag": "a"}]},
                        {"not": {"tag": "z"}},
                    ]
                },
                tags,
            )
        )

    def test_validate_filter(self):
        validate_filter(None)
        validate_filter({"and": [{"tag": "a"}, {"not": {"tag": "b"}}]})
        for bad in (
            {"tag": 1},
            {"and": []},
            {"and": [{"tag": "a"}], "tag": "b"},
            {"foo": 1},
            {"not": {"and": [{"tag": "a"}], "or": [{"tag": "b"}]}},
            "tag:a",
        ):
            with self.assertRaises(ValueError):
                validate_filter(bad)


def random_filter(rng, tags, depth):
    if depth == 0 or rng.random() < 0.4:
        return {"tag": rng.choice(tags)}
    kind = rng.choice(["and", "or", "not"])
    if kind == "not":
        return {"not": random_filter(rng, tags, depth - 1)}
    return {
        kind: [random_filter(rng, tags, depth - 1) for _ in range(rng.randint(2, 3))]
    }


class TestMayMatchSoundness(unittest.TestCase):
    """may_match may only prune when no point in the set can match."""

    def run_scenario(self, rng, stale):
        universe = [f"t{i}" for i in range(5)]
        sets = [
            {t for t in universe if rng.random() < 0.4}
            for _ in range(rng.randint(1, 12))
        ]
        tags_any = set().union(*sets)
        tags_all = set(sets[0])
        for s in sets[1:]:
            tags_all &= s
        if stale:
            # Simulate post-delete staleness: union too big, intersection too small.
            tags_any |= {rng.choice(universe)}
            tags_all -= {rng.choice(universe)}
        for _ in range(50):
            filt = random_filter(rng, universe, depth=3)
            if not may_match(filt, tags_any, tags_all):
                for s in sets:
                    self.assertFalse(
                        match_tags(filt, s),
                        f"unsound prune: filter {filt} pruned but {s} matches",
                    )

    def test_soundness_exact_summaries(self):
        rng = random.Random(20240101)
        for _ in range(200):
            self.run_scenario(rng, stale=False)

    def test_soundness_stale_summaries(self):
        rng = random.Random(20240102)
        for _ in range(200):
            self.run_scenario(rng, stale=True)


if __name__ == "__main__":
    unittest.main()
