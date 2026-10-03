"""Deterministic single-process network simulation.

All operations are recorded in an append-only event log; replaying the log
from an empty :class:`Network` reproduces the exact same final state
(verified via :meth:`Network.digest`).
"""
from __future__ import annotations

import hashlib
import heapq
import json

from .context import CausalContext
from .event import Event
from .node import Config, Node


class Network:
    def __init__(self):
        self.nodes = {}        # node_id -> Node
        self.epochs = {}       # node_id -> latest epoch ever assigned
        self.time = 0
        self.seq = 0
        self.queue = []        # heap of (deliver_at, seq, src, dst, msg)
        self.blocked = set()   # directed (src, dst) pairs currently cut
        self.log = []          # replayable operation log
        self.snapshots = {}    # name -> node snapshot
        self.config = Config(0, set())

    # ------------------------------------------------------------------
    def _record(self, op, **fields):
        entry = {"i": len(self.log), "t": self.time, "op": op}
        entry.update(fields)
        self.log.append(entry)
        return entry

    def _emit(self, src, dst, msg, delay=0, duplicates=1):
        for _ in range(duplicates):
            self.seq += 1
            heapq.heappush(self.queue, (self.time + delay, self.seq, src, dst, msg))

    def _broadcast(self, src, msg, delay=0, duplicates=1):
        for (node_id, _epoch) in sorted(self.config.members):
            if node_id != src and node_id in self.nodes:
                self._emit(src, node_id, msg, delay, duplicates)

    def _broadcast_config(self):
        for node_id in sorted(self.nodes):
            self._emit("system", node_id,
                       {"type": "config", "config": self.config.to_json()})

    # ------------------------------------------------------------------
    # membership
    # ------------------------------------------------------------------
    def add_node(self, node_id):
        if node_id in self.nodes:
            raise ValueError(f"node {node_id!r} already exists")
        epoch = self.epochs.get(node_id, 0) + 1
        self.epochs[node_id] = epoch
        node = Node(node_id, epoch)
        self.nodes[node_id] = node
        self.config = Config(self.config.version + 1,
                             set(self.config.members) | {(node_id, epoch)})
        node.apply_config(self.config)
        self._broadcast_config()
        self._record("add_node", node=node_id, epoch=epoch,
                     config=self.config.to_json())
        return node

    def retire(self, node_id):
        if node_id not in self.nodes:
            raise ValueError(f"unknown node {node_id!r}")
        self.config = Config(
            self.config.version + 1,
            {m for m in self.config.members if m[0] != node_id})
        self._broadcast_config()
        self._record("retire", node=node_id, config=self.config.to_json())

    def rejoin(self, node_id):
        """A retired member must come back under a *new* epoch."""
        if node_id not in self.nodes:
            raise ValueError(f"unknown node {node_id!r}")
        epoch = self.epochs[node_id] + 1
        self.epochs[node_id] = epoch
        node = self.nodes[node_id]
        node.epoch = epoch
        self.config = Config(self.config.version + 1,
                             set(self.config.members) | {(node_id, epoch)})
        self._broadcast_config()
        self._record("rejoin", node=node_id, epoch=epoch,
                     config=self.config.to_json())
        return node

    # ------------------------------------------------------------------
    # operations
    # ------------------------------------------------------------------
    def put(self, node_id, key, value, delay=0, duplicates=1):
        event = self.nodes[node_id].put(key, value)
        self._broadcast(node_id, {"type": "event", "event": event.to_json()},
                        delay, duplicates)
        self._record("put", node=node_id, key=key, value=value,
                     dot=list(event.dot), delay=delay, duplicates=duplicates)
        return event

    def delete(self, node_id, key, delay=0, duplicates=1):
        event = self.nodes[node_id].delete(key)
        self._broadcast(node_id, {"type": "event", "event": event.to_json()},
                        delay, duplicates)
        self._record("delete", node=node_id, key=key, dot=list(event.dot),
                     delay=delay, duplicates=duplicates)
        return event

    def read(self, node_id, key):
        result = self.nodes[node_id].read(key)
        self._record("read", node=node_id, key=key, result=result)
        return result

    def send_acks(self, node_id):
        node = self.nodes[node_id]
        msg = {"type": "ack", "member": [node.node_id, node.epoch],
               "config_version": node.config.version,
               "context": node.delivered.to_json()}
        self._broadcast(node_id, msg)
        self._record("ack", node=node_id, config_version=node.config.version)

    def partition(self, a, b):
        self.blocked.add((a, b))
        self.blocked.add((b, a))
        self._record("partition", a=a, b=b)

    def heal(self, a, b):
        self.blocked.discard((a, b))
        self.blocked.discard((b, a))
        self._record("heal", a=a, b=b)

    def deliver_next(self):
        """Deliver the oldest eligible message (blocked links are skipped
        and stay queued).  Returns a description, or None when idle."""
        skipped, chosen = [], None
        while self.queue:
            item = heapq.heappop(self.queue)
            if (item[2], item[3]) in self.blocked or item[0] > self.time:
                skipped.append(item)
                continue
            chosen = item
            break
        for item in skipped:
            heapq.heappush(self.queue, item)
        if chosen is None:
            self._record("deliver", result="idle")
            return None
        deliver_at, seq, src, dst, msg = chosen
        self.time = max(self.time, deliver_at)
        status = self._deliver_msg(dst, msg)
        self._record("deliver", seq=seq, src=src, dst=dst,
                     type=msg["type"], status=status)
        return {"seq": seq, "src": src, "dst": dst, "status": status}

    def run(self):
        """Deliver every currently eligible message, in deterministic order."""
        delivered = []
        while True:
            result = self.deliver_next()
            if result is None:
                break
            delivered.append(result)
        return delivered

    def advance(self, steps=1):
        """Advance logical time so delayed messages become eligible."""
        self.time += steps
        self._record("advance", steps=steps)

    def resync(self, node_id):
        """Recovery merge: every other current member re-sends its full
        event journal to *node_id* (duplicates are dropped on delivery)."""
        for (peer_id, _epoch) in sorted(self.config.members):
            if peer_id == node_id or peer_id not in self.nodes:
                continue
            for event in self.nodes[peer_id].history:
                self._emit(peer_id, node_id,
                           {"type": "event", "event": event.to_json()})
        self._record("resync", node=node_id)

    def _deliver_msg(self, dst, msg):
        node = self.nodes[dst]
        if msg["type"] == "event":
            return node.deliver(Event.from_json(msg["event"]))
        if msg["type"] == "ack":
            node.receive_ack(tuple(msg["member"]), msg["config_version"],
                             CausalContext.from_json(msg["context"]))
            return "ack"
        if msg["type"] == "config":
            node.apply_config(Config.from_json(msg["config"]))
            return "config"
        raise ValueError(f"unknown message type: {msg['type']!r}")

    def snapshot(self, node_id, name=None):
        name = name or f"snap-{node_id}-{len(self.snapshots)}"
        self.snapshots[name] = self.nodes[node_id].snapshot()
        self._record("snapshot", node=node_id, name=name)
        return name

    def restore(self, node_id, name):
        self.nodes[node_id] = Node.restore(self.snapshots[name])
        self._record("restore", node=node_id, name=name)
        return self.nodes[node_id]

    def gc(self, node_id):
        reclaimed = self.nodes[node_id].gc_tombstones()
        self._record("gc", node=node_id, reclaimed=reclaimed)
        return reclaimed

    # ------------------------------------------------------------------
    # replay / digest
    # ------------------------------------------------------------------
    def digest(self):
        state = {nid: self.nodes[nid].snapshot() for nid in sorted(self.nodes)}
        blob = json.dumps(state, sort_keys=True).encode()
        return hashlib.sha256(blob).hexdigest()

    def _replay_entry(self, entry):
        op = entry["op"]
        if op == "add_node":
            self.add_node(entry["node"])
        elif op == "put":
            self.put(entry["node"], entry["key"], entry["value"],
                     entry["delay"], entry["duplicates"])
        elif op == "delete":
            self.delete(entry["node"], entry["key"],
                        entry["delay"], entry["duplicates"])
        elif op == "read":
            self.read(entry["node"], entry["key"])
        elif op == "ack":
            self.send_acks(entry["node"])
        elif op == "partition":
            self.partition(entry["a"], entry["b"])
        elif op == "heal":
            self.heal(entry["a"], entry["b"])
        elif op == "deliver":
            self.deliver_next()
        elif op == "advance":
            self.advance(entry["steps"])
        elif op == "resync":
            self.resync(entry["node"])
        elif op == "snapshot":
            self.snapshot(entry["node"], entry["name"])
        elif op == "restore":
            self.restore(entry["node"], entry["name"])
        elif op == "gc":
            self.gc(entry["node"])
        elif op == "retire":
            self.retire(entry["node"])
        elif op == "rejoin":
            self.rejoin(entry["node"])
        else:
            raise ValueError(f"unknown log op: {op!r}")

    @classmethod
    def replay(cls, log):
        net = cls()
        for entry in log:
            net._replay_entry(entry)
        return net
