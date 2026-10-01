"""JSON command-line interface.

Reads one JSON request from a file argument or stdin, writes one JSON
response to stdout with deterministically sorted keys.

Commands:
  {"command": "propagate", "variables": {...}, "constraints": [...]}
  {"command": "solve",     "variables": {...}, "constraints": [...],
   "budget": 1000, "find_all": false}
  {"command": "verify",    "variables": {...}, "constraints": [...],
   "certificate": <conflict tree>}
"""

import json
import sys

from .errors import SolverError
from .search import Searcher, verify_unsat_certificate
from .spec import build_solver, normalize_spec


def _reject_duplicate_keys(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise SolverError(f"duplicate key {key!r} in JSON input")
        obj[key] = value
    return obj


def _spec_of(request):
    return {"variables": request.get("variables"),
            "constraints": request.get("constraints", [])}


def handle(request):
    if not isinstance(request, dict):
        raise SolverError("request must be a JSON object")
    command = request.get("command")
    if command == "propagate":
        spec = normalize_spec(_spec_of(request))
        solver = build_solver(spec)
        response = {
            "status": "conflict" if solver.conflict else "ok",
            "domains": {v: sorted(d) for v, d in sorted(solver.domains.items())},
            "removals": solver.removal_log,
        }
        if solver.conflict:
            response["conflict"] = solver.conflict
        return response
    if command == "solve":
        spec = normalize_spec(_spec_of(request))
        searcher = Searcher(spec, budget=request.get("budget"),
                            find_all=bool(request.get("find_all", False)))
        searcher.run()
        response = {"status": searcher.status, "nodes": searcher.nodes}
        if searcher.status == "sat":
            response["witness"] = searcher.witness
            if searcher.find_all:
                response["witnesses"] = searcher.witnesses
        elif searcher.status == "unsat":
            response["certificate"] = searcher.tree
        return response
    if command == "verify":
        spec = normalize_spec(_spec_of(request))
        if "certificate" not in request:
            raise SolverError("verify command requires 'certificate'")
        return {"status": "ok",
                "valid": verify_unsat_certificate(spec, request["certificate"])}
    raise SolverError(f"unknown command {command!r}")


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        if argv:
            with open(argv[0], "r", encoding="utf-8") as fh:
                request = json.load(fh, object_pairs_hook=_reject_duplicate_keys)
        else:
            request = json.load(sys.stdin,
                                object_pairs_hook=_reject_duplicate_keys)
        response = handle(request)
        exit_code = 0
    except SolverError as exc:
        response = {"status": "error", "error": str(exc)}
        exit_code = 1
    except json.JSONDecodeError as exc:
        response = {"status": "error", "error": f"invalid JSON: {exc}"}
        exit_code = 1
    json.dump(response, sys.stdout, sort_keys=True, indent=2)
    sys.stdout.write("\n")
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
