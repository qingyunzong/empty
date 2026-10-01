"""Deterministic multi-resource lease simulator.

Semantics
---------
* Ops are processed in ascending ``t``; ties break by client name
  (lexicographic), then by input order.
* ``acquire`` is atomic: either every requested resource amount is granted
  at once, or the request holds nothing and waits.
* A lease acquired at tick ``t`` with ``ttl`` expires at ``t + ttl``.
  Expirations due at tick ``t`` are processed *before* new ops of tick
  ``t``. ``ttl = 0`` means the lease is released at the *end* of the
  current tick. A missing ``ttl`` means the lease never expires.
* Waiting requests are queued by ``(request t, client)``.  Whenever the
  queue is examined (after releases/expirations, or when a request would
  block), a wait-for graph is consulted: an edge ``X -> Y`` means client
  ``X`` waits for a resource held by client ``Y``.  If granting/queueing a
  request would close a cycle, the request is rejected with ``DEADLOCK``
  instead of blocking the system forever.
* ``release`` frees only amounts actually held; releasing a resource the
  client does not hold is an error (exit code 2).
* Errors (exit code 2): ``need <= 0``, ``need > capacity``, a client
  acquiring a resource it already holds (duplicate concurrent holding
  conflict), releasing an unheld resource, malformed input.
"""

from __future__ import annotations

import heapq
from dataclasses import dataclass, field


class LeaseSimError(Exception):
    """Raised for invalid input or semantic errors (CLI exit code 2)."""


@dataclass
class _Request:
    seq: int
    t: int
    client: str
    needs: dict
    ttl: "int | None"


@dataclass
class _State:
    capacity: dict
    holders: dict = field(default_factory=dict)   # client -> {resource: amount}
    expiry_heap: list = field(default_factory=list)  # (expiry_t, seq, client, res, amount)
    waitq: list = field(default_factory=list)     # list[_Request], (t, client, seq) order
    events: list = field(default_factory=list)
    seq: int = 0

    def available(self, resource):
        held = sum(h.get(resource, 0) for h in self.holders.values())
        return self.capacity[resource] - held

    def held_by(self, client, resource):
        return self.holders.get(client, {}).get(resource, 0)

    def emit(self, t, client, kind, result, resources):
        self.events.append({
            "seq": self.seq,
            "t": t,
            "client": client,
            "op": kind,
            "result": result,
            "resources": dict(sorted(resources.items())),
        })
        self.seq += 1


def _validate_config(config):
    if not isinstance(config, dict):
        raise LeaseSimError("top-level JSON value must be an object")
    resources = config.get("resources")
    ops = config.get("ops")
    if not isinstance(resources, dict) or not resources:
        raise LeaseSimError("'resources' must be a non-empty object")
    for name, cap in resources.items():
        if not isinstance(name, str) or not name:
            raise LeaseSimError("resource names must be non-empty strings")
        if not isinstance(cap, int) or isinstance(cap, bool) or cap <= 0:
            raise LeaseSimError(f"capacity of resource {name!r} must be a positive integer")
    if not isinstance(ops, list):
        raise LeaseSimError("'ops' must be a list")
    return resources, ops


def _parse_op(index, raw, capacity):
    if not isinstance(raw, dict):
        raise LeaseSimError(f"op #{index} must be an object")
    t = raw.get("t")
    client = raw.get("client")
    if not isinstance(t, int) or isinstance(t, bool) or t < 0:
        raise LeaseSimError(f"op #{index}: 't' must be a non-negative integer")
    if not isinstance(client, str) or not client:
        raise LeaseSimError(f"op #{index}: 'client' must be a non-empty string")
    acquire = raw.get("acquire")
    release = raw.get("release")
    ttl = raw.get("ttl")
    if acquire is None and release is None:
        raise LeaseSimError(f"op #{index}: needs 'acquire' and/or 'release'")
    if acquire is not None:
        if not isinstance(acquire, dict) or not acquire:
            raise LeaseSimError(f"op #{index}: 'acquire' must be a non-empty object")
        for res, need in acquire.items():
            if res not in capacity:
                raise LeaseSimError(f"op #{index}: unknown resource {res!r}")
            if not isinstance(need, int) or isinstance(need, bool) or need <= 0:
                raise LeaseSimError(
                    f"op #{index}: need for {res!r} must be a positive integer")
            if need > capacity[res]:
                raise LeaseSimError(
                    f"op #{index}: need {need} exceeds capacity of {res!r}")
    if release is not None:
        if not isinstance(release, list) or not release:
            raise LeaseSimError(f"op #{index}: 'release' must be a non-empty list")
        if len(set(release)) != len(release):
            raise LeaseSimError(f"op #{index}: 'release' contains duplicates")
        for res in release:
            if res not in capacity:
                raise LeaseSimError(f"op #{index}: unknown resource {res!r}")
    if ttl is not None:
        if acquire is None:
            raise LeaseSimError(f"op #{index}: 'ttl' requires 'acquire'")
        if not isinstance(ttl, int) or isinstance(ttl, bool) or ttl < 0:
            raise LeaseSimError(f"op #{index}: 'ttl' must be a non-negative integer")
    return t, client, acquire, release, ttl


