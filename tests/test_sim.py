import unittest

from crdtsim.sim import Sim


def cluster(*nodes):
    sim = Sim()
    for n in nodes:
        sim.add_node(n)
    sim.run()
    return sim


class TestDelivery(unittest.TestCase):
    def test_delayed_delivery(self):
        sim = cluster("A", "B")
        sim.write("A", "k", "v1", delay=5)
        sim.run_ready()
        self.assertEqual(sim.read("B", "k"), [])  # not yet due
        sim.tick(5)
        sim.run_ready()
        self.assertEqual(sim.read("B", "k"), ["v1"])

    def test_duplicate_delivery_is_idempotent(self):
        sim = cluster("A", "B")
        sim.write("A", "k", "v1", duplicates=3)
        sim.run()
        self.assertEqual(sim.read("B", "k"), ["v1"])
        self.assertEqual(len(sim.replicas["B"].entries["k"]), 1)

    def test_partition_blocks_and_heal_releases(self):
        sim = cluster("A", "B")
        sim.partition("A", "B")
        sim.write("A", "k", "v1")
        sim.run()
        self.assertEqual(sim.read("B", "k"), [])
        sim.heal("A", "B")
        sim.run()
        self.assertEqual(sim.read("B", "k"), ["v1"])

    def test_partition_concurrent_writes_merge(self):
        sim = cluster("A", "B")
        sim.partition("A", "B")
        sim.write("A", "k", "va")
        sim.write("B", "k", "vb")
        sim.run()
        self.assertEqual(sim.read("A", "k"), ["va"])
        self.assertEqual(sim.read("B", "k"), ["vb"])
        sim.heal("A", "B")
        sim.run()
        for n in ("A", "B"):
            self.assertEqual(sim.read(n, "k"), ["va", "vb"])

    def test_delete_during_partition_then_merge(self):
        sim = cluster("A", "B")
        sim.write("A", "k", "v1")
        sim.run()
        sim.partition("A", "B")
        sim.delete("B", "k")
        sim.write("A", "k", "v2")  # concurrent with the delete
        sim.run()
        sim.heal("A", "B")
        sim.run()
        for n in ("A", "B"):
            self.assertEqual(sim.read(n, "k"), ["v2"])


class TestMembership(unittest.TestCase):
    def test_rejoin_uses_new_epoch(self):
        sim = cluster("A", "B")
        sim.write("A", "k", "v1")
        sim.run()
        sim.retire("A")
        sim.rejoin("A")
        sim.run()
        self.assertEqual(sim.replicas["A"].epoch, 2)
        members = sim.replicas["B"].members
        self.assertIn(("A", 2), members)
        self.assertNotIn(("A", 1), members)

    def test_old_epoch_message_does_not_resurrect_deleted_value(self):
        sim = cluster("A", "B")
        sim.write("A", "k", "v1", duplicates=2)  # second copy lands later
        sim.deliver_next()  # first copy -> B
        sim.delete("B", "k")
        sim.run()  # tomb propagates; duplicate copy of v1 arrives after
        self.assertEqual(sim.read("B", "k"), [])
        self.assertEqual(sim.read("A", "k"), [])

    def test_retired_member_writes_are_dropped(self):
        sim = cluster("A", "B")
        sim.write("A", "k", "v1", delay=10)  # still in flight
        sim.retire("A")
        sim.run()
        self.assertNotIn("A", sim.replicas)
        self.assertEqual(sim.read("B", "k"), ["v1"])  # B still gets it

    def test_rejoined_member_blocks_gc_until_it_acks(self):
        sim = cluster("A", "B", "C")
        sim.write("A", "k", "v1")
        sim.run()
        sim.delete("A", "k")
        sim.run()
        sim.broadcast_acks()
        sim.run()
        self.assertEqual(sim.gc("A"), 1)  # all current members acked
        # C retires and rejoins with a fresh (empty) state.
        sim.retire("C")
        sim.rejoin("C")
        sim.run()
        sim.write("A", "j", "w")
        sim.delete("A", "j")
        sim.run()
        sim.broadcast_acks()
        sim.run()
        # Rejoined C has empty kv: frontier cannot cover the new delete.
        self.assertEqual(sim.gc("A"), 0)
        # Anti-entropy catches C up; its ack then unblocks GC.
        sim.sync("B", "C")
        sim.broadcast_acks()
        sim.run()
        self.assertEqual(sim.gc("A"), 1)


class TestReplayAndRecovery(unittest.TestCase):
    def test_event_log_replay_reproduces_state(self):
        sim = cluster("A", "B", "C")
        sim.partition("A", "B")
        sim.write("A", "k", "va")
        sim.write("B", "k", "vb", duplicates=2)
        sim.delete("C", "missing")
        sim.heal("A", "B")
        sim.write("C", "j", "vc", delay=2)
        sim.run()
        sim.broadcast_acks()
        sim.run()
        sim.gc("A")
        replayed = Sim.replay(sim.log)
        self.assertEqual(replayed.fingerprint(), sim.fingerprint())

    def test_crash_during_merge_recovers_from_snapshot(self):
        sim = cluster("A", "B")
        sim.write("A", "k", "v1")
        sim.write("B", "j", "v2")
        sim.run()
        snap = sim.snapshot("B")
        # B crashes mid-merge: restore pre-merge snapshot, then re-merge.
        before = sim.replicas["B"].snapshot()
        sim.replicas["B"].merge_state(sim.replicas["A"])
        sim.restore("B", snap)
        self.assertEqual(sim.replicas["B"].snapshot(), before)
        sim.replicas["B"].merge_state(sim.replicas["A"])
        merged_once = sim.replicas["B"].snapshot()
        sim.replicas["B"].merge_state(sim.replicas["A"])  # retry: idempotent
        self.assertEqual(sim.replicas["B"].snapshot(), merged_once)
        self.assertEqual(sim.read("B", "k"), ["v1"])


if __name__ == "__main__":
    unittest.main()
