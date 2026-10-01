"""Deterministic single-process event-loop network simulator."""
from __future__ import annotations

import hashlib
import json
import random
from collections import Counter

from .events import Event, EventHeap
from .faults import FaultEngine
from .node import Node


def serialize(record: dict) -> str:
    """Canonical one-line JSON for a record (used for output and digest)."""
    return json.dumps(record, sort_keys=True)


class Simulator:
    def __init__(self, topo: dict, faults: dict, seed: int = 0,
                 assert_consistency: bool = False) -> None:
        self.seed = seed
        self.rng = random.Random(seed)
        self.assert_consistency = assert_consistency
        self.nodes = {n["id"]: Node(n["id"], n.get("clock_offset", 0))
                      for n in topo["nodes"]}
        self.links = {(l["src"], l["dst"]): l for l in topo["links"]}
        self.faults = FaultEngine(faults.get("rules", []))
        self.partitions = [
            {tuple(e) for e in rule["edges"]} for rule in self.faults.partitions
        ]
        self.active_partitions: set[int] = set()
        self.buffer: list[dict] = []
        self.heap = EventHeap()
        self.records: list[dict] = []
        self.counters: Counter = Counter()
        self.divergence: dict | None = None
        self.steps = 0
        self._last_time = 0

        for i, item in enumerate(topo.get("workload", [])):
            app_id = item.get("app_id") or f"w{i}"
            self.heap.push(item["time"], "send", src=item["src"], dst=item["dst"],
                           data={"app_id": app_id,
                                 "payload": item.get("payload", "")})
        for pid, rule in enumerate(self.faults.partitions):
            self.heap.push(rule["start"], "partition_start", data={"pid": pid})
            self.heap.push(rule["end"], "partition_end", data={"pid": pid})
        for rule in self.faults.clock_rules:
            self.heap.push(rule["start"], "clock_set", src=rule["node"],
                           data={"offset": rule["offset"]})
        for node_cfg in topo["nodes"]:
            node = self.nodes[node_cfg["id"]]
            for tmo in node_cfg.get("timeouts", []):
                # Local timeout at local time T fires at global T - offset.
                self.heap.push(tmo["at_local"] - node.clock_offset, "timeout",
                               src=node.id, data={"timeout_id": tmo["id"]})

    # -- main loop ---------------------------------------------------------

    def run(self, steps: int) -> dict:
        while len(self.heap) and self.steps < steps:
            ev = self.heap.pop()
            self.steps += 1
            self._last_time = ev.time
            getattr(self, f"_on_{ev.kind}")(ev)
            if self.assert_consistency and self.divergence is None:
                self._check_consistency(ev.time)
            if self.divergence is not None:
                break
        return self.summary()

    # -- event handlers ----------------------------------------------------

    def _on_send(self, ev: Event) -> None:
        src, dst = ev.src, ev.dst
        app_id = ev.data["app_id"]
        sender = self.nodes[src]
        link = self.links[(src, dst)]
        result = self.faults.apply_send(ev.time, src, dst, link, self.rng)
        # clock_apply phase: stamp the sender-local time (metadata only).
        self._record({"type": "send", "time": ev.time, "src": src, "dst": dst,
                      "app_id": app_id, "payload": ev.data["payload"],
                      "src_local_time": sender.local_time(ev.time)})
        self.counters["sent"] += 1
        if result["dropped"]:
            self._record({"type": "drop", "time": ev.time, "src": src,
                          "dst": dst, "app_id": app_id, "reason": "fault:drop"})
            self.counters["dropped"] += 1
            return
        copies = result["copies"]
        if copies > 1:
            self._record({"type": "dup", "time": ev.time, "src": src, "dst": dst,
                          "app_id": app_id, "copies": copies})
            self.counters["dup_copies"] += copies - 1
        for copy_no in range(copies):
            self.heap.push(ev.time + result["delay"], "deliver", src=src, dst=dst,
                           data={"app_id": app_id, "payload": ev.data["payload"],
                                 "copy": copy_no, "sent_time": ev.time})

    def _on_deliver(self, ev: Event) -> None:
        if self._edge_blocked(ev.src, ev.dst):
            self.buffer.append(dict(ev.data, src=ev.src, dst=ev.dst))
            self._record({"type": "buffer", "time": ev.time, "src": ev.src,
                          "dst": ev.dst, "app_id": ev.data["app_id"],
                          "reason": "partition"})
            self.counters["buffered"] += 1
            return
        self._deliver(ev.data, ev.src, ev.dst, ev.time)

    def _deliver(self, msg: dict, src: str, dst: str, time: float) -> None:
        node = self.nodes[dst]
        base = {"time": time, "src": src, "dst": dst, "app_id": msg["app_id"],
                "copy": msg["copy"], "local_time": node.local_time(time)}
        if node.receive(msg["app_id"]):
            self._record(dict(base, type="deliver"))
            self.counters["delivered"] += 1
        else:
            # Duplicate copy: dedup by application id, log untouched.
            self._record(dict(base, type="duplicate"))
            self.counters["duplicates_ignored"] += 1

    def _on_partition_start(self, ev: Event) -> None:
        self.active_partitions.add(ev.data["pid"])
        self._record({"type": "partition_start", "time": ev.time,
                      "pid": ev.data["pid"]})

    def _on_partition_end(self, ev: Event) -> None:
        self.active_partitions.discard(ev.data["pid"])
        self._record({"type": "partition_end", "time": ev.time,
                      "pid": ev.data["pid"]})
        remaining = []
        for msg in self.buffer:
            if not self._edge_blocked(msg["src"], msg["dst"]):
                self._record({"type": "release", "time": ev.time,
                              "src": msg["src"], "dst": msg["dst"],
                              "app_id": msg["app_id"]})
                self.counters["released"] += 1
                self.heap.push(ev.time, "deliver", src=msg["src"],
                               dst=msg["dst"], data=msg)
            else:
                remaining.append(msg)
        self.buffer = remaining

    def _on_timeout(self, ev: Event) -> None:
        node = self.nodes[ev.src]
        self._record({"type": "timeout", "time": ev.time, "node": ev.src,
                      "timeout_id": ev.data["timeout_id"],
                      "local_time": node.local_time(ev.time)})
        self.counters["timeouts"] += 1

    def _on_clock_set(self, ev: Event) -> None:
        self.nodes[ev.src].clock_offset = ev.data["offset"]
        self._record({"type": "clock_set", "time": ev.time, "node": ev.src,
                      "offset": ev.data["offset"]})

    # -- partitions --------------------------------------------------------

    def _edge_blocked(self, src: str, dst: str) -> bool:
        """An edge is blocked only if some active partition matches both
        directions of it."""
        for pid in self.active_partitions:
            edges = self.partitions[pid]
            if (src, dst) in edges and (dst, src) in edges:
                return True
        return False

    # -- consistency -------------------------------------------------------

    def _check_consistency(self, time: float) -> None:
        ids = sorted(self.nodes)
        for i, a in enumerate(ids):
            for b in ids[i + 1:]:
                la, lb = self.nodes[a].log, self.nodes[b].log
                if not _prefix_compatible(la, lb):
                    self.divergence = {
                        "nodes": [a, b],
                        "last_log": {
                            a: la[-1] if la else None,
                            b: lb[-1] if lb else None,
                        },
                    }
                    self._record({"type": "diverge", "time": time,
                                  "nodes": [a, b],
                                  "last_log": self.divergence["last_log"]})
                    return

    # -- output ------------------------------------------------------------

    def _record(self, record: dict) -> None:
        self.records.append(record)

    def digest(self) -> str:
        h = hashlib.sha256()
        for record in self.records:
            h.update(serialize(record).encode("utf-8"))
            h.update(b"\n")
        return h.hexdigest()

    def summary(self) -> dict:
        return {
            "type": "summary",
            "seed": self.seed,
            "steps": self.steps,
            "events": len(self.records),
            "sent": self.counters["sent"],
            "delivered": self.counters["delivered"],
            "dropped": self.counters["dropped"],
            "dup_copies": self.counters["dup_copies"],
            "duplicates_ignored": self.counters["duplicates_ignored"],
            "buffered": self.counters["buffered"],
            "released": self.counters["released"],
            "buffered_remaining": len(self.buffer),
            "timeouts": self.counters["timeouts"],
            "diverged": self.divergence is not None,
            "divergence": self.divergence,
            "logs": {nid: list(node.log) for nid, node in sorted(self.nodes.items())},
            "digest": self.digest(),
        }


def _prefix_compatible(a: list, b: list) -> bool:
    return all(x == y for x, y in zip(a, b))
