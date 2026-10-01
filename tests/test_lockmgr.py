import json
import random
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from lockmgr import LockManager
from lockmgr.cli import run as cli_run
from reference_sim import ReferenceSimulator

import io


class TwoTxnDeadlockTest(unittest.TestCase):
    """Acceptance (a): two transactions wait on each other; max id aborted."""

    def test_cycle_aborts_higher_txn_id(self):
        mgr = LockManager()
        self.assertEqual(
            mgr.lock(1, "A", "X") or mgr.drain_events(),
            [{"status": "GRANTED", "txn": 1, "resource": "A", "mode": "X"}],
        )
        self.assertEqual(
            mgr.lock(2, "B", "X") or mgr.drain_events(),
            [{"status": "GRANTED", "txn": 2, "resource": "B", "mode": "X"}],
        )
        # T1 blocks on B: no output.
        mgr.lock(1, "B", "X")
        self.assertEqual(mgr.drain_events(), [])
        # T2 blocks on A: cycle 1 <-> 2, victim is txn 2 (max id).
        mgr.lock(2, "A", "X")
        events = mgr.drain_events()
        self.assertEqual(events[0]["status"], "DEADLOCK")
        self.assertEqual(events[0]["victim"], 2)
        # Victim's locks released: T1's queued request on B is granted.
        self.assertIn(
            {"status": "GRANTED", "txn": 1, "resource": "B", "mode": "X"},
            events,
        )
        self.assertFalse(mgr.is_active(2))
        self.assertTrue(mgr.is_active(1))
        # Victim is finished: further ops on it are errors.
        mgr.lock(2, "A", "S")
        self.assertEqual(mgr.drain_events()[0]["status"], "ERROR")
        # Survivor can commit cleanly.
        mgr.commit(1)
        self.assertEqual(mgr.drain_events(),
                         [{"status": "COMMITTED", "txn": 1}])
        self.assertEqual(mgr.snapshot(), {"A": {}, "B": {}})


class UpgradeDeadlockTest(unittest.TestCase):
    """Acceptance (b): three-txn cycle that includes an S->X upgrade."""

    def test_three_txn_cycle_with_upgrade(self):
        mgr = LockManager()
        mgr.lock(1, "A", "S")
        mgr.lock(3, "A", "S")   # shared with T1
        mgr.lock(2, "B", "X")
        mgr.drain_events()

        # T1 upgrades S->X on A, blocked by T3's S lock: edge 1 -> 3.
        mgr.lock(1, "A", "X")
        self.assertEqual(mgr.drain_events(), [])
        # T3 wants B held by T2: edge 3 -> 2.
        mgr.lock(3, "B", "X")
        self.assertEqual(mgr.drain_events(), [])
        # T2 wants A held by T1: edge 2 -> 1. Cycle 1 -> 3 -> 2 -> 1.
        mgr.lock(2, "A", "X")
        events = mgr.drain_events()
        self.assertEqual(events[0]["status"], "DEADLOCK")
        self.assertEqual(events[0]["victim"], 3)  # max txn_id on the cycle
        # T3's abort releases S(A): T1's upgrade is granted.
        self.assertIn(
            {"status": "GRANTED", "txn": 1, "resource": "A", "mode": "X"},
            events,
        )
        # T2 is still blocked on A (now X-held by T1).
        self.assertEqual(mgr.snapshot(), {"A": {1: "X"}, "B": {2: "X"}})
        # T1 commits; T2 is woken with X(A).
        mgr.commit(1)
        events = mgr.drain_events()
        self.assertEqual(events[0], {"status": "COMMITTED", "txn": 1})
        self.assertIn(
            {"status": "GRANTED", "txn": 2, "resource": "A", "mode": "X"},
            events,
        )


class LongChainNoDeadlockTest(unittest.TestCase):
    """Acceptance (c): a long acyclic wait chain must not raise DEADLOCK."""

    def test_long_wait_chain(self):
        n = 30
        mgr = LockManager()
        for i in range(1, n + 1):
            mgr.lock(i, f"R{i}", "X")
        mgr.drain_events()
        # T_i waits on R_{i-1} held by T_{i-1}: chain n -> ... -> 1, no cycle.
        for i in range(2, n + 1):
            mgr.lock(i, f"R{i - 1}", "X")
            events = mgr.drain_events()
            self.assertEqual(events, [], f"txn {i} should block silently")
        # Commit T1, then cascade: each commit wakes exactly the next txn.
        for i in range(1, n):
            mgr.commit(i)
            events = mgr.drain_events()
            self.assertEqual(events[0], {"status": "COMMITTED", "txn": i})
            granted = [e for e in events if e["status"] == "GRANTED"]
            self.assertEqual(len(granted), 1)
            self.assertEqual(granted[0]["txn"], i + 1)
            self.assertEqual(granted[0]["resource"], f"R{i}")
            self.assertFalse(any(e["status"] == "DEADLOCK" for e in events))
        mgr.commit(n)
        self.assertEqual(mgr.drain_events(),
                         [{"status": "COMMITTED", "txn": n}])
        self.assertTrue(all(not h for h in mgr.snapshot().values()))


