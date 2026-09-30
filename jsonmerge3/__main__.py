"""CLI: python -m jsonmerge3 base.json ours.json theirs.json [-o result.json]"""

import argparse
import json
import sys

from .merge import merge3, pointer_of


def _load(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="jsonmerge3",
        description="Three-way merge of JSON documents.",
    )
    parser.add_argument("base", help="base JSON file")
    parser.add_argument("ours", help="ours JSON file")
    parser.add_argument("theirs", help="theirs JSON file")
    parser.add_argument("-o", "--output", help="write merged JSON to this file")
    args = parser.parse_args(argv)

    try:
        base = _load(args.base)
        ours = _load(args.ours)
        theirs = _load(args.theirs)
    except OSError as exc:
        print(f"jsonmerge3: cannot read input: {exc}", file=sys.stderr)
        return 2
    except json.JSONDecodeError as exc:
        print(f"jsonmerge3: invalid JSON: {exc}", file=sys.stderr)
        return 2

    conflicts = []
    merged = merge3(base, ours, theirs, conflicts=conflicts)
    text = json.dumps(merged, ensure_ascii=False, indent=2) + "\n"

    if args.output:
        try:
            with open(args.output, "w", encoding="utf-8") as fh:
                fh.write(text)
        except OSError as exc:
            print(f"jsonmerge3: cannot write output: {exc}", file=sys.stderr)
            return 2

    sys.stdout.write(text)
    sys.stderr.write(
        json.dumps([pointer_of(p) for p in conflicts], ensure_ascii=False) + "\n"
    )
    return 1 if conflicts else 0


if __name__ == "__main__":
    sys.exit(main())
