"""Core deterministic lease simulator.

Semantics
---------
* Ops are processed in (t, client) order; duplicate (t, client) is an error.
* An acquire is atomic: either the whole bundle is granted or the request
  waits holding nothing.
* A lease granted at time t with TTL k expires at t + k.  Expiry at time s
  is processed before any op with t == s.  ttl=0 means the lease is
  released at the end of the tick it was granted on.
* Waiters queue in (request_t, client) order and are granted strictly from
  the head of the queue (FIFO, head-of-line blocking).  A waiting request
  that sits on a cycle of the wait-for graph is marked DEADLOCK and
  dropped so the system can never block forever; the victim is the
  request with the largest (t, client) on the cycle.
"""

from __future__ import annotations

from dataclasses import dataclass, field


class SimError(Exception):
    """Invalid input or semantic conflict; the CLI exits with code 2."""


@dataclass(eq=False)
class Request:
    op_seq: int
    t: int
    client: str
    acquire: dict
    ttl: int
    status: str = "WAITING"  # WAITING | GRANTED | DEADLOCK
    expires_at: int | None = None
    cycle: list | None = None


class Simulator:
    def __init__(self, capacities):
        if not isinstance(capacities, dict) or not capacities:
            raise SimError("'resources' must be a non-empty object")
        for name, cap in capacities.items():
            if not isinstance(name, str) or not name:
                raise SimError(f"invalid resource name: {name!r}")
            if not isinstance(cap, int) or isinstance(cap, bool) or cap < 1:
                raise SimError(
                    f"resource {name!r}: capacity must be a positive integer")
        self.capacities = {k: capacities[k] for k in sorted(capacities)}
        self.holdings = {}   # client -> {resource: amount}
        self.expiries = {}   # client -> {resource: expiry time}
        self.queue = []      # pending Requests, ordered by (t, client)
        self.events = []     # ordered output entries
        self.now = 0
        self._event_seq = 0

    # ------------------------------------------------------------------ util
    def available(self, resource):
        used = sum(h.get(resource, 0) for h in self.holdings.values())
        return self.capacities[resource] - used

    def _emit(self, kind, result, client, **extra):
        entry = {
            "seq": self._event_seq,
            "t": self.now,
            "client": client,
            "kind": kind,
            "result": result,
        }
        entry.update(extra)
        self.events.append(entry)
        self._event_seq += 1

    # ------------------------------------------------------------- granting
    def _grantable(self, req):
        return all(self.available(res) >= need
                   for res, need in req.acquire.items())

    def _grant(self, req):
        held = self.holdings.setdefault(req.client, {})
        exp = self.expiries.setdefault(req.client, {})
        for res, amount in req.acquire.items():
            held[res] = held.get(res, 0) + amount
            exp[res] = self.now + req.ttl
        req.status = "GRANTED"
        req.expires_at = self.now + req.ttl

    # --------------------------------------------------------- wait-for graph
    def _wait_graph(self):
        """Edges waiter -> holders of any resource it cannot fully get."""
        graph = {}
        for req in self.queue:
            blockers = set()
            for res, need in req.acquire.items():
                if self.available(res) < need:
                    for holder, held in self.holdings.items():
                        if held.get(res, 0) > 0 and holder != req.client:
                            blockers.add(holder)
            graph[req.client] = sorted(blockers)
        return graph

    @staticmethod
    def _find_cycle(graph, order):
        """Deterministic iterative DFS; returns one cycle as a list or None."""
        WHITE, GRAY, BLACK = 0, 1, 2
        color = {node: WHITE for node in graph}
        for start in order:
            if color[start] != WHITE:
                continue
            color[start] = GRAY
            path = [start]
            stack = [(start, iter(graph[start]))]
            while stack:
                node, it = stack[-1]
                descend = None
                for nb in it:
                    nb_color = color.get(nb, BLACK)  # non-waiters are sinks
                    if nb_color == GRAY:
                        return path[path.index(nb):]
                    if nb_color == WHITE:
                        descend = nb
                        break
                if descend is None:
                    color[node] = BLACK
                    stack.pop()
                    path.pop()
                else:
                    color[descend] = GRAY
                    path.append(descend)
                    stack.append((descend, iter(graph[descend])))
        return None

    # ---------------------------------------------------------------- settle
    def _settle(self, silent=None):
        """Grant from the queue head and break deadlocks until stable."""
        while True:
            progressed = False
            while self.queue and self._grantable(self.queue[0]):
                req = self.queue.pop(0)
                self._grant(req)
                if req is not silent:
                    self._emit(
                        "grant", "GRANTED", req.client,
                        resources={r: req.acquire[r]
                                   for r in sorted(req.acquire)},
                        expires_at=req.expires_at, request_t=req.t)
                progressed = True
            graph = self._wait_graph()
            order = [req.client for req in self.queue]
            cycle = self._find_cycle(graph, order)
            if cycle is not None:
                by_client = {req.client: req for req in self.queue}
                victim = max(cycle, key=lambda c: (by_client[c].t, c))
                req = by_client[victim]
                req.status = "DEADLOCK"
                req.cycle = sorted(cycle)
                self.queue = [r for r in self.queue if r is not req]
                if req is not silent:
                    self._emit(
                        "deadlock", "DEADLOCK", req.client,
                        resources={r: req.acquire[r]
                                   for r in sorted(req.acquire)},
                        request_t=req.t, cycle=req.cycle)
                progressed = True
            if not progressed:
                return

    # ---------------------------------------------------------------- expiry
    def _expire_due(self, t):
        """Release every lease with expiry <= t, oldest expiry first."""
        while True:
            due = []
            for client, exps in self.expiries.items():
                for res, exp in exps.items():
                    if exp <= t:
                        due.append((exp, client, res))
            if not due:
                return
            first = min(exp for exp, _, _ in due)
            self.now = first
            clients = sorted({c for exp, c, _ in due if exp == first})
            for client in clients:
                released = {}
                for res in sorted(self.expiries[client]):
                    if self.expiries[client][res] <= first:
                        released[res] = self.holdings[client].pop(res)
                        del self.expiries[client][res]
                if not self.holdings[client]:
                    del self.holdings[client]
                    del self.expiries[client]
                self._emit("expire", "EXPIRED", client, resources=released)
            self._settle()

    # ------------------------------------------------------------------- ops
    def _apply_acquire(self, op):
        client = op["client"]
        acquire = op["acquire"]
        ttl = op["ttl"]
        if not isinstance(ttl, int) or isinstance(ttl, bool) or ttl < 0:
            raise SimError(
                f"op #{op['seq']}: ttl must be a non-negative integer")
        held = self.holdings.get(client, {})
        dup = sorted(r for r in acquire if held.get(r, 0) > 0)
        if dup:
            raise SimError(
                f"client {client!r} already holds resource(s) {dup}: "
                "concurrent-hold conflict")
        if any(req.client == client for req in self.queue):
            raise SimError(
                f"client {client!r} already has a pending request: "
                "concurrent-hold conflict")
        for res in sorted(acquire):
            need = acquire[res]
            if res not in self.capacities:
                raise SimError(f"op #{op['seq']}: unknown resource {res!r}")
            if not isinstance(need, int) or isinstance(need, bool) or need <= 0:
                raise SimError(
                    f"op #{op['seq']}: need for {res!r} must be a "
                    "positive integer")
            if need > self.capacities[res]:
                raise SimError(
                    f"op #{op['seq']}: need {need} exceeds capacity of "
                    f"{res!r} ({self.capacities[res]})")
        req = Request(op_seq=op["seq"], t=self.now, client=client,
                      acquire=dict(acquire), ttl=ttl)
        self.queue.append(req)  # stays sorted: ops arrive in (t, client) order
        self._settle(silent=req)
        extra = {"resources": {r: acquire[r] for r in sorted(acquire)},
                 "ttl": ttl}
        if req.status == "GRANTED":
            extra["expires_at"] = req.expires_at
        elif req.status == "DEADLOCK":
            extra["cycle"] = req.cycle
        self._emit("acquire", req.status, client, **extra)

    def _apply_release(self, op):
        client = op["client"]
        release = op["release"]
        held = self.holdings.get(client, {})
        for res in release:
            if res not in self.capacities:
                raise SimError(f"op #{op['seq']}: unknown resource {res!r}")
            if held.get(res, 0) <= 0:
                raise SimError(
                    f"op #{op['seq']}: client {client!r} does not hold "
                    f"resource {res!r}")
        released = {}
        for res in release:
            released[res] = self.holdings[client].pop(res)
            del self.expiries[client][res]
        if not self.holdings[client]:
            del self.holdings[client]
            del self.expiries[client]
        self._emit("release", "RELEASED", client,
                   resources={r: released[r] for r in sorted(released)})
        self._settle()

    def _apply_op(self, op):
        if "acquire" in op:
            self._apply_acquire(op)
        else:
            self._apply_release(op)

    # ------------------------------------------------------------------- run
    def run(self, ops):
        by_tick = {}
        for op in ops:
            by_tick.setdefault(op["t"], []).append(op)
        for t in sorted(by_tick):
            self._expire_due(t)          # expiries happen before same-t ops
            self.now = t
            for op in by_tick[t]:
                self._apply_op(op)
            self._expire_due(t)          # ttl=0 leases die at end of tick
        return {
            "resources": dict(self.capacities),
            "results": self.events,
            "holders": self.final_holders(),
        }

    def final_holders(self):
        out = {}
        for client in sorted(self.holdings):
            held = self.holdings[client]
            if held:
                out[client] = {
                    "resources": {r: held[r] for r in sorted(held)},
                    "expires_at": {r: self.expiries[client][r]
                                   for r in sorted(held)},
                }
        return out
