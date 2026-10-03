"""Deterministic JSON command line interface.

Commands:
  solve   problem.json [--budget N] [--resume state.json] [--save-state out.json]
  verify  problem.json certificate.json     (exit 0 iff certificate is valid)
  check   problem.json witness.json         (exit 0 iff witness is valid)

All output is JSON with sorted keys so repeated runs are byte-identical.
"""

from __future__ import annotations

import argparse
import json
import sys

from .core import SpecError
from .search import Searcher, check_witness, verify_unsat


def _load_json(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        raise SpecError(f"cannot read {path}: {exc}") from exc


def _emit(payload, stream=None):
    stream = stream or sys.stdout
    json.dump(payload, stream, indent=2, sort_keys=True)
    stream.write("\n")


def _cmd_solve(args):
    spec = _load_json(args.problem)
    if args.resume:
        state = _load_json(args.resume)
        searcher = Searcher.from_state(spec, state)
    else:
        searcher = Searcher(spec)
    result = searcher.run(budget=args.budget)
    if args.save_state and result["state"] is not None:
        with open(args.save_state, "w", encoding="utf-8") as handle:
            json.dump(result["state"], handle, indent=2, sort_keys=True)
            handle.write("\n")
    _emit(result)
    return 0


def _cmd_verify(args):
    spec = _load_json(args.problem)
    certificate = _load_json(args.certificate)
    valid = verify_unsat(spec, certificate)
    _emit({"valid": valid})
    return 0 if valid else 1


def _cmd_check(args):
    spec = _load_json(args.problem)
    witness = _load_json(args.witness)
    valid = check_witness(spec, witness)
    _emit({"valid": valid})
    return 0 if valid else 1


def build_parser():
    parser = argparse.ArgumentParser(
        prog="fdsolver",
        description="Finite-domain CSP solver (table + allDifferent, GAC).",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    solve_p = sub.add_parser("solve", help="solve a problem JSON file")
    solve_p.add_argument("problem", help="path to problem JSON")
    solve_p.add_argument("--budget", type=int, default=None,
                         help="maximum number of search nodes")
    solve_p.add_argument("--resume", default=None,
                         help="path to a saved search state JSON")
    solve_p.add_argument("--save-state", default=None,
                         help="write the resumable state here when unknown")
    solve_p.set_defaults(func=_cmd_solve)

    verify_p = sub.add_parser("verify", help="verify an UNSAT conflict tree")
    verify_p.add_argument("problem")
    verify_p.add_argument("certificate")
    verify_p.set_defaults(func=_cmd_verify)

    check_p = sub.add_parser("check", help="check a SAT witness")
    check_p.add_argument("problem")
    check_p.add_argument("witness")
    check_p.set_defaults(func=_cmd_check)
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except SpecError as exc:
        _emit({"error": str(exc)}, stream=sys.stderr)
        return 2
