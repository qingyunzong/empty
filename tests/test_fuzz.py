"""Acceptance D: cross-check deadlock marking (and every other outcome)
against an independent reference implementation on random scenarios with
<= 6 ops and <= 3 resources.

The reference below is written independently from leasesim.sim:
* cycle detection uses per-node self-reachability (BFS) instead of the
  iterative DFS first-cycle search in leasesim.sim.Simulator._find_cycle;
* the victim is the max (t, client) among *all* nodes currently on a
  cycle, recomputed after every removal.
Both formulations must agree on every generated scenario.
"""

import json
import random
import unittest

from leasesim.cli import load_spec
from leasesim.sim import SimError, Simulator


class RefError(Exception):
    pass


def _cyclic_clients(waiters):
    """Clients sitting on a wait-for cycle, via plain self-reachability."""
    edges = {client: set(blockers) for client, blockers in waiters}
    cyclic = set()
    for start in edges:
        seen = set()
        stack = list(edges[start])
        while stack:
            node = stack.pop()
            if node == start:
                cyclic.add(start)
                break
            if node in seen:
                continue
            seen.add(node)
            stack.extend(edges.get(node, ()))
    return cyclic


def ref_run(capacities, ops):
    """Independent simulator.  Returns (events, holders) like leasesim."""
    holdings = {}   # client -> {res: amount}
    expiries = {}   # client -> {res: expiry}
    queue = []      # pending request dicts
    events = []
    now = 0
    seq = 0

    def emit(kind, result, client, **extra):
        nonlocal seq
        events.append({"seq": seq, "t": now, "client": client,
                       "kind": kind, "result": result, **extra})
        seq += 1

    def available(res):
        return capacities[res] - sum(h.get(res, 0)
                                     for h in holdings.values())

    def grantable(req):
        return all(available(r) >= n for r, n in req["acquire"].items())

    def settle(silent=None):
        while True:
            moved = False
            while queue and grantable(queue[0]):
                req = queue.pop(0)
                held = holdings.setdefault(req["client"], {})
                exp = expiries.setdefault(req["client"], {})
                for res, need in req["acquire"].items():
                    held[res] = held.get(res, 0) + need
                    exp[res] = now + req["ttl"]
                req["status"] = "GRANTED"
                req["expires_at"] = now + req["ttl"]
                if req is not silent:
                    emit("grant", "GRANTED", req["client"],
                         resources={r: req["acquire"][r]
                                    for r in sorted(req["acquire"])},
                         expires_at=req["expires_at"], request_t=req["t"])
                moved = True
            waiters = []
            for req in queue:
                blockers = set()
                for res, need in req["acquire"].items():
                    if available(res) < need:
                        for holder, held in holdings.items():
                            if held.get(res, 0) > 0 and holder != req["client"]:
                                blockers.add(holder)
                waiters.append((req["client"], blockers))
            cyclic = _cyclic_clients(waiters)
            if cyclic:
                victim = max((req["t"], req["client"]) for req in queue
                             if req["client"] in cyclic)[1]
                req = next(r for r in queue if r["client"] == victim)
                req["status"] = "DEADLOCK"
                queue.remove(req)
                if req is not silent:
                    emit("deadlock", "DEADLOCK", victim,
                         resources={r: req["acquire"][r]
                                    for r in sorted(req["acquire"])},
                         request_t=req["t"])
                moved = True
            if not moved:
                return

    def expire_due(t):
        nonlocal now
        while True:
            due = [(exp, c, r) for c, exps in expiries.items()
                   for r, exp in exps.items() if exp <= t]
            if not due:
                return
            first = min(e for e, _, _ in due)
            now = first
            for client in sorted({c for e, c, _ in due if e == first}):
                released = {}
                for res in sorted(expiries[client]):
                    if expiries[client][res] <= first:
                        released[res] = holdings[client].pop(res)
                        del expiries[client][res]
                if not holdings[client]:
                    del holdings[client]
                    del expiries[client]
                emit("expire", "EXPIRED", client, resources=released)
            settle()

    def apply_op(op):
        nonlocal now
        client = op["client"]
        if "acquire" in op:
            acquire = op["acquire"]
            held = holdings.get(client, {})
            if any(held.get(r, 0) > 0 for r in acquire):
                raise RefError("concurrent-hold conflict")
            if any(req["client"] == client for req in queue):
                raise RefError("pending request exists")
            for res, need in acquire.items():
                if res not in capacities:
                    raise RefError("unknown resource")
                if need <= 0:
                    raise RefError("need must be positive")
                if need > capacities[res]:
                    raise RefError("need exceeds capacity")
            req = {"client": client, "t": now, "acquire": dict(acquire),
                   "ttl": op["ttl"], "status": "WAITING"}
            queue.append(req)
            settle(silent=req)
            extra = {"resources": {r: acquire[r] for r in sorted(acquire)},
                     "ttl": op["ttl"]}
            if req["status"] == "GRANTED":
                extra["expires_at"] = req["expires_at"]
            emit("acquire", req["status"], client, **extra)
        else:
            held = holdings.get(client, {})
            for res in op["release"]:
                if res not in capacities:
                    raise RefError("unknown resource")
                if held.get(res, 0) <= 0:
                    raise RefError("not held")
            released = {}
            for res in op["release"]:
                released[res] = holdings[client].pop(res)
                del expiries[client][res]
            if not holdings[client]:
                del holdings[client]
                del expiries[client]
            emit("release", "RELEASED", client,
                 resources={r: released[r] for r in sorted(released)})
            settle()

    by_tick = {}
    for op in ops:
        by_tick.setdefault(op["t"], []).append(op)
    for t in sorted(by_tick):
        expire_due(t)
        now = t
        for op in by_tick[t]:
            apply_op(op)
        expire_due(t)

    holders = {}
    for client in sorted(holdings):
        if holdings[client]:
            holders[client] = {
                "resources": {r: holdings[client][r]
                              for r in sorted(holdings[client])},
                "expires_at": {r: expiries[client][r]
                               for r in sorted(holdings[client])},
            }
    return events, holders


