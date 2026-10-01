"""JSON-lines CLI for the deterministic gossip simulator.

Reads one JSON object per line from stdin, writes one JSON response per line
to stdout.  Any error prints {"ok": false, "error": ...} and exits with 9.

Commands:
  {"cmd":"init","nodes":N,"seed":S,"fanout":F,"max_rounds":R,
   "topology":"random"|"ring", "trace":bool}
  {"cmd":"inject","node":i,"key":"k","value":any}
  {"cmd":"down","node":i} / {"cmd":"up","node":i}
  {"cmd":"step","rounds":n}          (rounds optional, default 1)
  {"cmd":"status"}
"""
from __future__ import annotations

import json
import sys

from .simulator import Simulator, SimError

EXIT_ERROR = 9


def _emit(obj):
    sys.stdout.write(json.dumps(obj, sort_keys=True, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _require(sim):
    if sim is None:
        raise SimError("not initialized: send an init command first")
    return sim


def _handle(req, state):
    cmd = req.get("cmd")
    if not isinstance(cmd, str):
        raise SimError("missing or invalid 'cmd' field")

    if cmd == "init":
        for field in ("nodes", "seed", "fanout", "max_rounds"):
            if field not in req:
                raise SimError(f"init requires '{field}'")
        state["sim"] = Simulator(
            nodes=req["nodes"],
            seed=req["seed"],
            fanout=req["fanout"],
            max_rounds=req["max_rounds"],
            topology=req.get("topology", "random"),
        )
        state["trace"] = bool(req.get("trace", False))
        state["events_sent"] = 0
        return {"ok": True, "cmd": "init"}

    sim = _require(state["sim"])

    if cmd == "inject":
        version = sim.inject(req.get("node"), req.get("key"), req.get("value"))
        return {"ok": True, "cmd": "inject", "version": version}
    if cmd == "down":
        sim.down(req.get("node"))
        return {"ok": True, "cmd": "down"}
    if cmd == "up":
        sim.up(req.get("node"))
        return {"ok": True, "cmd": "up"}
    if cmd == "step":
        ran = sim.step(req.get("rounds", 1))
        resp = {
            "ok": True,
            "cmd": "step",
            "round": sim.round,
            "rounds_run": ran,
            "converged": sim.converged(),
            "status": "CONVERGED" if sim.converged() else "NOT_CONVERGED",
        }
        if state["trace"]:
            resp["events"] = sim.events[state["events_sent"]:]
            state["events_sent"] = len(sim.events)
        return resp
    if cmd == "status":
        resp = {"ok": True, "cmd": "status"}
        resp.update(sim.status())
        return resp
    raise SimError(f"unknown command: {cmd!r}")


def main(argv=None):
    state = {"sim": None, "trace": False, "events_sent": 0}
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            if not isinstance(req, dict):
                raise SimError("request must be a JSON object")
            resp = _handle(req, state)
        except SimError as exc:
            _emit({"ok": False, "error": str(exc)})
            return EXIT_ERROR
        except (json.JSONDecodeError, TypeError, ValueError) as exc:
            _emit({"ok": False, "error": f"invalid request: {exc}"})
            return EXIT_ERROR
        _emit(resp)
    return 0
