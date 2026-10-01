"""Acceptance D: cross-check DEADLOCK marking against an independent
reference model that detects wait-for cycles with Kahn's topological
algorithm (the simulator under test uses iterative DFS reachability).
Scenarios are bounded to <= 6 ops and <= 3 resources.
"""

import random
import unittest
from collections import deque

from leasesim import LeaseSimError, run


# ---------------------------------------------------------------------------
# Independent reference model (separately written, Kahn-based cycle check).
# ---------------------------------------------------------------------------

def _kahn_has_cycle(edges):
    nodes = set(edges)
    for targets in edges.values():
        nodes |= targets
    indegree = {n: 0 for n in nodes}
    for targets in edges.values():
        for v in targets:
            indegree[v] += 1
    ready = deque(n for n in sorted(nodes) if indegree[n] == 0)
    seen = 0
    while ready:
        u = ready.popleft()
        seen += 1
        for v in sorted(edges.get(u, ())):
            indegree[v] -= 1
            if indegree[v] == 0:
                ready.append(v)
    return seen != len(nodes)


def reference_run(config):
    capacity = config["resources"]
    holders = {}            # client -> {resource: amount}
    expirations = []        # list of [tick, client, {resource: amount}]
    waitq = []              # list of dicts
    events = []

    def avail(res):
        return capacity[res] - sum(h.get(res, 0) for h in holders.values())

    def emit(t, client, kind, result, resources):
        events.append((t, client, kind, result, dict(sorted(resources.items()))))

    def cycle_if_added(client, needs):
        edges = {}
        pending = [(w["client"], w["needs"]) for w in waitq]
        pending.append((client, needs))
        for c, nd in pending:
            edges.setdefault(c, set())
            for res, n in nd.items():
                if avail(res) < n:
                    for h, held in holders.items():
                        if h != c and held.get(res, 0) > 0:
                            edges[c].add(h)
        return _kahn_has_cycle(edges)

    def grant(w, t):
        for res, n in w["needs"].items():
            holders.setdefault(w["client"], {})
            holders[w["client"]][res] = holders[w["client"]].get(res, 0) + n
        if w["ttl"] is not None:
            expirations.append([t + w["ttl"], w["client"], dict(w["needs"])])
        emit(t, w["client"], "acquire", "GRANTED", w["needs"])

    def drain(t):
        progress = True
        while progress:
            progress = False
            for w in sorted(waitq, key=lambda x: (x["t"], x["client"], x["order"])):
                if all(avail(r) >= n for r, n in w["needs"].items()):
                    waitq.remove(w)
                    grant(w, t)
                    progress = True
                    break
                if cycle_if_added(w["client"], w["needs"]):
                    waitq.remove(w)
                    emit(t, w["client"], "acquire", "DEADLOCK", w["needs"])
                    progress = True
                    break

    def expire_due(t):
        due = [e for e in expirations if e[0] <= t]
        if not due:
            return
        for e in due:
            expirations.remove(e)
        for tick, client, held in sorted(due, key=lambda e: (e[1], sorted(e[2]))):
            freed = {}
            for res, n in sorted(held.items()):
                have = holders.get(client, {}).get(res, 0)
                take = min(have, n)
                if take:
                    holders[client][res] = have - take
                    if not holders[client][res]:
                        del holders[client][res]
                    freed[res] = take
            if not holders.get(client):
                holders.pop(client, None)
            if freed:
                emit(t, client, "expire", "EXPIRED", freed)
        drain(t)

    ops = []
    for i, raw in enumerate(config["ops"]):
        ops.append((raw["t"], raw["client"], raw.get("acquire"),
                    raw.get("release"), raw.get("ttl"), i))
    ops.sort(key=lambda o: (o[0], o[1], o[5]))

    ticks = sorted({o[0] for o in ops})
    for t in ticks:
        expire_due(t)
        for tick, client, acquire, release, ttl, order in [o for o in ops if o[0] == t]:
            if acquire is not None:
                needs = dict(sorted(acquire.items()))
                if all(avail(r) >= n for r, n in needs.items()):
                    grant({"client": client, "needs": needs, "ttl": ttl}, t)
                elif cycle_if_added(client, needs):
                    emit(t, client, "acquire", "DEADLOCK", needs)
                else:
                    emit(t, client, "acquire", "WAITING", needs)
                    waitq.append({"t": t, "client": client, "needs": needs,
                                  "ttl": ttl, "order": order})
            if release is not None:
                freed = {}
                for res in release:
                    freed[res] = holders[client].pop(res)
                if not holders[client]:
                    del holders[client]
                emit(t, client, "release", "RELEASED", freed)
                drain(t)
        expire_due(t)

    final = {c: dict(sorted(h.items())) for c, h in sorted(holders.items())}
    return events, final


# ---------------------------------------------------------------------------
# Fuzz harness.
# ---------------------------------------------------------------------------

def _gen_config(rng):
    """Generate contention-heavy scenarios: per-client chains of acquires
    over distinct resources (capacity mostly 1), interleaved in time, so
    waits and wait-for cycles are likely.  Bounded to <= 6 ops, <= 3
    resources."""
    n_resources = rng.randint(2, 3)
    resources = {f"r{k}": (2 if rng.random() < 0.2 else 1)
                 for k in range(n_resources)}
    names = sorted(resources)
    clients = ["A", "B", "C"][: rng.randint(2, 3)]
    budget = rng.randint(2, 6)
    ops = []
    for client in clients:
        if budget <= 0:
            break
        requested = set()
        t = rng.randint(0, 1)
        for _ in range(rng.randint(1, min(3, budget))):
            pool = [r for r in names if r not in requested]
            if not pool:
                break
            picked = rng.sample(pool, rng.randint(1, min(len(pool), 2)))
            requested.update(picked)
            op = {"t": t, "client": client,
                  "acquire": {r: 1 for r in picked}}
            ttl = rng.choice([None, None, None, 1, 2, 3])
            if ttl is not None:
                op["ttl"] = ttl
            ops.append(op)
            budget -= 1
            t += rng.randint(1, 2)
            if budget > 0 and rng.random() < 0.15:
                ops.append({"t": t, "client": client,
                            "release": sorted(requested)[:1]})
                budget -= 1
                t += 1
    rng.shuffle(ops)
    return {"resources": resources, "ops": ops}


def _event_tuples(state):
    return [(e["t"], e["client"], e["op"], e["result"], e["resources"])
            for e in state["events"]]


class TestFuzzDeadlockCrossCheck(unittest.TestCase):
    def test_deadlock_marks_match_reference(self):
        compared = 0
        deadlocks = 0
        skipped = 0
        for seed in range(1500):
            rng = random.Random(seed)
            config = _gen_config(rng)
            try:
                state = run(config)
            except LeaseSimError:
                skipped += 1  # error-path scenarios are covered elsewhere
                continue
            ref_events, ref_holders = reference_run(config)
            got = _event_tuples(state)
            self.assertEqual(got, ref_events, f"seed={seed} config={config}")
            self.assertEqual(state["holders"], ref_holders,
                             f"seed={seed} config={config}")
            got_dead = sorted((t, c) for t, c, _, r, _ in got if r == "DEADLOCK")
            ref_dead = sorted((t, c) for t, c, _, r, _ in ref_events if r == "DEADLOCK")
            self.assertEqual(got_dead, ref_dead, f"seed={seed} config={config}")
            compared += 1
            deadlocks += len(got_dead)
        self.assertGreaterEqual(compared, 100, "fuzz compared too few scenarios")
        self.assertGreater(deadlocks, 0, "fuzz never exercised a deadlock")


if __name__ == "__main__":
    unittest.main()
