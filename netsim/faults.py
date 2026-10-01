"""Fault rules and their fixed-phase application.

Faults are applied to every sent message in the fixed phase order

    drop -> dup -> delay -> clock_apply

regardless of the order rules appear in the configuration file.  Rules
are canonicalised (sorted by their JSON serialization) inside each phase
so the result never depends on input or dictionary ordering.

Phases:
  drop        probabilistic drop; a dropped message never reaches later phases
  dup         probabilistic duplication; each firing rule adds one copy
  delay       deterministic extra delay plus optional link jitter
  clock_apply stamps local timestamps using the sender's current clock
              offset (metadata only; never alters global event order)

``partition`` and ``clock`` rules are not per-message phases: partitions
block bidirectionally matched edges while active, and clock rules rewrite
a node's offset at a scheduled time.  Both are handled by the simulator.
"""
from __future__ import annotations

import json
import math

PHASES = ("drop", "dup", "delay", "clock_apply")

_PHASE_OF = {
    "drop": "drop",
    "dup": "dup",
    "delay": "delay",
}


def _canon(rule: dict) -> str:
    return json.dumps(rule, sort_keys=True)


def _matches(rule: dict, src: str, dst: str, now: float) -> bool:
    if "src" in rule and rule["src"] != src:
        return False
    if "dst" in rule and rule["dst"] != dst:
        return False
    if now < rule.get("start", 0):
        return False
    end = rule.get("end")
    if end is not None and now >= end:
        return False
    return True


class FaultEngine:
    def __init__(self, rules: list[dict]) -> None:
        ordered = sorted(rules, key=_canon)
        self.rules = ordered
        self.by_phase: dict[str, list[dict]] = {
            phase: [r for r in ordered if _PHASE_OF.get(r["type"]) == phase]
            for phase in PHASES
        }
        self.partitions = [r for r in ordered if r["type"] == "partition"]
        self.clock_rules = [r for r in ordered if r["type"] == "clock"]

    def apply_send(self, now: float, src: str, dst: str, link: dict,
                   rng) -> dict:
        """Run the fixed-phase fault pipeline for one message send."""
        # Phase 1: drop
        for rule in self.by_phase["drop"]:
            if _matches(rule, src, dst, now) and rng.random() < rule.get("prob", 1.0):
                return {"dropped": True, "copies": 0, "delay": None}
        # Phase 2: dup
        copies = 1
        for rule in self.by_phase["dup"]:
            if _matches(rule, src, dst, now) and rng.random() < rule.get("prob", 1.0):
                copies += 1
        # Phase 3: delay
        delay = link["delay"]
        for rule in self.by_phase["delay"]:
            if _matches(rule, src, dst, now):
                delay += rule["extra"]
        jitter = link.get("jitter", 0)
        if jitter:
            delay += rng.randint(0, jitter)
        # Phase 4: clock_apply — local timestamps are stamped by the caller
        # using the sender's current offset; no timing changes happen here.
        return {"dropped": False, "copies": copies, "delay": delay}
