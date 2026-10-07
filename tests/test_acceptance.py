"""Acceptance tests A, B, C."""

import tests._bootstrap  # noqa: F401  (sys.path setup)
import unittest

from ticketpool.scheduler import serve


def ticket(tid, arrival, cost, group, priority=0):
    return {
        "id": tid,
        "arrival": arrival,
        "cost": cost,
        "group": group,
        "priority": priority,
    }


def by_id(results):
    return {r["id"]: r for r in results}


class TestAQuotaAlternation(unittest.TestCase):
    """A: single worker, two groups with 1:1 quota -> exact alternation."""

    def test_single_worker_exact_alternation(self):
        cfg = {"workers": 1, "aging_step": 2, "boost": 3,
               "base_quota": {"A": 1, "B": 1}}
        tickets = [
            ticket(1, 0, 1, "A"),
            ticket(2, 0, 1, "B"),
            ticket(3, 0, 1, "A"),
            ticket(4, 0, 1, "B"),
        ]
        results = serve(cfg, tickets)
        ordered = sorted(results, key=lambda r: r["start"])
        self.assertEqual([r["id"] for r in ordered], [1, 2, 3, 4])
        self.assertEqual([r["group"] for r in ordered], ["A", "B", "A", "B"])
        self.assertEqual([r["start"] for r in ordered], [0, 1, 2, 3])
        self.assertEqual([r["end"] for r in ordered], [0, 1, 2, 3])

    def test_quota_blocks_second_ticket_of_same_group(self):
        # 2 workers, quota 1 per group: the second A ticket may not start
        # until tick 1 even though a worker would be free for another group.
        cfg = {"workers": 2, "aging_step": 100, "boost": 1,
               "base_quota": {"A": 1, "B": 1}}
        tickets = [
            ticket(1, 0, 1, "A"),
            ticket(2, 0, 1, "A"),
            ticket(3, 0, 1, "B"),
            ticket(4, 0, 1, "B"),
        ]
        results = by_id(serve(cfg, tickets))
        self.assertEqual(results[1]["start"], 0)
        self.assertEqual(results[3]["start"], 0)
        self.assertEqual(results[2]["start"], 1)  # blocked by A's quota at t=0
        self.assertEqual(results[4]["start"], 1)  # blocked by B's quota at t=0


class TestBAgingOvertakes(unittest.TestCase):
    """B: an old low-priority ticket overtakes newer high-priority ones."""

    def setUp(self):
        self.cfg = {"workers": 1, "aging_step": 2, "boost": 3,
                    "base_quota": {"g": 4}}
        # one old low-priority ticket, then a stream of priority-10 tickets
        self.tickets = [ticket(1, 0, 1, "g", priority=0)] + [
            ticket(k + 1, k - 1, 1, "g", priority=10) for k in range(1, 10)
        ]

    def test_aging_overtakes(self):
        results = by_id(serve(self.cfg, self.tickets))
        old = results[1]
        # effective priority of the old ticket at tick t is 3 * (t // 2);
        # it first exceeds 10 at t = 8 (3 * 4 = 12), so it starts at 8.
        self.assertEqual(old["start"], 8)
        self.assertEqual(old["end"], 8)
        # the priority-10 ticket arriving at tick 8 must wait behind it
        self.assertEqual(results[10]["start"], 9)
        self.assertLess(old["start"], results[10]["start"])

    def test_without_aging_old_ticket_is_last(self):
        cfg = dict(self.cfg, boost=0)
        results = by_id(serve(cfg, self.tickets))
        self.assertEqual(results[1]["start"], 9)  # served only after all others


class TestCNoStarvationUnderFlood(unittest.TestCase):
    """C: a high-arrival-rate group cannot starve a finite stream."""

    def test_bounded_completion_despite_flood(self):
        cfg = {"workers": 2, "aging_step": 3, "boost": 2,
               "base_quota": {"flood": 2, "rare": 1}}
        tickets = [ticket("r1", 0, 1, "rare", priority=0)]
        # flood: 2 new priority-5 tickets every tick for 10 ticks
        for k in range(10):
            tickets.append(ticket(f"f{2 * k + 1}", k, 1, "flood", priority=5))
            tickets.append(ticket(f"f{2 * k + 2}", k, 1, "flood", priority=5))

        results = serve(cfg, tickets)
        # every ticket completes: finite stream + finite cost, never "unsatisfiable"
        self.assertEqual(len(results), 21)
        for r in results:
            self.assertIsNotNone(r["start"])
            self.assertIsNotNone(r["end"])

        rare = by_id(results)["r1"]
        # rare effective priority: 2 * (t // 3); first exceeds 5 at t = 9
        self.assertEqual(rare["start"], 9)
        self.assertEqual(rare["end"], 9)
        # the whole finite stream drains with a bounded end
        last_end = max(r["end"] for r in results)
        self.assertLessEqual(last_end, 12)

    def test_long_wait_is_never_unsatisfiable(self):
        # a ticket that must wait a very long time still completes
        cfg = {"workers": 1, "aging_step": 1, "boost": 1,
               "base_quota": {"g": 1}}
        tickets = [ticket("slow", 0, 1, "g", priority=0)]
        tickets += [ticket(k, 0, 1, "g", priority=1000) for k in range(1, 50)]
        results = by_id(serve(cfg, tickets))
        self.assertEqual(results["slow"]["end"], 49)
        self.assertEqual(results["slow"]["waits"], [[0, 49]])


if __name__ == "__main__":
    unittest.main()
