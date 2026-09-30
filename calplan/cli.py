"""Command line interface: python -m calplan.cli [input.json]

Reads a JSON request from a file argument or stdin, writes the plan as
JSON to stdout. On invalid input, writes a JSON error object to stderr
and exits with status 2.
"""

from __future__ import annotations

import argparse
import json
import sys

from .core import BadInput, plan


def _fail(message):
    json.dump({"error": {"code": BadInput.code, "message": message}}, sys.stderr)
    sys.stderr.write("\n")
    return 2


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="calplan.cli",
        description="Plan the earliest feasible segments for a demand.",
    )
    parser.add_argument(
        "path",
        nargs="?",
        help="JSON request file (reads stdin when omitted or '-')",
    )
    args = parser.parse_args(argv)

    if args.path and args.path != "-":
        try:
            with open(args.path, "r", encoding="utf-8") as handle:
                raw = handle.read()
        except OSError as exc:
            return _fail(f"cannot read input file: {exc}")
    else:
        raw = sys.stdin.read()

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        return _fail(f"invalid JSON: {exc}")

    try:
        result = plan(payload)
    except BadInput as exc:
        return _fail(str(exc))

    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
