import itertools
import unittest

from crdtsim.enumerate import (
    WriteSpec,
    _delivery_events,
    check_scenario,
    concurrent,
    enumerate_legal_orders,
    expected_maximal,
    happens_before,
    transitive_closure,
)


def brute_force_orders(nodes, specs):
    """Independent oracle: filter all permutations by the prereq poset."""
    events, prereq = _delivery_events(nodes, specs)
    valid = []
    for perm in itertools.permutations(events):
        pos = {e: i for i, e in enumerate(perm)}
        if all(pos[p] < pos[e] for e in events for p in prereq[e]):
            valid.append(perm)
    return valid


class TestEventDAG(unittest.TestCase):
    def setUp(self):
        self.specs = [
            WriteSpec("w1", "A", "k"),
            WriteSpec("w2", "B", "k", deps=("w1",)),
            WriteSpec("w3", "C", "k"),
        ]

    def test_transitive_closure(self):
        closure = transitive_closure(self.specs)
        self.assertEqual(closure["w2"], {"w1"})
        self.assertEqual(closure["w3"], set())

    def test_happens_before_and_concurrency(self):
        closure = transitive_closure(self.specs)
        self.assertTrue(happens_before(closure, "w1", "w2"))
        self.assertFalse(happens_before(closure, "w2", "w1"))
        self.assertTrue(concurrent(closure, "w1", "w3"))
        self.assertTrue(concurrent(closure, "w2", "w3"))

    def test_expected_maximal_per_key(self):
        maximal = expected_maximal(self.specs)
        self.assertEqual(maximal["k"], {"w2", "w3"})

    def test_session_order_is_causal(self):
        specs = [WriteSpec("a1", "A", "k"), WriteSpec("a2", "A", "k")]
        closure = transitive_closure(specs)
        self.assertTrue(happens_before(closure, "a1", "a2"))
        self.assertEqual(expected_maximal(specs)["k"], {"a2"})


class TestEnumeration(unittest.TestCase):
    def test_matches_brute_force_oracle(self):
        specs = [
            WriteSpec("w1", "A", "k"),
            WriteSpec("w2", "B", "k", deps=("w1",)),
        ]
        nodes = ["A", "B", "C"]
        expected = {tuple(o) for o in brute_force_orders(nodes, specs)}
        actual = {tuple(o) for o in enumerate_legal_orders(nodes, specs)}
        self.assertEqual(actual, expected)
        self.assertGreater(len(actual), 1)

    def test_concurrent_writes_match_oracle(self):
        specs = [WriteSpec("w1", "A", "k"), WriteSpec("w2", "B", "k")]
        nodes = ["A", "B", "C"]
        expected = {tuple(o) for o in brute_force_orders(nodes, specs)}
        actual = {tuple(o) for o in enumerate_legal_orders(nodes, specs)}
        self.assertEqual(actual, expected)

    def test_orders_respect_causal_dependencies(self):
        specs = [
            WriteSpec("w1", "A", "k"),
            WriteSpec("w2", "B", "k", deps=("w1",)),
        ]
        for order in enumerate_legal_orders(["A", "B"], specs):
            pos = {event: i for i, event in enumerate(order)}
            self.assertLess(pos[("w1", "A")], pos[("w2", "A")])
            self.assertLess(pos[("w1", "B")], pos[("w2", "B")])
            self.assertLess(pos[("w2", "B")], pos[("w2", "A")])

    def test_limits_enforced(self):
        specs = [WriteSpec(f"w{i}", "A", "k") for i in range(13)]
        with self.assertRaises(ValueError):
            enumerate_legal_orders(["A"], specs)
        with self.assertRaises(ValueError):
            enumerate_legal_orders(["A", "B", "C", "D", "E"], specs[:1])


class TestCrossCheck(unittest.TestCase):
    def test_concurrent_writes_converge_to_multivalue(self):
        specs = [
            WriteSpec("w1", "A", "k"),
            WriteSpec("w2", "B", "k"),
            WriteSpec("w3", "C", "k"),
        ]
        result = check_scenario(["A", "B", "C"], specs)
        self.assertTrue(result.ok)
        self.assertGreater(result.checked, 0)

    def test_causal_chain_converges_to_last_write(self):
        specs = [
            WriteSpec("w1", "A", "k"),
            WriteSpec("w2", "B", "k", deps=("w1",)),
            WriteSpec("w3", "A", "k", deps=("w2",)),
            WriteSpec("w4", "C", "j"),
        ]
        result = check_scenario(["A", "B", "C"], specs)
        self.assertTrue(result.ok)

    def test_four_replicas(self):
        specs = [WriteSpec("w1", "A", "k"), WriteSpec("w2", "D", "k")]
        result = check_scenario(["A", "B", "C", "D"], specs)
        self.assertTrue(result.ok)

    def test_counterexample_is_minimized(self):
        specs = [
            WriteSpec("w1", "A", "k"),
            WriteSpec("w2", "B", "k"),
            WriteSpec("w3", "B", "j"),
        ]

        def verdict(reads):  # fails whenever w2 is visible
            return all("w2" not in r.get("k", []) for r in reads.values())

        result = check_scenario(["A", "B"], specs, verdict=verdict)
        self.assertFalse(result.ok)
        self.assertIsNotNone(result.counterexample)
        involved = {wid for wid, _ in result.counterexample}
        self.assertEqual(involved, {"w2"})  # w1 and w3 shrunk away


if __name__ == "__main__":
    unittest.main()
