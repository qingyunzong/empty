"""Explicit-interleaving concurrency simulation and an independent serial
history search (linearizability witness).

A *thread* is an ordered list of operations for one logical requester (or
the clock).  `enumerate_interleavings` yields every interleaving that
respects per-thread order.  `run_history` executes one interleaving
atomically op-by-op, checking budget invariants at every step.
`find_serial_witness` independently searches for a serial execution of the
same operations that reproduces every observed result -- the concurrent
history is linearizable iff such a serial history exists.
"""

from __future__ import annotations

from .engine import Authorizer


def execute(auth: Authorizer, op: dict) -> dict:
    """Dispatch one operation; the call is the op's linearization point."""
    kind = op["op"]
    if kind == "reserve":
        return auth.reserve(op["request_id"], op["subject"], op["resource"],
                            op["amount"], op["ttl"])
    if kind == "confirm":
        return auth.confirm(op["request_id"])
    if kind == "release":
        return auth.release(op["request_id"])
    if kind == "advance_time":
        return auth.advance_time(op["now"])
    if kind == "set_quota":
        return auth.set_quota(op["budget_id"], op["quota"])
    raise ValueError(f"unknown op {kind!r}")


def enumerate_interleavings(threads: list[list[dict]],
                            max_ops: int | None = None):
    """Yield every order-respecting interleaving as a list of
    (thread_index, op_index, op)."""
    total = sum(len(t) for t in threads)
    if max_ops is not None and total > max_ops:
        return
    pos = [0] * len(threads)
    acc: list[tuple[int, int, dict]] = []

    def rec():
        if all(pos[i] == len(threads[i]) for i in range(len(threads))):
            yield list(acc)
            return
        for i, thread in enumerate(threads):
            k = pos[i]
            if k < len(thread):
                acc.append((i, k, thread[k]))
                pos[i] += 1
                yield from rec()
                pos[i] -= 1
                acc.pop()

    yield from rec()


def run_history(factory, interleaving) -> dict:
    """Execute one interleaving on a fresh authorizer; verify invariants
    after every single operation."""
    auth = factory()
    steps = []
    for (t, k, op) in interleaving:
        result = execute(auth, op)
        auth.check_invariants()
        steps.append({"thread": t, "index": k, "op": op, "result": result})
    final = auth.state()
    auth.close()
    return {"steps": steps, "final": final}


def find_serial_witness(factory, threads: list[list[dict]],
                        history: dict) -> list | None:
    """Independent serial history search.

    Returns a serial order of (thread, index) pairs whose execution
    reproduces every result observed in the concurrent history, or None.
    """
    expected = {(s["thread"], s["index"]): s["result"]
                for s in history["steps"]}
    auth = factory()
    pos = [0] * len(threads)

    def dfs():
        if all(pos[i] == len(threads[i]) for i in range(len(threads))):
            return []
        for i, thread in enumerate(threads):
            k = pos[i]
            if k >= len(thread):
                continue
            snap = auth.snapshot()
            result = execute(auth, thread[k])
            if result == expected[(i, k)]:
                pos[i] += 1
                witness = dfs()
                if witness is not None:
                    return [(i, k)] + witness
                pos[i] -= 1
            auth.restore(snap)
        return None

    return dfs()
