import unittest

from crdtsim.dvv import CausalContext
from crdtsim.store import Entry, Replica, Tombstone


def make_cluster(*names):
    replicas = {n: Replica(n, 1) for n in names}
    members = sorted(r.identity for r in replicas.values())
    for r in replicas.values():
        r.set_config(1, members)
    return replicas


def deliver_all(entry, *replicas):
    for r in replicas:
        assert r.deliver_put(entry)


def entry_sets(replica):
    return {k: frozenset(v) for k, v in replica.entries.items()}


class TestLocalWrites(unittest.TestCase):
    def test_local_write_and_read(self):
        r = Replica("A")
        r.write("k", "v1")
        self.assertEqual(r.read("k"), ["v1"])

    def test_causal_overwrite_keeps_only_latest(self):
        r = Replica("A")
        r.write("k", "v1")
        r.write("k", "v2")
        self.assertEqual(r.read("k"), ["v2"])

    def test_concurrent_writes_keep_all_maximal(self):
        rs = make_cluster("A", "B")
        ea = rs["A"].write("k", "va")
        eb = rs["B"].write("k", "vb")
        deliver_all(ea, rs["B"])
        deliver_all(eb, rs["A"])
        for r in rs.values():
            self.assertEqual(r.read("k"), ["va", "vb"])

    def test_read_returns_causally_maximal_only(self):
        rs = make_cluster("A", "B")
        e1 = rs["A"].write("k", "old")
        deliver_all(e1, rs["B"])
        e2 = rs["B"].write("k", "new")  # sees e1, supersedes it
        deliver_all(e2, rs["A"])
        for r in rs.values():
            self.assertEqual(r.read("k"), ["new"])


class TestDeliveryPreconditions(unittest.TestCase):
    def test_dependencies_must_arrive_first(self):
        rs = make_cluster("A", "B", "C")
        e1 = rs["A"].write("k", "v1")
        e2 = rs["A"].write("j", "v2")  # depends on e1
        # C receives e2 before e1: must buffer, not apply.
        self.assertFalse(rs["C"].deliver_put(e2))
        self.assertEqual(rs["C"].read("j"), [])
        self.assertTrue(rs["C"].deliver_put(e1))
        self.assertEqual(rs["C"].read("j"), ["v2"])  # flushed from buffer

    def test_gap_in_stream_is_not_accepted(self):
        rs = make_cluster("A", "B")
        rs["A"].write("k", "v1")
        e2 = rs["A"].write("k", "v2")
        # B never saw counter 1: e2 has a hole, cannot be delivered.
        self.assertFalse(rs["B"].deliver_put(e2))
        self.assertEqual(rs["B"].read("k"), [])
        self.assertEqual(len(rs["B"].buffer), 1)

    def test_duplicate_delivery_is_idempotent(self):
        rs = make_cluster("A", "B")
        e1 = rs["A"].write("k", "v1")
        self.assertTrue(rs["B"].deliver_put(e1))
        self.assertTrue(rs["B"].deliver_put(e1))
        self.assertEqual(rs["B"].read("k"), ["v1"])
        self.assertEqual(len(rs["B"].entries["k"]), 1)


class TestDeleteAndTombstones(unittest.TestCase):
    def test_delete_removes_covered_values(self):
        rs = make_cluster("A", "B")
        e1 = rs["A"].write("k", "v1")
        deliver_all(e1, rs["B"])
        tomb = rs["B"].delete("k")
        self.assertEqual(rs["B"].read("k"), [])
        self.assertTrue(rs["A"].deliver_delete(tomb))
        self.assertEqual(rs["A"].read("k"), [])

    def test_replayed_old_write_does_not_resurrect(self):
        rs = make_cluster("A", "B")
        e1 = rs["A"].write("k", "v1")
        deliver_all(e1, rs["B"])
        tomb = rs["B"].delete("k")
        rs["A"].deliver_delete(tomb)
        # The old put is replayed (e.g. retransmitted) after the delete.
        rs["B"].deliver_put(e1)
        rs["A"].deliver_put(e1)
        self.assertEqual(rs["A"].read("k"), [])
        self.assertEqual(rs["B"].read("k"), [])

    def test_concurrent_write_survives_delete(self):
        rs = make_cluster("A", "B")
        e1 = rs["A"].write("k", "v1")
        deliver_all(e1, rs["B"])
        tomb = rs["B"].delete("k")
        ec = rs["A"].write("k", "concurrent")  # did not see the delete
        rs["B"].deliver_put(ec)
        rs["A"].deliver_delete(tomb)
        self.assertEqual(rs["B"].read("k"), ["concurrent"])
        self.assertEqual(rs["A"].read("k"), ["concurrent"])


