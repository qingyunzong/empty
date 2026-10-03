import itertools
import random
import unittest

from symdfa import (EQUIVALENCE, INCLUSION, MAX_CHAR, Machine, check,
                    partition_transitions, verify_counterexample, verify_proof)


def random_machine(rng, n_states, n_chars):
    """Random machine whose only character boundary is at n_chars - 1.

    Characters 0..n_chars-2 get individual intervals; everything from
    n_chars-1 up to MAX_CHAR shares one interval, so the character
    n_chars-1 faithfully represents the whole tail region.
    """
    states = [f"q{i}" for i in range(n_states)]
    accepting = {s for s in states if rng.random() < 0.4}
    bounds = [(c, c) for c in range(n_chars - 1)] + [(n_chars - 1, MAX_CHAR)]
    transitions = {}
    for s in states:
        raw = [(lo, hi, rng.choice(states))
               for (lo, hi) in bounds if rng.random() < 0.8]
        merged = []
        for lo, hi, t in raw:
            if merged and merged[-1][2] == t and merged[-1][1] + 1 == lo:
                merged[-1] = (merged[-1][0], hi, t)
            else:
                merged.append((lo, hi, t))
        if merged:
            transitions[s] = merged
    return Machine.create(states, "q0", accepting, transitions)


def reference_check(a, b, alphabet, mode=EQUIVALENCE):
    """Full product reference: per-character BFS, (length, lex) minimal."""
    def mismatch(pair):
        acc_a, acc_b = a.is_accepting(pair[0]), b.is_accepting(pair[1])
        return acc_a != acc_b if mode == EQUIVALENCE else acc_a and not acc_b

    start = (a.initial, b.initial)
    layer = {start: ()}
    visited = {start}
    while layer:
        nxt = {}
        for pair, word in sorted(layer.items(), key=lambda kv: kv[1]):
            if mismatch(pair):
                return list(word)
            for c in alphabet:
                succ = (a.step(pair[0], c), b.step(pair[1], c))
                if succ not in visited and succ not in nxt:
                    nxt[succ] = word + (c,)
        visited.update(nxt)
        layer = nxt
    return None


class TestPartition(unittest.TestCase):
    def test_endpoint_splitting(self):
        segs = partition_transitions(((0, 100, "x"),), ((50, 150, "y"),))
        self.assertEqual(segs, [
            (0, 49, "x", None),
            (50, 100, "x", "y"),
            (101, 150, None, "y"),
            (151, MAX_CHAR, None, None),
        ])

    def test_shared_endpoints_no_empty_segments(self):
        segs = partition_transitions(((0, 10, "x"),), ((0, 10, "y"),))
        self.assertEqual(segs, [
            (0, 10, "x", "y"),
            (11, MAX_CHAR, None, None),
        ])

    def test_empty_transitions_cover_whole_alphabet(self):
        self.assertEqual(partition_transitions((), ()), [(0, MAX_CHAR, None, None)])


class TestBasicCases(unittest.TestCase):
    def test_empty_word_difference(self):
        a = Machine.create(["q0"], "q0", ["q0"], {})
        b = Machine.create(["r0"], "r0", [], {})
        res = check(a, b)
        self.assertEqual(res.status, "different")
        self.assertEqual(res.counterexample["word"], [])
        self.assertEqual(verify_counterexample(a, b, res.counterexample), [])

    def test_implicit_sink_equals_explicit_trap(self):
        a = Machine.create(
            ["q0", "q1", "t"], "q0", ["q1"],
            {"q0": [[0, 10, "q1"], [11, MAX_CHAR, "t"]],
             "q1": [[0, MAX_CHAR, "q1"]],
             "t": [[0, MAX_CHAR, "t"]]})
        b = Machine.create(
            ["r0", "r1"], "r0", ["r1"],
            {"r0": [[0, 10, "r1"]], "r1": [[0, MAX_CHAR, "r1"]]})
        res = check(a, b)
        self.assertEqual(res.status, "equivalent")
        self.assertEqual(verify_proof(a, b, res.proof), [])

    def test_implicit_sink_difference(self):
        a = Machine.create(["q0", "q1"], "q0", ["q1"],
                           {"q0": [[10, 20, "q1"]]})
        b = Machine.create(["r0"], "r0", [], {})
        res = check(a, b)
        self.assertEqual(res.status, "different")
        self.assertEqual(res.counterexample["word"], [10])

    def test_multiple_same_length_witnesses_lexicographic(self):
        a = Machine.create(["q0", "qa"], "q0", ["qa"],
                           {"q0": [[3, 3, "qa"], [5, 5, "qa"]]})
        b = Machine.create(["r0"], "r0", [], {})
        res = check(a, b)
        self.assertEqual(res.status, "different")
        self.assertEqual(res.counterexample["word"], [3])

    def test_endpoint_splitting_equivalence(self):
        a = Machine.create(["q0", "q1"], "q0", ["q1"],
                           {"q0": [[0, 100, "q1"]]})
        b = Machine.create(["r0", "r1"], "r0", ["r1"],
                           {"r0": [[0, 49, "r1"], [50, 100, "r1"]]})
        res = check(a, b)
        self.assertEqual(res.status, "equivalent")
        self.assertEqual(verify_proof(a, b, res.proof), [])

    def test_inclusion(self):
        a = Machine.create(["q0", "q1"], "q0", ["q1"], {"q0": [[0, 5, "q1"]]})
        b = Machine.create(["r0", "r1"], "r0", ["r1"], {"r0": [[0, 10, "r1"]]})
        res = check(a, b, mode=INCLUSION)
        self.assertEqual(res.status, "included")
        self.assertEqual(res.proof["type"], "inclusion_proof")
        self.assertEqual(verify_proof(a, b, res.proof), [])
        res_back = check(b, a, mode=INCLUSION)
        self.assertEqual(res_back.status, "not_included")
        self.assertEqual(res_back.counterexample["word"], [6])
        self.assertEqual(
            verify_counterexample(b, a, res_back.counterexample, INCLUSION), [])


class TestRandomizedCrossCheck(unittest.TestCase):
    def test_against_full_product_reference(self):
        rng = random.Random(20261004)
        for _ in range(150):
            a = random_machine(rng, rng.randint(1, 4), 4)
            b = random_machine(rng, rng.randint(1, 4), 4)
            mode = rng.choice([EQUIVALENCE, INCLUSION])
            res = check(a, b, mode=mode)
            ref_word = reference_check(a, b, [0, 1, 2, 3], mode)
            if ref_word is None:
                self.assertIn(res.status, ("equivalent", "included"))
                self.assertEqual(verify_proof(a, b, res.proof), [])
            else:
                self.assertIn(res.status, ("different", "not_included"))
                self.assertEqual(res.counterexample["word"], ref_word)
                self.assertEqual(
                    verify_counterexample(a, b, res.counterexample, mode), [])

    def test_exhaustive_word_enumeration(self):
        rng = random.Random(7)
        alphabet = [0, 1, 2]
        for _ in range(30):
            a = random_machine(rng, rng.randint(1, 2), 3)
            b = random_machine(rng, rng.randint(1, 2), 3)
            res = check(a, b)
            found = None
            for length in range(10):
                for word in itertools.product(alphabet, repeat=length):
                    if a.accepts(word) != b.accepts(word):
                        found = list(word)
                        break
                if found is not None:
                    break
            if found is None:
                self.assertEqual(res.status, "equivalent")
            else:
                self.assertEqual(res.status, "different")
                self.assertEqual(res.counterexample["word"], found)


if __name__ == "__main__":
    unittest.main()
