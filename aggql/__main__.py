"""CLI: python -m aggql query.json rows.json"""

import json
import sys

from . import AggqlError, compute


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) != 2:
        print("usage: python -m aggql query.json rows.json", file=sys.stderr)
        return 2
    try:
        with open(argv[0], encoding="utf-8") as fh:
            query = json.load(fh)
        with open(argv[1], encoding="utf-8") as fh:
            rows = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"error: cannot read input: {exc}", file=sys.stderr)
        return 2
    try:
        result = compute(rows, query)
    except AggqlError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