class FifoFairnessTest(unittest.TestCase):
    """A new S request must queue behind a waiting X request."""

    def test_s_waits_behind_queued_x(self):
        mgr = LockManager()
        mgr.lock(1, "A", "S")
        mgr.lock(2, "A", "X")   # blocked by T1's S
        mgr.drain_events()
        mgr.lock(3, "A", "S")   # compatible with holder, but X is queued
        self.assertEqual(mgr.drain_events(), [])
        mgr.commit(1)
        events = mgr.drain_events()
        # FIFO: T2's X granted first; T3's S still blocked behind it.
        self.assertEqual(
            [e for e in events if e["status"] == "GRANTED"],
            [{"status": "GRANTED", "txn": 2, "resource": "A", "mode": "X"}],
        )
        mgr.commit(2)
        events = mgr.drain_events()
        self.assertIn(
            {"status": "GRANTED", "txn": 3, "resource": "A", "mode": "S"},
            events,
        )


class RandomizedDifferentialTest(unittest.TestCase):
    """Acceptance (d): random op sequences vs. reference simulator."""

    def _run_manager(self, ops):
        mgr = LockManager()
        victims = []
        for op in ops:
            if op[0] == "lock":
                mgr.lock(op[1], op[2], op[3])
            elif op[0] == "commit":
                mgr.commit(op[1])
            else:
                mgr.abort(op[1])
            victims.extend(e["victim"] for e in mgr.drain_events()
                           if e["status"] == "DEADLOCK")
        return victims, mgr.snapshot()

    def _run_reference(self, ops):
        sim = ReferenceSimulator()
        for op in ops:
            if op[0] == "lock":
                sim.lock(op[1], op[2], op[3])
            elif op[0] == "commit":
                sim.commit(op[1])
            else:
                sim.abort(op[1])
        return sim.deadlock_victims, {r: dict(h) for r, h in sim.holds.items()}

    def test_random_sequences_match_reference(self):
        for seed in range(120):
            rng = random.Random(seed)
            txns = list(range(1, 7))
            resources = list("ABCDE")
            ops = []
            for _ in range(250):
                roll = rng.random()
                txn = rng.choice(txns)
                if roll < 0.7:
                    ops.append(("lock", txn, rng.choice(resources),
                                rng.choice("SX")))
                elif roll < 0.85:
                    ops.append(("commit", txn))
                else:
                    ops.append(("abort", txn))
            mgr_victims, mgr_holds = self._run_manager(ops)
            ref_victims, ref_holds = self._run_reference(ops)
            self.assertEqual(
                sorted(mgr_victims), sorted(ref_victims),
                f"seed={seed}: aborted txn sets differ",
            )
            # Final lock state must also agree exactly.
            self.assertEqual(
                {r: h for r, h in mgr_holds.items() if h},
                {r: h for r, h in ref_holds.items() if h},
                f"seed={seed}: final holders differ",
            )


class CliTest(unittest.TestCase):
    """JSON-lines protocol; blocked requests stay silent until woken."""

    def _run_cli(self, lines):
        inp = io.StringIO("\n".join(json.dumps(x) for x in lines) + "\n")
        out = io.StringIO()
        cli_run(inp, out)
        return [json.loads(x) for x in out.getvalue().splitlines()]

    def test_blocked_request_produces_no_output_until_woken(self):
        events = self._run_cli([
            {"op": "lock", "txn": 1, "resource": "A", "mode": "X"},
            {"op": "lock", "txn": 2, "resource": "A", "mode": "X"},
            {"op": "commit", "txn": 1},
        ])
        self.assertEqual(events, [
            {"status": "GRANTED", "txn": 1, "resource": "A", "mode": "X"},
            {"status": "COMMITTED", "txn": 1},
            {"status": "GRANTED", "txn": 2, "resource": "A", "mode": "X"},
        ])

    def test_deadlock_reported_over_cli(self):
        events = self._run_cli([
            {"op": "lock", "txn": 1, "resource": "A", "mode": "X"},
            {"op": "lock", "txn": 2, "resource": "B", "mode": "X"},
            {"op": "lock", "txn": 1, "resource": "B", "mode": "X"},
            {"op": "lock", "txn": 2, "resource": "A", "mode": "X"},
        ])
        deadlock = [e for e in events if e["status"] == "DEADLOCK"]
        self.assertEqual(len(deadlock), 1)
        self.assertEqual(deadlock[0]["victim"], 2)

    def test_errors(self):
        events = self._run_cli([
            {"op": "commit", "txn": 9},
            {"op": "lock", "txn": 1, "resource": "A", "mode": "Q"},
            {"op": "teleport", "txn": 1},
        ])
        self.assertTrue(all(e["status"] == "ERROR" for e in events))
        self.assertEqual(len(events), 3)

    def test_subprocess_end_to_end(self):
        root = Path(__file__).resolve().parent.parent
        proc = subprocess.run(
            [sys.executable, "-m", "lockmgr"],
            input='{"op":"lock","txn":1,"resource":"A","mode":"S"}\n'
                  '{"op":"commit","txn":1}\n',
            capture_output=True, text=True, cwd=root, check=True,
        )
        lines = [json.loads(x) for x in proc.stdout.splitlines()]
        self.assertEqual(lines, [
            {"status": "GRANTED", "txn": 1, "resource": "A", "mode": "S"},
            {"status": "COMMITTED", "txn": 1},
        ])


if __name__ == "__main__":
    unittest.main()
