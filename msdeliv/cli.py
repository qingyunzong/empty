"""JSON-lines CLI.

Usage: python3.11 -m msdeliv.cli < commands.jsonl

One JSON command per line on stdin, one JSON event per line on stdout.

Commands:
  {"op":"new","mod":16,"window":4,"log":"path.jsonl"}   start a session
  {"op":"send","frame":{...}}                           offer one frame
  {"op":"poll"}                                         commit deliveries
  {"op":"acks","stream":"s","epoch":0}                  selective acks
  {"op":"state"}                                        engine state
  {"op":"crash"}                                        drop memory, keep log
  {"op":"recover"}                                      rebuild from log
  {"op":"replay","schedule":[...],"prefix":[...]}       run via virtual net
  {"op":"verify","schedule":[...],"prefix":[...]}       cross-check vs model
"""

from __future__ import annotations

import json
import sys

from . import vnet
from .engine import DeliveryEngine
from .frames import Frame
from .log import DurableLog


class Session:
    def __init__(self):
        self.engine = None
        self.log_path = None
        self.mod = None
        self.window = None

    def handle(self, cmd):
        op = cmd.get("op")
        handler = getattr(self, f"op_{op}", None)
        if handler is None:
            return {"event": "error", "error": f"unknown op: {op}"}
        try:
            return handler(cmd)
        except Exception as exc:  # keep the CLI total: report, don't crash
            return {"event": "error", "error": f"{type(exc).__name__}: {exc}"}

    def op_new(self, cmd):
        self.mod = int(cmd.get("mod", 1 << 16))
        self.window = int(cmd.get("window", 8))
        self.capacity = cmd.get("capacity")
        self.log_path = cmd.get("log")
        if self.log_path:
            open(self.log_path, "w").close()  # fresh session truncates the log
        self.engine = DeliveryEngine(mod=self.mod, window=self.window,
                                     capacity=self.capacity,
                                     log=DurableLog(self.log_path))
        return {"event": "ready", "mod": self.mod, "window": self.window,
                "capacity": self.engine.capacity}

    def op_send(self, cmd):
        result = self.engine.offer(Frame.from_dict(cmd["frame"]))
        result["event"] = "accept"
        return result

    def op_poll(self, cmd):
        return {"event": "delivered", "outputs": self.engine.poll()}

    def op_acks(self, cmd):
        return {"event": "acks",
                "acks": self.engine.acks(cmd["stream"], int(cmd["epoch"]))}

    def op_state(self, cmd):
        return {"event": "state", "state": self.engine.state()}

    def op_crash(self, cmd):
        if self.engine is not None:
            self.engine.log.close()
        self.engine = None
        return {"event": "crashed"}

    def op_recover(self, cmd):
        path = cmd.get("log", self.log_path)
        self.engine = DeliveryEngine.recover(path)
        self.mod, self.window = self.engine.mod, self.engine.window
        return {"event": "recovered", "cursor": self.engine.cursor,
                "state": self.engine.state()}

    def op_replay(self, cmd):
        mod = int(cmd.get("mod", self.mod or (1 << 16)))
        window = int(cmd.get("window", self.window or 8))
        capacity = cmd.get("capacity")
        prefix = [Frame.from_dict(d) for d in cmd.get("prefix", [])]
        schedule = [Frame.from_dict(d) for d in cmd["schedule"]]
        outputs, _engine, parked = vnet.run_schedule(schedule, mod, window,
                                                     capacity,
                                                     prefix)
        return {"event": "outputs", "outputs": outputs,
                "parked": [f.to_dict() for f in parked]}

    def op_verify(self, cmd):
        mod = int(cmd.get("mod", self.mod or (1 << 16)))
        window = int(cmd.get("window", self.window or 8))
        capacity = cmd.get("capacity")
        prefix = [Frame.from_dict(d) for d in cmd.get("prefix", [])]
        schedule = [Frame.from_dict(d) for d in cmd["schedule"]]
        mismatches = vnet.compare(schedule, mod, window, capacity, prefix)
        if not mismatches:
            return {"event": "ok"}
        minimal = vnet.minimize_failing(
            schedule,
            lambda s: bool(vnet.compare(s, mod, window, capacity, prefix)),
        )
        return {
            "event": "mismatch",
            "mismatches": mismatches,
            "minimal_schedule": [f.to_dict() for f in minimal],
            "prefix": [f.to_dict() for f in prefix],
            "mod": mod,
            "window": window,
        }


def main(argv=None):
    session = Session()
    out = sys.stdout
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except json.JSONDecodeError as exc:
            out.write(json.dumps({"event": "error", "error": str(exc)}) + "\n")
            out.flush()
            continue
        out.write(json.dumps(session.handle(cmd), sort_keys=True) + "\n")
        out.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
