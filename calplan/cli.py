"""Command line interface: python -m calplan.cli < request.json

Reads a JSON request from stdin and writes the JSON result to stdout.
Invalid input writes a JSON error object to stderr and exits with code 2.
"""

from __future__ import annotations

import json
import sys

from .core import BadInputError, plan


def main(argv=None):
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError) as exc:
        json.dump({"code": "BAD_INPUT", "message": f"invalid JSON: {exc}"}, sys.stderr)
        sys.stderr.write("\n")
        return 2

    try:
        result = plan(payload)
    except BadInputError as exc:
        json.dump({"code": "BAD_INPUT", "message": str(exc)}, sys.stderr)
        sys.stderr.write("\n")
        return 2

    json.dump(result, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
