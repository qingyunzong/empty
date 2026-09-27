"""Acceptance tests for the add-wins OR-Set (orset.py).

A: <=4 nodes, <=15 ops, enumerate every final merge order; the resulting
   contains-set must match a happens-before reference model.
B: concurrent add vs remove -> add wins.
C: a late old remove message must not delete a revived element.
D: compact preserves query results (<=100 random queries) and replaying an
   old remove stays a no-op.
"""

import itertools
import json
import random
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from orset import ORSet  # noqa: E402

ORSET_PY = ROOT / "orset.py"


def clone(replica):
    """Deep copy via the JSON serialization round trip."""
    return ORSet.from_json(json.loads(json.dumps(replica.to_json())))


def gossip_all(replicas, rounds=3):
    """Merge every ordered pair of replicas; returns after full propagation."""
    for _ in range(rounds):
        for source, target in itertools.permutations(replicas, 2):
            replicas[target].merge(clone(replicas[source]))


# --------------------------------------------------------------------- model
class Event:
    __slots__ = ("id", "node", "kind", "elem", "preds")

    def __init__(self, eid, node, kind, elem, preds):
        self.id = eid
        self.node = node
        self.kind = kind
        self.elem = elem
        self.preds = frozenset(preds)


def reference_membership(events):
    """Element is present iff some add of it is not observed by any remove."""
    by_id = {ev.id: ev for ev in events}
    anc_cache = {}

    def ancestors(eid):
        if eid in anc_cache:
            return anc_cache[eid]
        result = set()
        for pred in by_id[eid].preds:
            result.add(pred)
            result |= ancestors(pred)
        anc_cache[eid] = result
        return result

    present = set()
    for ev in events:
        if ev.kind != "add":
            continue
        observed_by_remove = any(
            other.kind == "rem"
            and other.elem == ev.elem
            and ev.id in ancestors(other.id)
            for other in events
        )
        if not observed_by_remove:
            present.add(ev.elem)
    return present


# ---------------------------------------------------------------------- A
class TestMergeOrdersMatchReference(unittest.TestCase):
    def test_enumerate_merge_orders(self):
        for trial in range(30):
            rng = random.Random(1000 + trial)
            node_count = rng.randint(2, 4)
            op_count = rng.randint(4, 15)
            nodes = [f"N{i}" for i in range(node_count)]
            pool = [f"e{i}" for i in range(3)]
            replicas = {node: ORSet(node) for node in nodes}
            events = []
            last = {}

            def add_event(node, kind, elem, extra_preds=()):
                preds = set(extra_preds)
                if node in last:
                    preds.add(last[node])
                ev = Event(len(events), node, kind, elem, preds)
                events.append(ev)
                last[node] = ev.id

            for _ in range(op_count):
                node = rng.choice(nodes)
                roll = rng.random()
                if roll < 0.45:
                    elem = rng.choice(pool)
                    replicas[node].add(elem)
                    add_event(node, "add", elem)
                elif roll < 0.80:
                    elem = rng.choice(pool)
                    replicas[node].remove(elem)
                    add_event(node, "rem", elem)
                else:
                    others = [n for n in nodes if n != node]
                    source = rng.choice(others)
                    replicas[node].merge(clone(replicas[source]))
                    extra = {last[source]} if source in last else set()
                    add_event(node, "merge", None, extra)

            expected = reference_membership(events)
            results = []
            for perm in itertools.permutations(nodes):
                acc = clone(replicas[perm[0]])
                for name in perm[1:]:
                    acc.merge(clone(replicas[name]))
                results.append(acc)
                self.assertEqual(
                    acc.elements(),
                    expected,
                    f"trial {trial}: merge order {perm} disagrees with model",
                )
            for first, second in zip(results, results[1:]):
                self.assertEqual(first.live, second.live)
                self.assertEqual(first.tomb, second.tomb)

    def test_merge_properties(self):
        rng = random.Random(7)
        for _ in range(20):
            replicas = []
            for i in range(3):
                rep = ORSet(f"M{i}")
                for _ in range(rng.randint(0, 5)):
                    rep.add(f"e{rng.randint(0, 3)}")
                for _ in range(rng.randint(0, 3)):
                    rep.remove(f"e{rng.randint(0, 3)}")
                replicas.append(rep)
            a, b, c = (clone(r) for r in replicas)

            ab = clone(a)
            ab.merge(clone(b))
            ba = clone(b)
            ba.merge(clone(a))
            self.assertEqual(ab.live, ba.live, "merge not commutative")
            self.assertEqual(ab.tomb, ba.tomb)

            aa = clone(a)
            aa.merge(clone(a))
            self.assertEqual(aa.live, a.live, "merge not idempotent")
            self.assertEqual(aa.tomb, a.tomb)

            ab_c = clone(ab)
            ab_c.merge(clone(c))
            bc = clone(b)
            bc.merge(clone(c))
            a_bc = clone(a)
            a_bc.merge(bc)
            self.assertEqual(ab_c.live, a_bc.live, "merge not associative")
            self.assertEqual(ab_c.tomb, a_bc.tomb)


