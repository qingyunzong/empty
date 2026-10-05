"""JSON request/response interface for the Gomory-Hu cut tree.

Request (JSON object read from stdin or a file):

    {
      "graph": {"vertices": ["a", "b"], "edges": [["a", "b", 3], ...]},
      "state": {...},                # alternative to "graph": a state
                                     # previously emitted by this CLI
      "operations": [
        {"op": "query",  "pairs": [["a", "b"], ...]},
        {"op": "update", "updates": [["a", "b", 5], ...]},
        {"op": "verify"},
        {"op": "state"}
      ]
    }

Exactly one of "graph" / "state" must be given.  The response is
``{"ok": bool, "results": [...], "state": {...}}``; the emitted state can
be fed back into a later request to keep querying/updating the same tree.
All output is deterministic: vertex collections are sorted and every
partition is normalised by the explicit rule "both sides sorted, then the
two sides ordered lexicographically".
"""

import json

from .tree import GomoryHuTree


def _run_op(tree, op):
    kind = op.get("op")
    try:
        if kind == "query":
            results = [tree.query_cut(str(a), str(b)) for a, b in op["pairs"]]
            return {"op": "query", "ok": True, "results": results}, True
        if kind == "update":
            updates = [(str(a), str(b), c) for a, b, c in op["updates"]]
            report = tree.update(updates)
            return {"op": "update", "ok": True, "report": report}, True
        if kind == "verify":
            return {"op": "verify", "ok": True,
                    "verification": tree.verify()}, True
        if kind == "state":
            return {"op": "state", "ok": True, "state": tree.to_dict()}, True
        return {"op": kind, "ok": False,
                "error": "unknown op %r" % (kind,)}, False
    except Exception as exc:  # op failed; tree state stays consistent
        return {"op": kind, "ok": False, "error": str(exc)}, False


def run_request(request):
    if not isinstance(request, dict):
        return {"ok": False, "error": "request must be a JSON object"}
    has_graph = "graph" in request
    has_state = "state" in request
    if has_graph == has_state:
        return {"ok": False,
                "error": "provide exactly one of 'graph' or 'state'"}
    try:
        if has_graph:
            graph = request["graph"]
            vertices = [str(v) for v in graph["vertices"]]
            edges = [[str(a), str(b), c] for a, b, c in graph["edges"]]
            tree = GomoryHuTree(vertices, edges)
        else:
            tree = GomoryHuTree.from_dict(request["state"])
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
    ok = True
    results = []
    for op in request.get("operations", []):
        result, op_ok = _run_op(tree, op)
        results.append(result)
        ok = ok and op_ok
    return {"ok": ok, "results": results, "state": tree.to_dict()}


def main(argv=None):
    import sys
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        if argv:
            with open(argv[0], "r", encoding="utf-8") as fh:
                request = json.load(fh)
        else:
            request = json.load(sys.stdin)
    except (OSError, json.JSONDecodeError) as exc:
        json.dump({"ok": False, "error": str(exc)}, sys.stdout,
                  indent=2, sort_keys=True)
        sys.stdout.write("\n")
        return 2
    response = run_request(request)
    json.dump(response, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0 if response.get("ok") else 1
