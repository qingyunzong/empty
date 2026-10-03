"""JSON command line interface.

Commands
--------
solve PROBLEM.json [--budget N] [--checkpoint CP.json] [--certificate CERT.json]
      [--result R.json]
resume CP.json [--budget N] [--checkpoint CP2.json] [--certificate CERT.json]
      [--result R.json]
verify CERT.json

``solve``/``resume`` print a JSON result with ``confirmed_lower``,
``certified_upper``, ``complete`` and ``exact`` (only when the bounds
meet).  A checkpoint is always written when ``--checkpoint`` is given,
so a run paused by budget exhaustion can be resumed in a new process.
"""

from __future__ import annotations

import argparse
import json
import sys

from .checker import verify_certificate
from .problem import Problem
from .solver import Solver


def _load_json(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _write_json(path, data):
    if path is None:
        return
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, sort_keys=True)
        fh.write("\n")


def _result_payload(solver):
    out = solver.result()
    out["stats"] = dict(solver.stats)
    out["cache"] = {
        "size": len(solver.cache.entries),
        "hits": solver.cache.hits,
        "stale": solver.cache.stale,
        "misses": solver.cache.misses,
    }
    return out


def _run_search(args, solver):
    solver.solve(budget=args.budget)
    payload = _result_payload(solver)
    if args.checkpoint:
        _write_json(args.checkpoint, solver.to_checkpoint())
    if args.certificate:
        _write_json(args.certificate, solver.certificate())
    text = json.dumps(payload, indent=2, sort_keys=True)
    if args.result:
        _write_json(args.result, payload)
    print(text)
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(prog="schcount")
    sub = parser.add_subparsers(dest="command", required=True)

    def add_search_args(p, problem_arg):
        p.add_argument(problem_arg, help="input JSON file")
        p.add_argument(
            "--budget",
            type=int,
            default=None,
            help="maximum number of value-support checks (default: unlimited)",
        )
        p.add_argument("--checkpoint", help="write a resumable checkpoint here")
        p.add_argument("--certificate", help="write a verifiable certificate here")
        p.add_argument("--result", help="also write the result JSON here")

    p_solve = sub.add_parser("solve", help="count solutions of a problem file")
    add_search_args(p_solve, "problem")
    p_resume = sub.add_parser("resume", help="resume from a checkpoint file")
    add_search_args(p_resume, "checkpoint_in")
    p_verify = sub.add_parser("verify", help="check a certificate file")
    p_verify.add_argument("certificate")

    args = parser.parse_args(argv)
    try:
        if args.command == "solve":
            problem = Problem.from_json(_load_json(args.problem))
            return _run_search(args, Solver(problem))
        if args.command == "resume":
            solver = Solver.from_checkpoint(_load_json(args.checkpoint_in))
            return _run_search(args, solver)
        ok, reason = verify_certificate(_load_json(args.certificate))
        print(json.dumps({"valid": ok, "reason": reason}, indent=2, sort_keys=True))
        return 0 if ok else 1
    except (OSError, ValueError, KeyError) as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
