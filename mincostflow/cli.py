"""JSON command line interface.

Usage:
    python3.11 -m mincostflow solve [spec.json]     # default: stdin
    python3.11 -m mincostflow verify [result.json]  # default: stdin

Solve spec format:
    {
      "demands": {"a": -2, "b": 2},
      "edges": [{"id": "e1", "tail": "a", "head": "b",
                 "lower": 0, "upper": 5, "cost": 3}],
      "budget": 100,                       # optional, for the initial solve
      "batches": [                         # optional incremental updates
        {"budget": 10,
         "changes": [{"op": "set_bounds", "edge": "e1",
                      "lower": 0, "upper": 2}]}
      ]
    }

The solve output reports feasibility and optimality as two independent
booleans per step, plus the last published feasible result.  The verify
subcommand independently re-checks a step (flow + potentials, or a cut
certificate) against the model.
"""

from __future__ import annotations

import json
import sys

from .solver import MinCostCirculation, UpdateError
from . import verify as _verify


def _load_json(path):
    if path is None or path == "-":
        return json.load(sys.stdin)
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _build_solver(model: dict) -> MinCostCirculation:
    solver = MinCostCirculation()
    for node, demand in model.get("demands", {}).items():
        solver.add_node(node, demand)
    for e in model.get("edges", []):
        solver.add_edge(e["id"], e["tail"], e["head"],
                        e.get("lower", 0), e.get("upper", 0), e.get("cost", 0))
    return solver


def cmd_solve(spec: dict) -> dict:
    solver = _build_solver(spec)
    steps = []

    def record(result):
        steps.append(result.to_dict())

    record(solver.solve(budget=spec.get("budget")))
    for batch in spec.get("batches", []):
        try:
            solver.apply_updates(batch.get("changes", []))
        except UpdateError as exc:
            # Transaction failed: model, flow and caches are unchanged.
            steps.append({"error": str(exc), "feasible": None, "optimal": None})
            continue
        record(solver.solve(budget=batch.get("budget")))

    published = solver.published
    return {
        "model": solver.model_dict(),
        "steps": steps,
        "published": published.to_dict() if published else None,
    }


def cmd_verify(doc: dict) -> dict:
    model = doc.get("model", {})
    result = doc.get("result", {})
    demands = model.get("demands", {})
    edges = model.get("edges", [])
    out = {"flow_ok": None, "optimality_ok": None, "certificate_ok": None,
           "problems": []}

    if result.get("certificate") is not None:
        problems = _verify.check_cut_certificate(
            demands, edges, result["certificate"])
        out["certificate_ok"] = not problems
        out["problems"] = problems
        return out

    if result.get("flow") is not None:
        problems = _verify.check_flow(demands, edges, result["flow"])
        out["flow_ok"] = not problems
        out["problems"] = problems
        if result.get("optimal"):
            opt_problems = _verify.check_optimality(
                demands, edges, result["flow"], result.get("potentials"))
            out["optimality_ok"] = not opt_problems
            out["problems"] = problems + opt_problems
        return out

    out["problems"] = ["result contains neither flow nor certificate"]
    return out


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] not in ("solve", "verify"):
        print(__doc__.strip(), file=sys.stderr)
        return 2
    command = argv[0]
    path = argv[1] if len(argv) > 1 else None
    try:
        doc = _load_json(path)
    except (OSError, json.JSONDecodeError) as exc:
        print(json.dumps({"error": f"cannot read input: {exc}"}))
        return 2

    if command == "solve":
        try:
            output = cmd_solve(doc)
        except UpdateError as exc:
            print(json.dumps({"error": str(exc)}))
            return 2
        print(json.dumps(output, indent=2))
        return 0

    output = cmd_verify(doc)
    print(json.dumps(output, indent=2))
    ok = all(v is not False for k, v in output.items() if k.endswith("_ok"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
