"""Command line interface for the incremental recompute engine."""

from __future__ import annotations

import json
import os
import sys

from .core import EXIT_USAGE, Graph, RecomputeError, UsageError

DEFAULT_STATE_PATH = "recompute_state.json"

USAGE = """\
usage: python -m recompute [--state PATH] <command> [args]

commands:
  set <node> <cost> <value> [dep ...]  define/redefine a node (starts dirty)
  upd <node> <cost>                    update cost; node and its transitive
                                       successors become dirty
  run <budget>                         pick the optimal set within budget and
                                       recompute it (state is saved)
  best <budget>                        like run, but only prints the plan
                                       (dry run, no state change)
  status                               print all nodes and their dirty flags

state is persisted as JSON (default ./recompute_state.json, override with
--state PATH or the RECOMPUTE_STATE environment variable).

exit codes: 0 ok, 2 bad usage / negative cost or budget, 3 dependency cycle,
4 unknown node
"""


def _parse_int(text, what):
    try:
        return int(text)
    except ValueError:
        raise UsageError(f"invalid {what}: {text!r}") from None


def _load_graph(path):
    if not os.path.exists(path):
        return Graph()
    with open(path, "r", encoding="utf-8") as fh:
        return Graph.from_dict(json.load(fh))


def _save_graph(graph, path):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(graph.to_dict(), fh, indent=2, sort_keys=True)
        fh.write("\n")
    os.replace(tmp, path)


def _emit_plan(graph, selected):
    cost = sum(graph.nodes[nid].cost for nid in selected)
    value = sum(graph.nodes[nid].value for nid in selected)
    print("selected:" + (" " + " ".join(selected) if selected else ""))
    print(f"cost: {cost}")
    print(f"value: {value}")
    print(f"clean_value: {graph.clean_value(selected)}")


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    state_path = os.environ.get("RECOMPUTE_STATE", DEFAULT_STATE_PATH)
    args = []
    i = 0
    while i < len(argv):
        if argv[i] == "--state":
            if i + 1 >= len(argv):
                print("error: --state requires a path", file=sys.stderr)
                return EXIT_USAGE
            state_path = argv[i + 1]
            i += 2
        else:
            args.append(argv[i])
            i += 1
    if not args:
        sys.stderr.write(USAGE)
        return EXIT_USAGE
    cmd, rest = args[0], args[1:]
    try:
        if cmd == "set":
            if len(rest) < 3:
                raise UsageError("set requires <node> <cost> <value> [dep ...]")
            graph = _load_graph(state_path)
            graph.set_node(
                rest[0],
                _parse_int(rest[1], "cost"),
                _parse_int(rest[2], "value"),
                rest[3:],
            )
            _save_graph(graph, state_path)
        elif cmd == "upd":
            if len(rest) != 2:
                raise UsageError("upd requires <node> <cost>")
            graph = _load_graph(state_path)
            graph.update_cost(rest[0], _parse_int(rest[1], "cost"))
            _save_graph(graph, state_path)
        elif cmd in ("run", "best"):
            if len(rest) != 1:
                raise UsageError(f"{cmd} requires <budget>")
            budget = _parse_int(rest[0], "budget")
            graph = _load_graph(state_path)
            if cmd == "run":
                selected = graph.recompute(budget)
                _save_graph(graph, state_path)
            else:
                selected = graph.select(budget)
            _emit_plan(graph, selected)
        elif cmd == "status":
            if rest:
                raise UsageError("status takes no arguments")
            graph = _load_graph(state_path)
            for nid in sorted(graph.nodes):
                node = graph.nodes[nid]
                deps = ",".join(node.deps) if node.deps else "-"
                flag = "dirty" if node.dirty else "clean"
                print(f"{nid} cost={node.cost} value={node.value} {flag} deps={deps}")
        else:
            sys.stderr.write(USAGE)
            return EXIT_USAGE
    except RecomputeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return exc.exit_code
    return 0
