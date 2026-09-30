"""JSON-lines CLI.

Reads one JSON command per line on stdin, writes one JSON result per line.
Endpoints are strings: "p/q", integers, "+inf"/"-inf".

Commands:
  {"op":"add","source":"s","lo":"0","hi":"3/4"}
  {"op":"remove_source","source":"s"[,"lo":...,"hi":...]}
  {"op":"union"|"intersection"|"difference","intervals":[{"source","lo","hi"},...]}
  {"op":"begin"} {"op":"commit"} {"op":"rollback"}
  {"op":"save","name":"v1"} {"op":"restore","name":"v1"}
  {"op":"intervals"} {"op":"threshold","k":2} {"op":"length"}
  {"op":"refcounts"} {"op":"events"} {"op":"check"["k":2]} {"op":"reset"}
"""

from __future__ import annotations

import json
import sys

from . import checker
from .core import IntervalMap
from .endpoints import format_endpoint, sort_key


def _seg_json(seg):
    return {
        "lo": format_endpoint(seg["lo"]),
        "hi": format_endpoint(seg["hi"]),
        "sources": seg["sources"],
        "count": seg["count"],
    }


def _build_map(specs):
    m = IntervalMap()
    for item in specs:
        m.add(item["source"], item["lo"], item["hi"])
    return m


class Session:
    def __init__(self):
        self.map = IntervalMap()
        self.saved = {}

    def handle(self, cmd):
        op = cmd.get("op")
        m = self.map
        if op == "add":
            m.add(cmd["source"], cmd["lo"], cmd["hi"])
            return {"ok": True}
        if op == "remove_source":
            m.remove_source(cmd["source"], cmd.get("lo"), cmd.get("hi"))
            return {"ok": True}
        if op in ("union", "intersection", "difference"):
            other = _build_map(cmd.get("intervals", []))
            self.map = getattr(m, op)(other)
            return {"ok": True}
        if op == "begin":
            m.begin()
            return {"ok": True, "depth": m.transaction_depth}
        if op == "commit":
            m.commit()
            return {"ok": True, "depth": m.transaction_depth}
        if op == "rollback":
            m.rollback()
            return {"ok": True, "depth": m.transaction_depth}
        if op == "save":
            self.saved[cmd["name"]] = self.map.snapshot()
            return {"ok": True}
        if op == "restore":
            version = self.saved.get(cmd["name"])
            if version is None:
                return {"ok": False, "error": f"unknown snapshot {cmd['name']!r}"}
            self.map.restore(version)
            return {"ok": True}
        if op == "intervals":
            return {"ok": True, "intervals": [_seg_json(s) for s in m.intervals()]}
        if op == "threshold":
            k = int(cmd["k"])
            return {"ok": True, "k": k,
                    "intervals": [_seg_json(s) for s in m.covered_at_least(k)]}
        if op == "length":
            return {"ok": True, "length": format_endpoint(m.length())}
        if op == "refcounts":
            return {"ok": True, "refcounts": m.refcounts()}
        if op == "events":
            return {"ok": True, "events": {
                format_endpoint(ep): ev
                for ep, ev in sorted(m.events().items(), key=lambda kv: sort_key(kv[0]))
            }}
        if op == "check":
            checker.check_map(m)
            out = {"ok": True, "check": "map"}
            if "k" in cmd:
                k = int(cmd["k"])
                checker.check_threshold_result(m.intervals(), k, m.covered_at_least(k))
                out["check"] = "map+threshold"
            return out
        if op == "reset":
            self.map = IntervalMap()
            self.saved = {}
            return {"ok": True}
        return {"ok": False, "error": f"unknown op {op!r}"}


def main(argv=None):
    session = Session()
    stream = sys.stdin
    for line in stream:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
            result = session.handle(cmd)
        except Exception as exc:  # illegal input must not corrupt state
            result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        sys.stdout.write(json.dumps(result) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
