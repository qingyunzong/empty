"""JSON CLI: reads a script of operations from stdin, writes JSON results.

Usage:

    echo '{"ops": [...]}' | python3.11 -m rknni

Operations (executed in order against one in-memory index):

    {"op": "new", "dim": 2, "capacity": 8, "fanout": 8}
    {"op": "insert", "id": "a", "vector": ["1/2", 3], "tags": ["x"], "version": 1}
    {"op": "upsert", "id": "a", "vector": [1, 1], "tags": [], "version": 2}
    {"op": "delete", "id": "a"}
    {"op": "query", "vector": [0, 0], "k": 5, "filter": {"tag": "x"}, "budget": 100}
    {"op": "verify", "vector": [0, 0], "k": 5, "filter": null, "result": {...}}
    {"op": "stats"}
    {"op": "save", "path": "/tmp/idx.json"}
    {"op": "load", "path": "/tmp/idx.json"}

Every operation produces one JSON object in the output ``results`` array;
failures are reported as {"ok": false, "error": ...} without aborting the
remaining operations.
"""

from __future__ import annotations

import json
import sys

from .errors import RKNIError
from .tree import Index
from .verify import verify


def _exec_op(state, op):
    kind = op.get("op")
    if kind == "new":
        state["index"] = Index(
            op["dim"], op.get("capacity", 8), op.get("fanout", 8)
        )
        return {"ok": True}
    idx = state.get("index")
    if idx is None:
        raise RKNIError("index not initialized; send {'op': 'new', ...} first")
    if kind == "insert":
        idx.insert(op["id"], op["vector"], op.get("tags", []), op.get("version", 1))
        return {"ok": True, "size": len(idx)}
    if kind == "upsert":
        idx.upsert(op["id"], op["vector"], op.get("tags", []), op.get("version"))
        return {"ok": True, "size": len(idx)}
    if kind == "delete":
        idx.delete(op["id"])
        return {"ok": True, "size": len(idx)}
    if kind == "query":
        res = idx.query(op["vector"], op["k"], op.get("filter"), op.get("budget"))
        return {"ok": True, "result": res.to_dict()}
    if kind == "verify":
        verify(idx.points(), op["vector"], op["k"], op.get("filter"), op["result"])
        return {"ok": True, "valid": True}
    if kind == "stats":
        return {
            "ok": True,
            "stats": {
                "points": len(idx),
                "data_version": idx.data_version,
                "nodes": idx.total_nodes(),
            },
        }
    if kind == "save":
        idx.save(op["path"])
        return {"ok": True}
    if kind == "load":
        state["index"] = Index.load(op["path"])
        return {"ok": True, "size": len(state["index"])}
    raise RKNIError(f"unknown op: {kind!r}")


def execute_script(data):
    state = {}
    outputs = []
    for op in data.get("ops", []):
        try:
            outputs.append(_exec_op(state, op))
        except Exception as exc:  # reported per-op, script continues
            outputs.append({"ok": False, "error": f"{type(exc).__name__}: {exc}"})
    return {"results": outputs}


def main(argv=None):
    data = json.load(sys.stdin)
    out = execute_script(data)
    json.dump(out, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0
