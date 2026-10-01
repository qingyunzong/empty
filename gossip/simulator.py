"""Deterministic gossip simulator core.

Semantics:
  * Each round, every live node selects ``fanout`` peers in a fixed,
    seed-derived order and sends its digest (key -> [version, origin, value]).
  * A received entry with a strictly higher version is applied; an entry
    with an equal version but different origin/value is recorded as a
    conflict; lower or identical entries are ignored, so duplicate
    messages are idempotent.
  * Messages addressed to a down node stay buffered in its inbox and are
    delivered FIFO once it comes back up; pending messages are never
    dropped as undeliverable.
  * Converged iff all live nodes hold identical version vectors and no
    live node has pending conflicts.

All randomness derives from the seed alone; no wall-clock or other
non-deterministic source is used anywhere.
"""

from __future__ import annotations

import random

MAX_NODES = 64
MAX_FANOUT = 4
MAX_ROUNDS = 200


class SimError(Exception):
    """Raised for any invalid command or parameter (CLI maps this to exit 9)."""


class Node:
    __slots__ = ("id", "up", "store", "conflicts", "inbox")

    def __init__(self, node_id):
        self.id = node_id
        self.up = True
        self.store = {}       # key -> [version, origin, value]
        self.conflicts = {}   # key -> list of [version, origin, value] alternatives
        self.inbox = []       # FIFO of buffered Message objects


class Message:
    __slots__ = ("src", "dst", "round", "digest")

    def __init__(self, src, dst, round_no, digest):
        self.src = src
        self.dst = dst
        self.round = round_no
        self.digest = digest  # key -> [version, origin, value]


class Simulator:
    def __init__(self, nodes, seed, fanout, topology="random"):
        if isinstance(nodes, bool) or not isinstance(nodes, int):
            raise SimError("nodes must be an integer")
        if not 1 <= nodes <= MAX_NODES:
            raise SimError(f"nodes must be in [1, {MAX_NODES}]")
        if isinstance(fanout, bool) or not isinstance(fanout, int):
            raise SimError("fanout must be an integer")
        if not 1 <= fanout <= MAX_FANOUT:
            raise SimError(f"fanout must be in [1, {MAX_FANOUT}]")
        if isinstance(seed, bool) or not isinstance(seed, int):
            raise SimError("seed must be an integer")
        if topology not in ("random", "ring"):
            raise SimError("topology must be 'random' or 'ring'")
        if topology == "ring" and fanout != 1:
            raise SimError("ring topology requires fanout=1")

        self.n = nodes
        self.seed = seed
        self.fanout = fanout
        self.topology = topology
        self.round = 0
        self.nodes = [Node(i) for i in range(nodes)]
        self.events = []  # deterministic event trace

    # ------------------------------------------------------------------ util

    def _emit(self, event):
        self.events.append(event)

    def _node(self, node_id):
        if isinstance(node_id, bool) or not isinstance(node_id, int):
            raise SimError("node must be an integer")
        if not 0 <= node_id < self.n:
            raise SimError(f"node must be in [0, {self.n - 1}]")
        return self.nodes[node_id]

    def _peers(self, node_id):
        """Fixed-order peer selection; depends only on (seed, node, round)."""
        if self.topology == "ring":
            return [(node_id + 1) % self.n] if self.n > 1 else []
        rng = random.Random(f"{self.seed}:{node_id}:{self.round}")
        others = [j for j in range(self.n) if j != node_id]
        k = min(self.fanout, len(others))
        return sorted(rng.sample(others, k))

    # -------------------------------------------------------------- commands

    def inject(self, node_id, key, value):
        node = self._node(node_id)
        if not isinstance(key, str) or not key:
            raise SimError("key must be a non-empty string")
        current = node.store.get(key)
        version = (current[0] + 1) if current else 1
        node.store[key] = [version, node_id, value]
        # A fresh local inject dominates and therefore resolves any
        # previously recorded conflict for this key.
        node.conflicts.pop(key, None)
        self._emit({
            "event": "inject", "round": self.round, "node": node_id,
            "key": key, "version": version, "value": value,
        })
        return version

    def down(self, node_id):
        node = self._node(node_id)
        node.up = False
        self._emit({"event": "down", "round": self.round, "node": node_id})

    def up(self, node_id):
        node = self._node(node_id)
        # Old state (store, conflicts, buffered inbox) is preserved.
        node.up = True
        self._emit({"event": "up", "round": self.round, "node": node_id})

    def step(self, rounds=1):
        if isinstance(rounds, bool) or not isinstance(rounds, int) or rounds < 1:
            raise SimError("rounds must be a positive integer")
        for _ in range(rounds):
            if self.round >= MAX_ROUNDS:
                raise SimError(
                    f"round limit {MAX_ROUNDS} exceeded: NOT_CONVERGED")
            self.round += 1
            self._send_phase()
            self._deliver_phase()

    # ---------------------------------------------------------------- phases

    def _send_phase(self):
        for node in self.nodes:
            if not node.up:
                continue
            digest = {k: list(v) for k, v in sorted(node.store.items())}
            for peer in self._peers(node.id):
                msg = Message(node.id, peer, self.round, digest)
                self.nodes[peer].inbox.append(msg)
                self._emit({
                    "event": "send", "round": self.round,
                    "from": node.id, "to": peer, "digest": digest,
                })

    def _deliver_phase(self):
        for node in self.nodes:
            if not node.up:
                # Node is down: it neither sends nor receives. Its buffered
                # messages stay queued and are never dropped.
                continue
            while node.inbox:
                msg = node.inbox.pop(0)
                self._deliver(node, msg)

    def _deliver(self, node, msg):
        applied = []
        conflicts = []
        for key in sorted(msg.digest):
            incoming = msg.digest[key]
            local = node.store.get(key)
            if local is None or incoming[0] > local[0]:
                node.store[key] = list(incoming)
                node.conflicts.pop(key, None)
                applied.append(key)
            elif incoming[0] == local[0]:
                if incoming[1] != local[1] or incoming[2] != local[2]:
                    # Concurrent version: same version, different origin/value.
                    alts = node.conflicts.setdefault(key, [list(local)])
                    if list(local) not in alts:
                        alts.append(list(local))
                    if list(incoming) not in alts:
                        alts.append(list(incoming))
                    conflicts.append(key)
                # Identical entry: duplicate, idempotent no-op.
            # Lower version: stale, ignored.
        self._emit({
            "event": "deliver", "round": self.round,
            "from": msg.src, "to": node.id, "sent_round": msg.round,
            "applied": applied, "conflicts": conflicts,
            "duplicate": not applied and not conflicts,
        })

    # ---------------------------------------------------------------- status

    def _version_vector(self, node):
        return {k: [v[0], v[1]] for k, v in sorted(node.store.items())}

    def converged(self):
        live = [n for n in self.nodes if n.up]
        if not live:
            return False
        reference = self._version_vector(live[0])
        for node in live:
            if node.conflicts:
                return False
            if self._version_vector(node) != reference:
                return False
        return True

    def status(self):
        converged = self.converged()
        if converged:
            state = "CONVERGED"
        elif self.round >= MAX_ROUNDS:
            state = "NOT_CONVERGED"
        else:
            state = "RUNNING"
        return {
            "round": self.round,
            "converged": converged,
            "state": state,
            "nodes": [
                {
                    "id": node.id,
                    "up": node.up,
                    "versions": self._version_vector(node),
                    "conflicts": {
                        k: [list(a) for a in v]
                        for k, v in sorted(node.conflicts.items())
                    },
                    "buffered": len(node.inbox),
                }
                for node in self.nodes
            ],
        }
