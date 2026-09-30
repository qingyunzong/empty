"""JSON command-line interface for the persistent interval map.

Reads a JSON array of commands from a file (or stdin) and writes a JSON
array of per-command results to stdout.  Example:

    python3.11 -m intervalmap commands.json
    echo '[{"op":"add","lo":"0","hi":"3/2","source":"a"},
           {"op":"segments"}]' | python3.11 -m intervalmap

Endpoints are JSON integers or strings: "3/2", "5", "inf", "-inf".
"""
from __future__ import annotations

import argparse
import json
import sys

from .checker import check_canonical, verify_threshold
from .core import IntervalMap
from .endpoints import fmt, fmt_length
from .workspace import Workspace


def _seg_json(lo, hi, src):
    return {"lo": fmt(lo), "hi": fmt(hi), "sources": dict(src)}


def execute(ws: Workspace, cmd: dict) -> dict:
    op = cmd.get("op")
    if op == "add":
        ws.add(cmd["lo"], cmd["hi"], cmd["source"], int(cmd.get("count", 1)))
        return {"ok": True}
    if op == "revoke":
        ws.revoke(cmd["source"], cmd.get("count"))
        return {"ok": True}
    if op in ("union", "intersection", "difference"):
        other = IntervalMap.from_json(cmd["map"])
        getattr(ws, op)(other)
        return {"ok": True}
    if op == "begin":
        ws.begin()
        return {"ok": True, "depth": ws.transaction_depth}
    if op == "commit":
        ws.commit()
        return {"ok": True, "depth": ws.transaction_depth}
    if op == "rollback":
        ws.rollback()
        return {"ok": True, "depth": ws.transaction_depth}
    if op == "snapshot":
        ws.snapshot(cmd["name"])
        return {"ok": True}
    if op == "restore":
        ws.restore(cmd["name"])
        return {"ok": True}
    if op == "segments":
        return {"ok": True,
                "segments": [_seg_json(*s) for s in ws.current.segments()]}
    if op == "threshold":
        k = int(cmd["k"])
        count_mode = bool(cmd.get("count_mode", False))
        result = ws.current.covered_by_at_least(k, count_mode)
        errors = verify_threshold(ws.current, k, result, count_mode)
        return {
            "ok": True,
            "intervals": [_seg_json(*r) for r in result],
            "total_length": fmt_length(ws.current.length_at_least(k, count_mode)),
            "verified": not errors,
            "errors": errors,
        }
    if op == "sources_at":
        return {"ok": True, "sources": ws.current.sources_at(cmd["x"])}
    if op == "total_length":
        return {"ok": True, "total_length": fmt_length(ws.current.total_length)}
    if op == "refcount":
        return {"ok": True, "refcount": ws.current.refcount(cmd["source"])}
    if op == "check":
        errors = check_canonical(ws.current)
        return {"ok": True, "verified": not errors, "errors": errors}
    if op == "save":
        with open(cmd["path"], "w", encoding="utf-8") as fh:
            json.dump(ws.current.to_json(), fh, indent=2)
        return {"ok": True}
    if op == "load":
        with open(cmd["path"], encoding="utf-8") as fh:
            ws.current = IntervalMap.from_json(json.load(fh))
        return {"ok": True}
    raise ValueError(f"unknown op: {op!r}")


def run(commands) -> list:
    ws = Workspace()
    out = []
    for cmd in commands:
        try:
            out.append(execute(ws, cmd))
        except Exception as exc:  # state is untouched on error
            out.append({"ok": False, "error": f"{type(exc).__name__}: {exc}"})
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(prog="intervalmap")
    parser.add_argument("file", nargs="?",
                        help="JSON file with a list of commands (default: stdin)")
    args = parser.parse_args(argv)
    if args.file:
        with open(args.file, encoding="utf-8") as fh:
            commands = json.load(fh)
    else:
        commands = json.load(sys.stdin)
    if not isinstance(commands, list):
        commands = [commands]
    json.dump(run(commands), sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
