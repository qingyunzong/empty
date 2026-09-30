"""Command line interface for jsonmerge3.

Usage:
    python -m jsonmerge3 base.json ours.json theirs.json -o result.json

* The merged JSON is written to stdout (and to the ``-o`` file when
  given).
* The conflict report (a JSON array of JSON Pointer strings) is written
  to stderr.
* Exit codes: 0 = clean merge, 1 = conflicts, 2 = invalid
  JSON/IO/usage error. On any failure nothing is written to stdout or
  to the output file.
"""

import argparse
import json
import sys

from . import merge3


def _load_json(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def _build_parser():
    parser = argparse.ArgumentParser(
        prog="jsonmerge3",
        description="Three-way recursive JSON merge.",
    )
    parser.add_argument("base", help="path to the base JSON file")
    parser.add_argument("ours", help="path to our JSON file")
    parser.add_argument("theirs", help="path to their JSON file")
    parser.add_argument(
        "-o",
        "--output",
        metavar="FILE",
        default=None,
        help="also write the merged JSON to FILE",
    )
    return parser


def main(argv=None):
    parser = _build_parser()
    args = parser.parse_args(argv)

    try:
        base = _load_json(args.base)
        ours = _load_json(args.ours)
        theirs = _load_json(args.theirs)
    except OSError as exc:
        print(f"jsonmerge3: error: {exc}", file=sys.stderr)
        return 2
    except json.JSONDecodeError as exc:
        print(
            f"jsonmerge3: error: invalid JSON in {exc.doc!r} "
            f"(line {exc.lineno} column {exc.colno}: {exc.msg})",
            file=sys.stderr,
        )
        return 2

    merged, conflicts = merge3(base, ours, theirs)
    text = json.dumps(merged, ensure_ascii=False, indent=2)

    if args.output is not None:
        try:
            with open(args.output, "w", encoding="utf-8") as handle:
                handle.write(text + "\n")
        except OSError as exc:
            print(f"jsonmerge3: error: {exc}", file=sys.stderr)
            return 2

    print(text)
    print(json.dumps(conflicts, ensure_ascii=False), file=sys.stderr)
    return 1 if conflicts else 0
