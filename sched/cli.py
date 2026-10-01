"""Command line interface: read transactions from a JSON file, print the
schedule as JSON to stdout.

Usage:
    python -m sched INPUT.json
    python -m sched - < input.json

Input format::

    {
      "transactions": [
        {"id": "T1", "ops": [{"type": "write", "key": "x", "value": 1},
                              {"type": "read",  "key": "y"}]},
        ...
      ],
      "order": [["T1", 0], ["T2", 0], ...]   // optional reference order
    }

Output (success)::

    {"rounds": [[["T1", 0], ...], ...], "num_rounds": 2}

Output (not conflict serializable)::

    {"error": "NON_SERIALIZABLE", "cycle": ["T1", "T2"]}

Exit codes: 0 on success, 1 when the input is not serializable,
2 on malformed input.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Optional, Sequence

from .core import NON_SERIALIZABLE, ScheduleError, schedule_transactions


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="sched",
        description=(
            "Build a minimal-round, conflict-serializable parallel schedule "
            "for a set of transactions described in JSON."
        ),
    )
    parser.add_argument(
        "input",
        help="path to the JSON input file, or '-' to read from stdin",
    )
    args = parser.parse_args(argv)

    try:
        if args.input == "-":
            data = json.load(sys.stdin)
        else:
            with open(args.input, "r", encoding="utf-8") as fh:
                data = json.load(fh)
    except OSError as exc:
        print(
            json.dumps({"error": "INVALID_INPUT", "message": str(exc)}),
            file=sys.stderr,
        )
        return 2
    except json.JSONDecodeError as exc:
        print(
            json.dumps({"error": "INVALID_INPUT", "message": f"invalid JSON: {exc}"}),
            file=sys.stderr,
        )
        return 2

    if not isinstance(data, dict) or "transactions" not in data:
        print(
            json.dumps(
                {
                    "error": "INVALID_INPUT",
                    "message": "top-level object must contain 'transactions'",
                }
            ),
            file=sys.stderr,
        )
        return 2

    try:
        result = schedule_transactions(data["transactions"], data.get("order"))
    except ScheduleError as exc:
        print(
            json.dumps({"error": "INVALID_INPUT", "message": str(exc)}),
            file=sys.stderr,
        )
        return 2

    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 1 if result.get("error") == NON_SERIALIZABLE else 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
