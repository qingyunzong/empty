"""CLI: python -m vclock run scenario.json  ->  JSONL event trace on stdout."""

from __future__ import annotations

import argparse
import sys

from .scenario import run_scenario


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="vclock")
    sub = parser.add_subparsers(dest="command", required=True)
    run_p = sub.add_parser("run", help="run a scenario JSON, emit JSONL trace")
    run_p.add_argument("scenario", help="path to scenario JSON file")
    args = parser.parse_args(argv)

    if args.command == "run":
        run_scenario(args.scenario)
        return 0
    return 2  # unreachable: subcommand is required


if __name__ == "__main__":
    sys.exit(main())
