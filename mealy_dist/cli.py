"""JSON command line interface.

Usage:
    python -m mealy_dist.cli <command> MACHINE.json [options]

Commands:
    pairs       pairwise distinguishability, witnesses, classes
    tree        synthesise an adaptive distinguishing tree
    verify      check a certificate tree against the machine
    brute       brute-force cross-check of optimal lengths
"""

from __future__ import annotations

import argparse
import json
import sys

from .brute import exhaustive_check, optimal_adaptive_depth, optimal_preset_length
from .machine import MealyMachine
from .pairs import PairAnalysis
from .solver import DistinguishingTreeSolver
from .tree import check_certificate


def _load_machine(path: str) -> MealyMachine:
    with open(path, "r", encoding="utf-8") as handle:
        return MealyMachine.from_json(handle.read())


def _emit(data: dict) -> int:
    json.dump(data, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


def cmd_pairs(args: argparse.Namespace) -> int:
    machine = _load_machine(args.machine)
    return _emit(PairAnalysis(machine).to_dict())


def cmd_tree(args: argparse.Namespace) -> int:
    machine = _load_machine(args.machine)
    solver = DistinguishingTreeSolver(machine)
    status = solver.solve(budget=args.budget, time_limit=args.time_limit)
    return _emit(status.to_dict())


def cmd_verify(args: argparse.Namespace) -> int:
    machine = _load_machine(args.machine)
    with open(args.certificate, "r", encoding="utf-8") as handle:
        certificate = json.load(handle)
    ok, errors = check_certificate(machine, certificate)
    return _emit({"valid": ok, "errors": errors})


def cmd_brute(args: argparse.Namespace) -> int:
    machine = _load_machine(args.machine)
    solver = DistinguishingTreeSolver(machine)
    status = solver.solve(budget=args.budget, time_limit=args.time_limit)
    tree = status.current_tree()
    height = None if tree is None else tree.height()
    report = exhaustive_check(machine, height, max_depth=args.max_depth)
    report["solver_optimal"] = status.optimal
    return _emit(report)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="mealy_dist", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_pairs = sub.add_parser("pairs", help="pairwise distinguishability report")
    p_pairs.add_argument("machine")
    p_pairs.set_defaults(func=cmd_pairs)

    p_tree = sub.add_parser("tree", help="synthesise an adaptive distinguishing tree")
    p_tree.add_argument("machine")
    p_tree.add_argument("--budget", type=int, default=100_000)
    p_tree.add_argument("--time-limit", type=float, default=None)
    p_tree.set_defaults(func=cmd_tree)

    p_verify = sub.add_parser("verify", help="check a certificate tree")
    p_verify.add_argument("machine")
    p_verify.add_argument("certificate")
    p_verify.set_defaults(func=cmd_verify)

    p_brute = sub.add_parser("brute", help="brute-force cross-check")
    p_brute.add_argument("machine")
    p_brute.add_argument("--budget", type=int, default=100_000)
    p_brute.add_argument("--time-limit", type=float, default=None)
    p_brute.add_argument("--max-depth", type=int, default=8)
    p_brute.set_defaults(func=cmd_brute)
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except (ValueError, KeyError, json.JSONDecodeError) as exc:
        json.dump({"error": str(exc)}, sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
