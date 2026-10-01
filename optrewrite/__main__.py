"""Command line interface: python -m optrewrite query.json stats.json budget.json"""

import json
import sys

from .optimizer import (
    MalformedQueryError,
    UnknownColumnError,
    UnknownRelationError,
    optimize_query,
)

USAGE = "usage: python -m optrewrite query.json stats.json budget.json"


def _load_json(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 3:
        print(USAGE, file=sys.stderr)
        return 1
    try:
        query = _load_json(args[0])
        stats = _load_json(args[1])
        budget_data = _load_json(args[2])
    except (OSError, json.JSONDecodeError) as exc:
        print(json.dumps({"error": "input_error", "message": str(exc)}))
        return 1
    budget = budget_data.get("budget") if isinstance(budget_data, dict) else budget_data
    if not isinstance(budget, (int, float)) or isinstance(budget, bool):
        print(json.dumps({"error": "input_error", "message": "budget must be a number"}))
        return 1
    try:
        result = optimize_query(query, stats)
    except UnknownColumnError as exc:
        print(json.dumps({"error": "unknown_column", "column": exc.column}))
        return 2
    except UnknownRelationError as exc:
        print(json.dumps({"error": "unknown_relation", "relation": exc.relation}))
        return 2
    except MalformedQueryError as exc:
        print(json.dumps({"error": "malformed_query", "message": str(exc)}))
        return 1
    if result["cost"] <= budget:
        print(json.dumps(result, indent=2))
        return 0
    print(json.dumps({
        "error": "budget_exceeded",
        "cost": result["cost"],
        "budget": budget,
    }))
    return 3


if __name__ == "__main__":
    sys.exit(main())
