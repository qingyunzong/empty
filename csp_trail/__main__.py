"""CLI: python -m csp_trail run --input <problem.json> --assign '{"x": 1}'

Prints a JSON object with current_level, domains and status on stdout.
Errors go to stderr with a non-zero exit code.
"""

from __future__ import annotations

import argparse
import json
import sys

from .core import CSPError, TrailCSP, load_problem


def _cmd_run(args):
    try:
        variables, constraints = load_problem(args.input)
    except (CSPError, OSError, json.JSONDecodeError) as exc:
        print(f"error: cannot load problem: {exc}", file=sys.stderr)
        return 1

    csp = TrailCSP(variables, constraints)
    status = csp.status

    assignments = {}
    if args.assign:
        try:
            assignments = json.loads(args.assign)
        except json.JSONDecodeError as exc:
            print(f"error: invalid --assign JSON: {exc}", file=sys.stderr)
            return 1
        if not isinstance(assignments, dict):
            print("error: --assign must be a JSON object mapping variables to values",
                  file=sys.stderr)
            return 1

    if status != TrailCSP.STATUS_UNSAT:
        for var, value in assignments.items():
            try:
                result = csp.assign(str(var), value)
            except CSPError as exc:
                print(f"error: {exc}", file=sys.stderr)
                return 1
            if result == TrailCSP.STATUS_CONFLICT:
                status = TrailCSP.STATUS_CONFLICT
                break

    if args.backtrack is not None and status != TrailCSP.STATUS_UNSAT:
        try:
            csp.backtrack(args.backtrack)
        except CSPError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1
        if status == TrailCSP.STATUS_CONFLICT:
            status = TrailCSP.STATUS_OK

    output = {
        "current_level": csp.current_level,
        "domains": csp.snapshot(),
        "status": status,
    }
    json.dump(output, sys.stdout, sort_keys=True)
    sys.stdout.write("\n")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(prog="csp_trail")
    subparsers = parser.add_subparsers(dest="command", required=True)
    run_parser = subparsers.add_parser("run", help="run the solver on a problem file")
    run_parser.add_argument("--input", required=True, help="path to the problem JSON file")
    run_parser.add_argument("--assign", default=None,
                            help="JSON object mapping variables to values")
    run_parser.add_argument("--backtrack", type=int, default=None,
                            help="backtrack to the given decision level after assignments")
    args = parser.parse_args(argv)
    if args.command == "run":
        return _cmd_run(args)
    return 2


if __name__ == "__main__":
    sys.exit(main())
