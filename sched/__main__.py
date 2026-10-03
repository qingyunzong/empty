"""CLI: read a transaction set from a JSON file, print the schedule."""

import json
import sys

from .scheduler import NonSerializableError, schedule_transactions


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) != 1:
        print("usage: python -m sched <input.json>", file=sys.stderr)
        return 2
    try:
        with open(argv[0], "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except OSError as exc:
        print(f"error: cannot read {argv[0]!r}: {exc}", file=sys.stderr)
        return 2
    except json.JSONDecodeError as exc:
        print(f"error: invalid JSON in {argv[0]!r}: {exc}", file=sys.stderr)
        return 2

    try:
        result = schedule_transactions(data)
    except NonSerializableError as exc:
        result = {"error": "NON_SERIALIZABLE", "cycle": exc.cycle}
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
