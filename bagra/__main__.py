"""JSON CLI for the bagra engine.

Usage:
    python3.11 -m bagra [--state STATE.json] SCRIPT.json

SCRIPT.json is {"commands": [...]} where each command is one of:

    {"op": "subscribe",   "id": "s1", "plan": {...}}
    {"op": "unsubscribe", "id": "s1"}
    {"op": "batch", "batch_id": 1,
     "changes": [{"table": "R", "row": [1, "a"], "delta": 1}, ...]}

Plans are nested JSON objects, e.g.:

    {"op": "join",
     "inputs": [{"op": "scan", "table": "R"},
                {"op": "scan", "table": "S"}],
     "cols": [0], "right_cols": [1]}

    {"op": "filter", "inputs": [{"op": "scan", "table": "R"}],
     "pred": {"kind": "cmp", "op": "eq", "col": 0, "value": 1}}

With --state, the engine is recovered from the state file if it exists
and persisted after the script runs.  Output is a JSON document with the
records published by each command; exit status is non-zero if any
command failed (failed batches roll back and do not stop later ones).
"""
from __future__ import annotations

import argparse
import json
import os
import sys

from .engine import Engine
from .plans import plan_from_json


def run_script(engine: Engine, script: dict) -> list:
    results = []
    for index, cmd in enumerate(script.get("commands", [])):
        entry = {"command": index}
        try:
            op = cmd["op"]
            if op == "subscribe":
                entry["published"] = engine.add_subscription(
                    cmd["id"], plan_from_json(cmd["plan"]))
            elif op == "unsubscribe":
                engine.remove_subscription(cmd["id"])
                entry["published"] = []
            elif op == "batch":
                changes = [
                    (c["table"], tuple(c["row"]), c["delta"])
                    for c in cmd.get("changes", [])
                ]
                entry["published"] = engine.apply_batch(
                    changes, batch_id=cmd.get("batch_id"))
            else:
                raise ValueError(f"unknown command op {op!r}")
        except Exception as exc:  # engine state is rolled back already
            entry["error"] = f"{type(exc).__name__}: {exc}"
        results.append(entry)
    return results


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python3.11 -m bagra")
    parser.add_argument("script", help="JSON script of commands")
    parser.add_argument("--state", help="engine state file to recover "
                                        "from and persist to")
    args = parser.parse_args(argv)

    with open(args.script, encoding="utf-8") as fh:
        script = json.load(fh)

    if args.state and os.path.exists(args.state):
        engine = Engine.load(args.state)
    else:
        engine = Engine()

    results = run_script(engine, script)

    if args.state:
        engine.save(args.state)

    ok = all("error" not in entry for entry in results)
    json.dump({"ok": ok, "version": engine.version, "results": results},
              sys.stdout, indent=1)
    sys.stdout.write("\n")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
