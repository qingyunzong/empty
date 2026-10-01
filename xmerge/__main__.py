"""CLI: python -m xmerge graph.json A B -o result.json

stdout: merged tree as JSON.  stderr: conflicting paths (one per line).
Exit codes: 0 = clean merge, 1 = conflicts, 2 = usage/graph errors.
"""

from __future__ import annotations

import argparse
import json
import sys

from .core import Graph, GraphError, Merger


def _no_duplicate_keys(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise GraphError(f"duplicate key {key!r} in graph JSON")
        obj[key] = value
    return obj


def _load_graph(path):
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh, object_pairs_hook=_no_duplicate_keys)
    return Graph(data)


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="xmerge",
        description="Recursive three-way merge of two heads in a commit graph.",
    )
    parser.add_argument("graph", help="path to graph.json")
    parser.add_argument("ours", help="head node id (ours)")
    parser.add_argument("theirs", help="head node id (theirs)")
    parser.add_argument("-o", "--output", help="also write the merged tree JSON here")
    args = parser.parse_args(argv)

    try:
        graph = _load_graph(args.graph)
        for head in (args.ours, args.theirs):
            if head not in graph.nodes:
                raise GraphError(f"unknown head {head!r}")
        tree, conflicts = Merger(graph).merge_commits(args.ours, args.theirs)
    except GraphError as exc:
        print(f"xmerge: error: {exc}", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"xmerge: error: {exc}", file=sys.stderr)
        return 2
    except json.JSONDecodeError as exc:
        print(f"xmerge: error: invalid JSON: {exc}", file=sys.stderr)
        return 2

    text = json.dumps(tree, indent=2, sort_keys=True)
    if args.output:
        try:
            with open(args.output, "w", encoding="utf-8") as fh:
                fh.write(text + "\n")
        except OSError as exc:
            print(f"xmerge: error: {exc}", file=sys.stderr)
            return 2
    print(text)
    for path in sorted(conflicts):
        print(path, file=sys.stderr)
    return 1 if conflicts else 0


if __name__ == "__main__":
    sys.exit(main())
