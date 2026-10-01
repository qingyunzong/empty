"""Acceptance D: clock offsets shift local timeouts, never the global order."""

import unittest

from netsim.config import Faults
from netsim.sim import Simulator

from helpers import make_config

MESSAGE_TYPES = {"send", "recv", "drop", "dup", "dup_ignored", "buffered"}


def build(offsets):
    return make_config(
        nodes=["n1", "n2"],
        links=[("n1", "n2", 3, 0), ("n2", "n1", 4, 0)],
        clock_offsets=offsets,
        timeout_intervals={"n1": 10, "n2": 15},
        workload=[
            (0, "n1", "n2", "m1", ""),
            (2, "n2", "n1", "m2", ""),
            (5, "n1", "n2", "m3", ""),
        ],
    )


def message_stream(sim):
    return [
        (e["type"], e.get("src"), e.get("dst"), e.get("app_id"), e["time"])
        for e in sim.events
        if e["type"] in MESSAGE_TYPES
    ]


class TestClockOffset(unittest.TestCase):
    def test_offsets_do_not_change_global_message_order(self):
        sim_flat = Simulator(build({}), Faults(), seed=0, max_steps=1000)
        sim_off = Simulator(build({"n1": 7, "n2": -13}), Faults(), seed=0, max_steps=1000)
        sim_flat.run()
        sim_off.run()
        # The global message-event sequence (types, endpoints, times) is
        # identical; only local timestamps and timeout placement may differ.
        self.assertEqual(message_stream(sim_flat), message_stream(sim_off))

    def test_offsets_shift_local_timeout_global_times(self):
        sim_flat = Simulator(build({}), Faults(), seed=0, max_steps=1000)
        sim_off = Simulator(build({"n2": 9}), Faults(), seed=0, max_steps=1000)
        sim_flat.run()
        sim_off.run()
        t_flat = [(e["time"], e["local_time"]) for e in sim_flat.events if e["type"] == "timeout" and e["node"] == "n2"]
        t_off = [(e["time"], e["local_time"]) for e in sim_off.events if e["type"] == "timeout" and e["node"] == "n2"]
        self.assertNotEqual([t for t, _ in t_flat], [t for t, _ in t_off])
        # Local fire times stay aligned to the interval grid in both runs.
        self.assertEqual([lt for _, lt in t_flat], [lt for _, lt in t_off])

    def test_clock_apply_fault_updates_offset(self):
        config = make_config(
            nodes=["n1", "n2"],
            links=[("n1", "n2", 3, 0)],
            workload=[(0, "n1", "n2", "m1", ""), (30, "n1", "n2", "m2", "")],
        )
        faults = Faults(clock_apply=[{"node": "n2", "offset": 100.0, "at": 20.0}])
        sim = Simulator(config, faults, seed=0, max_steps=1000)
        sim.run()
        applies = [e for e in sim.events if e["type"] == "clock_apply"]
        self.assertEqual(len(applies), 1)
        self.assertEqual(applies[0]["time"], 20.0)
        recv = {e["app_id"]: e for e in sim.events if e["type"] == "recv"}
        # m1 arrives before the clock_apply: local time uses the old offset.
        self.assertEqual(recv["m1"]["local_time"], 3.0)
        # m2 arrives after: global time unchanged (33), local time shifted.
        self.assertEqual(recv["m2"]["time"], 33.0)
        self.assertEqual(recv["m2"]["local_time"], 133.0)

    def test_event_times_globally_ordered_with_offsets(self):
        sim = Simulator(build({"n1": 50, "n2": -80}), Faults(), seed=0, max_steps=1000)
        sim.run()
        times = [e["time"] for e in sim.events]
        self.assertEqual(times, sorted(times))


if __name__ == "__main__":
    unittest.main()
