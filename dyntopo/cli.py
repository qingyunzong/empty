"""JSONL command-line interface for the incremental topological orderer.

Reads one JSON command per line from stdin (or from a file given as the
first argument) and applies it to a fresh DynamicTopoGraph:

    {"op": "add_node", "node": "a"}
    {"op": "add_edge", "from": "a", "to": "b"}
    {"op": "del_edge", "from": "a", "to": "b"}
    {"op": "del_node", "node": "a"}
    {"op": "order"}

`order` prints the current executable topological order as a JSON array
(level by level, node ids ascending within a level) to stdout.

Exit codes:
    0  all commands applied
    2  malformed line (bad JSON, unknown op, missing/invalid field)
    3  an add_edge would create a cycle; the cycle's node set (sorted
       ascending) is printed to stdout and the graph keeps the last
       acyclic snapshot
    4  a command referenced an unknown node

A failing command is never partially applied: validation happens before
any mutation, and the process exits at the first error.
"""

import json
import sys

from .graph import CycleError, DynamicTopoGraph, UnknownNodeError

EXIT_OK = 0
EXIT_BAD_JSON = 2
EXIT_CYCLE = 3
EXIT_UNKNOWN_NODE = 4

_VALID_ID_TYPES = (str, int, float, bool)


def _emit(err_stream, **payload):
    print(json.dumps(payload), file=err_stream)


def _get_id(cmd, key):
    value = cmd[key]
    if not isinstance(value, _VALID_ID_TYPES):
        raise TypeError("node id must be a JSON string or number")
    return value


def run(in_stream, out_stream, err_stream):
    graph = DynamicTopoGraph()
    for lineno, raw in enumerate(in_stream, 1):
        line = raw.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except json.JSONDecodeError:
            _emit(err_stream, error="invalid_json", line=lineno)
            return EXIT_BAD_JSON
        if not isinstance(cmd, dict) or not isinstance(cmd.get("op"), str):
            _emit(err_stream, error="invalid_command", line=lineno)
            return EXIT_BAD_JSON
        op = cmd["op"]
        try:
            if op == "add_node":
                graph.add_node(_get_id(cmd, "node"))
            elif op == "add_edge":
                graph.add_edge(_get_id(cmd, "from"), _get_id(cmd, "to"))
            elif op == "del_edge":
                graph.del_edge(_get_id(cmd, "from"), _get_id(cmd, "to"))
            elif op == "del_node":
                graph.del_node(_get_id(cmd, "node"))
            elif op == "order":
                print(json.dumps(graph.order()), file=out_stream)
            else:
                _emit(err_stream, error="unknown_op", op=op, line=lineno)
                return EXIT_BAD_JSON
        except UnknownNodeError as exc:
            _emit(err_stream, error="unknown_node", node=exc.args[0], line=lineno)
            return EXIT_UNKNOWN_NODE
        except CycleError as exc:
            print(json.dumps({"error": "cycle", "cycle": exc.nodes}),
                  file=out_stream)
            return EXIT_CYCLE
        except (KeyError, TypeError) as exc:
            _emit(err_stream, error="invalid_command", detail=str(exc),
                  line=lineno)
            return EXIT_BAD_JSON
    return EXIT_OK


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv:
        with open(argv[0], "r", encoding="utf-8") as handle:
            return run(handle, sys.stdout, sys.stderr)
    return run(sys.stdin, sys.stdout, sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
