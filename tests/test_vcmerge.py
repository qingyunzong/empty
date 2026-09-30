"""Tests for vcmerge: deterministic convergent merge of JSON replicas."""

import itertools
import json
import os
import random
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import vcmerge
from vcmerge import (
    MergeError,
    NegativeCounterError,
    canonical_dumps,
    compare_clocks,
    merge_documents,
    merge_entries,
    normalize_document,
)

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODES = ("n1", "n2", "n3")


def entry(value, clock, tombstone=False, origin="n1"):
    return {"value": value, "clock": dict(clock), "tombstone": tombstone, "origin": origin}


def run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "vcmerge", *args],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )


class ClockComparisonTests(unittest.TestCase):
    def test_missing_entries_are_zero(self):
        self.assertEqual(compare_clocks({"a": 1}, {"a": 1, "b": 0}), 0)
        self.assertEqual(compare_clocks({"a": 2}, {"a": 1}), 1)
        self.assertEqual(compare_clocks({"a": 1}, {"a": 1, "b": 1}), -1)
        self.assertIsNone(compare_clocks({"a": 1}, {"b": 1}))
        self.assertEqual(compare_clocks({}, {}), 0)

    def test_normalization_drops_zero_counters(self):
        doc = normalize_document(
            {"k": entry("v", {"a": 1, "b": 0})}, "doc"
        )
        self.assertEqual(doc["k"]["clock"], {"a": 1})

    def test_negative_counter_rejected(self):
        with self.assertRaises(NegativeCounterError):
            normalize_document({"k": entry("v", {"a": -1})})
        with self.assertRaises(NegativeCounterError):
            merge_documents({"k": entry("v", {"a": -3})}, {})

    def test_malformed_documents_rejected(self):
        bad_inputs = [
            [],
            {"k": {"value": 1}},
            {"k": entry("v", {"a": 1}, tombstone="yes")},
            {"k": entry("v", {"a": 1}, origin=7)},
            {"k": entry("v", {"a": 1.5})},
            {"k": entry("v", {"a": True})},
            {"k": dict(entry("v", {"a": 1}), extra=1)},
        ]
        for bad in bad_inputs:
            with self.assertRaises(MergeError, msg=repr(bad)):
                normalize_document(bad)


class MergeSemanticsTests(unittest.TestCase):
    def test_comparable_newer_wins(self):
        older = entry("old", {"n1": 1})
        newer = entry("new", {"n1": 2})
        for first, second in ((older, newer), (newer, older)):
            merged, conflict = merge_entries(first, second)
            self.assertEqual(merged["value"], "new")
            self.assertFalse(conflict)

    def test_concurrent_writes_conflict_and_deterministic(self):
        # Acceptance B: concurrent edits of the same field -> conflict,
        # deterministic winner (lexicographically smaller canonical JSON).
        left = entry("zebra", {"n1": 1}, origin="n1")
        right = entry("apple", {"n2": 1}, origin="n2")
        r1 = merge_documents({"k": left}, {"k": right})
        r2 = merge_documents({"k": right}, {"k": left})
        self.assertEqual(r1.conflicts, 1)
        self.assertEqual(r2.conflicts, 1)
        self.assertEqual(r1.document, r2.document)
        self.assertEqual(r1.document["k"]["value"], "apple")

    def test_no_conflict_when_values_identical_but_clocks_differ(self):
        merged = merge_documents({"k": entry(1, {"n1": 1})}, {"k": entry(1, {"n1": 1})})
        self.assertEqual(merged.conflicts, 0)

    def test_delete_beats_concurrent_update(self):
        tomb = entry(None, {"n1": 1}, tombstone=True, origin="n1")
        upd = entry("v", {"n2": 1}, origin="n2")
        for first, second in ((tomb, upd), (upd, tomb)):
            merged, conflict = merge_entries(first, second)
            self.assertTrue(merged["tombstone"])
            self.assertFalse(conflict)

    def test_late_update_does_not_resurrect(self):
        # Acceptance C: a delete dominates an older update; the stale update
        # arriving late must not bring the value back.
        tomb = entry(None, {"n1": 2}, tombstone=True, origin="n1")
        stale = entry("ghost", {"n1": 1}, origin="n1")
        result = merge_documents({"k": tomb}, {"k": stale})
        self.assertTrue(result.document["k"]["tombstone"])
        self.assertIsNone(result.document["k"]["value"])
        # Merging the stale replica again keeps the tombstone (idempotent).
        again = merge_documents(result.document, {"k": stale})
        self.assertTrue(again.document["k"]["tombstone"])

    def test_update_after_delete_wins(self):
        tomb = entry(None, {"n1": 1}, tombstone=True, origin="n1")
        later = entry("back", {"n1": 2}, origin="n1")
        merged, _ = merge_entries(tomb, later)
        self.assertFalse(merged["tombstone"])
        self.assertEqual(merged["value"], "back")

    def test_tombstone_retained_when_only_on_one_replica(self):
        tomb = entry(None, {"n1": 3}, tombstone=True, origin="n1")
        result = merge_documents({"k": tomb}, {})
        self.assertTrue(result.document["k"]["tombstone"])

    def test_key_union(self):
        result = merge_documents(
            {"a": entry(1, {"n1": 1})}, {"b": entry(2, {"n2": 1})}
        )
        self.assertEqual(set(result.document), {"a", "b"})
        self.assertEqual(result.conflicts, 0)


