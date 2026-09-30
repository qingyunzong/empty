"""CLI: python -m vcmerge merge LEFT RIGHT --out OUT"""

from __future__ import annotations

import argparse
import json
import sys

from .core import MergeError, count_conflicts, dump_document, merge_documents


def _load(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="vcmerge",
        description="Deterministically merge two JSON document replicas.",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    merge_cmd = sub.add_parser("merge", help="merge LEFT and RIGHT into OUT")
    merge_cmd.add_argument("left", help="path to the left JSON document")
    merge_cmd.add_argument("right", help="path to the right JSON document")
    merge_cmd.add_argument("--out", required=True, help="path for the merged output")
    args = parser.parse_args(argv)

    try:
        left = _load(args.left)
        right = _load(args.right)
        merged = merge_documents(left, right)
    except MergeError as exc:
        print(f"vcmerge: {exc}", file=sys.stderr)
        return exc.exit_code
    except OSError as exc:
        print(f"vcmerge: {exc}", file=sys.stderr)
        return 2
    except json.JSONDecodeError as exc:
        print(f"vcmerge: invalid JSON: {exc}", file=sys.stderr)
        return 2

    try:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(dump_document(merged))
    except OSError as exc:
        print(f"vcmerge: {exc}", file=sys.stderr)
        return 2

    print(count_conflicts(merged))
    return 0


if __name__ == "__main__":
    sys.exit(main())
