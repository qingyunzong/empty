"""CLI: python -m xmerge graph.json A B -o result.json

stdout: merged tree (JSON). stderr: conflicted paths (one per line).
Exit codes: 0 = clean merge, 1 = conflicts, 2 = usage/input error
(unknown head, cycle, duplicate node, malformed graph).
"""

import argparse
import json
import sys

from . import GraphError, load_graph, merge_heads


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="xmerge",
        description="Recursive three-way merge of two heads in a commit graph.",
    )
    parser.add_argument("graph", help="path to graph.json")
    parser.add_argument("head_a", help="id of the first head")
    parser.add_argument("head_b", help="id of the second head")
    parser.add_argument(
        "-o",
        "--output",
        help="also write {'tree': ..., 'conflicts': [...]} JSON to this file",
    )
    args = parser.parse_args(argv)

    try:
        graph = load_graph(args.graph)
        merged_tree, conflicts = merge_heads(graph, args.head_a, args.head_b)
    except GraphError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    json.dump(merged_tree, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    for path in conflicts:
        print(path, file=sys.stderr)

    if args.output:
        result = {"tree": merged_tree, "conflicts": conflicts}
        try:
            with open(args.output, "w", encoding="utf-8") as handle:
                json.dump(result, handle, indent=2, sort_keys=True)
                handle.write("\n")
        except OSError as exc:
            print(f"error: cannot write output file: {exc}", file=sys.stderr)
            return 2

    return 1 if conflicts else 0


if __name__ == "__main__":
    sys.exit(main())
