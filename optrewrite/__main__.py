"""CLI: python -m optrewrite query.json stats.json budget.json

Exit codes:
    0  success; the optimal canonical plan JSON is printed to stdout
    1  invalid input (bad JSON, malformed query, ...)
    2  unknown column (or missing selectivity) referenced by the query
    3  the optimal plan cost exceeds the budget; an error object containing
       the optimal cost is printed to stderr
"""

from __future__ import annotations

import json
import sys

from . import core


def _load_json(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _parse_budget(data):
    if isinstance(data, dict):
        data = data["budget"]
    return core.to_fraction(data)


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 3:
        print(
            "usage: python -m optrewrite query.json stats.json budget.json",
            file=sys.stderr,
        )
        return 1
    try:
        query = _load_json(args[0])
        stats = core.Stats.from_dict(_load_json(args[1]))
        budget = _parse_budget(_load_json(args[2]))
    except (OSError, json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
        print(
            json.dumps({"error": "invalid_input", "message": str(exc)}),
            file=sys.stderr,
        )
        return 1

    try:
        plan, cost = core.optimize(query, stats)
    except core.OptRewriteError as exc:
        print(json.dumps(exc.to_object()), file=sys.stderr)
        return exc.exit_code

    if cost <= budget:
        print(json.dumps(plan, indent=2, sort_keys=True))
        return 0
    print(
        json.dumps(
            {
                "error": "budget_exceeded",
                "optimal_cost": core.number(cost),
                "budget": core.number(budget),
            }
        ),
        file=sys.stderr,
    )
    return 3


if __name__ == "__main__":
    sys.exit(main())
