"""Acceptance D: messages to a down node are buffered, then delivered in
order after it comes back up, without loss."""

import unittest

from gossip import Simulator


class BufferingTest(unittest.TestCase):
    def test_buffered_messages_delivered_in_order_without_loss(self):
        sim = Simulator(nodes=4, seed=9, fanout=3)
        sim.down(3)
        for i in range(5):
            sim.inject(0, f"key{i}", i)
            sim.step(2)

        # While node 3 is down it receives nothing but loses nothing.
        self.assertEqual(sim.nodes[3].store, {})
        sent_to_3 = [e for e in sim.events
                     if e["event"] == "send" and e["to"] == 3]
        self.assertGreater(len(sent_to_3), 0)
        self.assertEqual(sim.nodes[3].inbox.__len__(), len(sent_to_3))
        self.assertFalse(any(e["event"] == "deliver" and e["to"] == 3
                             for e in sim.events))

        sim.up(3)
        sim.step(1)

        sent_to_3 = [e for e in sim.events
                     if e["event"] == "send" and e["to"] == 3]
        delivered_to_3 = [e for e in sim.events
                          if e["event"] == "deliver" and e["to"] == 3]
        # No loss: everything ever sent to node 3 was delivered exactly once.
        self.assertEqual(len(delivered_to_3), len(sent_to_3))
        # In-order: FIFO per inbox, matching the send order.
        self.assertEqual(
            [(e["from"], e["sent_round"]) for e in delivered_to_3],
            [(e["from"], e["round"]) for e in sent_to_3])
        # Final state caught up with the rest of the cluster.
        self.assertEqual(sim.nodes[3].store, sim.nodes[0].store)

    def test_down_node_state_preserved_on_up(self):
        sim = Simulator(nodes=3, seed=5, fanout=2)
        sim.inject(1, "local", 42)
        sim.step(3)
        snapshot = dict(sim.nodes[1].store)
        sim.down(1)
        sim.step(2)
        sim.up(1)
        self.assertEqual(sim.nodes[1].store, snapshot)


if __name__ == "__main__":
    unittest.main()
