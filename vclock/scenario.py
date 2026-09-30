"""Scenario loader/runner: executes a JSON scenario and emits a JSONL trace."""

from __future__ import annotations

import json
import sys
from typing import IO, Any, Dict, List

from .core import VirtualClock
from .protocols import HeartbeatSession, StopAndWaitARQ


def run_scenario(path: str, out: IO[str] = sys.stdout) -> Dict[str, Any]:
    """Run the scenario described by ``path``; write JSONL trace to ``out``.

    Returns the session objects keyed by id (useful for tests).
    """
    with open(path, "r", encoding="utf-8") as fh:
        spec = json.load(fh)

    clock = VirtualClock()
    order = 0

    def trace(**fields: Any) -> None:
        nonlocal order
        record = {"order": order, **fields}
        order += 1
        out.write(json.dumps(record, sort_keys=True) + "\n")

    # Manual events: {"tick", "prio", "name", "spawn": [{"delay","prio","name"}]}
    def make_manual(spec_evt: Dict[str, Any]):
        def fire() -> None:
            trace(kind="exec", tick=clock.now, prio=spec_evt["prio"],
                  name=spec_evt["name"])
            for child in spec_evt.get("spawn", []):
                clock.schedule(clock.now + child["delay"], child["prio"],
                               make_manual({**child, "tick": clock.now + child["delay"]}))
        return fire

    for evt in spec.get("events", []):
        clock.schedule(evt["tick"], evt["prio"], make_manual(evt))

    sessions: Dict[str, Any] = {}
    for s in spec.get("sessions", []):
        stype = s["type"]
        sid = s["id"]
        if stype == "heartbeat":
            sess = HeartbeatSession(
                clock, sid, trace,
                interval=s.get("interval", 30),
                timeout=s.get("timeout", 60),
                pong_delay=s.get("pong_delay"),
            )
        elif stype == "arq":
            sess = StopAndWaitARQ(
                clock, sid, trace,
                num_packets=s.get("packets", 1),
                timeout=s.get("timeout", 10),
                max_retries=s.get("max_retries", 3),
                ack_delay=s.get("ack_delay", 2),
                ack_loss=s.get("ack_loss", 0),
            )
        else:
            raise ValueError(f"unknown session type: {stype!r}")
        sessions[sid] = sess
        clock.schedule(s.get("start", 0), 0, sess.start)

    clock.run_until(spec["until"])
    trace(kind="end", tick=clock.now)
    return sessions
