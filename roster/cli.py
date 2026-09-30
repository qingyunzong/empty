"""Command line interface: python -m roster.cli <input.json|->

Reads a roster problem as JSON, prints the result as JSON on stdout.
Validation errors (code BAD_ROSTER) are reported on stderr with exit code 2.
"""

from __future__ import annotations

import json
import sys

from .core import BAD_ROSTER, RosterError, solve


def _emit_error(code, message):
    json.dump({"error": {"code": code, "message": message}}, sys.stderr, ensure_ascii=False)
    sys.stderr.write("\n")


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) != 1:
        print("usage: python -m roster.cli <input.json|->", file=sys.stderr)
        return 2
    try:
        if argv[0] == "-":
            text = sys.stdin.read()
        else:
            with open(argv[0], "r", encoding="utf-8") as fh:
                text = fh.read()
        problem = json.loads(text)
    except OSError as exc:
        _emit_error(BAD_ROSTER, "cannot read input: %s" % exc)
        return 2
    except json.JSONDecodeError as exc:
        _emit_error(BAD_ROSTER, "invalid JSON: %s" % exc)
        return 2
    try:
        result = solve(problem)
    except RosterError as exc:
        _emit_error(exc.code, exc.message)
        return 2
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
