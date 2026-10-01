"""Command line interface: python -m budgetfn plan jobs.json --budget B --out plan.json"""

import argparse
import json
import sys

from .planner import InputError, solve


def _build_parser():
    parser = argparse.ArgumentParser(
        prog="budgetfn",
        description="Budget-constrained single-machine job scheduler.",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    plan = sub.add_parser("plan", help="compute an optimal plan")
    plan.add_argument("jobs", help="path to a JSON array of jobs")
    plan.add_argument("--budget", type=int, required=True, help="total budget B")
    plan.add_argument("--out", required=True, help="path to write the plan JSON")
    return parser


def main(argv=None):
    args = _build_parser().parse_args(argv)
    if args.command == "plan":
        try:
            with open(args.jobs, "r", encoding="utf-8") as handle:
                jobs = json.load(handle)
        except (OSError, json.JSONDecodeError) as exc:
            print(f"error: cannot read jobs file: {exc}", file=sys.stderr)
            return 2
        try:
            plan = solve(jobs, args.budget)
        except InputError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2
        try:
            with open(args.out, "w", encoding="utf-8") as handle:
                json.dump(plan, handle, indent=2, sort_keys=True)
                handle.write("\n")
        except OSError as exc:
            print(f"error: cannot write plan file: {exc}", file=sys.stderr)
            return 2
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
