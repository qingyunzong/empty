import unittest

from dvv.context import CausalContext
from dvv.enumcheck import (count_linear_extensions, relation_matrix,
                           transitive_closure, verify)
from dvv.event import DELETE, PUT, Event
from dvv.network import Network
from dvv.node import Node


def ev(node, epoch, counter, key, kind=PUT, value=None, deps=()):
    ctx = CausalContext.from_dots(list(deps) + [(node, epoch, counter)])
    return Event((node, epoch, counter), key, kind, value, ctx)


class TestDagAndClosure(unittest.TestCase):
    def test_chain_has_single_order(self):
        events = [ev("a", 1, 1, "k", value=1),
                  ev("a", 1, 2, "k", value=2, deps=[("a", 1, 1)]),
                  ev("a", 1, 3, "k", value=3, deps=[("a", 1, 2)])]
        self.assertEqual(count_linear_extensions(events), 1)

    def test_independent_events_have_factorial_orders(self):
        events = [ev(n, 1, 1, "k", value=n) for n in "abcd"]
        self.assertEqual(count_linear_extensions(events), 24)

    def test_transitive_closure_and_concurrency(self):
        a1 = ev("a", 1, 1, "x", value=1)
        b1 = ev("b", 1, 1, "x", value=2)
        a2 = ev("a", 1, 2, "x", value=3, deps=[("a", 1, 1), ("b", 1, 1)])
        rel = relation_matrix([a1, b1, a2])
        self.assertIn((a1.dot, a2.dot), rel["before"])
        self.assertIn((b1.dot, a2.dot), rel["before"])
        self.assertIn((a1.dot, b1.dot), rel["concurrent"])
        # closure reaches transitively: a1 before a2 even via b1
        deps = {a1.dot: set(), b1.dot: set(), a2.dot: {a1.dot, b1.dot}}
        reach = transitive_closure(deps)
        self.assertEqual(reach[a2.dot], {a1.dot, b1.dot})


class TestVerify(unittest.TestCase):
    def scenario_events(self):
        net = Network()
        for nid in ("a", "b", "c", "d"):
            net.add_node(nid)
        net.run()
        events = []
        net.partition("a", "b")
        net.partition("c", "d")
        events.append(net.put("a", "x", "A1"))
        events.append(net.put("b", "x", "B1"))
        events.append(net.put("c", "x", "C1"))
        net.heal("a", "b")
        net.run()
        events.append(net.put("a", "x", "A2"))   # saw A1, B1
        events.append(net.delete("b", "x"))      # saw A1, B1, A2
        net.heal("c", "d")
        net.run()
        events.append(net.put("d", "y", "D1"))
        net.run()
        return events

    def test_verify_ok_on_four_replica_scenario(self):
        events = self.scenario_events()
        self.assertLessEqual(len(events), 12)
        report = verify(events)
        self.assertEqual(report["status"], "ok", report)
        self.assertGreater(report["orders"], 1)
        self.assertGreater(len(report["relations"]["concurrent"]), 0)
        self.assertGreater(len(report["relations"]["before"]), 0)

    def test_verify_at_scale_four_replicas_twelve_events(self):
        net = Network()
        for nid in ("r1", "r2", "r3", "r4"):
            net.add_node(nid)
        net.run()
        events = []
        net.partition("r1", "r2")
        net.partition("r3", "r4")
        events.append(net.put("r1", "x", 1))
        events.append(net.put("r2", "x", 2))
        events.append(net.put("r3", "y", 3))
        events.append(net.put("r4", "x", 4))
        net.heal("r1", "r2")
        net.run()
        events.append(net.put("r1", "y", 5))
        events.append(net.delete("r2", "x"))
        net.partition("r1", "r3")
        events.append(net.put("r2", "y", 6))
        net.heal("r3", "r4")
        net.heal("r1", "r3")
        net.run()
        events.append(net.put("r3", "x", 7))
        events.append(net.delete("r4", "y"))
        net.run()
        events.append(net.put("r4", "x", 8))
        events.append(net.put("r1", "x", 9))
        events.append(net.delete("r3", "x"))
        self.assertEqual(len(events), 12)
        report = verify(events, keys=["x", "y"])
        self.assertEqual(report["status"], "ok", report)
        self.assertGreater(report["orders"], 100)

    def test_verify_detects_delete_ignored_with_shortest_counterexample(self):
        put = ev("a", 1, 1, "k", value="old")
        delete = Event(("a", 1, 2), "k", DELETE, None,
                       CausalContext.from_dots([("a", 1, 1), ("a", 1, 2)]))

        class BrokenNode(Node):  # deletes never remove dominated versions
            def _apply(self, event):
                if event.kind == PUT:
                    super()._apply(event)
                else:
                    self.delivered = self.delivered.merge(event.context)

        report = verify([put, delete],
                        node_factory=lambda: BrokenNode("verifier"))
        self.assertEqual(report["status"], "fail")
        # shortest counterexample: put then delete, value must be gone
        self.assertEqual(report["counterexample"],
                         [["a", 1, 1], ["a", 1, 2]])
        self.assertEqual(report["actual"], ["old"])
        self.assertEqual(report["expected"], [])

    def test_verify_detects_replay_resurrection_after_premature_gc(self):
        # tombstone reclaimed before the stable frontier covers the delete,
        # then the old write is replayed: the value must not come back.
        put = ev("a", 1, 1, "k", value="old")
        delete = Event(("a", 1, 2), "k", DELETE, None,
                       CausalContext.from_dots([("a", 1, 1), ("a", 1, 2)]))

        class BrokenNode(Node):
            def deliver(self, event):  # no duplicate suppression
                if event.dot in self.delivered and event.kind == PUT:
                    self._apply(event)  # re-applies replays!
                    return "delivered"
                return super().deliver(event)

            def _add_tombstone(self, key, context):
                pass  # stable frontier misused: tombstone reclaimed at once

        report = verify([put, delete], redeliver=True,
                        node_factory=lambda: BrokenNode("verifier"))
        self.assertEqual(report["status"], "fail")
        self.assertEqual(report["counterexample"], [["a", 1, 1], ["a", 1, 2]])
        self.assertTrue(report["replayed"])

    def test_correct_node_passes_with_redelivery(self):
        put = ev("a", 1, 1, "k", value="old")
        delete = Event(("a", 1, 2), "k", DELETE, None,
                       CausalContext.from_dots([("a", 1, 1), ("a", 1, 2)]))
        report = verify([put, delete], redeliver=True)
        self.assertEqual(report["status"], "ok", report)

    def test_diamond_dag_has_two_orders(self):
        a1 = ev("a", 1, 1, "x", value=1)
        b1 = ev("b", 1, 1, "x", value=2, deps=[("a", 1, 1)])
        c1 = ev("c", 1, 1, "x", value=3, deps=[("a", 1, 1)])
        d1 = ev("d", 1, 1, "x", value=4,
                deps=[("b", 1, 1), ("c", 1, 1)])
        events = [a1, b1, c1, d1]
        self.assertEqual(count_linear_extensions(events), 2)
        report = verify(events)
        self.assertEqual(report["status"], "ok", report)


if __name__ == "__main__":
    unittest.main()
