"""Acceptance and semantics tests for the add-wins OR-Set."""
import itertools
import json
import random
import unittest

from orset import ORSet


# --------------------------------------------------------------------- harness
class RefModel:
    """Independent spec-level reference based on version vectors.

    A remove(e) covers exactly the add tags causally observed by the remover.
    At convergence, contains(e) is true iff some add tag of e is covered by
    no remove of e.  A remove can never cover an add not delivered to it.
    """

    def __init__(self, nodes):
        self.vv = {n: {m: 0 for m in nodes} for n in nodes}
        self.adds = []     # (element, node, stamp)
        self.removes = []  # (element, vector snapshot)

    def op(self, node, kind, element):
        self.vv[node][node] += 1
        if kind == "add":
            self.adds.append((element, node, self.vv[node][node]))
        else:
            self.removes.append((element, dict(self.vv[node])))

    def sync(self, dst, src):
        for n in self.vv[dst]:
            self.vv[dst][n] = max(self.vv[dst][n], self.vv[src][n])

    def contains(self, element):
        for e, node, stamp in self.adds:
            if e != element:
                continue
            covered = any(re == element and rv.get(node, 0) >= stamp
                          for re, rv in self.removes)
            if not covered:
                return True
        return False


def run_simulation(nodes, events):
    """Apply events to both the CRDT and the reference model.

    events: ('op', node, 'add'|'rem', element) | ('sync', dst, src)
    Returns (crdt_states, ref_model, all_elements).
    """
    states = {n: ORSet(n) for n in nodes}
    ref = RefModel(nodes)
    elements = set()
    for ev in events:
        if ev[0] == "op":
            _, node, kind, element = ev
            elements.add(element)
            if kind == "add":
                states[node].add(element)
            else:
                states[node].remove(element)
            ref.op(node, kind, element)
        else:
            _, dst, src = ev
            states[dst] = states[dst].merge(states[src])
            ref.sync(dst, src)
    return states, ref, elements


def random_events(rng, nodes, n_ops, elements, sync_prob=0.4):
    events = []
    for _ in range(n_ops):
        node = rng.choice(nodes)
        kind = "add" if rng.random() < 0.6 else "rem"
        events.append(("op", node, kind, rng.choice(elements)))
        if rng.random() < sync_prob:
            dst, src = rng.sample(nodes, 2)
            events.append(("sync", dst, src))
    return events


def canonical(state):
    """Canonical form of the *observable* payload.

    `node`/`counter` are replica-local metadata (the merge receiver keeps its
    own identity); CRDT equality is defined over live/dead/summary only.
    """
    payload = state.to_json()
    observable = {k: payload[k] for k in ("live", "dead", "summary")}
    return json.dumps(observable, sort_keys=True)


def merge_all(states, order):
    merged = states[order[0]]
    for i in order[1:]:
        merged = merged.merge(states[i])
    return merged


# ----------------------------------------------------------------------- tests
class TestMergeProperties(unittest.TestCase):
    """Merge must be commutative, associative and idempotent."""

    def test_three_properties(self):
        rng = random.Random(20261001)
        nodes = ["A", "B", "C"]
        for _ in range(30):
            events = random_events(rng, nodes, rng.randint(1, 15), list("abcd"))
            states, _, _ = run_simulation(nodes, events)
            a, b, c = (states[n] for n in nodes)
            self.assertEqual(canonical(a.merge(a)), canonical(a))            # idempotent
            self.assertEqual(canonical(a.merge(b)), canonical(b.merge(a)))   # commutative
            self.assertEqual(canonical(a.merge(b).merge(c)),                 # associative
                             canonical(a.merge(b.merge(c))))


class TestAllMergeOrdersMatchReference(unittest.TestCase):
    """Acceptance A: <=4 nodes, <=15 ops; every merge order matches the model."""

    def test_enumerate_merge_orders(self):
        checked_orders = 0
        for seed in range(40):
            rng = random.Random(seed)
            nodes = [chr(ord("A") + i) for i in range(rng.randint(2, 4))]
            n_ops = rng.randint(1, 15)
            elements = [f"e{i}" for i in range(rng.randint(1, 4))]  # well under 200
            events = random_events(rng, nodes, n_ops, elements)
            states, ref, used = run_simulation(nodes, events)
            self.assertLessEqual(sum(1 for e in events if e[0] == "op"), 15)
            names = list(nodes)
            results = []
            for order in itertools.permutations(names):
                merged = merge_all(states, order)
                results.append(canonical(merged))
                checked_orders += 1
                for element in used | {f"e{i}" for i in range(6)}:
                    self.assertEqual(
                        merged.contains(element), ref.contains(element),
                        f"seed={seed} order={order} element={element}")
            # Merge order must not matter: all converged states are identical.
            self.assertEqual(len(set(results)), 1, f"seed={seed}: divergence across merge orders")
        self.assertGreater(checked_orders, 0)


