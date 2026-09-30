"""Command line interface: ``python -m roster.cli [input.json]``.

Reads a JSON problem description from a file or stdin and writes the JSON
result to stdout. Invalid input prints an error object with code
``BAD_ROSTER`` to stderr and exits with status 2.
"""

import argparse
import json
import sys

from . import BAD_ROSTER, RosterError, solve


def _fail(code, message):
    json.dump({"error": {"code": code, "message": message}}, sys.stderr)
    sys.stderr.write("\n")
    return 2


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="python -m roster.cli",
        description="Solve a layered roster problem given as JSON.",
    )
    parser.add_argument(
        "input",
        nargs="?",
        help="JSON input file (defaults to stdin)",
    )
    args = parser.parse_args(argv)

    try:
        if args.input:
            with open(args.input, "r", encoding="utf-8") as handle:
                raw = handle.read()
        else:
            raw = sys.stdin.read()
    except OSError as exc:
        return _fail(BAD_ROSTER, "cannot read input: %s" % exc)

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        return _fail(BAD_ROSTER, "invalid JSON: %s" % exc)

    if not isinstance(data, dict):
        return _fail(BAD_ROSTER, "input must be a JSON object")

    try:
        result = solve(
            employees=data.get("employees", []),
            demand=data.get("demand", {}),
            off=data.get("off", {}),
            levels=data.get("levels", []),
            days=data.get("days"),
        )
    except RosterError as exc:
        return _fail(exc.code, str(exc))

    json.dump(result, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
