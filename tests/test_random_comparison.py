"""Acceptance (d): random operation sequences are checked against an
independent reference waits-for-graph simulator; the sets of aborted
transactions must match exactly.
"""

import random
import unittest

from lockmgr import LockManager, LockMode


class ReferenceSimulator:
    """Standalone waits-for-graph simulator written directly from the
    specification (no shared code with lockmgr.manager)."""

    def __init__(self):
        self.holders = {}   # resource -> {txn: "S"|"X"}
        self.queues = {}    # resource -> list of [txn, mode, is_upgrade]
        self.aborted = set()
        self.finished = set()

    # -- operations ----------------------------------------------------
    def lock(self, txn, res, mode):
        if txn in self.finished:
            return
        holders = self.holders.setdefault(res, {})
        queue = self.queues.setdefault(res, [])
        held = holders.get(txn)
        if held == "X" or held == mode:
            return
        if held == "S" and mode == "X":
            if len(holders) == 1:
                holders[txn] = "X"
            else:
                queue.insert(0, [txn, "X", True])
                self._break_deadlocks()
            return
        grantable = not queue and (
            not holders or (mode == "S" and set(holders.values()) == {"S"})
        )
        if grantable:
            holders[txn] = mode
        else:
            queue.append([txn, mode, False])
            self._break_deadlocks()

    def commit(self, txn):
        if txn in self.finished:
            return
        self.finished.add(txn)
        self._release(txn)

    def abort(self, txn):
        if txn in self.finished:
            return
        self.finished.add(txn)
        self.aborted.add(txn)
        self._release(txn)

    # -- internals -----------------------------------------------------
    def _release(self, txn):
        for holders in self.holders.values():
            holders.pop(txn, None)
        for res, queue in self.queues.items():
            self.queues[res] = [req for req in queue if req[0] != txn]
        self._drain()

    def _drain(self):
        changed = True
        while changed:
            changed = False
            for res in sorted(self.queues):
                queue = self.queues[res]
                holders = self.holders[res]
                while queue:
                    txn, mode, is_upgrade = queue[0]
                    if is_upgrade:
                        ok = set(holders) <= {txn}
                    elif mode == "S":
                        ok = set(holders.values()) <= {"S"}
                    else:
                        ok = not holders
                    if not ok:
                        break
                    queue.pop(0)
                    holders[txn] = mode
                    changed = True

    def _waits_for(self):
        edges = {}
        for res, queue in self.queues.items():
            holders = self.holders[res]
            for index, (txn, _mode, is_upgrade) in enumerate(queue):
                targets = set(holders)
                if not is_upgrade:
                    targets.update(
                        other for other, _m, up in queue[:index] if up
                    )
                targets.discard(txn)
                edges.setdefault(txn, set()).update(targets)
        return edges

    def _break_deadlocks(self):
        while True:
            cycle = self._any_cycle()
            if cycle is None:
                return
            victim = max(cycle)
            self.finished.add(victim)
            self.aborted.add(victim)
            self._release(victim)

    def _any_cycle(self):
        edges = self._waits_for()
        visiting, visited, stack = set(), set(), []

        def dfs(node):
            visiting.add(node)
            stack.append(node)
            for nxt in sorted(edges.get(node, ())):
                if nxt in visiting:
                    return stack[stack.index(nxt):]
                if nxt not in visited:
                    found = dfs(nxt)
                    if found:
                        return found
            stack.pop()
            visiting.discard(node)
            visited.add(node)
            return None

        for node in sorted(edges):
            if node not in visited:
                found = dfs(node)
                if found:
                    return found
        return None


def random_script(rng, steps):
    txns = [1, 2, 3, 4, 5]
    resources = ["A", "B", "C", "D"]
    script = []
    for _ in range(steps):
        roll = rng.random()
        txn = rng.choice(txns)
        if roll < 0.7:
            script.append(
                ("lock", txn, rng.choice(resources), rng.choice(["S", "X"]))
            )
        elif roll < 0.85:
            script.append(("commit", txn))
        else:
            script.append(("abort", txn))
    return script


def replay_on_lock_manager(script):
    lm = LockManager()
    for op in script:
        if op[0] == "lock":
            lm.lock(op[1], op[2], LockMode.parse(op[3]))
        elif op[0] == "commit":
            lm.commit(op[1])
        else:
            lm.abort(op[1])
    return lm


def replay_on_reference(script):
    sim = ReferenceSimulator()
    for op in script:
        if op[0] == "lock":
            sim.lock(op[1], op[2], op[3])
        elif op[0] == "commit":
            sim.commit(op[1])
        else:
            sim.abort(op[1])
    return sim


class TestRandomComparison(unittest.TestCase):
    def test_aborted_sets_match_reference(self):
        for seed in range(300):
            rng = random.Random(seed)
            script = random_script(rng, steps=rng.randint(20, 120))
            lm = replay_on_lock_manager(script)
            ref = replay_on_reference(script)
            lm_aborted = {
                txn for txn in range(1, 6) if lm.is_aborted(txn)
            }
            self.assertEqual(
                lm_aborted,
                ref.aborted,
                msg=f"seed={seed} script={script}",
            )

    def test_final_holders_match_reference(self):
        for seed in range(300, 400):
            rng = random.Random(seed)
            script = random_script(rng, steps=rng.randint(20, 120))
            lm = replay_on_lock_manager(script)
            ref = replay_on_reference(script)
            for res in ["A", "B", "C", "D"]:
                lm_holders = {
                    txn: mode.value for txn, mode in lm.holders(res).items()
                }
                self.assertEqual(
                    lm_holders,
                    ref.holders.get(res, {}),
                    msg=f"seed={seed} resource={res}",
                )

    def test_deadlocks_actually_exercised(self):
        # sanity: the random workloads must produce some deadlocks,
        # otherwise the comparison above would be vacuous
        total_aborted = 0
        for seed in range(300):
            rng = random.Random(seed)
            script = random_script(rng, steps=rng.randint(20, 120))
            total_aborted += len(replay_on_reference(script).aborted)
        self.assertGreater(total_aborted, 50)


if __name__ == "__main__":
    unittest.main()
