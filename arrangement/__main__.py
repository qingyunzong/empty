"""JSON command-line interface for the arrangement library.

Usage:
    python3.11 -m arrangement build  [input.json]
    python3.11 -m arrangement verify [input.json]
    python3.11 -m arrangement roundtrip [input.json]

Input (stdin or file) is a JSON object::

    {"segments": [[[x1, y1], [x2, y2]], ...],
     "ops": [{"insert": [...]}, {"delete": [sid, ...]}]}

Coordinates may be integers, decimals, or "p/q" strings.  The output is
a JSON document with vertices, edges (stable ids + source sets), faces
(including the outer face), intersection points and a verification
report.  ``roundtrip`` additionally saves and restores the arrangement
and checks that the topology is identical.
"""

from __future__ import annotations

import json
import sys

from .arrangement import Arrangement
from .errors import ArrangementError
from .serialize import arrangement_from_dict, arrangement_to_dict
from .verify import verify_all


def _describe(arr: Arrangement) -> dict:
    topo = arr.topology
    point_of = {v.id: v.point for v in topo.vertices}
    from .serialize import point_to_json

    vertices = [
        {"id": v.id, "point": point_to_json(v.point)} for v in topo.vertices
    ]
    edges = []
    for e in topo.edges:
        edges.append({
            "id": e.id,
            "endpoints": [point_to_json(point_of[e.v0]),
                          point_to_json(point_of[e.v1])],
            "sources": sorted(e.sources),
        })
    faces = []
    for f in topo.faces:
        boundary = [h.origin for h in f.halfedges]
        faces.append({
            "id": f.id,
            "outer": f.is_outer,
            "area": str(f.area),
            "boundary": boundary,
        })
    return {
        "vertices": vertices,
        "edges": edges,
        "faces": faces,
        "intersections": [point_to_json(p) for p in sorted(arr.intersections)],
        "components": topo.components,
        "components_with_edges": topo.components_with_edges,
        "euler": topo.euler_value(),
    }


def _run(data: dict, command: str) -> dict:
    arr = Arrangement()
    if "segments" in data:
        arr.insert(data["segments"])
    affected = []
    for op in data.get("ops", []):
        if "insert" in op:
            arr.insert(op["insert"])
        elif "delete" in op:
            arr.delete(op["delete"])
        else:
            raise ArrangementError(f"unknown op {op!r}")
        affected.append(arr.last_affected)
    result = {"arrangement": _describe(arr),
              "verification": verify_all(arr)}
    if affected:
        result["affected"] = affected
    if command == "roundtrip":
        restored = arrangement_from_dict(arrangement_to_dict(arr))
        result["roundtrip"] = {
            "ok": _describe(restored) == _describe(arr),
            "verification": verify_all(restored),
        }
    return result


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    command = "build"
    if argv and argv[0] in ("build", "verify", "roundtrip"):
        command = argv.pop(0)
    if argv:
        with open(argv[0], "r", encoding="utf-8") as fh:
            data = json.load(fh)
    else:
        data = json.load(sys.stdin)
    try:
        result = _run(data, command)
    except ArrangementError as exc:
        json.dump({"error": str(exc)}, sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 1
    if command == "verify":
        result = {"verification": result["verification"]}
    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
