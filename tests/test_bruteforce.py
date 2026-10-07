import random
import unittest

from logfilter import (
    Index,
    bf_distance,
    bf_matches,
    parse_pattern,
    search,
    validate_alignment,
)

ALPHABET = "abc"
CLASS_SNIPPETS = ["[a-b]", "[^b]", "[ac]", "[a-c]", "[^a]"]


def random_pattern(rng):
    parts = []
    for _ in range(rng.randint(1, 4)):
        r = rng.random()
        if r < 0.45:
            parts.append(rng.choice(ALPHABET))
        elif r < 0.60:
            parts.append("?")
        elif r < 0.75:
            parts.append(rng.choice(CLASS_SNIPPETS))
        else:
            parts.append("*")
    return "".join(parts)


class TestCrossCheckWithIndependentDP(unittest.TestCase):
    """Automaton intersection vs. independent per-word DP interpretation.

    Only feasible because the dictionary uses a short alphabet and stays
    tiny; the production search path never enumerates words like this.
    """

    def test_random_dictionaries_and_patterns(self):
        rng = random.Random(20261007)
        for trial in range(200):
            words = sorted(
                {
                    "".join(rng.choice(ALPHABET) for _ in range(rng.randint(1, 5)))
                    for _ in range(rng.randint(1, 40))
                }
            )
            index = Index()
            index.add_document("d1", words)
            pattern_src = random_pattern(rng)
            d = rng.randint(0, 2)
            if d:
                pattern_src += "{~%d}" % d
            compiled = parse_pattern(pattern_src)

            result = search(index, pattern=pattern_src, limit=10000)
            self.assertTrue(result.complete, pattern_src)
            got = {}
            for entry in result.results:
                for hit in entry["terms"]:
                    got[hit["term"]] = hit
            want = {w for w in words if bf_matches(compiled.elements, w, d)}
            self.assertEqual(
                set(got),
                want,
                f"trial={trial} pattern={pattern_src!r} d={d} words={words}",
            )
            for term, hit in got.items():
                self.assertEqual(
                    hit["distance"], bf_distance(compiled.elements, term), hit
                )
                ok, cost = validate_alignment(
                    compiled.elements, term, hit["alignment"]
                )
                self.assertTrue(ok, hit)
                self.assertEqual(cost, hit["distance"], hit)

    def test_cross_check_with_paginated_scan(self):
        rng = random.Random(7)
        words = sorted(
            {
                "".join(rng.choice(ALPHABET) for _ in range(rng.randint(1, 4)))
                for _ in range(30)
            }
        )
        index = Index()
        for i, word in enumerate(words):
            index.add_document(f"doc{i}", [word])
        compiled = parse_pattern("a*{~1}")

        seen = set()
        cursor = None
        for _ in range(500):
            result = search(
                index,
                pattern="a*{~1}" if cursor is None else None,
                limit=2,
                budget=5,
                cursor=cursor,
            )
            for entry in result.results:
                for hit in entry["terms"]:
                    seen.add(hit["term"])
            if result.complete:
                break
            cursor = result.cursor
        else:
            self.fail("paginated scan did not terminate")
        want = {w for w in words if bf_matches(compiled.elements, w, 1)}
        self.assertEqual(seen, want)


if __name__ == "__main__":
    unittest.main()
