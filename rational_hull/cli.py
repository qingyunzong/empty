"""JSON-lines command-line interface for the dynamic convex hull.

Reads one JSON object per line from stdin and writes one JSON response per
line to stdout.  Coordinates are exact rationals: JSON integers or "p/q"
strings (JSON floats are rejected to protect exactness).

Example session::

    $ python3.11 -m rational_hull
    {"op": "insert", "id": "a", "x": 0, "y": 0}
    {"ok": true, "result": {"inserted": "a"}}
    {"op": "insert", "id": "b", "x": 4, "y": 0}
    {"ok": true, "result": {"inserted": "b"}}
    {"op": "insert", "id": "c", "x": 2, "y": 3}
    {"ok": true, "result": {"inserted": "c"}}
    {"op": "hull"}
    {"ok": true, "result": {"vertices": [...], "edges": [...]}}

Run ``{"op": "help"}`` for the list of operations.
"""

from __future__ import annotations

import json
import sys

from .core import DynamicConvexHull

OPS = (
    "insert {id,x,y} | delete {id} | contains_id {id} | get {id} | count | "
    "hull | extreme {dx,dy} | tangent {x,y} | contains_point {x,y} | "
    "snapshot | restore {version} | push | pop | save {path} | "
    "load {path} | verify | stats | reset_stats | help"
)


def _point_json(p):
    return {"id": p.id, "x": str(p.x), "y": str(p.y)}


def _handle(state, req):
    op = req.get("op")
    hull = state["hull"]
    if op == "help":
        return {"operations": OPS}
    if op == "insert":
        p = hull.insert(req["id"], req["x"], req["y"])
        return {"inserted": p.id}
    if op == "delete":
        p = hull.delete(req["id"])
        return {"deleted": p.id}
    if op == "contains_id":
        return {"present": req["id"] in hull}
    if op == "get":
        return _point_json(hull.get(req["id"]))
    if op == "count":
        return {"count": len(hull)}
    if op == "hull":
        result = hull.hull()
        return {
            "vertices": [_point_json(v) for v in result.vertices],
            "edges": [
                {
                    "p1": e.p1.id,
                    "p2": e.p2.id,
                    "a": e.a,
                    "b": e.b,
                    "c": e.c,
                }
                for e in result.edges
            ],
        }
    if op == "extreme":
        return _point_json(hull.extreme(req["dx"], req["dy"]))
    if op == "tangent":
        left, right = hull.tangent(req["x"], req["y"])
        return {"left": _point_json(left), "right": _point_json(right)}
    if op == "contains_point":
        return {"classification": hull.contains_point(req["x"], req["y"])}
    if op == "snapshot":
        state["next_version"] += 1
        state["versions"][state["next_version"]] = hull.snapshot()
        return {"version": state["next_version"]}
    if op == "restore":
        hull.restore(state["versions"][req["version"]])
        return {"restored": req["version"]}
    if op == "push":
        state["next_version"] += 1
        state["versions"][state["next_version"]] = hull.push()
        return {"version": state["next_version"]}
    if op == "pop":
        version = hull.pop()
        return {"popped": version.stamp}
    if op == "save":
        hull.save(req["path"])
        return {"saved": req["path"]}
    if op == "load":
        state["hull"] = DynamicConvexHull.load(req["path"])
        state["versions"] = {}
        return {"loaded": req["path"], "count": len(state["hull"])}
    if op == "verify":
        hull.verify()
        return {"valid": True}
    if op == "stats":
        return {"size": len(hull), "stats": hull.stats.to_dict()}
    if op == "reset_stats":
        hull.stats.reset()
        return {"reset": True}
    raise ValueError(f"unknown op: {op!r}")


def main(argv=None):
    state = {"hull": DynamicConvexHull(), "versions": {}, "next_version": 0}
    out = sys.stdout
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            result = _handle(state, req)
            resp = {"ok": True, "result": result}
        except Exception as exc:  # report, keep serving
            resp = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        out.write(json.dumps(resp) + "\n")
        out.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
