import unittest

from leasesim import LeaseSimError, run


def results(state, result=None):
    out = [e for e in state["events"] if result is None or e["result"] == result]
    return [(e["t"], e["client"], e["op"], e["result"], e["resources"]) for e in out]


class TestAcceptanceA(unittest.TestCase):
    """Two resources, two clients, crossed requests: second is DEADLOCK."""

    def test_cross_deadlock_and_recovery(self):
        state = run({
            "resources": {"r1": 1, "r2": 1},
            "ops": [
                {"t": 0, "client": "A", "acquire": {"r1": 1}},
                {"t": 1, "client": "B", "acquire": {"r2": 1}},
                {"t": 2, "client": "A", "acquire": {"r2": 1}},
                {"t": 3, "client": "B", "acquire": {"r1": 1}},
                {"t": 4, "client": "B", "release": ["r2"]},
            ],
        })
        self.assertEqual(results(state), [
            (0, "A", "acquire", "GRANTED", {"r1": 1}),
            (1, "B", "acquire", "GRANTED", {"r2": 1}),
            (2, "A", "acquire", "WAITING", {"r2": 1}),
            (3, "B", "acquire", "DEADLOCK", {"r1": 1}),
            (4, "B", "release", "RELEASED", {"r2": 1}),
            (4, "A", "acquire", "GRANTED", {"r2": 1}),
        ])
        self.assertEqual(state["holders"], {"A": {"r1": 1, "r2": 1}})
        self.assertEqual(state["waiting"], [])


class TestAcceptanceB(unittest.TestCase):
    """Expiry happens before same-tick acquires; ttl=0 ends at tick end."""

    def test_expiry_precedes_same_tick_acquire(self):
        state = run({
            "resources": {"r1": 1},
            "ops": [
                {"t": 0, "client": "A", "acquire": {"r1": 1}, "ttl": 2},
                {"t": 1, "client": "C", "acquire": {"r1": 1}},
                {"t": 2, "client": "B", "acquire": {"r1": 1}},
            ],
        })
        self.assertEqual(results(state), [
            (0, "A", "acquire", "GRANTED", {"r1": 1}),
            (1, "C", "acquire", "WAITING", {"r1": 1}),
            (2, "A", "expire", "EXPIRED", {"r1": 1}),
            (2, "C", "acquire", "GRANTED", {"r1": 1}),
            (2, "B", "acquire", "WAITING", {"r1": 1}),
        ])
        self.assertEqual(state["holders"], {"C": {"r1": 1}})

    def test_ttl_zero_released_at_end_of_tick(self):
        state = run({
            "resources": {"r1": 1},
            "ops": [
                {"t": 3, "client": "D", "acquire": {"r1": 1}, "ttl": 0},
                {"t": 3, "client": "E", "acquire": {"r1": 1}},
                {"t": 4, "client": "F", "acquire": {"r1": 1}},
            ],
        })
        self.assertEqual(results(state), [
            (3, "D", "acquire", "GRANTED", {"r1": 1}),
            (3, "E", "acquire", "WAITING", {"r1": 1}),
            (3, "D", "expire", "EXPIRED", {"r1": 1}),
            (3, "E", "acquire", "GRANTED", {"r1": 1}),
            (4, "F", "acquire", "WAITING", {"r1": 1}),
        ])
        self.assertEqual(state["holders"], {"E": {"r1": 1}})


class TestAcceptanceC(unittest.TestCase):
    """Atomicity: a three-resource request that misses one holds nothing."""

    def test_all_or_nothing(self):
        state = run({
            "resources": {"a": 1, "b": 1, "c": 1},
            "ops": [
                {"t": 0, "client": "X", "acquire": {"a": 1}},
                {"t": 1, "client": "Y", "acquire": {"a": 1, "b": 1, "c": 1}},
                {"t": 2, "client": "Z", "acquire": {"b": 1, "c": 1}},
            ],
        })
        self.assertEqual(results(state), [
            (0, "X", "acquire", "GRANTED", {"a": 1}),
            (1, "Y", "acquire", "WAITING", {"a": 1, "b": 1, "c": 1}),
            (2, "Z", "acquire", "GRANTED", {"b": 1, "c": 1}),
        ])
        # Y never partially occupied b or c.
        self.assertNotIn("Y", state["holders"])
        self.assertEqual(state["holders"], {"X": {"a": 1}, "Z": {"b": 1, "c": 1}})


class TestOrdering(unittest.TestCase):
    def test_same_tick_lexicographic_client_order(self):
        state = run({
            "resources": {"r1": 1},
            "ops": [
                {"t": 0, "client": "B", "acquire": {"r1": 1}},
                {"t": 0, "client": "A", "acquire": {"r1": 1}},
            ],
        })
        self.assertEqual(results(state), [
            (0, "A", "acquire", "GRANTED", {"r1": 1}),
            (0, "B", "acquire", "WAITING", {"r1": 1}),
        ])

    def test_later_tick_expiry_flushes_earlier_ttl_zero(self):
        state = run({
            "resources": {"r1": 1},
            "ops": [
                {"t": 0, "client": "A", "acquire": {"r1": 1}, "ttl": 0},
                {"t": 5, "client": "B", "acquire": {"r1": 1}},
            ],
        })
        self.assertEqual(results(state), [
            (0, "A", "acquire", "GRANTED", {"r1": 1}),
            (0, "A", "expire", "EXPIRED", {"r1": 1}),
            (5, "B", "acquire", "GRANTED", {"r1": 1}),
        ])


class TestErrors(unittest.TestCase):
    def test_need_zero(self):
        with self.assertRaises(LeaseSimError):
            run({"resources": {"r": 1},
                 "ops": [{"t": 0, "client": "A", "acquire": {"r": 0}}]})

    def test_need_exceeds_capacity(self):
        with self.assertRaises(LeaseSimError):
            run({"resources": {"r": 1},
                 "ops": [{"t": 0, "client": "A", "acquire": {"r": 2}}]})

    def test_duplicate_concurrent_holding_conflict(self):
        with self.assertRaises(LeaseSimError):
            run({"resources": {"r": 2},
                 "ops": [
                     {"t": 0, "client": "A", "acquire": {"r": 1}},
                     {"t": 1, "client": "A", "acquire": {"r": 1}},
                 ]})

    def test_release_unheld_resource(self):
        with self.assertRaises(LeaseSimError):
            run({"resources": {"r": 1},
                 "ops": [{"t": 0, "client": "A", "release": ["r"]}]})

    def test_unknown_resource(self):
        with self.assertRaises(LeaseSimError):
            run({"resources": {"r": 1},
                 "ops": [{"t": 0, "client": "A", "acquire": {"q": 1}}]})


if __name__ == "__main__":
    unittest.main()
