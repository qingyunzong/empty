"""Scenario runner: build a simulation from a JSON description.

Scenario format:
{
  "until": 200,
  "events": [
    {"tick": 5, "prio": 1, "name": "evt-a",
     "spawn": [{"tick": 5, "prio": 0, "name": "evt-a-child"}],
     "cancel": "evt-b"}
  ],
  "sessions": [
    {"type": "arq", "name": "arq1", "start": 0, "packets": ["m1", "m2"],
     "ack_delay": 4, "timeout": 10, "max_retries": 3, "loss": [1]},
    {"type": "heartbeat", "name": "hb1", "start": 0, "interval": 30,
     "dead_after": 60, "peer_responds": false}
  ]
}

"spawn" registers child events while the parent callback runs (absolute
ticks; a child at the current tick runs within the same tick).
"cancel" cancels the most recently scheduled pending event with that name.
"""

from __future__ import annotations

import json

from .core import VirtualClock
from .protocols import HeartbeatSession, StopWaitARQ


def run_scenario(spec: dict) -> tuple[VirtualClock, dict]:
    clock = VirtualClock()
    named_handles: dict[str, list] = {}
    sessions: dict[str, object] = {}

    def register(spec_event: dict) -> None:
        def callback(spec_event=spec_event):
            for child in spec_event.get("spawn", []):
                register(child)
            target = spec_event.get("cancel")
            if target is not None:
                handles = named_handles.get(target, [])
                if handles:
                    clock.cancel(handles[-1])

        handle = clock.schedule(
            spec_event["tick"],
            spec_event.get("prio", 0),
            callback,
            name=spec_event.get("name"),
        )
        if spec_event.get("name"):
            named_handles.setdefault(spec_event["name"], []).append(handle)

    for spec_event in spec.get("events", []):
        register(spec_event)

    for sess in spec.get("sessions", []):
        if sess["type"] == "arq":
            arq = StopWaitARQ(
                clock,
                name=sess.get("name", "arq"),
                ack_delay=sess.get("ack_delay", 4),
                timeout=sess.get("timeout", 10),
                max_retries=sess.get("max_retries", 3),
                loss=sess.get("loss", ()),
            )
            packets = list(sess.get("packets", []))

            def start_arq(arq=arq, packets=packets):
                for packet in packets:
                    arq.send(packet)

            clock.schedule(
                sess.get("start", 0), 0, start_arq,
                name=f"{arq.name}:start",
            )
            sessions[arq.name] = arq
        elif sess["type"] == "heartbeat":
            hb = HeartbeatSession(
                clock,
                name=sess.get("name", "hb"),
                interval=sess.get("interval", 30),
                dead_after=sess.get("dead_after", 60),
                peer_responds=sess.get("peer_responds", True),
                pong_delay=sess.get("pong_delay", 5),
            )
            clock.schedule(
                sess.get("start", 0), 0, hb.start, name=f"{hb.name}:start"
            )
            sessions[hb.name] = hb
        else:
            raise ValueError(f"unknown session type: {sess['type']!r}")

    clock.run_until(spec["until"])
    return clock, sessions


def run_scenario_file(path: str) -> tuple[VirtualClock, dict]:
    with open(path, "r", encoding="utf-8") as fh:
        spec = json.load(fh)
    return run_scenario(spec)
