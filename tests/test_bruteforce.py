import hashlib
import itertools
import random
import unittest

from sessionize import Sessionizer

UNIVERSE = [(0, "a"), (4, "b"), (10, "c"), (11, "d"),
            (25, "e"), (26, "f"), (40, "g"), (41, "h")]


def reference_sessions(events, gap):
    """Brute-force union-find over event-time intervals (reference)."""
    ordered = sorted(events, key=lambda e: (e[0], e[1]))
    parent = list(range(len(ordered)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for i in range(len(ordered) - 1):
        if ordered[i + 1][0] - ordered[i][0] <= gap:
            pi, pj = find(i), find(i + 1)
            if pi != pj:
                parent[pi] = pj

    groups = {}
    for i, (ts, ident) in enumerate(ordered):
        groups.setdefault(find(i), []).append((ts, ident))

    result = []
    for members in groups.values():
        tss = [t for t, _ in members]
        ids = sorted(str(i) for _, i in members)
        digest = hashlib.sha256("".join(ids).encode("utf-8")).hexdigest()
        result.append((min(tss), max(tss), len(members), digest))
    return sorted(result)


def actual_sessions(sz, key):
    return sorted((s.start, s.end, s.count, s.ids) for s in sz.sessions(key))


def orders(events):
    events = list(events)
    yield events
    yield list(reversed(events))
    shuffled = list(events)
    random.Random(42).shuffle(shuffled)
    yield shuffled


class TestBruteForce(unittest.TestCase):
    def test_all_subsets_up_to_8_events(self):
        # 2^8 = 256 event sets x 2 gaps x 3 arrival orders; late is huge so
        # no event is ever dropped and the final state must equal the
        # brute-force reference regardless of arrival order.
        checked = 0
        for gap in (3, 10):
            for r in range(len(UNIVERSE) + 1):
                for subset in itertools.combinations(UNIVERSE, r):
                    expected = reference_sessions(subset, gap)
                    for order in orders(subset):
                        sz = Sessionizer(gap=gap, late=10 ** 9)
                        for ts, ident in order:
                            sz.add("k", ts, ident)
                        self.assertEqual(
                            actual_sessions(sz, "k"), expected,
                            f"gap={gap} order={order}")
                        checked += 1
        self.assertEqual(checked, 2 * 256 * 3)

    def test_interleaved_keys_match_reference(self):
        events = [("k1", 0, "a"), ("k2", 3, "x"), ("k1", 5, "b"),
                  ("k2", 30, "y"), ("k1", 100, "c"), ("k2", 34, "z"),
                  ("k1", 108, "d")]
        sz = Sessionizer(gap=10, late=10 ** 9)
        for key, ts, ident in events:
            sz.add(key, ts, ident)
        for key in ("k1", "k2"):
            expected = reference_sessions(
                [(ts, i) for k, ts, i in events if k == key], 10)
            self.assertEqual(actual_sessions(sz, key), expected)


if __name__ == "__main__":
    unittest.main()
