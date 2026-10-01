"""Command line interface: python -m trimerge base ours theirs -o merged"""

from __future__ import annotations

import argparse
import sys

from . import join_lines, merge_lines, split_lines


def _read_lines(path):
    with open(path, "r", encoding="utf-8", newline="") as handle:
        return split_lines(handle.read())


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="trimerge",
        description="Deterministic three-way text merge.",
    )
    parser.add_argument("base", help="common ancestor file")
    parser.add_argument("ours", help="our side of the merge")
    parser.add_argument("theirs", help="their side of the merge")
    parser.add_argument("-o", "--output", required=True, help="output file")
    args = parser.parse_args(argv)

    try:
        base = _read_lines(args.base)
        ours = _read_lines(args.ours)
        theirs = _read_lines(args.theirs)
    except (OSError, UnicodeDecodeError) as exc:
        print(f"trimerge: error: {exc}", file=sys.stderr)
        return 2

    merged, conflicts = merge_lines(base, ours, theirs)

    try:
        with open(args.output, "w", encoding="utf-8", newline="") as handle:
            handle.write(join_lines(merged))
    except OSError as exc:
        print(f"trimerge: error: {exc}", file=sys.stderr)
        return 2

    if conflicts:
        print(f"trimerge: {conflicts} conflict(s)", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
