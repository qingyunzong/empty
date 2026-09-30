"""CLI entry point: ``python -m gbn simulate trace.json``."""

import argparse
import json
import sys

from .simulator import load_trace, run_trace


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="gbn",
        description="Go-Back-N protocol simulator (window N=4, seq space 8)",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    sim = sub.add_parser("simulate", help="run a simulation from a trace script")
    sim.add_argument("trace", help="path to a trace JSON file")
    sim.add_argument(
        "--events",
        action="store_true",
        help="also print the full event log",
    )
    args = parser.parse_args(argv)

    if args.command == "simulate":
        result = run_trace(load_trace(args.trace))
        if args.events:
            print(
                json.dumps(
                    {
                        "delivered": result.delivered,
                        "ticks": result.ticks,
                        "events": [list(e) for e in result.events],
                    }
                )
            )
        else:
            print(json.dumps(result.delivered))
    return 0


if __name__ == "__main__":
    sys.exit(main())