# ---------------------------------------------------------------------- B
class TestConcurrentAddWins(unittest.TestCase):
    def test_concurrent_add_beats_remove(self):
        alice, bob = ORSet("A"), ORSet("B")
        alice.add("x")          # concurrent adds of the same element
        bob.add("x")
        alice.remove("x")       # removes only the tag Alice observed
        alice.merge(clone(bob))
        bob.merge(clone(alice))
        self.assertTrue(alice.contains("x"))
        self.assertTrue(bob.contains("x"))
        self.assertEqual(alice.elements(), {"x"})

    def test_observed_remove_then_no_readd_is_absent(self):
        alice, bob = ORSet("A"), ORSet("B")
        alice.add("y")
        bob.merge(clone(alice))  # Bob observes the add
        bob.remove("y")          # and removes exactly that tag
        alice.merge(clone(bob))
        self.assertFalse(alice.contains("y"))
        self.assertFalse(bob.contains("y"))

    def test_remove_cannot_reach_undelivered_add(self):
        alice, bob = ORSet("A"), ORSet("B")
        alice.add("z")
        bob.remove("z")          # Bob never saw the add: removes nothing
        bob.merge(clone(alice))
        self.assertTrue(bob.contains("z"))


# ---------------------------------------------------------------------- C
class TestLateRemoveMessage(unittest.TestCase):
    def test_late_remove_does_not_delete_revived_element(self):
        alice, bob, carol = ORSet("A"), ORSet("B"), ORSet("C")
        alice.add("e")                     # tag t1
        bob.merge(clone(alice))            # Bob observes t1
        bob.remove("e")                    # Bob's remove targets t1 only
        old_remove_msg = clone(bob)        # captured but delivery delayed

        carol.merge(clone(alice))          # Carol sees t1
        alice.merge(clone(bob))            # remove delivered to Alice
        self.assertFalse(alice.contains("e"))
        alice.add("e")                     # revive with fresh tag t2
        carol.merge(clone(alice))          # Carol: t1 dead, t2 alive
        self.assertTrue(carol.contains("e"))

        carol.merge(old_remove_msg)        # late old remove arrives
        self.assertTrue(carol.contains("e"))

        # t1 stays dead: removing the element now kills it for good.
        carol.remove("e")
        alice.merge(clone(carol))
        bob.merge(clone(carol))
        for rep in (alice, bob, carol):
            self.assertFalse(rep.contains("e"))

    def test_replayed_remove_is_idempotent(self):
        alice, bob = ORSet("A"), ORSet("B")
        alice.add("e")
        bob.merge(clone(alice))
        bob.remove("e")
        msg = clone(bob)
        alice.merge(clone(msg))
        alice.merge(clone(msg))            # replay: no further effect
        self.assertFalse(alice.contains("e"))
        alice.add("e")                     # revive after remove observed
        alice.merge(clone(msg))            # replay again: revived tag survives
        self.assertTrue(alice.contains("e"))