class AlgebraPropertyTests(unittest.TestCase):
    """Merge must be commutative, associative and idempotent."""

    @classmethod
    def setUpClass(cls):
        clocks = []
        for a, b in itertools.product(range(3), repeat=2):
            clock = {}
            if a:
                clock["n1"] = a
            if b:
                clock["n2"] = b
            clocks.append(clock)
        cls.entries = [
            entry(value, clock, tombstone=tomb, origin=origin)
            for clock in clocks
            for value in (0, 1)
            for tomb in (False, True)
            for origin in ("n1", "n2")
        ]

    def test_commutative(self):
        for e1, e2 in itertools.product(self.entries, repeat=2):
            m1 = merge_documents({"k": e1}, {"k": e2})
            m2 = merge_documents({"k": e2}, {"k": e1})
            self.assertEqual(m1.document, m2.document)
            self.assertEqual(m1.conflicts, m2.conflicts)

    def test_idempotent(self):
        for e in self.entries:
            merged = merge_documents({"k": e}, {"k": e})
            self.assertEqual(merged.document, {"k": normalize_document({"k": e})["k"]})
            self.assertEqual(merged.conflicts, 0)

    def test_associative(self):
        for e1, e2, e3 in itertools.product(self.entries, repeat=3):
            left = merge_documents(
                merge_documents({"k": e1}, {"k": e2}).document, {"k": e3}
            ).document
            right = merge_documents(
                {"k": e1}, merge_documents({"k": e2}, {"k": e3}).document
            ).document
            self.assertEqual(left, right)

    def test_document_level_idempotent(self):
        left = {
            "x": entry("a", {"n1": 1}),
            "y": entry(None, {"n1": 2}, tombstone=True),
        }
        right = {
            "x": entry("b", {"n2": 1}, origin="n2"),
            "z": entry(3, {"n2": 2}, origin="n2"),
        }
        once = merge_documents(left, right).document
        twice = merge_documents(once, right).document
        thrice = merge_documents(once, left).document
        self.assertEqual(once, twice)
        self.assertEqual(once, thrice)


class EventGraphConvergenceTests(unittest.TestCase):
    """Acceptance A: enumerate 3-node event graphs (n <= 8 events) and every
    possible synchronisation order; the converged document must be unique."""

    @staticmethod
    def apply_events(events):
        """Each node applies its own events in order to its private replica."""
        counters = {node: 0 for node in NODES}
        replicas = {node: {} for node in NODES}
        for node, op, key, value in events:
            counters[node] += 1
            replica = replicas[node]
            clock = dict(replica.get(key, {}).get("clock", {}))
            clock[node] = counters[node]
            if op == "set":
                replica[key] = entry(value, clock, origin=node)
            else:
                replica[key] = entry(None, clock, tombstone=True, origin=node)
        return replicas

    @staticmethod
    def reachable_states(replicas):
        """BFS over joint replica states; edges are pairwise syncs."""
        start = tuple(canonical_dumps(replicas[node]) for node in NODES)
        seen = {start}
        queue = [start]
        terminals = []
        while queue:
            state = queue.pop()
            docs = {node: json.loads(state[i]) for i, node in enumerate(NODES)}
            progressed = False
            for i, dst in enumerate(NODES):
                for j, src in enumerate(NODES):
                    if i == j:
                        continue
                    merged = merge_documents(docs[dst], docs[src]).document
                    dumped = canonical_dumps(merged)
                    if dumped != state[i]:
                        progressed = True
                        nxt = list(state)
                        nxt[i] = dumped
                        nxt = tuple(nxt)
                        if nxt not in seen:
                            seen.add(nxt)
                            queue.append(nxt)
            if not progressed:
                terminals.append(state)
        return terminals

    def assert_converges(self, events):
        replicas = self.apply_events(events)
        terminals = self.reachable_states(replicas)
        self.assertEqual(
            len(terminals),
            1,
            f"divergent sync orders for events {events}: {terminals}",
        )
        final = terminals[0]
        self.assertEqual(final[0], final[1])
        self.assertEqual(final[1], final[2])

    def test_exhaustive_tiny_graphs(self):
        # All event sequences of length 1..3 over 3 nodes, set/del, 2 values.
        alphabet = [
            (node, op, "a", value)
            for node in NODES
            for op in ("set", "del")
            for value in (0, 1)
        ]
        count = 0
        for length in (1, 2, 3):
            for events in itertools.product(alphabet, repeat=length):
                self.assert_converges(list(events))
                count += 1
        self.assertGreater(count, 1000)

    def test_random_graphs_up_to_8_events(self):
        rng = random.Random(20260930)
        for _ in range(40):
            events = [
                (
                    rng.choice(NODES),
                    rng.choice(("set", "set", "del")),
                    rng.choice(("a", "b")),
                    rng.randrange(3),
                )
                for _ in range(rng.randrange(4, 9))
            ]
            self.assert_converges(events)


class CliTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def path(self, name, doc=None):
        p = os.path.join(self.tmp.name, name)
        if doc is not None:
            with open(p, "w", encoding="utf-8") as fh:
                json.dump(doc, fh)
        return p

    def test_merge_conflicts_printed_and_canonical_out(self):
        left = self.path("l.json", {"k": entry("zebra", {"n1": 1})})
        right = self.path("r.json", {"k": entry("apple", {"n2": 1}, origin="n2")})
        out = self.path("out.json")
        proc = run_cli("merge", left, right, "--out", out)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.strip(), "1")
        with open(out, encoding="utf-8") as fh:
            text = fh.read()
        self.assertEqual(
            text,
            '{"k":{"clock":{"n2":1},"origin":"n2","tombstone":false,"value":"apple"}}\n',
        )
        self.assertEqual(json.loads(text)["k"]["value"], "apple")

    def test_repeated_merge_byte_identical(self):
        # Acceptance D: merging the same pair twice yields identical bytes.
        left = self.path("l.json", {"k": entry("zebra", {"n1": 1})})
        right = self.path("r.json", {"k": entry("apple", {"n2": 1}, origin="n2")})
        out1 = self.path("o1.json")
        out2 = self.path("o2.json")
        self.assertEqual(run_cli("merge", left, right, "--out", out1).returncode, 0)
        self.assertEqual(run_cli("merge", left, right, "--out", out2).returncode, 0)
        with open(out1, "rb") as fh:
            b1 = fh.read()
        with open(out2, "rb") as fh:
            b2 = fh.read()
        self.assertEqual(b1, b2)
        # Merging the result with an input again is a no-op (idempotent).
        out3 = self.path("o3.json")
        self.assertEqual(run_cli("merge", out1, right, "--out", out3).returncode, 0)
        with open(out3, "rb") as fh:
            self.assertEqual(fh.read(), b1)

    def test_negative_counter_exit_code_3(self):
        left = self.path("l.json", {"k": entry("v", {"n1": -1})})
        right = self.path("r.json", {})
        out = self.path("out.json")
        proc = run_cli("merge", left, right, "--out", out)
        self.assertEqual(proc.returncode, 3)
        self.assertIn("negative", proc.stderr.lower())
        self.assertFalse(os.path.exists(out))

    def test_missing_input_file_error(self):
        proc = run_cli(
            "merge", self.path("nope.json"), self.path("r.json", {}), "--out",
            self.path("out.json"),
        )
        self.assertEqual(proc.returncode, 1)
        self.assertTrue(proc.stderr.strip())

    def test_invalid_json_error(self):
        bad = self.path("bad.json")
        with open(bad, "w", encoding="utf-8") as fh:
            fh.write("{not json")
        proc = run_cli("merge", bad, self.path("r.json", {}), "--out", self.path("o.json"))
        self.assertEqual(proc.returncode, 1)
        self.assertTrue(proc.stderr.strip())

    def test_invalid_structure_error(self):
        left = self.path("l.json", {"k": {"value": 1}})
        proc = run_cli("merge", left, self.path("r.json", {}), "--out", self.path("o.json"))
        self.assertEqual(proc.returncode, 1)
        self.assertTrue(proc.stderr.strip())


if __name__ == "__main__":
    unittest.main()
