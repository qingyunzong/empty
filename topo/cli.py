"""JSONL command-line interface for the incremental topo sorter.

Reads one JSON command per line from stdin:

  {"op": "add_node", "node": "a"}
  {"op": "add_edge", "src": "a", "dst": "b"}
  {"op": "del_edge", "src": "a", "dst": "b"}
  {"op": "del_node", "node": "a"}
  {"op": "order"}

`order` prints {"order": [...], "version": N} to stdout.
Errors print a JSON object to stderr and exit:
  2 = malformed JSON / malformed command (no partial application)
  3 = cycle detected (state keeps last acyclic snapshot)
  4 = unknown node referenced
"""

from __future__ import annotations

import json
import sys

from .core import CycleError, IncrementalTopo, UnknownNodeError

EXIT_OK = 0
EXIT_BAD_JSON = 2
EXIT_CYCLE = 3
EXIT_UNKNOWN_NODE = 4


def _err(payload, code):
    print(json.dumps(payload), file=sys.stderr)
    return code


def _node_arg(cmd, key):
    value = cmd[key]
    if not isinstance(value, str):
        raise ValueError(key)
    return value


def run(stream, out, err):
    ts = IncrementalTopo()
    for lineno, raw in enumerate(stream, 1):
        line = raw.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except json.JSONDecodeError as exc:
            print(json.dumps({"error": "bad_json", "line": lineno, "detail": str(exc)}), file=err)
            return EXIT_BAD_JSON
        if not isinstance(cmd, dict) or "op" not in cmd:
            print(json.dumps({"error": "bad_command", "line": lineno}), file=err)
            return EXIT_BAD_JSON
        op = cmd["op"]
        try:
            if op == "add_node":
                ts.add_node(_node_arg(cmd, "node"))
            elif op == "add_edge":
                ts.add_edge(_node_arg(cmd, "src"), _node_arg(cmd, "dst"))
            elif op == "del_edge":
                ts.del_edge(_node_arg(cmd, "src"), _node_arg(cmd, "dst"))
            elif op == "del_node":
                ts.del_node(_node_arg(cmd, "node"))
            elif op == "order":
                print(json.dumps({"order": ts.order(), "version": ts.version}), file=out)
            else:
                print(json.dumps({"error": "unknown_op", "op": op, "line": lineno}), file=err)
                return EXIT_BAD_JSON
        except (KeyError, TypeError, ValueError):
            print(json.dumps({"error": "bad_command", "line": lineno, "op": op}), file=err)
            return EXIT_BAD_JSON
        except UnknownNodeError as exc:
            print(json.dumps({"error": "unknown_node", "node": exc.node, "line": lineno}), file=err)
            return EXIT_UNKNOWN_NODE
        except CycleError as exc:
            print(json.dumps({"error": "cycle", "nodes": exc.nodes, "line": lineno}), file=err)
            return EXIT_CYCLE
    return EXIT_OK


def main(argv=None):
    return run(sys.stdin, sys.stdout, sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
