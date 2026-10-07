"""JSON command-line interface.

    python3.11 -m exactcount solve PROBLEM.json [--budget N]
        [--checkpoint-in CP.json] [--checkpoint-out CP.json]
        [--certificate-out CERT.json]
    python3.11 -m exactcount count PROBLEM.json
    python3.11 -m exactcount verify CERT.json
"""

from __future__ import annotations

import argparse
import json
import sys

from .checker import verify_certificate
from .problem import Problem, ProblemError
from .solver import Solver


def _load_json(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _write_json(path, data):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, sort_keys=True)
        fh.write("\n")


def _emit(data):
    json.dump(data, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="exactcount",
        description="Exact counter for finite integer domains with "
        "allowed-tuple table constraints, with budgeted, resumable search.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_solve = sub.add_parser("solve", help="count under a support-check budget")
    p_solve.add_argument("problem", help="problem JSON file")
    p_solve.add_argument(
        "--budget",
        type=int,
        default=None,
        help="maximum number of value-support checks (default: unlimited)",
    )
    p_solve.add_argument("--checkpoint-in", help="resume from checkpoint JSON")
    p_solve.add_argument("--checkpoint-out", help="write checkpoint JSON")
    p_solve.add_argument("--certificate-out", help="write certificate JSON")

    p_count = sub.add_parser("count", help="exact count, unlimited budget")
    p_count.add_argument("problem", help="problem JSON file")

    p_verify = sub.add_parser("verify", help="independently verify a certificate")
    p_verify.add_argument("certificate", help="certificate JSON file")

    args = parser.parse_args(argv)
    try:
        if args.command == "solve":
            problem = Problem.from_dict(_load_json(args.problem))
            if args.checkpoint_in:
                solver = Solver.from_checkpoint(
                    _load_json(args.checkpoint_in), problem
                )
            else:
                solver = Solver(problem)
            result = solver.solve(args.budget)
            if args.checkpoint_out:
                _write_json(args.checkpoint_out, solver.checkpoint())
            if args.certificate_out:
                _write_json(args.certificate_out, solver.certificate())
            _emit(result)
            return 0
        if args.command == "count":
            solver = Solver(Problem.from_dict(_load_json(args.problem)))
            result = solver.solve(None)
            _emit({"exact": result["exact"], "checks_total": result["checks_total"]})
            return 0
        if args.command == "verify":
            errors = verify_certificate(_load_json(args.certificate))
            _emit({"valid": not errors, "errors": errors})
            return 0 if not errors else 1
    except (ProblemError, ValueError, KeyError, OSError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    return 2
