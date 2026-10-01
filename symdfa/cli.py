"""JSON command-line interface.

Reads one JSON request from a file argument or stdin and writes one JSON
response to stdout.  Request shape::

    {"command": "equivalence" | "inclusion",
     "dfa1": {...}, "dfa2": {...}, "budget": 42}          # budget optional

    {"command": "verify-proof",
     "dfa1": {...}, "dfa2": {...}, "proof": {...}}

    {"command": "replay-witness",
     "dfa1": {...}, "dfa2": {...}, "witness": [0, 7],
     "mode": "equivalence"}                               # mode optional

DFA shape::

    {"num_states": 2, "start": 0, "accepting": [1],
     "transitions": {"0": [[0, 9, 1]]}}
"""

from __future__ import annotations

import json
import sys

from .dfa import DFA, DFAError
from .product import check, UNKNOWN
from .proof import build_proof, proof_to_json, proof_from_json
from .verify import verify_proof, verify_witness


def _load_request(argv):
    if len(argv) > 1:
        with open(argv[1], "r", encoding="utf-8") as fh:
            return json.load(fh)
    return json.load(sys.stdin)


def handle(request: dict) -> dict:
    command = request["command"]
    if command in ("equivalence", "inclusion"):
        dfa1 = DFA.from_json(request["dfa1"])
        dfa2 = DFA.from_json(request["dfa2"])
        budget = request.get("budget")
        result = check(dfa1, dfa2, mode=command, budget=budget)
        out = {"status": result.status, "edges_used": result.edges_used}
        if result.witness is not None:
            out["witness"] = list(result.witness)
        if result.items is not None:
            out["proof"] = proof_to_json(build_proof(result, dfa1, dfa2))
        if result.status == UNKNOWN and result.state is not None:
            out["frontier"] = [
                {"pair": list(pair), "path": list(path)}
                for pair, path in result.state.frontier
            ]
        return out
    if command == "verify-proof":
        dfa1 = DFA.from_json(request["dfa1"])
        dfa2 = DFA.from_json(request["dfa2"])
        ok, reason = verify_proof(proof_from_json(request["proof"]), dfa1, dfa2)
        return {"valid": ok, "reason": reason}
    if command == "replay-witness":
        dfa1 = DFA.from_json(request["dfa1"])
        dfa2 = DFA.from_json(request["dfa2"])
        ok, reason = verify_witness(request["witness"], dfa1, dfa2,
                                    request.get("mode", "equivalence"))
        return {"valid": ok, "reason": reason}
    raise DFAError(f"unknown command {command!r}")


def main(argv=None):
    argv = sys.argv if argv is None else argv
    try:
        request = _load_request(argv)
        response = handle(request)
    except (DFAError, KeyError, ValueError, json.JSONDecodeError) as exc:
        json.dump({"error": f"{type(exc).__name__}: {exc}"}, sys.stdout)
        sys.stdout.write("\n")
        return 2
    json.dump(response, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
