"""Command line interface: python -m budgetfn plan jobs.json --budget B --out plan.json"""

from __future__ import annotations

import argparse
import json
import sys

from .core import JobError, plan, validate_budget, validate_jobs


def _parse_number(text):
    try:
        return int(text)
    except ValueError:
        try:
            return float(text)
        except ValueError:
            raise JobError(f"invalid number: {text!r}")


def _build_parser():
    parser = argparse.ArgumentParser(
        prog="budgetfn",
        description="Budget-constrained single-machine job scheduler.")
    sub = parser.add_subparsers(dest="command", required=True)
    plan_parser = sub.add_parser(
        "plan", help="compute an optimal schedule for a jobs file")
    plan_parser.add_argument("jobs_file", help="JSON file with the job list")
    plan_parser.add_argument("--budget", required=True,
                             help="total cost budget B (must be >= 0)")
    plan_parser.add_argument("--out", required=True,
                             help="path to write the plan JSON")
    return parser


def main(argv=None):
    args = _build_parser().parse_args(argv)
    try:
        budget = validate_budget(_parse_number(args.budget))
        with open(args.jobs_file, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        jobs = validate_jobs(data)
        result = plan(jobs, budget)
    except JobError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"error: cannot read jobs file: {exc}", file=sys.stderr)
        return 2
    except json.JSONDecodeError as exc:
        print(f"error: invalid JSON in jobs file: {exc}", file=sys.stderr)
        return 2

    text = json.dumps(result, indent=2, sort_keys=True) + "\n"
    try:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text)
    except OSError as exc:
        print(f"error: cannot write plan file: {exc}", file=sys.stderr)
        return 2

    print(f"spent={result['spent']} earned={result['earned']} "
          f"horizon={result['horizon']} -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
