import unittest

from netsim.events import EventHeap


class TestEventHeap(unittest.TestCase):
    def test_orders_by_time_then_seq(self):
        heap = EventHeap()
        heap.push(5, "send", src="n1", dst="n2")
        heap.push(3, "send", src="n1", dst="n2")
        heap.push(5, "send", src="n3", dst="n1")
        heap.push(1, "send", src="n2", dst="n3")
        order = [(ev.time, ev.seq) for ev in
                 (heap.pop(), heap.pop(), heap.pop(), heap.pop())]
        self.assertEqual(order, [(1, 3), (3, 1), (5, 0), (5, 2)])

    def test_same_time_is_stable_by_seq(self):
        heap = EventHeap()
        for i in range(50):
            heap.push(10, "send", src=f"n{i % 3}", dst="n9")
        seqs = [heap.pop().seq for _ in range(50)]
        self.assertEqual(seqs, list(range(50)))

    def test_key_includes_src_dst(self):
        heap = EventHeap()
        ev = heap.push(7, "deliver", src="n2", dst="n1")
        self.assertEqual((ev.time, ev.seq, ev.src, ev.dst), (7, 0, "n2", "n1"))

    def test_seq_is_globally_monotonic(self):
        heap = EventHeap()
        heap.push(0, "send")
        heap.push(0, "send")
        ev = heap.push(0, "send")
        self.assertEqual(ev.seq, 2)
        self.assertEqual(len(heap), 3)


if __name__ == "__main__":
    unittest.main()
