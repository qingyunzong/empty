"""Command line interface: python -m gpupack schedule req.json --out alloc.json"""
from __future__ import annotations

import argparse
import json
import sys

from .model import ProblemError, parse_problem
from .scheduler import solve


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="gpupack", description="Deterministic GPU job scheduler"
    )
    sub = parser.add_subparsers(dest="command", required=True)
    sched = sub.add_parser("schedule", help="schedule requests onto GPUs")
    sched.add_argument("input", help="path to the request JSON file")
    sched.add_argument(
        "--out", help="write the allocation to this file (default: stdout)"
    )
    args = parser.parse_args(argv)

    if args.command == "schedule":
        try:
            with open(args.input, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError) as exc:
            print(f"error: cannot read {args.input}: {exc}", file=sys.stderr)
            return 2
        try:
            problem = parse_problem(data)
        except ProblemError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2
        solution = solve(problem)
        if solution is None:
            payload = "INFEASIBLE\n"
        else:
            payload = (
                json.dumps({"jobs": list(solution.jobs)}, indent=2, sort_keys=True)
                + "\n"
            )
        if args.out:
            try:
                with open(args.out, "w", encoding="utf-8") as fh:
                    fh.write(payload)
            except OSError as exc:
                print(f"error: cannot write {args.out}: {exc}", file=sys.stderr)
                return 1
        else:
            sys.stdout.write(payload)
        return 0
    return 2
