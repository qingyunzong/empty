"""JSON CLI: python3.11 -m mincostflow [input.json]  (defaults to stdin).

Input schema:
{
  "nodes": ["A", "B", ...],
  "edges": [{"id","tail","head","lo","hi","cost"}, ...],
  "demands": {"A": -3, ...},
  "operations": [
    {"op": "solve", "budget": 10},          // budget optional
    {"op": "update", "edges": {"e1": {"hi": 2}}, "demands": {"A": 1}},
    {"op": "published"}
  ]
}

Output: {"results": [...]} with one entry per operation. Solve results
report "feasibility" and "optimality" as two independent states. A failed
update reports ok:false and leaves the solver state (and the published
feasible version) untouched.
"""

from __future__ import annotations

import json
import sys

from .solver import MinCostCirculation, UpdateError


def run(document: dict) -> dict:
    solver = MinCostCirculation(
        document.get("nodes", []),
        document.get("edges", []),
        document.get("demands", {}),
    )
    results = []
    for op in document.get("operations", []):
        kind = op.get("op")
        if kind == "solve":
            res = solver.solve(budget=op.get("budget"))
            out = {"op": "solve"}
            out.update(res.to_dict())
            results.append(out)
        elif kind == "update":
            try:
                solver.apply_updates(op.get("edges"), op.get("demands"))
                results.append({"op": "update", "ok": True})
            except (UpdateError, ValueError) as exc:
                results.append({"op": "update", "ok": False, "error": str(exc)})
        elif kind == "published":
            pub = solver.published_result()
            if pub is None:
                results.append({"op": "published", "available": False})
            else:
                out = {"op": "published", "available": True}
                out.update(pub.to_dict())
                results.append(out)
        else:
            results.append({"op": kind, "ok": False,
                            "error": f"unknown operation: {kind!r}"})
    return {"results": results}


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv:
        with open(argv[0], "r", encoding="utf-8") as fh:
            document = json.load(fh)
    else:
        document = json.load(sys.stdin)
    json.dump(run(document), sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