def normalize(events):
    """Drop the 'cycle' detail: both sims may report a different member
    ordering for the same deadlock, everything else must match exactly."""
    return [{k: v for k, v in e.items() if k != "cycle"} for e in events]


def gen_spec(rng):
    n_res = rng.randint(1, 3)
    resources = {f"r{i}": rng.randint(1, 2) for i in range(n_res)}
    n_ops = rng.randint(1, 6)
    ops = []
    used = set()
    # Plant a crossed-request (deadlock-prone) pattern in some scenarios.
    if n_res >= 2 and n_ops >= 4 and rng.random() < 0.4:
        ra, rb = rng.sample(sorted(resources), 2)
        resources[ra] = resources[rb] = 1
        c1, c2 = rng.sample(("a", "b", "c"), 2)
        t0 = rng.randint(0, 3)
        planted = [
            {"t": t0, "client": c1, "acquire": {ra: 1}, "ttl": 9},
            {"t": t0, "client": c2, "acquire": {rb: 1}, "ttl": 9},
            {"t": t0 + 1, "client": c1, "acquire": {rb: 1}, "ttl": 9},
            {"t": t0 + 1, "client": c2, "acquire": {ra: 1}, "ttl": 9},
        ]
        for op in planted:
            used.add((op["t"], op["client"]))
        ops.extend(planted)
        n_ops -= 4
    slots = [slot for slot in
             [(t, c) for t in range(5) for c in ("a", "b", "c")]
             if slot not in used]
    slots = rng.sample(slots, min(n_ops, len(slots)))
    for t, client in slots:
        if rng.random() < 0.65:
            names = rng.sample(sorted(resources),
                               rng.randint(1, n_res))
            acquire = {}
            for name in names:
                cap = resources[name]
                roll = rng.random()
                if roll < 0.08:
                    acquire[name] = 0            # invalid: need <= 0
                elif roll < 0.16:
                    acquire[name] = cap + 1      # invalid: over capacity
                else:
                    acquire[name] = rng.randint(1, cap)
            ops.append({"t": t, "client": client, "acquire": acquire,
                        "ttl": rng.randint(0, 3)})
        else:
            names = rng.sample(sorted(resources),
                               rng.randint(1, n_res))
            ops.append({"t": t, "client": client, "release": names})
    return {"resources": resources, "ops": ops}


class TestFuzzCrossCheck(unittest.TestCase):
    def test_against_reference_implementation(self):
        checked = errors = deadlocks = 0
        for seed in range(400):
            rng = random.Random(seed)
            spec = gen_spec(rng)
            capacities, ops = load_spec(json.dumps(spec))
            main_events = main_holders = main_err = None
            try:
                state = Simulator(capacities).run(
                    [dict(op) for op in ops])
                main_events = normalize(state["results"])
                main_holders = state["holders"]
            except SimError as exc:
                main_err = exc
            ref_events = ref_holders = ref_err = None
            try:
                ref_events, ref_holders = ref_run(
                    capacities, [dict(op) for op in ops])
                ref_events = normalize(ref_events)
            except RefError as exc:
                ref_err = exc
            self.assertEqual(
                main_err is None, ref_err is None,
                f"seed={seed}: error mismatch {main_err!r} vs {ref_err!r}")
            if main_err is not None:
                errors += 1
                continue
            self.assertEqual(main_events, ref_events,
                             f"seed={seed}: event stream mismatch")
            self.assertEqual(main_holders, ref_holders,
                             f"seed={seed}: holders mismatch")
            checked += 1
            deadlocks += sum(1 for e in main_events
                             if e["result"] == "DEADLOCK")
        # sanity: the corpus must actually exercise deadlocks and errors
        self.assertGreater(deadlocks, 0)
        self.assertGreater(errors, 0)
        self.assertGreater(checked, 0)


if __name__ == "__main__":
    unittest.main()
