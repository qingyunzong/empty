"""Deterministic single-process network simulator.

All ordering is decided by ``(deliver_at, seq)`` so runs are reproducible.
Every public operation appends to an event log that fully determines the
run; :meth:`Sim.replay` re-executes a log and must reproduce the state.
"""
from __future__ import annotations

import hashlib
import heapq
import json
from typing import Dict, List, Optional, Tuple

from .dvv import CausalContext
from .store import Entry, Replica, Tombstone


class Sim:
    def __init__(self) -> None:
        self.replicas: Dict[str, Replica] = {}
        self.retired: Dict[str, int] = {}  # node -> last retired epoch
        self.time = 0
        self.seq = 0
        self.pending: List[tuple] = []  # (deliver_at, seq, src, dst, kind, payload)
        self.blocked: set[Tuple[str, str]] = set()
        self.held: List[tuple] = []  # messages blocked by a partition
        self.config_version = 0
        self.log: List[dict] = []

    # -- helpers ------------------------------------------------------------
    def _record(self, op: str, **fields) -> None:
        self.log.append({"op": op, **fields})

    def _members(self) -> List[Tuple[str, int]]:
        return sorted(r.identity for r in self.replicas.values())

    def _broadcast_config(self) -> None:
        self.config_version += 1
        members = self._members()
        for node in self.replicas:
            self._send("system", node, "config", (self.config_version, members))

    def _send(self, src: str, dst: str, kind: str, payload, delay: int = 0,
              duplicates: int = 1) -> None:
        for _ in range(duplicates):
            self.seq += 1
            item = (self.time + delay, self.seq, src, dst, kind, payload)
            self.pending.append(item)
        self.pending.sort(key=lambda x: (x[0], x[1]))

    def _broadcast(self, src: str, kind: str, payload, delay: int = 0,
                   duplicates: int = 1) -> None:
        for node in self.replicas:
            if node != src:
                self._send(src, node, kind, payload, delay, duplicates)

    # -- topology -------------------------------------------------------------
    def add_node(self, node: str) -> None:
        epoch = self.retired.get(node, 0) + 1
        self.replicas[node] = Replica(node, epoch)
        self._broadcast_config()
        self._record("add_node", node=node)

    def partition(self, a: str, b: str) -> None:
        self.blocked.add((a, b))
        self.blocked.add((b, a))
        self._record("partition", a=a, b=b)

    def heal(self, a: str, b: str) -> None:
        self.blocked.discard((a, b))
        self.blocked.discard((b, a))
        self.release_held()
        self._record("heal", a=a, b=b)

    # -- operations -------------------------------------------------------------
    def write(self, node: str, key: str, value: str, delay: int = 0,
              duplicates: int = 1) -> None:
        entry = self.replicas[node].write(key, value)
        self._broadcast(node, "put", entry, delay, duplicates)
        self._record("write", node=node, key=key, value=value,
                     delay=delay, duplicates=duplicates)

    def delete(self, node: str, key: str, delay: int = 0) -> None:
        tomb = self.replicas[node].delete(key)
        self._broadcast(node, "del", tomb, delay)
        self._record("delete", node=node, key=key, delay=delay)

    def send_acks(self, node: str) -> None:
        replica = self.replicas[node]
        payload = (replica.identity, replica.config_version, replica.kv)
        self._broadcast(node, "ack", payload)
        self._record("send_acks", node=node)

    def broadcast_acks(self) -> None:
        for node in sorted(self.replicas):
            replica = self.replicas[node]
            payload = (replica.identity, replica.config_version, replica.kv)
            self._broadcast(node, "ack", payload)
        self._record("broadcast_acks")

    def retire(self, node: str) -> None:
        replica = self.replicas.pop(node)
        self.retired[node] = replica.epoch
        self._broadcast_config()
        self._record("retire", node=node)

    def rejoin(self, node: str) -> None:
        epoch = self.retired.get(node, 0) + 1
        self.replicas[node] = Replica(node, epoch)
        self._broadcast_config()
        self._record("rejoin", node=node)

    def snapshot(self, node: str) -> dict:
        snap = self.replicas[node].snapshot()
        self._record("snapshot", node=node)
        return snap

    def restore(self, node: str, snap: dict) -> None:
        self.replicas[node] = Replica.restore(snap)
        self._record("restore", node=node, snap=snap)

    def gc(self, node: str) -> int:
        collected = self.replicas[node].gc_tombstones()
        self._record("gc", node=node)
        return collected

    def sync(self, src: str, dst: str) -> None:
        """Anti-entropy: join ``src``'s store state into ``dst``."""
        self.replicas[dst].merge_state(self.replicas[src])
        self._record("sync", src=src, dst=dst)

    def read(self, node: str, key: str) -> List[str]:
        return self.replicas[node].read(key)

    # -- delivery -------------------------------------------------------------
    def _apply(self, dst: str, kind: str, payload) -> None:
        replica = self.replicas.get(dst)
        if replica is None:
            return  # retired member: message dies
        if kind == "put":
            replica.deliver_put(payload)
        elif kind == "del":
            replica.deliver_delete(payload)
        elif kind == "ack":
            identity, config_version, vector = payload
            replica.receive_ack(identity, config_version, vector)
        elif kind == "config":
            version, members = payload
            replica.set_config(version, members)

    def deliver_next(self) -> bool:
        """Deliver the single next message in deterministic order."""
        self._record("deliver_next")
        return self._deliver_next()

    def _deliver_next(self) -> bool:
        while self.pending and self.pending[0][0] <= self.time:
            item = self.pending.pop(0)
            _, _, src, dst, kind, payload = item
            if src is not None and (src, dst) in self.blocked:
                self.held.append(item)
                continue
            self._apply(dst, kind, payload)
            return True
        return False

    def run(self) -> None:
        """Deliver everything, advancing the clock past delayed messages."""
        self._record("run")
        while self.pending:
            if self.pending[0][0] > self.time:
                self.time = self.pending[0][0]
            if not self._deliver_next():
                break

    def run_ready(self) -> None:
        """Deliver only messages whose delay has already elapsed."""
        self._record("run_ready")
        while self._deliver_next():
            pass

    def tick(self, steps: int = 1) -> None:
        self.time += steps
        self._record("tick", steps=steps)

    def release_held(self) -> None:
        still_held = []
        for item in self.held:
            _, _, src, dst, kind, payload = item
            if src is not None and (src, dst) in self.blocked:
                still_held.append(item)
            else:
                self.pending.append(item)
        self.held = still_held
        self.pending.sort(key=lambda x: (x[0], x[1]))

    # -- replay / fingerprints -------------------------------------------------
    def fingerprint(self) -> str:
        state = {
            node: replica.snapshot()
            for node, replica in sorted(self.replicas.items())
        }
        blob = json.dumps(state, sort_keys=True)
        return hashlib.sha256(blob.encode()).hexdigest()

    @classmethod
    def replay(cls, log: List[dict]) -> "Sim":
        sim = cls()
        for event in log:
            op = event["op"]
            args = {k: v for k, v in event.items() if k != "op"}
            if op == "snapshot":
                continue  # pure read of state; no effect
            if op == "restore":
                sim.restore(args["node"], args["snap"])
                continue
            getattr(sim, op)(**args)
        return sim
