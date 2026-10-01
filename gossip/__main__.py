"""JSON-lines CLI for the deterministic gossip simulator.

Reads one JSON command per line from stdin, writes one JSON response (plus
event trace lines) per command to stdout. Any error prints
``{"ok": false, "error": ...}`` and exits with status 9.

Commands:
  {"cmd": "init", "nodes": N, "seed": S, "fanout": F, "topology": "random"|"ring"}
  {"cmd": "inject", "node": i, "key": "k", "value": v}
  {"cmd": "down", "node": i}
  {"cmd": "up", "node": i}
  {"cmd": "step", "rounds": k}        # rounds optional, default 1
  {"cmd": "status"}
"""

from __future__ import annotations

import json
import sys

from .simulator import SimError, Simulator

EXIT_ERROR = 9


def _dump(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def _fail(message):
    sys.stdout.write(_dump({"ok": False, "error": str(message)}) + "\n")
    sys.stdout.flush()
    sys.exit(EXIT_ERROR)


def _require_int(req, field):
    value = req.get(field)
    if isinstance(value, bool) or not isinstance(value, int):
        raise SimError(f"'{field}' must be an integer")
    return value


def main():
    sim = None
    printed_events = 0

    def flush_events():
        nonlocal printed_events
        if sim is not None:
            for event in sim.events[printed_events:]:
                sys.stdout.write(_dump(event) + "\n")
            printed_events = len(sim.events)

    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except json.JSONDecodeError as exc:
            _fail(f"invalid JSON: {exc}")
        if not isinstance(req, dict) or not isinstance(req.get("cmd"), str):
            _fail("request must be a JSON object with a string 'cmd'")

        cmd = req["cmd"]
        try:
            if cmd == "init":
                sim = Simulator(
                    nodes=_require_int(req, "nodes"),
                    seed=_require_int(req, "seed"),
                    fanout=_require_int(req, "fanout"),
                    topology=req.get("topology", "random"),
                )
                printed_events = 0
                response = {"ok": True}
            elif sim is None:
                raise SimError("simulator not initialized")
            elif cmd == "inject":
                if "key" not in req:
                    raise SimError("'key' is required")
                if "value" not in req:
                    raise SimError("'value' is required")
                try:
                    json.dumps(req["value"])
                except (TypeError, ValueError):
                    raise SimError("'value' must be JSON-serializable")
                version = sim.inject(
                    _require_int(req, "node"), req["key"], req["value"])
                response = {"ok": True, "version": version}
            elif cmd == "down":
                sim.down(_require_int(req, "node"))
                response = {"ok": True}
            elif cmd == "up":
                sim.up(_require_int(req, "node"))
                response = {"ok": True}
            elif cmd == "step":
                rounds = req.get("rounds", 1)
                sim.step(rounds)
                response = {
                    "ok": True,
                    "round": sim.round,
                    "converged": sim.converged(),
                }
            elif cmd == "status":
                response = {"ok": True}
                response.update(sim.status())
            else:
                raise SimError(f"unknown command: {cmd!r}")
        except SimError as exc:
            _fail(str(exc))

        flush_events()
        sys.stdout.write(_dump(response) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
