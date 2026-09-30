"""Library-level tests for vcmerge, including acceptance criteria A-D."""

from __future__ import annotations

import itertools
import random
import unittest

from vcmerge import (
    DocumentError,
    NegativeClockError,
    canonical_dumps,
    count_conflicts,
    merge_documents,
)


def entry(value, clock, tombstone=False, origin=""):
    return {"value": value, "clock": clock, "tombstone": tombstone, "origin": origin}


class Node:
    """Simulated replica maintaining a knowledge vector clock."""

    def __init__(self, name):
        self.name = name
        self.doc = {}
        self.knowledge = {}

    def _bump(self):
        clock = dict(self.knowledge)
        clock[self.name] = clock.get(self.name, 0) + 1
        self.knowledge = clock
        return clock

    def put(self, key, value):
        self.doc[key] = entry(value, self._bump(), False, self.name)

    def delete(self, key):
        self.doc[key] = entry(None, self._bump(), True, self.name)

    def sync(self, other):
        merged = merge_documents(self.doc, other.doc)
        self.doc = other.doc = merged
        for e in merged.values():
            for v in e["versions"]:
                for node, counter in v["clock"].items():
                    if counter > self.knowledge.get(node, 0):
                        self.knowledge[node] = counter
        other.knowledge = dict(self.knowledge)


def sync_docs(docs, i, j):
    merged = merge_documents(docs[i], docs[j])
    docs[i] = docs[j] = merged


def is_quiesced(docs):
    for i, j in itertools.combinations(range(len(docs)), 2):
        merged = merge_documents(docs[i], docs[j])
        if canonical_dumps(merged) != canonical_dumps(docs[i]):
            return False
        if canonical_dumps(merged) != canonical_dumps(docs[j]):
            return False
    return True


def gen_history(seed, n_events):
    """Build 3 replica docs by replaying a random event graph (puts/deletes/syncs)."""
    rng = random.Random(seed)
    nodes = [Node("A"), Node("B"), Node("C")]
    keys = ["k1", "k2"]
    values = [1, 2, "x", "y", {"n": 1}, [1, 2]]
    done = 0
    while done < n_events:
        op = rng.random()
        if op < 0.25:
            i, j = rng.sample(range(3), 2)
            nodes[i].sync(nodes[j])
            continue
        node = rng.choice(nodes)
        key = rng.choice(keys)
        if op < 0.85 or key not in node.doc:
            node.put(key, rng.choice(values))
        else:
            node.delete(key)
        done += 1
    return [n.doc for n in nodes]


class SemilatticeProperties(unittest.TestCase):
    def test_commutative_associative_idempotent(self):
        for seed in range(60):
            docs = gen_history(seed, n_events=6)
            a, b, c = docs
            ab = canonical_dumps(merge_documents(a, b))
            ba = canonical_dumps(merge_documents(b, a))
            self.assertEqual(ab, ba, f"not commutative (seed {seed})")
            aa = canonical_dumps(merge_documents(a, a))
            self.assertEqual(aa, canonical_dumps(merge_documents({}, a)),
                             f"not idempotent (seed {seed})")
            ab_c = canonical_dumps(merge_documents(merge_documents(a, b), c))
            a_bc = canonical_dumps(merge_documents(a, merge_documents(b, c)))
            self.assertEqual(ab_c, a_bc, f"not associative (seed {seed})")

    def test_merge_with_empty_is_identity(self):
        for seed in range(10):
            doc = gen_history(seed, 5)[0]
            self.assertEqual(
                canonical_dumps(merge_documents(doc, {})),
                canonical_dumps(merge_documents({}, doc)),
            )


class AcceptanceAConvergence(unittest.TestCase):
    """All synchronisation orders over 3-node event graphs (n <= 8) converge."""

    def test_regression_causally_masked_loser(self):
        # A: put "x" @{A:1}; C sees it then puts "z" @{A:1,C:1};
        # B concurrently puts "y" @{B:1}.  Pairwise resolution order must
        # not change the outcome.
        a = {"k": entry("x", {"A": 1}, origin="A")}
        b = {"k": entry("y", {"B": 1}, origin="B")}
        c = {"k": entry("z", {"A": 1, "C": 1}, origin="C")}
        order1 = merge_documents(merge_documents(a, b), c)
        order2 = merge_documents(a, merge_documents(b, c))
        order3 = merge_documents(merge_documents(a, c), b)
        self.assertEqual(canonical_dumps(order1), canonical_dumps(order2))
        self.assertEqual(canonical_dumps(order2), canonical_dumps(order3))

    def test_all_sync_orders_converge(self):
        pairs = [(0, 1), (0, 2), (1, 2)]
        schedules = list(itertools.product(pairs, repeat=6))
        for seed in range(10):
            initial = gen_history(1000 + seed, n_events=4 + seed % 5)
            finals = set()
            quiesced_count = 0
            for schedule in schedules:
                docs = [merge_documents(d, {}) for d in initial]
                for i, j in schedule:
                    sync_docs(docs, i, j)
                if is_quiesced(docs):
                    quiesced_count += 1
                    finals.add(canonical_dumps(docs[0]))
            self.assertGreater(quiesced_count, 100, f"seed {seed}: too few quiesced schedules")
            self.assertEqual(len(finals), 1,
                             f"seed {seed}: {len(finals)} distinct converged outputs")