class TestConcurrentAddWins(unittest.TestCase):
    """Acceptance B: concurrent add and remove -> add wins."""

    def test_concurrent_add_and_remove(self):
        # Case 1: B removes an element whose concurrent add it never saw.
        a, b = ORSet("A"), ORSet("B")
        a.add("x")
        b.remove("x")  # observes nothing
        merged = a.merge(b)
        self.assertTrue(merged.contains("x"))

        # Case 2: both observed x; B removes it while A concurrently re-adds.
        a, b = ORSet("A"), ORSet("B")
        a.add("x")
        b = b.merge(a)
        b.remove("x")
        a.add("x")  # concurrent with B's remove
        merged = a.merge(b)
        self.assertTrue(merged.contains("x"))
        self.assertTrue(b.merge(a).contains("x"))  # order-independent

    def test_sequential_remove_still_wins(self):
        a = ORSet("A")
        a.add("x")
        b = ORSet("B").merge(a)
        b.remove("x")  # observes the add -> removes it
        self.assertFalse(a.merge(b).contains("x"))


class TestLateRemoveReplay(unittest.TestCase):
    """Acceptance C: a late/replayed old remove must not kill a revived element."""

    def test_late_and_replayed_remove(self):
        a = ORSet("A")
        a.add("x")                       # tag (A,0)
        b = ORSet("B").merge(a)
        b.remove("x")                    # tombstones (A,0)
        a.add("x")                       # tag (A,1), concurrent with B's remove
        late_remove_state = ORSet.from_json(b.to_json())  # the "remove message"

        a = a.merge(late_remove_state)   # late delivery of the remove
        self.assertTrue(a.contains("x"))

        a = a.merge(late_remove_state)   # replay of the same old remove
        self.assertTrue(a.contains("x"))

        # Even after compaction, replaying the stale remove is a no-op.
        barrier = a.merge(b)             # everyone has seen everything
        barrier.compact(["A", "B"])
        self.assertTrue(barrier.contains("x"))
        replayed = barrier.merge(late_remove_state)
        self.assertTrue(replayed.contains("x"))
        self.assertEqual(canonical(replayed), canonical(barrier.merge(replayed)))


class TestCompact(unittest.TestCase):
    """Acceptance D: compact preserves observables; old remove replays stay invalid."""

    def test_compact_preserves_queries_and_rejects_replays(self):
        rng = random.Random(777)
        nodes = ["A", "B", "C"]
        elements = [f"e{i}" for i in range(5)]
        events = random_events(rng, nodes, 100, elements, sync_prob=0.5)
        states, ref, _ = run_simulation(nodes, events)

        # Quiescence barrier: merge everything into one converged state.
        converged = states["A"]
        for n in nodes[1:]:
            converged = converged.merge(states[n])

        queries = [rng.choice(elements + ["zzz"]) for _ in range(100)]
        before = {q: converged.contains(q) for q in queries}
        for q in queries:  # sanity: converged CRDT agrees with reference model
            self.assertEqual(converged.contains(q), ref.contains(q))

        compacted = ORSet.from_json(converged.to_json())
        compacted.compact(nodes)
        after = {q: compacted.contains(q) for q in queries}
        self.assertEqual(before, after, "compact changed observable results")

        # Replaying pre-compact states (carrying old removes) changes nothing.
        for n in nodes:
            replayed = compacted.merge(states[n])
            for q in queries:
                self.assertEqual(replayed.contains(q), before[q],
                                 f"replay of {n}'s old state altered {q}")

        # Compact is idempotent and keeps rejecting replays.
        again = ORSet.from_json(compacted.to_json())
        again.compact(nodes)
        self.assertEqual(canonical(again), canonical(compacted))
        for n in nodes:
            replayed = again.merge(states[n])
            for q in queries:
                self.assertEqual(replayed.contains(q), before[q])

    def test_compact_actually_shrinks_state(self):
        a = ORSet("A")
        for i in range(10):
            a.add("x")
            a.remove("x")
        size_before = len(json.dumps(a.to_json()))
        a.compact(["A"])
        size_after = len(json.dumps(a.to_json()))
        self.assertLess(size_after, size_before)
        self.assertFalse(a.contains("x"))
        # Summary retains enough info: replaying a pre-compact remove is a no-op.
        b = ORSet("B").merge(a)
        self.assertFalse(b.contains("x"))


if __name__ == "__main__":
    unittest.main()
