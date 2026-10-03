import unittest

from dvv.context import CausalContext
from dvv.event import PUT, Event
from dvv.node import Node


def make_event(node, epoch, counter, key, value, deps=()):
    context = CausalContext.from_dots(list(deps) + [(node, epoch, counter)])
    return Event((node, epoch, counter), key, PUT, value, context)


class TestLocalWrites(unittest.TestCase):
    def test_put_and_read(self):
        n = Node("a")
        n.put("k", "v1")
        self.assertEqual([r["value"] for r in n.read("k")], ["v1"])

    def test_dots_are_unique_and_monotonic(self):
        n = Node("a")
        e1 = n.put("k", 1)
        e2 = n.put("k", 2)
        self.assertEqual(e1.dot, ("a", 1, 1))
        self.assertEqual(e2.dot, ("a", 1, 2))

    def test_concurrent_puts_keep_multiple_values(self):
        a, b = Node("a"), Node("b")
        ea = a.put("k", "from-a")
        eb = b.put("k", "from-b")
        a.deliver(eb)
        b.deliver(ea)
        for node in (a, b):
            self.assertEqual(sorted(r["value"] for r in node.read("k")),
                             ["from-a", "from-b"])

    def test_causal_overwrite_keeps_single_value(self):
        a, b = Node("a"), Node("b")
        e1 = a.put("k", "old")
        b.deliver(e1)
        e2 = b.put("k", "new")
        a.deliver(e2)
        self.assertEqual([r["value"] for r in a.read("k")], ["new"])


class TestDelivery(unittest.TestCase):
    def test_duplicate_delivery_is_idempotent(self):
        a, b = Node("a"), Node("b")
        e = a.put("k", "v")
        self.assertEqual(b.deliver(e), "delivered")
        self.assertEqual(b.deliver(e), "duplicate")
        self.assertEqual(len(b.read("k")), 1)

    def test_out_of_order_delivery_buffers_until_deps_arrive(self):
        a, b = Node("a"), Node("b")
        e1 = a.put("x", 1)
        e2 = a.put("y", 2)  # depends on e1
        self.assertEqual(b.deliver(e2), "buffered")
        self.assertEqual(b.read("y"), [])
        self.assertEqual(b.deliver(e1), "delivered")
        self.assertEqual([r["value"] for r in b.read("y")], [2])

    def test_causal_hole_blocks_dependent_event(self):
        # event claims dependency on ("a",1,2) which never arrives
        b = Node("b")
        ev = make_event("a", 1, 3, "k", "v", deps=[("a", 1, 1), ("a", 1, 2)])
        self.assertEqual(b.deliver(ev), "buffered")
        b.deliver(make_event("a", 1, 1, "other", 1))
        self.assertEqual(b.read("k"), [])  # hole at counter 2 still blocks
        b.deliver(make_event("a", 1, 2, "other", 2))
        self.assertEqual([r["value"] for r in b.read("k")], ["v"])

    def test_holey_context_cannot_masquerade_as_prefix(self):
        # a forged context claiming contig=3 without delivering 1..3 must be
        # rejected at deserialization; and delivery checks real dependencies.
        b = Node("b")
        forged = Event(("a", 1, 4), "k", PUT, "v",
                       CausalContext({("a", 1): [4, set()]}))
        self.assertEqual(b.deliver(forged), "buffered")
        self.assertEqual(b.read("k"), [])


class TestDeleteAndTombstones(unittest.TestCase):
    def test_delete_removes_dominated_put(self):
        n = Node("a")
        n.put("k", "v")
        n.delete("k")
        self.assertEqual(n.read("k"), [])

    def test_concurrent_put_survives_delete(self):
        a, b = Node("a"), Node("b")
        e_put = a.put("k", "concurrent")
        b.put("k", "seen")
        e_del = b.delete("k")  # only saw its own put
        a.deliver(e_del)
        b.deliver(e_put)
        self.assertEqual([r["value"] for r in a.read("k")], ["concurrent"])
        self.assertEqual([r["value"] for r in b.read("k")], ["concurrent"])

    def test_replayed_old_write_does_not_resurrect(self):
        a, b = Node("a"), Node("b")
        e_put = a.put("k", "old")
        b.deliver(e_put)
        e_del = b.delete("k")
        self.assertEqual(b.deliver(e_put), "duplicate")
        # a third node applies the same put and delete: no resurrection
        c = Node("c")
        c.deliver(e_put)
        c.deliver(e_del)
        self.assertEqual(c.read("k"), [])
        # now replay the old put again after the tombstone exists
        self.assertEqual(c.deliver(e_put), "duplicate")

    def test_late_old_write_after_delete_is_dropped(self):
        a, b = Node("a"), Node("b")
        e_put = a.put("k", "stale")
        b.deliver(e_put)
        e_del = b.delete("k")
        c = Node("c")
        c.deliver(e_del)      # c learns the delete first
        c.deliver(e_put)      # stale write arrives late
        self.assertEqual(c.read("k"), [])


class TestSnapshot(unittest.TestCase):
    def test_snapshot_restore_roundtrip(self):
        a = Node("a")
        a.put("k", 1)
        a.delete("k")
        a.put("x", 2)
        snap = a.snapshot()
        restored = Node.restore(snap)
        self.assertEqual(restored.snapshot(), snap)
        self.assertEqual([r["value"] for r in restored.read("x")], [2])
        self.assertEqual(restored.read("k"), [])

    def test_restore_continues_counters(self):
        a = Node("a")
        a.put("k", 1)
        restored = Node.restore(a.snapshot())
        e = restored.put("k", 2)
        self.assertEqual(e.dot, ("a", 1, 2))


if __name__ == "__main__":
    unittest.main()