# ---------------------------------------------------------------------- D
class TestCompact(unittest.TestCase):
    def _build_cluster(self):
        rng = random.Random(2024)
        nodes = ["N0", "N1", "N2"]
        replicas = {node: ORSet(node) for node in nodes}
        pool = [f"e{i}" for i in range(6)]
        for _ in range(30):
            node = rng.choice(nodes)
            roll = rng.random()
            if roll < 0.5:
                replicas[node].add(rng.choice(pool))
            elif roll < 0.8:
                replicas[node].remove(rng.choice(pool))
            else:
                other = rng.choice([n for n in nodes if n != node])
                replicas[node].merge(clone(replicas[other]))
        # Force a remove-then-revive pattern and capture the old remove.
        replicas["N0"].add("e0")
        gossip_all(replicas)
        replicas["N1"].remove("e0")
        old_remove_msg = clone(replicas["N1"])
        gossip_all(replicas)
        replicas["N2"].add("e0")           # revive e0
        gossip_all(replicas)
        return replicas, old_remove_msg

    def test_compact_preserves_queries_and_rejects_replay(self):
        replicas, old_remove_msg = self._build_cluster()
        rng = random.Random(99)
        pool = [f"e{i}" for i in range(6)] + ["ghost1", "ghost2"]
        queries = [rng.choice(pool) for _ in range(100)]

        before = {
            node: [rep.contains(q) for q in queries]
            for node, rep in replicas.items()
        }
        # Cluster converged before compaction.
        reference = before["N0"]
        for node in replicas:
            self.assertEqual(before[node], reference)

        made = {node: rep.compact() for node, rep in replicas.items()}
        self.assertTrue(any(count > 0 for count in made.values()))

        for node, rep in replicas.items():
            after = [rep.contains(q) for q in queries]
            self.assertEqual(after, before[node], f"compact changed {node}")

        # Replaying the old remove message must not change anything,
        # and the revived element must survive.
        for node, rep in replicas.items():
            rep.merge(clone(old_remove_msg))
            replayed = [rep.contains(q) for q in queries]
            self.assertEqual(replayed, before[node], f"replay affected {node}")
            self.assertTrue(rep.contains("e0"))

    def test_compact_is_transparent_to_concurrent_remove(self):
        alice, bob = ORSet("A"), ORSet("B")
        alice.add("e")                     # t1
        bob.merge(clone(alice))            # Bob observed t1
        alice.compact()                    # Alice folds t1 into a summary
        self.assertTrue(alice.contains("e"))
        bob.remove("e")                    # Bob removes exactly t1
        alice.merge(clone(bob))
        # The remove observed precisely the folded tags: element is gone.
        self.assertFalse(alice.contains("e"))

    def test_compact_summary_survives_stale_remove_after_revive(self):
        alice, bob = ORSet("A"), ORSet("B")
        alice.add("e")
        bob.merge(clone(alice))
        bob.remove("e")
        old_remove_msg = clone(bob)
        alice.merge(clone(bob))            # e gone everywhere
        alice.add("e")                     # revive with a fresh tag
        bob.merge(clone(alice))            # Bob observes the revival
        alice.merge(clone(bob))            # Alice learns Bob has seen it
        made = alice.compact()
        self.assertGreaterEqual(made, 1)
        self.assertTrue(alice.contains("e"))
        alice.merge(clone(old_remove_msg))  # stale remove replayed
        self.assertTrue(alice.contains("e"))

    def test_compact_does_not_fold_unobserved_tags(self):
        alice, bob = ORSet("A"), ORSet("B")
        alice.add("e")
        bob.merge(clone(alice))            # Bob knows t1, Alice doesn't know
        made = alice.compact()             # Alice only knows herself -> folds
        self.assertEqual(made, 1)
        alice.add("e")                     # new tag, unknown to Bob's view
        alice.merge(clone(bob))            # now Alice knows Bob is behind
        made2 = alice.compact()            # new tag not observed by Bob yet
        self.assertEqual(made2, 0)
        self.assertTrue(alice.contains("e"))


# -------------------------------------------------------------------- CLI
class TestCLI(unittest.TestCase):
    def run_cli(self, args, stdin_text):
        return subprocess.run(
            [sys.executable, str(ORSET_PY), *args],
            input=stdin_text,
            capture_output=True,
            text=True,
        )

    def test_cli_happy_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            a_state = str(Path(tmp) / "a.json")
            b_state = str(Path(tmp) / "b.json")

            proc = self.run_cli(
                [a_state, "--node", "A"],
                '{"op":"add","e":"x"}\n{"op":"contains","e":"x"}\n',
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            lines = [json.loads(line) for line in proc.stdout.splitlines()]
            self.assertTrue(lines[0]["ok"])
            self.assertEqual(lines[0]["tag"], ["A", 1])
            self.assertTrue(lines[1]["result"])

            proc = self.run_cli([b_state, "--node", "B"], '{"op":"add","e":"y"}\n')
            self.assertEqual(proc.returncode, 0, proc.stderr)

            proc = self.run_cli(
                [a_state],
                "\n".join(
                    [
                        json.dumps({"op": "merge", "file": b_state}),
                        '{"op":"contains","e":"y"}',
                        '{"op":"compact"}',
                        '{"op":"dump"}',
                    ]
                )
                + "\n",
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            lines = [json.loads(line) for line in proc.stdout.splitlines()]
            self.assertTrue(all(line["ok"] for line in lines))
            self.assertTrue(lines[1]["result"])
            self.assertIn("state", lines[3])
            self.assertEqual(lines[3]["state"]["node"], "A")

            proc = self.run_cli(
                [a_state], '{"op":"rem","e":"x"}\n{"op":"contains","e":"x"}\n'
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            lines = [json.loads(line) for line in proc.stdout.splitlines()]
            self.assertEqual(lines[0]["removed"], 1)
            self.assertFalse(lines[1]["result"])

    def test_cli_errors_exit_4(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = str(Path(tmp) / "s.json")

            proc = self.run_cli([state, "--node", "A"], '{"op":"bogus"}\n')
            self.assertEqual(proc.returncode, 4)
            self.assertFalse(json.loads(proc.stdout)["ok"])

            proc = self.run_cli([state, "--node", "A"], "not json\n")
            self.assertEqual(proc.returncode, 4)

            proc = self.run_cli([state, "--node", "A"], '{"op":"add"}\n')
            self.assertEqual(proc.returncode, 4)

            proc = self.run_cli(
                [state, "--node", "A"],
                json.dumps({"op": "merge", "file": str(Path(tmp) / "none.json")})
                + "\n",
            )
            self.assertEqual(proc.returncode, 4)

            missing = str(Path(tmp) / "missing.json")
            proc = self.run_cli([missing], '{"op":"contains","e":"x"}\n')
            self.assertEqual(proc.returncode, 4)


if __name__ == "__main__":
    unittest.main()
