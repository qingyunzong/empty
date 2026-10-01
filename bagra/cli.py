"""JSON CLI for the incremental bag relational algebra engine.

Usage:
    python3.11 -m bagra.cli script.json
    cat script.json | python3.11 -m bagra.cli -

Script format:
    {
      "load": "state.json",          # optional: recover before running
      "save": "state.json",          # optional: persist after running
      "commands": [
        {"op": "add_table", "name": "R"},
        {"op": "add_node", "node": {"id": "r", "type": "scan", "table": "R"}},
        {"op": "subscribe", "node": "r"},
        {"op": "unsubscribe", "id": 1},
        {"op": "batch", "changes": {"R": [[[1, 2], 1], [[1, 2], -1]]}},
        {"op": "result", "node": "r"},
        {"op": "table", "name": "R"},
        {"op": "save", "path": "state.json"},
        {"op": "load", "path": "state.json"},
        {"op": "publish_log"}
      ]
    }

Output: a JSON array with one result object per command, printed to stdout.
Failed commands (e.g. a batch that would make a multiplicity negative)
return {"ok": false, "error": ...}; the batch is fully rolled back and
subsequent commands still run.
"""

import json
import sys

from .engine import Engine
from .operators import BagraError


def _run_command(engine, cmd):
    op = cmd["op"]
    if op == "add_table":
        engine.add_table(cmd["name"])
        return engine, {"ok": True}
    if op == "add_node":
        node_id = engine.add_node(cmd["node"])
        return engine, {"ok": True, "node": node_id}
    if op == "subscribe":
        return engine, {"ok": True, "subscription": engine.subscribe(cmd["node"])}
    if op == "unsubscribe":
        engine.unsubscribe(cmd["id"])
        return engine, {"ok": True}
    if op == "batch":
        changes = {
            name: [(tuple(row), delta) for row, delta in edits]
            for name, edits in cmd["changes"].items()
        }
        records = engine.apply_batch(changes)
        return engine, {"ok": True, "version": engine.version, "published": records}
    if op == "result":
        return engine, {"ok": True, "version": engine.version, "result": engine.result(cmd["node"])}
    if op == "table":
        return engine, {"ok": True, "table": engine.table(cmd["name"])}
    if op == "save":
        engine.save(cmd["path"])
        return engine, {"ok": True}
    if op == "load":
        engine = Engine.load(cmd["path"])
        return engine, {"ok": True, "version": engine.version}
    if op == "publish_log":
        return engine, {"ok": True, "publish_log": engine.publish_log}
    raise BagraError(f"unknown op: {op!r}")


def run_script(script):
    engine = Engine()
    results = []
    if "load" in script:
        engine = Engine.load(script["load"])
    for cmd in script.get("commands", []):
        try:
            engine, res = _run_command(engine, cmd)
        except Exception as exc:  # batch errors roll back; keep going
            res = {"ok": False, "error": str(exc), "error_type": type(exc).__name__}
        results.append(res)
    if "save" in script:
        engine.save(script["save"])
    return results


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) != 1:
        print("usage: python3.11 -m bagra.cli <script.json|->", file=sys.stderr)
        return 2
    if argv[0] == "-":
        script = json.load(sys.stdin)
    else:
        with open(argv[0], "r", encoding="utf-8") as fh:
            script = json.load(fh)
    json.dump(run_script(script), sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
