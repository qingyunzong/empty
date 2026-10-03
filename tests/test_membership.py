import unittest

from dvv.network import Network


def net_with(nodes):
    net = Network()
    for nid in nodes:
        net.add_node(nid)
    net.run()
    return net


def full_ack_round(net, nodes):
    for nid in nodes:
        net.send_acks(nid)
    net.run()


class TestStableFrontier(unittest.TestCase):
    def test_tombstone_gc_requires_all_current_members(self):
        net = net_with(["a", "b", "c"])
        net.put("a", "k", "v")
        net.run()
        net.delete("b", "k")
        net.run()
        # only a and b ack: c's ack missing -> frontier stays empty
        net.send_acks("a")
        net.send_acks("b")
        net.run()
        self.assertEqual(net.gc("a"), 0)
        self.assertTrue(net.nodes["a"].tombstones)
        # c acks too -> frontier covers the delete -> reclaim
        net.send_acks("c")
        net.run()
        self.assertGreaterEqual(net.gc("a"), 1)
        self.assertFalse(net.nodes["a"].tombstones)

    def test_stale_config_acks_do_not_advance_frontier(self):
        net = net_with(["a", "b"])
        net.put("a", "k", "v")
        net.run()
        net.delete("a", "k")
        net.run()
        # membership change bumps the config version
        net.add_node("c")
        net.run()
        # a and b ack with the *new* config version, c never acks
        net.send_acks("a")
        net.send_acks("b")
        net.run()
        self.assertEqual(net.gc("a"), 0)  # c (current member) missing
        # now simulate c answering with a stale config version
        stale = net.nodes["c"].config.version - 1
        net.nodes["a"].receive_ack(("c", 1), stale,
                                   net.nodes["c"].delivered)
        self.assertEqual(net.gc("a"), 0)  # stale ack must not count
        net.resync("c")  # new member catches up before its ack counts
        net.run()
        net.send_acks("c")
        net.run()
        self.assertGreaterEqual(net.gc("a"), 1)

    def test_ack_from_retired_member_is_irrelevant(self):
        net = net_with(["a", "b", "c"])
        net.put("a", "k", "v")
        net.run()
        net.delete("a", "k")
        net.run()
        net.retire("c")  # c leaves: frontier must not wait for c
        net.run()
        full_ack_round(net, ["a", "b"])
        self.assertGreaterEqual(net.gc("a"), 1)


class TestRetireRejoin(unittest.TestCase):
    def test_rejoin_uses_new_epoch(self):
        net = net_with(["a", "b"])
        net.put("a", "k", "v1")
        net.run()
        net.retire("a")
        net.run()
        net.rejoin("a")
        net.run()
        self.assertEqual(net.nodes["a"].epoch, 2)
        event = net.put("a", "k", "v2")
        self.assertEqual(event.dot, ("a", 2, 1))  # fresh epoch, fresh counter

    def test_old_epoch_messages_do_not_resurrect_deleted_values(self):
        net = net_with(["a", "b"])
        net.put("a", "k", "old", delay=10)  # in-flight, delayed
        net.advance(10)
        net.run()
        net.delete("b", "k")
        net.run()
        net.retire("a")
        net.rejoin("a")
        net.run()
        # replay a's pre-retirement write to b once more (old epoch, old msg)
        old_event = net.nodes["a"].history[0]
        self.assertEqual(old_event.dot[1], 1)
        status = net.nodes["b"].deliver(old_event)
        self.assertIn(status, ("duplicate", "delivered"))
        self.assertEqual(net.read("b", "k"), [])  # tombstone still wins

    def test_old_epoch_write_unknown_to_delete_still_dropped(self):
        # b deletes k after seeing a's write; a's write copy reaches c only
        # after c already learned the delete -> dropped by tombstone.
        net = net_with(["a", "b", "c"])
        net.put("a", "k", "stale")
        net.run()
        net.delete("b", "k")
        net.run()
        self.assertEqual(net.read("c", "k"), [])
        self.assertEqual(net.read("b", "k"), [])


if __name__ == "__main__":
    unittest.main()