class TestStableFrontierGC(unittest.TestCase):
    def setUp(self):
        self.rs = make_cluster("A", "B")
        e1 = self.rs["A"].write("k", "v1")
        deliver_all(e1, self.rs["B"])
        self.tomb = self.rs["A"].delete("k")
        self.rs["B"].deliver_delete(self.tomb)

    def test_no_collection_before_acks(self):
        self.assertEqual(self.rs["A"].gc_tombstones(), 0)
        self.assertTrue(self.rs["A"].tombstones)

    def test_collection_once_frontier_covers_delete(self):
        a, b = self.rs["A"], self.rs["B"]
        a.receive_ack(b.identity, 1, b.kv)
        b.receive_ack(a.identity, 1, a.kv)
        self.assertEqual(a.gc_tombstones(), 1)
        self.assertFalse(a.tombstones)
        self.assertEqual(b.gc_tombstones(), 1)

    def test_lagging_config_ack_does_not_advance_frontier(self):
        a, b = self.rs["A"], self.rs["B"]
        a.set_config(2, [a.identity, b.identity])  # membership changed
        a.receive_ack(b.identity, 1, b.kv)  # stale config version
        self.assertIsNone(a.stable_frontier())
        self.assertEqual(a.gc_tombstones(), 0)
        a.receive_ack(b.identity, 2, b.kv)  # current config ack
        self.assertIsNotNone(a.stable_frontier())
        self.assertEqual(a.gc_tombstones(), 1)

    def test_retired_member_not_required_for_frontier(self):
        a, b = self.rs["A"], self.rs["B"]
        a.set_config(2, [a.identity])  # B retired
        self.assertIsNotNone(a.stable_frontier())
        self.assertEqual(a.gc_tombstones(), 1)


class TestStateMergeLaws(unittest.TestCase):
    def build(self):
        rs = make_cluster("A", "B", "C")
        e1 = rs["A"].write("k", "va")
        e2 = rs["B"].write("k", "vb")
        rs["C"].deliver_put(e1)
        rs["C"].write("j", "vc")
        return rs

    def test_merge_commutative_and_associative_and_idempotent(self):
        rs = self.build()
        ab = Replica("x"); ab.merge_state(rs["A"]); ab.merge_state(rs["B"])
        ba = Replica("x"); ba.merge_state(rs["B"]); ba.merge_state(rs["A"])
        self.assertEqual(ab.kv, ba.kv)
        self.assertEqual(entry_sets(ab), entry_sets(ba))
        abc = Replica("y")
        abc.merge_state(ab); abc.merge_state(rs["C"])
        bca = Replica("y")
        bca.merge_state(rs["B"]); bca.merge_state(rs["C"])
        bca.merge_state(rs["A"])
        self.assertEqual(abc.kv, bca.kv)
        self.assertEqual(entry_sets(abc), entry_sets(bca))
        again = Replica("y"); again.merge_state(abc); again.merge_state(abc)
        self.assertEqual(again.kv, abc.kv)
        self.assertEqual(entry_sets(again), entry_sets(abc))


class TestSnapshot(unittest.TestCase):
    def test_snapshot_restore_roundtrip(self):
        rs = make_cluster("A", "B")
        e1 = rs["A"].write("k", "v1")
        deliver_all(e1, rs["B"])
        rs["B"].delete("k")
        rs["B"].receive_ack(rs["A"].identity, 1, rs["A"].kv)
        snap = rs["B"].snapshot()
        clone = Replica.restore(snap)
        self.assertEqual(clone.snapshot(), snap)
        self.assertEqual(clone.read("k"), [])
        self.assertEqual(clone.stable_frontier(), rs["B"].stable_frontier())


if __name__ == "__main__":
    unittest.main()
