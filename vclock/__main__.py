"""CLI: python -m vclock run scenario.json

Runs the scenario and prints the event trace as JSONL on stdout.
"""

from __future__ import annotations

import argparse
import json
import sys

from .scenario import run_scenario_file


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="vclock")
    sub = parser.add_subparsers(dest="command", required=True)
    run_parser = sub.add_parser("run", help="run a scenario JSON file")
    run_parser.add_argument("scenario", help="path to scenario JSON file")
    args = parser.parse_args(argv)

    if args.command == "run":
        clock, sessions = run_scenario_file(args.scenario)
        for entry in clock.trace:
            print(json.dumps(entry, ensure_ascii=False))
        summary = {
            "kind": "SUMMARY",
            "tick": clock.now,
            "sessions": {name: s.state for name, s in sessions.items()},
        }
        print(json.dumps(summary, ensure_ascii=False), file=sys.stderr)
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
