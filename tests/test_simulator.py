"""Acceptance tests for the deterministic gossip simulator.

A: same seed -> byte-identical event trace across two runs (CLI level).
B: <=8 nodes with random faults -> final versions match a full-sync reference.
C: fanout=1 ring converges within the theoretical round bound, or reports
   NOT_CONVERGED.
D: messages to a down node are buffered and delivered FIFO after up, no loss.
"""
import json
import os
import random
import subprocess
import sys
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from gossip import Simulator, SimError  # noqa: E402


def run_cli(script):
    proc = subprocess.run(
        [sys.executable, "-m", "gossip"],
        input="\n".join(json.dumps(c) for c in script) + "\n",
        capture_output=True, text=True, cwd=REPO_ROOT,
    )
    return proc


def reference_merge(injects):
    """Full-sync reference: for each key the winner is the inject with the
    largest (counter, origin) -- the same deterministic rule the simulator
    uses, applied over the union of all writes."""
    ref = {}
    for node, key, value, counter in injects:
        cand = (counter, node)
        if key not in ref or cand > ref[key][1]:
            ref[key] = (value, cand)
    return ref


class TestADeterminism(unittest.TestCase):
    SCRIPT = [
        {"cmd": "init", "nodes": 6, "seed": 42, "fanout": 2,
         "max_rounds": 100, "trace": True},
        {"cmd": "inject", "node": 0, "key": "a", "value": 1},
        {"cmd": "inject", "node": 3, "key": "b", "value": "x"},
        {"cmd": "step", "rounds": 5},
        {"cmd": "down", "node": 2},
        {"cmd": "inject", "node": 1, "key": "a", "value": 2},
        {"cmd": "step", "rounds": 10},
        {"cmd": "up", "node": 2},
        {"cmd": "step", "rounds": 50},
        {"cmd": "status"},
    ]

    def test_same_seed_byte_identical_trace(self):
        out1 = run_cli(self.SCRIPT).stdout
        out2 = run_cli(self.SCRIPT).stdout
        self.assertEqual(out1, out2)
        self.assertIn('"events"', out1)  # trace actually emitted

    def test_different_seed_diverges(self):
        other = [dict(c, seed=43) if c.get("cmd") == "init" else c
                 for c in self.SCRIPT]
        self.assertNotEqual(run_cli(self.SCRIPT).stdout,
                            run_cli(other).stdout)

    def test_in_memory_determinism(self):
        def build():
            sim = Simulator(5, seed=7, fanout=2, max_rounds=60)
            sim.inject(0, "k", "v0")
            sim.inject(2, "k", "v2")
            sim.down(4)
            sim.step(10)
            sim.up(4)
            sim.step(50)
            return sim
        a, b = build(), build()
        self.assertEqual(json.dumps(a.events, sort_keys=True),
                         json.dumps(b.events, sort_keys=True))
        self.assertEqual(a.status(), b.status())


class TestBRandomFaultsVsReference(unittest.TestCase):
    def test_final_versions_match_reference(self):
        n = 8
        sim = Simulator(n, seed=7, fanout=3, max_rounds=200)
        rng = random.Random(2024)
        injects = []
        for _ in range(40):
            node = rng.randrange(n)
            key = f"k{rng.randrange(6)}"
            value = rng.randrange(1000)
            version = sim.inject(node, key, value)
            injects.append((node, key, value, version[1]))
            for _ in range(rng.randrange(3)):
                target = rng.randrange(n)
                (sim.down if rng.random() < 0.5 else sim.up)(target)
            sim.step(rng.randrange(1, 4))
        # Heal all faults and let gossip finish.
        for i in range(n):
            if not sim.alive[i]:
                sim.up(i)
        sim.step(150)
        ref = {k: [v, o, c] for k, (v, (c, o)) in
               reference_merge(injects).items()}
        for i in range(n):
            self.assertTrue(sim.alive[i])
            self.assertEqual(sim.store[i], ref,
                             f"node {i} diverged from reference")