def _wait_edges(state, extra=None):
    """Wait-for graph: X -> {Y} if X waits on a resource held by Y.

    ``extra`` is an optional ``(client, needs)`` pair for a prospective
    request that is not queued yet.
    """
    edges = {}
    candidates = [(req.client, req.needs) for req in state.waitq]
    if extra is not None:
        candidates.append(extra)
    for client, needs in candidates:
        targets = edges.setdefault(client, set())
        for res, need in needs.items():
            if state.available(res) < need:
                for holder, holdings in state.holders.items():
                    if holder != client and holdings.get(res, 0) > 0:
                        targets.add(holder)
    return edges


def _creates_cycle(state, client, needs):
    """True if adding wait edges for ``client`` closes a cycle.

    The existing wait-for graph is acyclic by invariant, so a new cycle
    must pass through ``client``: it exists iff some client that ``client``
    would wait on can itself reach ``client``.
    """
    edges = _wait_edges(state, (client, needs))
    visited = set()
    stack = list(edges.get(client, ()))
    while stack:
        node = stack.pop()
        if node == client:
            return True
        if node in visited:
            continue
        visited.add(node)
        stack.extend(edges.get(node, ()))
    return False


def _can_grant(state, needs):
    return all(state.available(res) >= need for res, need in needs.items())


def _grant(state, req, t):
    for res, need in req.needs.items():
        state.holders.setdefault(req.client, {})
        state.holders[req.client][res] = state.holders[req.client].get(res, 0) + need
    if req.ttl is not None:
        heapq.heappush(state.expiry_heap,
                       (t + req.ttl, state.seq, req.client, tuple(sorted(req.needs.items()))))
    state.emit(t, req.client, "acquire", "GRANTED", req.needs)


def _drain_queue(state, t):
    """Scan the wait queue in (t, client, seq) order.

    Grant requests that can be fully satisfied; reject requests that would
    close a wait-for cycle with DEADLOCK; leave the rest queued.  Never
    blocks the whole system behind a single unsatisfiable request.
    """
    changed = True
    while changed:
        changed = False
        for req in list(state.waitq):
            if _can_grant(state, req.needs):
                state.waitq.remove(req)
                _grant(state, req, t)
                changed = True
                break
            if _creates_cycle(state, req.client, req.needs):
                state.waitq.remove(req)
                state.emit(t, req.client, "acquire", "DEADLOCK", req.needs)
                changed = True
                break


def _expire_due(state, t):
    due = []
    while state.expiry_heap and state.expiry_heap[0][0] <= t:
        _, _, client, items = heapq.heappop(state.expiry_heap)
        due.append((client, items))
    if not due:
        return
    due.sort(key=lambda item: (item[0], item[1]))
    for client, items in due:
        released = {}
        for res, amount in items:
            held = state.held_by(client, res)
            freed = min(held, amount)
            if freed <= 0:
                continue
            state.holders[client][res] = held - freed
            if state.holders[client][res] == 0:
                del state.holders[client][res]
            released[res] = released.get(res, 0) + freed
        if not state.holders.get(client):
            state.holders.pop(client, None)
        if released:
            state.emit(t, client, "expire", "EXPIRED", released)
    _drain_queue(state, t)


def _do_acquire(state, t, client, acquire, ttl):
    for res in acquire:
        if state.held_by(client, res) > 0:
            raise LeaseSimError(
                f"client {client!r} already holds resource {res!r} "
                "(duplicate concurrent holding conflict)")
    req = _Request(seq=state.seq, t=t, client=client,
                   needs=dict(sorted(acquire.items())), ttl=ttl)
    if _can_grant(state, req.needs):
        _grant(state, req, t)
    elif _creates_cycle(state, client, req.needs):
        state.emit(t, client, "acquire", "DEADLOCK", req.needs)
    else:
        state.emit(t, client, "acquire", "WAITING", req.needs)
        state.waitq.append(req)
        state.waitq.sort(key=lambda r: (r.t, r.client, r.seq))


def _do_release(state, t, client, release):
    missing = [res for res in release if state.held_by(client, res) <= 0]
    if missing:
        raise LeaseSimError(
            f"client {client!r} does not hold {sorted(missing)!r}")
    released = {}
    for res in release:
        released[res] = state.holders[client].pop(res)
    if not state.holders[client]:
        del state.holders[client]
    state.emit(t, client, "release", "RELEASED", released)
    _drain_queue(state, t)


def run(config):
    """Run the simulation and return a deterministic result dict."""
    capacity, raw_ops = _validate_config(config)
    parsed = [_parse_op(i, raw, capacity) for i, raw in enumerate(raw_ops)]
    order = sorted(range(len(parsed)),
                   key=lambda i: (parsed[i][0], parsed[i][1], i))

    state = _State(capacity=dict(sorted(capacity.items())))
    by_tick = {}
    for i in order:
        by_tick.setdefault(parsed[i][0], []).append(i)

    for t in sorted(by_tick):
        _expire_due(state, t)
        for i in by_tick[t]:
            _, client, acquire, release, ttl = parsed[i]
            if acquire is not None:
                _do_acquire(state, t, client, acquire, ttl)
            if release is not None:
                _do_release(state, t, client, release)
        _expire_due(state, t)  # ttl == 0 leases end here

    holders = {client: dict(sorted(h.items()))
               for client, h in sorted(state.holders.items())}
    waiting = [{"t": req.t, "client": req.client,
                "needs": dict(sorted(req.needs.items()))}
               for req in state.waitq]
    return {
        "events": state.events,
        "holders": holders,
        "waiting": waiting,
        "resources": dict(sorted(capacity.items())),
    }
