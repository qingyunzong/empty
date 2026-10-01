"""Deterministic gossip simulator.

Determinism rules:
  * The only randomness source is one ``random.Random(seed)`` instance.
  * Peer selection happens once per live node per round, in fixed node-id
    order, so the RNG call sequence is fully determined by the seed and the
    command history.
  * No wall-clock time is used anywhere; convergence is decided purely from
    node state (version vectors and conflict sets).

Data model:
  * Each node stores ``store[key] = [value, origin, counter]``.
  * A version is the pair ``(origin, counter)``.  Versions from the same
    origin are ordered by ``counter``; versions from different origins are
    concurrent.  Conflicts are resolved deterministically: the winner is the
    version with the largest ``(counter, origin)`` pair, so every node that
    has seen the same set of versions picks the same winner.
"""
from __future__ import annotations

import random
from collections import deque

MAX_NODES = 64
MAX_FANOUT = 4
MAX_ROUNDS = 200

TOPOLOGIES = ("random", "ring")


class SimError(Exception):
    """Raised for any invalid command or parameter (CLI maps this to exit 9)."""


def _version_key(origin, counter):
    # Total order used to pick a deterministic winner between two versions.
    return (counter, origin)


def _check_int(name, value, lo, hi):
    if isinstance(value, bool) or not isinstance(value, int):
        raise SimError(f"{name} must be an integer")
    if not lo <= value <= hi:
        raise SimError(f"{name} must be in [{lo}, {hi}], got {value}")
    return value


