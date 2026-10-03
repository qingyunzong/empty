import unittest

from dvv.network import Network


def three_node_net():
    net = Network()
    for nid in ("a", "b", "c"):
        net.add_node(nid)
    net.run()  # deliver config messages
    return net


class TestPartitionAndDelay(unittest.TestCase):
    def test_partition_creates_concurrent_values_heal_merges(self):
        net = three_node_net()
        net.partition("a", "b")
        net.put("a", "k", "A")
        net.put("b", "k", "B")
        net.run()  # a<->b blocked, c sees nothing new yet
        self.assertEqual([r["value"] for r in net.read("a", "k")], ["A"])
        self.assertEqual([r["value"] for r in net.read("b", "k")], ["B"])
        net.heal("a", "b")
        net.run()
        for nid in ("a", "b", "c"):
            self.assertEqual(sorted(r["value"] for r in net.read(nid, "k")),
                             ["A", "B"])

    def test_delayed_and_duplicate_delivery(self):
        net = three_node_net()
        net.put("a", "k", "v", delay=5, duplicates=2)
        net.run()  # nothing eligible before t=5
        self.assertEqual(net.read("b", "k"), [])
        net.advance(5)
        net.run()
        self.assertEqual([r["value"] for r in net.read("b", "k")], ["v"])
        self.assertEqual([r["value"] for r in net.read("c", "k")], ["v"])

    def test_messages_queued_during_partition_deliver_after_heal(self):
        net = three_node_net()
        net.partition("a", "c")
        net.put("a", "k", 1)
        net.run()
        self.assertEqual(net.read("c", "k"), [])
        self.assertTrue(net.queue)  # a->c copy still queued
        net.heal("a", "c")
        net.run()
        self.assertEqual([r["value"] for r in net.read("c", "k")], [1])


class TestCrashRecovery(unittest.TestCase):
    def script(self, net, crash):
        net.put("a", "x", 1)
        net.put("a", "y", 2)
        net.put("b", "x", 10)
        net.snapshot("c", "before-merge")
        net.deliver_next()
        net.deliver_next()
        if crash:
            net.restore("c", "before-merge")  # crash mid-merge: roll back
            net.resync("c")                   # peers re-send their journals
        net.run()
        return net

    def test_crash_mid_merge_recovers_to_same_state(self):
        crashed = self.script(three_node_net(), crash=True)
        clean = self.script(three_node_net(), crash=False)
        self.assertEqual(crashed.digest(), clean.digest())

    def test_redelivery_after_restore_is_idempotent(self):
        net = three_node_net()
        net.put("a", "x", 1, duplicates=2)
        net.run()
        net.snapshot("b", "s")
        net.run()  # duplicate copies still queued: delivered again, dropped
        self.assertEqual(net.nodes["b"].snapshot(), net.snapshots["s"])
        net.restore("b", "s")
        net.resync("b")  # recovery merge re-sends everything; all duplicates
        net.run()
        self.assertEqual([r["value"] for r in net.read("b", "x")], [1])
        self.assertEqual(net.nodes["b"].snapshot(), net.snapshots["s"])


class TestEventLogReplay(unittest.TestCase):
    def test_replay_reproduces_digest(self):
        net = three_node_net()
        net.partition("a", "b")
        net.put("a", "k", "A", duplicates=2)
        net.put("b", "k", "B", delay=3)
        net.delete("a", "k")
        net.run()
        net.heal("a", "b")
        net.run()
        net.send_acks("a")
        net.send_acks("b")
        net.run()
        net.gc("c")
        replica = Network.replay(net.log)
        self.assertEqual(replica.digest(), net.digest())
        # replayed log is identical to the original
        self.assertEqual(replica.log, net.log)


if __name__ == "__main__":
    unittest.main()
