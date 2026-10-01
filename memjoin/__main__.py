"""CLI: python -m memjoin query.json data.json --budget M"""

from __future__ import annotations

import argparse
import json
import sys

from .core import QueryError, run_query, validate_data, validate_query


def _positive_int(text):
    try:
        value = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError(
            f"budget must be a positive integer, got {text!r}"
        )
    if value < 1:
        raise argparse.ArgumentTypeError(
            f"budget must be a positive integer, got {text!r}"
        )
    return value


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="python -m memjoin",
        description="Plan and execute a 2-4 table equi-inner-join under a "
        "row-residency budget.",
    )
    parser.add_argument("query", help="path to query JSON (tables + joins)")
    parser.add_argument("data", help="path to data JSON (table -> rows)")
    parser.add_argument(
        "--budget",
        type=_positive_int,
        required=True,
        help="maximum number of rows resident at once (positive integer)",
    )
    args = parser.parse_args(argv)

    try:
        with open(args.query, "r", encoding="utf-8") as fh:
            query = validate_query(json.load(fh))
        with open(args.data, "r", encoding="utf-8") as fh:
            data = validate_data(json.load(fh), query["tables"])
    except (OSError, json.JSONDecodeError, QueryError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    rows, trace = run_query(query, data, args.budget)
    json.dump({"rows": rows, "plan_trace": trace}, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
