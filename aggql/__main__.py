"""CLI entry point: python -m aggql query.json rows.json"""

from __future__ import annotations

import json
import sys

from . import QueryError, run_query

USAGE = "usage: python -m aggql query.json rows.json"


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) != 2:
        print(USAGE, file=sys.stderr)
        return 2
    query_path, rows_path = argv
    try:
        with open(query_path, "r", encoding="utf-8") as handle:
            query = json.load(handle)
        with open(rows_path, "r", encoding="utf-8") as handle:
            rows = json.load(handle)
    except OSError as exc:
        print(f"aggql: cannot read input: {exc}", file=sys.stderr)
        return 1
    except json.JSONDecodeError as exc:
        print(f"aggql: invalid JSON: {exc}", file=sys.stderr)
        return 1
    if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
        print("aggql: rows.json must be a JSON array of objects", file=sys.stderr)
        return 1
    try:
        result = run_query(query, rows)
    except QueryError as exc:
        print(f"aggql: {exc}", file=sys.stderr)
        return 2
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