class AcceptanceBConflict(unittest.TestCase):
    def test_concurrent_updates_conflict_deterministically(self):
        left = {"k": entry("beta", {"A": 1}, origin="A")}
        right = {"k": entry("alpha", {"B": 1}, origin="B")}
        m1 = merge_documents(left, right)
        m2 = merge_documents(right, left)
        self.assertEqual(canonical_dumps(m1), canonical_dumps(m2))
        e = m1["k"]
        self.assertTrue(e["conflict"])
        self.assertEqual(e["value"], "alpha")  # smaller canonical serialisation
        self.assertEqual(count_conflicts(m1), 1)

    def test_comparable_clocks_newer_wins_no_conflict(self):
        older = {"k": entry("old", {"A": 1}, origin="A")}
        newer = {"k": entry("new", {"A": 2}, origin="A")}
        merged = merge_documents(older, newer)
        self.assertEqual(merged["k"]["value"], "new")
        self.assertFalse(merged["k"]["conflict"])

    def test_missing_clock_counts_as_zero(self):
        older = {"k": entry("old", {}, origin="A")}
        newer = {"k": entry("new", {"A": 1}, origin="A")}
        merged = merge_documents(older, newer)
        self.assertEqual(merged["k"]["value"], "new")
        self.assertFalse(merged["k"]["conflict"])

    def test_non_string_values_compared_by_serialisation(self):
        left = {"k": entry([1, 2], {"A": 1}, origin="A")}
        right = {"k": entry({"a": 1}, {"B": 1}, origin="B")}
        merged = merge_documents(left, right)
        self.assertEqual(merged["k"]["value"], [1, 2])  # "[1,2]" < '{"a":1}'
        self.assertTrue(merged["k"]["conflict"])


class AcceptanceCTombstone(unittest.TestCase):
    def test_late_old_update_does_not_resurrect(self):
        put = {"k": entry("v", {"A": 1}, origin="A")}
        delete = {"k": entry(None, {"A": 1, "B": 1}, tombstone=True, origin="B")}
        merged = merge_documents(delete, put)
        self.assertTrue(merged["k"]["tombstone"])
        self.assertIsNone(merged["k"]["value"])
        # Merging the stale update again stays deleted (idempotent too).
        again = merge_documents(merged, put)
        self.assertEqual(canonical_dumps(again), canonical_dumps(merged))
        self.assertTrue(again["k"]["tombstone"])

    def test_concurrent_delete_beats_update(self):
        update = {"k": entry("v", {"A": 1, "B": 1}, origin="B")}
        delete = {"k": entry(None, {"A": 2}, tombstone=True, origin="A")}
        for merged in (merge_documents(update, delete), merge_documents(delete, update)):
            self.assertTrue(merged["k"]["tombstone"])
            self.assertIsNone(merged["k"]["value"])

    def test_newer_update_revives_after_delete(self):
        delete = {"k": entry(None, {"A": 2}, tombstone=True, origin="A")}
        readd = {"k": entry("back", {"A": 2, "B": 1}, origin="B")}
        merged = merge_documents(delete, readd)
        self.assertFalse(merged["k"]["tombstone"])
        self.assertEqual(merged["k"]["value"], "back")

    def test_tombstone_retained_in_output(self):
        delete = {"k": entry(None, {"A": 1}, tombstone=True, origin="A")}
        merged = merge_documents(delete, {})
        self.assertTrue(merged["k"]["tombstone"])


class AcceptanceDIdempotentBytes(unittest.TestCase):
    def test_repeated_merge_byte_identical(self):
        left = gen_history(7, 6)[0]
        right = gen_history(8, 6)[1]
        first = canonical_dumps(merge_documents(left, right))
        second = canonical_dumps(merge_documents(left, right))
        self.assertEqual(first, second)

    def test_merging_result_with_input_is_fixpoint(self):
        docs = gen_history(9, 6)
        merged = merge_documents(docs[0], docs[1])
        for d in docs:
            self.assertEqual(
                canonical_dumps(merge_documents(merged, d)),
                canonical_dumps(merged),
            )


class Validation(unittest.TestCase):
    def test_negative_counter_rejected(self):
        bad = {"k": entry("v", {"A": -1}, origin="A")}
        with self.assertRaises(NegativeClockError) as ctx:
            merge_documents(bad, {})
        self.assertEqual(ctx.exception.exit_code, 3)

    def test_negative_counter_in_versions_rejected(self):
        bad = {"k": {"value": "v", "clock": {}, "tombstone": False, "origin": "A",
                     "versions": [{"value": "v", "clock": {"B": -2},
                                   "tombstone": False, "origin": "B"}]}}
        with self.assertRaises(NegativeClockError):
            merge_documents({}, bad)

    def test_malformed_document_rejected(self):
        with self.assertRaises(DocumentError):
            merge_documents(["not", "a", "dict"], {})
        with self.assertRaises(DocumentError):
            merge_documents({"k": "not-an-entry"}, {})


if __name__ == "__main__":
    unittest.main()
