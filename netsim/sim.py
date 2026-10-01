"""Deterministic single-process network simulator.

Event heap key is (time, seq, src, dst): events at the same global time are
ordered by a monotonically increasing sequence number, so runs with the same
seed are bit-for-bit reproducible.

Fault rules are applied to every sent message in the fixed phase order
drop -> dup -> delay -> clock_apply (see netsim.config.PHASES), independent
of the key order used in the faults document.

Clock offsets only shift *local* times (logged local timestamps and local
timeout scheduling). Global event times and the global event order never
depend on any node's clock offset.
"""

from __future__ import annotations

import hashlib
import heapq
import json
import random

from .config import PHASES, Config, Faults, Link

_KIND_RANK = {"clock_apply": 0, "send": 1, "deliver": 2, "timeout": 3}


class _NodeState:
    __slots__ = ("node_id", "offset", "timeout_interval", "timeout_gen", "seen_app_ids")

    def __init__(self, node_id, offset, timeout_interval):
        self.node_id = node_id
        self.offset = offset
        self.timeout_interval = timeout_interval
        self.timeout_gen = 0
        self.seen_app_ids = set()


class Simulator:
    def __init__(self, config: Config, faults: Faults | None = None, seed: int = 0, max_steps: int = 10000):
        self.config = config
        self.faults = faults if faults is not None else Faults()
        self.max_steps = max_steps
        self.rng = random.Random(seed)
        self.seed = seed

        self.time = 0.0
        self._seq = 0
        self._heap: list[tuple] = []

        self.nodes = {
            node_id: _NodeState(
                node_id,
                config.clock_offsets.get(node_id, 0.0),
                config.timeout_intervals.get(node_id),
            )
            for node_id in config.nodes
        }

        self.events: list[dict] = []
        self.node_logs: dict[str, list[str]] = {node_id: [] for node_id in config.nodes}
        self.stats = {
            "sent": 0,
            "delivered": 0,
            "dropped": 0,
            "duplicated": 0,
            "dup_ignored": 0,
            "buffered": 0,
            "timeouts": 0,
        }
        self.steps = 0

        for item in config.workload:
            self._push(item["time"], item["src"], item["dst"], "send", item)
        for rule in self.faults.clock_apply:
            self._push(rule["at"], rule["node"], rule["node"], "clock_apply", rule)
        for node_id in config.nodes:
            self._schedule_timeout(node_id)

    # ------------------------------------------------------------------ heap

    def _push(self, time, src, dst, kind, data):
        seq = self._seq
        self._seq += 1
        heapq.heappush(self._heap, (time, seq, src, dst, _KIND_RANK[kind], kind, data))

    # ------------------------------------------------------------------ log

    def _emit(self, event: dict):
        self.events.append(event)

    def _log(self, node_id: str, line: str):
        self.node_logs[node_id].append(line)

    # ------------------------------------------------------------- timeouts

    def _schedule_timeout(self, node_id: str):
        state = self.nodes[node_id]
        interval = state.timeout_interval
        if interval is None:
            return
        state.timeout_gen += 1
        local_now = self.time + state.offset
        next_local = (int(local_now // interval) + 1) * interval
        at = next_local - state.offset
        self._push(at, node_id, node_id, "timeout", {"gen": state.timeout_gen})

    # --------------------------------------------------------------- faults

    def _matches(self, rule, src, dst):
        return rule["src"] in ("*", src) and rule["dst"] in ("*", dst)

    def _active_partition(self, src, dst):
        for part in self.faults.partitions:
            if {part["a"], part["b"]} == {src, dst} and part["start"] <= self.time < part["end"]:
                return part
        return None

    # -------------------------------------------------------------- handlers

    def _on_send(self, src, dst, item):
        app_id = item["app_id"]
        self.stats["sent"] += 1
        self._emit({"type": "send", "time": self.time, "src": src, "dst": dst, "app_id": app_id})
        self._log(src, f"send {app_id} -> {dst} @{self.time}")

        link = self.config.links.get((src, dst), Link())
        latency = link.latency
        if link.jitter > 0:
            latency += self.rng.uniform(0.0, link.jitter)

        # Fault phases run in the fixed PHASES order, never in dict order.
        copies = 1
        extra_delay = 0.0
        for phase in PHASES:
            if phase == "drop":
                for rule in self.faults.drop:
                    if self._matches(rule, src, dst) and self.rng.random() < rule["rate"]:
                        self.stats["dropped"] += 1
                        self._emit(
                            {"type": "drop", "time": self.time, "src": src, "dst": dst, "app_id": app_id}
                        )
                        self._log(src, f"drop {app_id} -> {dst} @{self.time}")
                        return
            elif phase == "dup":
                for rule in self.faults.dup:
                    if self._matches(rule, src, dst) and self.rng.random() < rule["rate"]:
                        copies += rule["copies"]
                if copies > 1:
                    self.stats["duplicated"] += copies - 1
                    self._emit(
                        {
                            "type": "dup",
                            "time": self.time,
                            "src": src,
                            "dst": dst,
                            "app_id": app_id,
                            "copies": copies,
                        }
                    )
            elif phase == "delay":
                for rule in self.faults.delay:
                    if self._matches(rule, src, dst):
                        extra_delay += rule["extra"]
            elif phase == "clock_apply":
                # Clock offsets never alter global delivery times; the
                # receiver's local receive time is computed at delivery.
                pass

        deliver_at = self.time + latency + extra_delay
        partition = self._active_partition(src, dst)
        if partition is not None:
            deliver_at = partition["end"] + latency + extra_delay
            self.stats["buffered"] += 1
            self._emit(
                {
                    "type": "buffered",
                    "time": self.time,
                    "src": src,
                    "dst": dst,
                    "app_id": app_id,
                    "until": partition["end"],
                }
            )
            self._log(src, f"buffered {app_id} -> {dst} until {partition['end']}")

        for _ in range(copies):
            self._push(deliver_at, src, dst, "deliver", {"src": src, "dst": dst, "app_id": app_id})

    def _on_deliver(self, src, dst, data):
        app_id = data["app_id"]
        state = self.nodes[dst]
        local_time = self.time + state.offset
        if app_id in state.seen_app_ids:
            self.stats["dup_ignored"] += 1
            self._emit(
                {
                    "type": "dup_ignored",
                    "time": self.time,
                    "src": src,
                    "dst": dst,
                    "app_id": app_id,
                    "local_time": local_time,
                }
            )
            self._log(dst, f"dup_ignored {app_id} from {src} @local {local_time}")
            return
        state.seen_app_ids.add(app_id)
        self.stats["delivered"] += 1
        self._emit(
            {
                "type": "recv",
                "time": self.time,
                "src": src,
                "dst": dst,
                "app_id": app_id,
                "local_time": local_time,
            }
        )
        self._log(dst, f"recv {app_id} from {src} @local {local_time}")

    def _on_timeout(self, node_id, data):
        state = self.nodes[node_id]
        if data["gen"] != state.timeout_gen:
            return  # stale timer from before a clock_apply
        local_time = self.time + state.offset
        self.stats["timeouts"] += 1
        self._emit({"type": "timeout", "time": self.time, "node": node_id, "local_time": local_time})
        self._log(node_id, f"timeout @local {local_time}")
        self._schedule_timeout(node_id)

    def _on_clock_apply(self, node_id, data):
        state = self.nodes[node_id]
        state.offset = data["offset"]
        self._emit(
            {"type": "clock_apply", "time": self.time, "node": node_id, "offset": data["offset"]}
        )
        self._log(node_id, f"clock_apply offset={data['offset']} @{self.time}")
        self._schedule_timeout(node_id)

    # ------------------------------------------------------------------ run

    def run(self):
        while self._heap and self.steps < self.max_steps:
            time, seq, src, dst, _rank, kind, data = heapq.heappop(self._heap)
            self.time = time
            self.steps += 1
            if kind == "send":
                self._on_send(src, dst, data)
            elif kind == "deliver":
                self._on_deliver(src, dst, data)
            elif kind == "timeout":
                self._on_timeout(src, data)
            elif kind == "clock_apply":
                self._on_clock_apply(src, data)
        return self.summary()

    def summary(self) -> dict:
        log_hash = hashlib.sha256(
            json.dumps(self.node_logs, sort_keys=True).encode("utf-8")
        ).hexdigest()
        return {
            "type": "summary",
            "seed": self.seed,
            "steps": self.steps,
            "remaining_events": len(self._heap),
            "final_time": self.time,
            "log_hash": log_hash,
            **self.stats,
        }


def check_determinism(config: Config, faults: Faults, steps: int, seed: int) -> str:
    """Run the simulation twice and compare per-node log prefixes.

    Returns "OK" when both runs agree. On any mismatch returns a report
    starting with DIVERGE followed by the last log lines of the two nodes
    involved in the first diverging event.
    """
    run_a = Simulator(config, faults, seed=seed, max_steps=steps)
    run_a.run()
    run_b = Simulator(config, faults, seed=seed, max_steps=steps)
    run_b.run()

    for index, (event_a, event_b) in enumerate(zip(run_a.events, run_b.events)):
        if event_a != event_b:
            nodes = sorted(
                {str(event_a.get("src", event_a.get("node", "?"))), str(event_a.get("dst", "?"))}
            )
            lines = [f"DIVERGE at event {index}"]
            for node_id in nodes:
                lines.append(f"node {node_id} last logs (run A): {run_a.node_logs.get(node_id, [])[-5:]}")
                lines.append(f"node {node_id} last logs (run B): {run_b.node_logs.get(node_id, [])[-5:]}")
            return "\n".join(lines)
    if len(run_a.events) != len(run_b.events):
        return f"DIVERGE: event count {len(run_a.events)} != {len(run_b.events)}"
    for node_id in config.nodes:
        if run_a.node_logs[node_id] != run_b.node_logs[node_id]:
            return (
                f"DIVERGE: node {node_id} logs differ\n"
                f"run A last logs: {run_a.node_logs[node_id][-5:]}\n"
                f"run B last logs: {run_b.node_logs[node_id][-5:]}"
            )
    return "OK"
