"""CLI: python -m dreach run OPS.json

OPS.json is a JSON list of operation objects:
  {"op": "init", "n": 3}
  {"op": "insert", "u": 0, "v": 1}
  {"op": "delete", "u": 0, "v": 1}
  {"op": "savepoint"}                 -> prints monotonic snapshot id
  {"op": "rollback", "id": 1}
  {"op": "reachable", "u": 0, "v": 2} -> prints true/false
  {"op": "witness", "u": 0, "v": 2}   -> prints node list or null

Exit codes: 0 ok; 1 rollback to unknown savepoint id; 2 bad JSON/operation.
"""

import json
import sys

from .core import Graph, OpError


def _endpoints(op):
    if "u" not in op or "v" not in op:
        raise OpError(f"{op.get('op')}: missing u/v")
    return op["u"], op["v"]


def run_ops(ops, graph=None):
    """Execute ops, yielding JSON-encoded result lines as they are produced."""
    if graph is None:
        graph = Graph()
    for i, op in enumerate(ops):
        if not isinstance(op, dict):
            raise OpError(f"op {i}: expected object, got {op!r}")
        kind = op.get("op")
        if kind == "init":
            graph.init(op.get("n"))
        elif kind == "insert":
            graph.insert(*_endpoints(op))
        elif kind == "delete":
            graph.delete(*_endpoints(op))
        elif kind == "savepoint":
            yield json.dumps(graph.savepoint())
        elif kind == "rollback":
            if "id" not in op:
                raise OpError("rollback: missing id")
            graph.rollback(op["id"])  # KeyError -> exit 1
        elif kind == "reachable":
            yield json.dumps(graph.reachable(*_endpoints(op)))
        elif kind == "witness":
            yield json.dumps(graph.witness(*_endpoints(op)))
        else:
            raise OpError(f"op {i}: unknown op {kind!r}")


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) != 2 or argv[0] != "run":
        print("usage: python -m dreach run OPS.json", file=sys.stderr)
        return 2
    try:
        with open(argv[1], "r", encoding="utf-8") as fh:
            ops = json.load(fh)
    except OSError as exc:
        print(f"error: cannot read {argv[1]}: {exc}", file=sys.stderr)
        return 2
    except json.JSONDecodeError as exc:
        print(f"error: invalid JSON: {exc}", file=sys.stderr)
        return 2
    if not isinstance(ops, list):
        print("error: top-level JSON value must be a list of operations",
              file=sys.stderr)
        return 2
    try:
        for line in run_ops(ops):
            print(line)
    except KeyError as exc:
        print(f"error: no such savepoint id: {exc.args[0]!r}", file=sys.stderr)
        return 1
    except OpError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
