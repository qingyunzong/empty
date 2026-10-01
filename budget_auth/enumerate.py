"""Exhaustive scenario enumeration for small configurations.

Generates deterministic pseudo-random scenarios with at most 6 budgets
and 4 requests, plus the drivers that enumerate every interleaving of
the per-request operation sequences and compare the real authorizer
against the independent reference model.
"""
import random

from .reference import RefModel, interleavings
from .system import Authorizer

MAX_BUDGETS = 6
MAX_REQUESTS = 4


def make_scenario(seed):
    """Return (setup_ops, threads) with <=6 budgets and <=4 requests."""
    rng = random.Random(seed)
    setup = []
    n_budgets = rng.randint(2, MAX_BUDGETS)
    for i in range(n_budgets):
        op = {"op": "add_budget", "id": f"b{i}",
              "quota": rng.randint(5, 25)}
        if i and rng.random() < 0.6:
            op["parent"] = f"b{rng.randrange(i)}"
        setup.append(op)
    for i in range(n_budgets):
        setup.append({
            "op": "add_rule", "id": f"r{i}",
            "subject": rng.choice(["alice", "bob", "*"]),
            "resource": rng.choice(["gpu", "*"]),
            "budget": f"b{i}",
            "start": 0, "end": rng.choice([4, 8, 100]),
        })
    threads = []
    for q in range(rng.randint(2, MAX_REQUESTS)):
        rid = f"q{q}"
        threads.append([
            {"op": "reserve", "request": rid,
             "subject": rng.choice(["alice", "bob"]), "resource": "gpu",
             "amount": rng.randint(1, 20), "ttl": rng.randint(2, 8)},
            {"op": rng.choice(["confirm", "release"]), "request": rid},
        ])
    ticks = [{"op": "tick", "now": t}
             for t in sorted(rng.sample(range(1, 12), 2))]
    threads.append(ticks)
    return setup, threads


def tagged(threads):
    return [[(f"{t}:{i}", op) for i, op in enumerate(seq)]
            for t, seq in enumerate(threads)]


def compare_run(setup, ops):
    """Run one op sequence on both implementations; return result vector."""
    auth = Authorizer()
    ref = RefModel()
    results = []
    for op in setup:
        auth.apply(op)
        ref.apply(op)
    for op in ops:
        res_a = auth.apply(op)
        res_r = ref.apply(op)
        results.append((res_a, res_r))
    return results, auth.snapshot(), ref.snapshot()


def results_match(res_a, res_r):
    keys = ("ok", "error", "holds", "expires_at", "status")
    return all(res_a.get(k) == res_r.get(k) for k in keys)


def enumerate_interleavings(setup, threads, limit=4000):
    """Yield (interleaving, results, snapshots) for short interleavings."""
    seqs = tagged(threads)
    for count, interleaving in enumerate(interleavings(seqs)):
        if count >= limit:
            return
        ops = [op for _, op in interleaving]
        results, snap_a, snap_r = compare_run(setup, ops)
        yield interleaving, results, snap_a, snap_r
