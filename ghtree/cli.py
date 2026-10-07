"""JSON command line interface for the Gomory-Hu cut tree.

Commands:
    build   --graph graph.json [--save state.json]
    query   --state state.json (--pairs '[[0,1]]' | --pairs-file f.json)
    update  --state state.json (--updates '[...]' | --updates-file f.json)
            [--save state.json]
    verify  --state state.json

Graph JSON:    {"n": 4, "edges": [[u, v, cap], ...]
                              or [{"u": u, "v": v, "capacity": cap}, ...]}
Updates JSON:  [[u, v, new_cap], ...] or
               [{"u": u, "v": v, "capacity": new_cap}, ...]
All results are printed to stdout as JSON.
"""

from __future__ import annotations

import argparse
import json
import sys

from .graph import Graph
from .tree import CutTree, UpdateError


def _read_json(path):
    if path in (None, "-"):
        return json.load(sys.stdin)
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _norm_edge(item):
    if isinstance(item, dict):
        return (item["u"], item["v"], item["capacity"])
    u, v, c = item
    return (u, v, c)


def _load_graph(data) -> Graph:
    return Graph(data["n"], [_norm_edge(e) for e in data.get("edges", [])])


def _load_tree(path) -> CutTree:
    with open(path, "r", encoding="utf-8") as fh:
        state = json.load(fh)
    return CutTree.from_state(state)


def _emit(obj) -> None:
    json.dump(obj, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")


def _cmd_build(args) -> int:
    tree = CutTree(_load_graph(_read_json(args.graph)))
    state = tree.to_state()
    if args.save:
        with open(args.save, "w", encoding="utf-8") as fh:
            json.dump(state, fh, indent=2, sort_keys=True)
            fh.write("\n")
        _emit({"ok": True, "state": args.save,
               "tree_edges": len(state["tree"])})
    else:
        _emit(state)
    return 0


def _cmd_query(args) -> int:
    tree = _load_tree(args.state)
    pairs = _read_json(args.pairs_file) if args.pairs_file else json.loads(args.pairs)
    values = [tree.query(int(u), int(v)) for u, v in pairs]
    _emit({"pairs": [[int(u), int(v)] for u, v in pairs], "values": values})
    return 0


def _cmd_update(args) -> int:
    tree = _load_tree(args.state)
    raw = _read_json(args.updates_file) if args.updates_file else json.loads(args.updates)
    updates = [_norm_edge(item) for item in raw]
    try:
        report = tree.update(updates)
    except UpdateError as exc:
        json.dump({"ok": False, "error": str(exc)}, sys.stderr)
        sys.stderr.write("\n")
        return 2
    if args.save:
        with open(args.save, "w", encoding="utf-8") as fh:
            json.dump(tree.to_state(), fh, indent=2, sort_keys=True)
            fh.write("\n")
    report["ok"] = True
    _emit(report)
    return 0


def _cmd_verify(args) -> int:
    tree = _load_tree(args.state)
    errors = tree.verify()
    _emit({"ok": not errors, "errors": errors})
    return 0 if not errors else 1


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="ghtree", description="Gomory-Hu cut tree JSON CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("build", help="build a cut tree from a graph JSON")
    p.add_argument("--graph", help="graph JSON file (default: stdin)")
    p.add_argument("--save", help="write the tree state JSON here")
    p.set_defaults(func=_cmd_build)

    p = sub.add_parser("query", help="query pairwise min-cut values")
    p.add_argument("--state", required=True)
    p.add_argument("--pairs", help="JSON list of [u, v] pairs")
    p.add_argument("--pairs-file", help="file with the pairs JSON")
    p.set_defaults(func=_cmd_query)

    p = sub.add_parser("update", help="apply a batch of capacity updates")
    p.add_argument("--state", required=True)
    p.add_argument("--updates", help="JSON list of updates")
    p.add_argument("--updates-file", help="file with the updates JSON")
    p.add_argument("--save", help="write the updated state JSON here")
    p.set_defaults(func=_cmd_update)

    p = sub.add_parser("verify", help="independently verify certificates")
    p.add_argument("--state", required=True)
    p.set_defaults(func=_cmd_verify)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
