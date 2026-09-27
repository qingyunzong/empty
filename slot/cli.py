"""Command-line interface: python -m slot.cli

Reads a JSON object from stdin (or from a file path given as argv[1]):

    {
      "busy":   [[[0, 30], [60, 90]], [[15, 45]]],
      "d":      30,
      "window": [0, 240],
      "prefer": [[10, 20]]            // optional
    }

Writes a JSON result to stdout:

    {"status": "ok",   "slots": [[s, e], ...]}
    {"status": "none", "slots": []}
    {"error": {"code": "BAD_SLOT" | "BAD_INPUT", "message": "..."}}

Exit code is 0 on success (including status "none") and 2 on any error.
"""

import json
import sys

from .core import BAD_INPUT, SlotError, find_slots


def _emit(payload):
    json.dump(payload, sys.stdout)
    sys.stdout.write("\n")


def _fail(code, message):
    _emit({"error": {"code": code, "message": message}})
    return 2


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        if argv:
            with open(argv[0], "r", encoding="utf-8") as handle:
                payload = json.load(handle)
        else:
            payload = json.load(sys.stdin)
    except OSError as exc:
        return _fail(BAD_INPUT, f"cannot read input: {exc}")
    except json.JSONDecodeError as exc:
        return _fail(BAD_INPUT, f"invalid JSON: {exc}")

    if not isinstance(payload, dict):
        return _fail(BAD_INPUT, "input must be a JSON object")
    missing = [key for key in ("busy", "d", "window") if key not in payload]
    if missing:
        return _fail(BAD_INPUT, f"missing required field(s): {', '.join(missing)}")

    try:
        result = find_slots(
            payload["busy"],
            payload["d"],
            payload["window"],
            payload.get("prefer"),
        )
    except SlotError as exc:
        return _fail(exc.code, exc.message)

    _emit(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
