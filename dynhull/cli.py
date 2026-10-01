"""JSON-lines command interface.

Reads one JSON command per line on stdin, writes one JSON response per
line on stdout.  Rationals are given as integers, "p/q" strings, or
{"num": p, "den": q} objects; JSON floats are rejected (exactness is
never traded for floats).

Commands:
  {"op": "insert", "id": ..., "x": ..., "y": ...}
  {"op": "delete", "id": ...}
  {"op": "hull"}
  {"op": "extreme", "dx": ..., "dy": ...}
  {"op": "tangent", "x": ..., "y": ...}
  {"op": "checkpoint"} / {"op": "rollback"} / {"op": "commit"}
  {"op": "save", "path": ...} / {"op": "load", "path": ...}
  {"op": "verify"} / {"op": "stats"} / {"op": "reset"}
"""
import json
import sys

from .checker import verify
from .geometry import to_fraction
from .hull import DynamicHull


def _number(value):
    if isinstance(value, bool) or value is None:
        raise TypeError(f"invalid rational {value!r}")
    if isinstance(value, int):
        return to_fraction(value)
    if isinstance(value, float):
        raise TypeError("JSON floats are rejected; use \"p/q\" strings")
    if isinstance(value, str):
        return to_fraction(value)
    if isinstance(value, dict):
        return to_fraction((value["num"], value["den"]))
    raise TypeError(f"invalid rational {value!r}")


def _point(triple):
    if triple is None:
        return None
    pid, x, y = triple
    return {"id": pid, "x": str(x), "y": str(y)}


def make_handler(hull=None):
    hull = hull or DynamicHull()

    def handle(cmd):
        op = cmd.get("op")
        if op == "insert":
            hull.insert(cmd["id"], _number(cmd["x"]), _number(cmd["y"]))
            return {"size": len(hull)}
        if op == "delete":
            hull.delete(cmd["id"])
            return {"size": len(hull)}
        if op == "hull":
            return hull.hull()
        if op == "extreme":
            return {"point": _point(hull.extreme(_number(cmd["dx"]),
                                                 _number(cmd["dy"])))}
        if op == "tangent":
            pair = hull.tangents(_number(cmd["x"]), _number(cmd["y"]))
            if pair is None:
                return {"tangents": None}
            left, right = pair
            return {"tangents": {"left": _point(left), "right": _point(right)}}
        if op == "checkpoint":
            return {"token": hull.checkpoint()}
        if op == "rollback":
            hull.rollback(cmd.get("token"))
            return {"size": len(hull)}
        if op == "commit":
            hull.commit(cmd.get("token"))
            return {"size": len(hull)}
        if op == "save":
            hull.save(cmd["path"])
            return {"saved": cmd["path"]}
        if op == "load":
            hull.load(cmd["path"])
            return {"size": len(hull)}
        if op == "verify":
            return {"valid": verify(hull._state.points, hull.hull())}
        if op == "stats":
            return {"stats": dict(hull.stats), "last_op": dict(hull.last_op)}
        if op == "reset":
            hull.__init__()
            return {"size": 0}
        raise ValueError(f"unknown op {op!r}")

    return handle


def main(stream=None, out=None):
    stream = stream or sys.stdin
    out = out or sys.stdout
    handle = make_handler()
    for line in stream:
        line = line.strip()
        if not line:
            continue
        try:
            result = handle(json.loads(line))
            response = {"ok": True, "result": result}
        except Exception as exc:  # report, keep serving
            response = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        out.write(json.dumps(response, default=str) + "\n")
        out.flush()


if __name__ == "__main__":
    main()