class TestCRingFanout1(unittest.TestCase):
    def test_ring_converges_within_theoretical_bound(self):
        n = 8
        sim = Simulator(n, seed=1, fanout=1, max_rounds=200, topology="ring")
        sim.inject(0, "x", 1)
        sim.step(200)
        self.assertTrue(sim.converged())
        # Info travels one hop per round: node k learns after k rounds.
        self.assertLessEqual(sim.round, n - 1)

    def test_persistent_conflict_reports_not_converged(self):
        sim = Simulator(4, seed=1, fanout=1, max_rounds=20, topology="ring")
        sim.inject(0, "x", "a")  # version (origin=0, counter=1)
        sim.inject(1, "x", "b")  # concurrent version (origin=1, counter=1)
        ran = sim.step(20)
        self.assertEqual(ran, 20)
        self.assertFalse(sim.converged())
        # Deterministic winner: (counter=1, origin=1) beats (1, 0) everywhere.
        for i in range(4):
            self.assertEqual(sim.store[i]["x"], ["b", 1, 1])
        # The losing concurrent version stays recorded as a conflict.
        self.assertTrue(any(sim.conflicts[i] for i in range(4)))


class TestDBufferingAcrossDownUp(unittest.TestCase):
    def test_buffered_delivery_fifo_no_loss(self):
        sim = Simulator(5, seed=9, fanout=2, max_rounds=100)
        sim.down(3)
        sim.inject(0, "a", 1)
        sim.inject(1, "b", 2)
        sim.step(10)
        # Down node neither received nor lost anything: messages are buffered.
        self.assertEqual(sim.store[3], {})
        self.assertGreater(len(sim.inbox[3]), 0)
        sim.up(3)
        sim.step(50)
        self.assertTrue(sim.converged())
        self.assertEqual(sim.store[3], sim.store[0])
        # FIFO: deliveries to node 3 happen in non-decreasing send-round order.
        sent_rounds = [e["sent_round"] for e in sim.events
                       if e["type"] == "deliver" and e["dst"] == 3]
        self.assertEqual(sent_rounds, sorted(sent_rounds))
        self.assertTrue(sent_rounds)

    def test_up_restores_old_state(self):
        sim = Simulator(3, seed=3, fanout=1, max_rounds=50)
        sim.inject(1, "k", "v")
        before = dict(sim.store[1])
        sim.down(1)
        sim.step(3)
        sim.up(1)
        self.assertEqual(sim.store[1], before)


class TestSemantics(unittest.TestCase):
    def test_duplicate_message_idempotent(self):
        sim = Simulator(2, seed=5, fanout=1, max_rounds=50)
        sim.inject(0, "k", "v")
        self.assertEqual(sim._apply(1, "k", "v", 0, 1), "applied")
        self.assertEqual(sim._apply(1, "k", "v", 0, 1), "duplicate")
        self.assertEqual(sim.store[1], {"k": ["v", 0, 1]})
        self.assertEqual(sim.conflicts[1], {})

    def test_higher_version_applies_lower_is_stale(self):
        sim = Simulator(2, seed=5, fanout=1, max_rounds=50)
        self.assertEqual(sim._apply(1, "k", "v2", 0, 2), "applied")
        self.assertEqual(sim._apply(1, "k", "v1", 0, 1), "duplicate")
        self.assertEqual(sim.store[1]["k"], ["v2", 0, 2])

    def test_limits_enforced(self):
        with self.assertRaises(SimError):
            Simulator(65, seed=0, fanout=1, max_rounds=10)
        with self.assertRaises(SimError):
            Simulator(2, seed=0, fanout=5, max_rounds=10)
        with self.assertRaises(SimError):
            Simulator(2, seed=0, fanout=1, max_rounds=201)


class TestCLI(unittest.TestCase):
    def test_error_exit_code_9(self):
        for script in (
            [{"cmd": "bogus"}],
            [{"cmd": "init", "nodes": 100, "seed": 1, "fanout": 1,
              "max_rounds": 10}],
            [{"cmd": "inject", "node": 0, "key": "k", "value": 1}],  # no init
            [{"cmd": "init", "nodes": 2, "seed": 1, "fanout": 1,
              "max_rounds": 10}, {"cmd": "down", "node": 5}],
        ):
            proc = run_cli(script)
            self.assertEqual(proc.returncode, 9, script)
            self.assertIn('"ok":false', proc.stdout.replace(" ", ""))

    def test_status_and_step_flow(self):
        proc = run_cli([
            {"cmd": "init", "nodes": 3, "seed": 11, "fanout": 2,
             "max_rounds": 50},
            {"cmd": "inject", "node": 0, "key": "k", "value": 7},
            {"cmd": "step", "rounds": 50},
            {"cmd": "status"},
        ])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        lines = [json.loads(l) for l in proc.stdout.splitlines()]
        self.assertEqual(lines[2]["status"], "CONVERGED")
        status = lines[3]
        self.assertTrue(status["converged"])
        for node in status["nodes"]:
            self.assertEqual(node["store"], {"k": [7, 0, 1]})


if __name__ == "__main__":
    unittest.main()
