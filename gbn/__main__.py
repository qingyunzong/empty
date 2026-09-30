"""CLI: python -m gbn simulate <trace.json> [--events]"""

import json
import sys

from .simulator import run_simulation

USAGE = "usage: python -m gbn simulate <trace.json> [--events]"


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] != "simulate" or len(argv) < 2:
        print(USAGE, file=sys.stderr)
        return 2
    with open(argv[1], "r", encoding="utf-8") as fh:
        config = json.load(fh)
    result = run_simulation(config)
    if "--events" in argv[2:]:
        json.dump(result, sys.stdout, indent=2)
        print()
    else:
        print(json.dumps(result["delivered"]))
    return 0 if result["completed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
