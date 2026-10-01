"""Command line interface: python -m rostersolve plan jobs.json --out plan.json --trace trace.json"""

import argparse
import json
import sys

from .model import InputError, parse_problem
from .solver import Solver, build_plan, minimal_conflict


def _emit_error(message):
    sys.stderr.write(json.dumps({"error": message}, ensure_ascii=False) + "\n")
    return 2


def main(argv=None):
    parser = argparse.ArgumentParser(prog="rostersolve")
    sub = parser.add_subparsers(dest="command", required=True)
    plan_parser = sub.add_parser("plan", help="compute a feasible schedule or prove INFEASIBLE")
    plan_parser.add_argument("input", help="input JSON file")
    plan_parser.add_argument("--out", help="write plan JSON here (default: stdout)")
    plan_parser.add_argument("--trace", help="write deterministic search trace JSON here")
    args = parser.parse_args(argv)

    try:
        with open(args.input, "r", encoding="utf-8") as fh:
            text = fh.read()
    except OSError as exc:
        return _emit_error("cannot read input file: %s" % exc)

    try:
        problem = parse_problem(text)
    except InputError as exc:
        return _emit_error(str(exc))

    solver = Solver(problem, record_trace=True)
    placement = solver.solve()

    if placement is not None:
        plan = build_plan(problem, placement)
        conflict = []
    else:
        conflict = minimal_conflict(problem)
        plan = {"status": "INFEASIBLE", "conflict": conflict}

    out_text = json.dumps(plan, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(out_text)
    else:
        sys.stdout.write(out_text)

    if args.trace:
        trace = {
            "input": {
                "jobs": len(problem.jobs),
                "machines": len(problem.machines),
                "horizon": problem.horizon,
            },
            "status": plan["status"],
            "nodes": solver.nodes,
            "events": solver.events,
            "conflict": conflict,
        }
        with open(args.trace, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(trace, ensure_ascii=False, indent=2, sort_keys=True) + "\n")

    return 0