class Simulator:
    def __init__(self, nodes, seed, fanout, max_rounds, topology="random"):
        self.nodes = _check_int("nodes", nodes, 1, MAX_NODES)
        self.seed = _check_int("seed", seed, -(2 ** 63), 2 ** 63 - 1)
        self.fanout = _check_int("fanout", fanout, 0, MAX_FANOUT)
        self.max_rounds = _check_int("max_rounds", max_rounds, 1, MAX_ROUNDS)
        if topology not in TOPOLOGIES:
            raise SimError(f"topology must be one of {TOPOLOGIES}")
        self.topology = topology

        self._rng = random.Random(seed)
        # store[i][key] = [value, origin, counter]
        self.store = [dict() for _ in range(self.nodes)]
        # conflicts[i][key] = list of losing concurrent [value, origin, counter]
        self.conflicts = [dict() for _ in range(self.nodes)]
        self.clocks = [0] * self.nodes
        self.alive = [True] * self.nodes
        # Pending messages are never dropped while a node is down; they are
        # delivered FIFO once the node comes back up.
        self.inbox = [deque() for _ in range(self.nodes)]
        self.round = 0
        self.events = []

    # ------------------------------------------------------------------ util
    def _check_node(self, node):
        return _check_int("node", node, 0, self.nodes - 1)

    def version_vector(self, i):
        """Canonical comparable view of a node's knowledge."""
        return sorted((key, origin, counter)
                      for key, (value, origin, counter) in self.store[i].items())

    def converged(self):
        """True iff every live node has the same version vector and no
        live node has any unresolved conflict.  Purely state-based."""
        live = [i for i in range(self.nodes) if self.alive[i]]
        if not live:
            return False
        base = self.version_vector(live[0])
        return all(self.version_vector(i) == base and not self.conflicts[i]
                   for i in live)

    # ----------------------------------------------------------------- merge
    def _apply(self, i, key, value, origin, counter):
        """Apply one (key, value, version) to node i.  Idempotent."""
        cur = self.store[i].get(key)
        if cur is None:
            self.store[i][key] = [value, origin, counter]
            return "applied"
        _, cur_origin, cur_counter = cur
        if origin == cur_origin:
            if counter <= cur_counter:
                return "duplicate"  # stale or repeated message: no-op
            self.store[i][key] = [value, origin, counter]
            self._prune_conflicts(i, key, origin, counter)
            return "applied"
        # Different origins: concurrent versions.
        if _version_key(origin, counter) <= _version_key(cur_origin, cur_counter):
            entry = [value, origin, counter]
            known = self.conflicts[i].setdefault(key, [])
            if entry in known:
                return "duplicate"
            known.append(entry)
            return "conflict"
        self.store[i][key] = [value, origin, counter]
        self._prune_conflicts(i, key, origin, counter)
        return "applied"

    def _prune_conflicts(self, i, key, origin, counter):
        known = self.conflicts[i].get(key)
        if not known:
            return
        keep = [e for e in known
                if _version_key(e[1], e[2]) > _version_key(origin, counter)]
        if keep:
            self.conflicts[i][key] = keep
        else:
            self.conflicts[i].pop(key, None)

    # -------------------------------------------------------------- commands
    def inject(self, node, key, value):
        """Client write at one node.  Returns the new version [origin, counter]."""
        self._check_node(node)
        if not isinstance(key, str):
            raise SimError("key must be a string")
        self.clocks[node] += 1
        counter = self.clocks[node]
        result = self._apply(node, key, value, node, counter)
        self.events.append({
            "round": self.round, "type": "inject", "node": node,
            "key": key, "value": value, "version": [node, counter],
            "result": result,
        })
        return [node, counter]

    def down(self, node):
        self._check_node(node)
        self.alive[node] = False
        self.events.append({"round": self.round, "type": "down", "node": node})

    def up(self, node):
        self._check_node(node)
        self.alive[node] = True
        self.events.append({"round": self.round, "type": "up", "node": node})

    def step(self, rounds=1):
        """Run up to ``rounds`` rounds; stops early on convergence or when the
        round limit is reached.  Returns the number of rounds actually run."""
        _check_int("rounds", rounds, 1, MAX_ROUNDS)
        ran = 0
        for _ in range(rounds):
            if self.converged() or self.round >= self.max_rounds:
                break
            self._step_one()
            ran += 1
        return ran

    # ---------------------------------------------------------------- rounds
    def _select_peers(self, i):
        if self.nodes == 1 or self.fanout == 0:
            return []
        if self.topology == "ring":
            return [(i + k + 1) % self.nodes
                    for k in range(min(self.fanout, self.nodes - 1))]
        peers = [j for j in range(self.nodes) if j != i]
        return self._rng.sample(peers, min(self.fanout, len(peers)))

    def _step_one(self):
        self.round += 1
        # Send phase: live nodes, in fixed node-id order, gossip their digest.
        for i in range(self.nodes):
            if not self.alive[i]:
                continue
            targets = self._select_peers(i)
            if not targets:
                continue
            digest = {key: list(entry)
                      for key, entry in sorted(self.store[i].items())}
            for t in targets:
                self.inbox[t].append({"src": i, "sent_round": self.round,
                                      "entries": digest})
                self.events.append({"round": self.round, "type": "send",
                                    "src": i, "dst": t})
        # Deliver phase: live nodes drain their inbox FIFO; down nodes keep
        # their buffered messages untouched.
        for i in range(self.nodes):
            if not self.alive[i]:
                continue
            while self.inbox[i]:
                msg = self.inbox[i].popleft()
                results = {"applied": [], "conflict": [], "duplicate": []}
                for key in sorted(msg["entries"]):
                    value, origin, counter = msg["entries"][key]
                    result = self._apply(i, key, value, origin, counter)
                    results[result].append(key)
                self.events.append({
                    "round": self.round, "type": "deliver",
                    "src": msg["src"], "dst": i,
                    "sent_round": msg["sent_round"],
                    "applied": results["applied"],
                    "conflict": results["conflict"],
                    "duplicate": results["duplicate"],
                })

    # ---------------------------------------------------------------- status
    def status(self):
        return {
            "round": self.round,
            "converged": self.converged(),
            "nodes": [
                {
                    "id": i,
                    "alive": self.alive[i],
                    "clock": self.clocks[i],
                    "store": {k: list(v) for k, v in sorted(self.store[i].items())},
                    "conflicts": {k: [list(e) for e in v]
                                  for k, v in sorted(self.conflicts[i].items())},
                    "inbox": len(self.inbox[i]),
                }
                for i in range(self.nodes)
            ],
        }
