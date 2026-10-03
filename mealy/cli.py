"""JSON command line interface for Mealy machine distinguishability analysis.

Usage examples:
    python3.11 -m mealy.cli pairs machine.json
    python3.11 -m mealy.cli tree machine.json --set A B C --budget 10000
    python3.11 -m mealy.cli tree machine.json --resume state.json
    python3.11 -m mealy.cli verify machine.json cert.json
    python3.11 -m mealy.cli preset machine.json --max-len 5

All commands read JSON and write a single JSON document to stdout.
"""
from __future__ import annotations

import argparse
import json
import sys

from .machine import MachineError, MealyMachine
from .pairs import PairAnalysis
from .preset import min_preset_sequence
from .tree import Solver, tree_from_json, tree_to_json
from .verify import check_certificate


def _load_machine(path):
    return MealyMachine.load(path)


def _initials(machine, values):
    if not values:
        return list(machine.user_states)
    unknown = [s for s in values if s not in machine.states]
    if unknown:
        raise MachineError(f"unknown states in --set: {unknown}")
    if len(set(values)) != len(values):
        raise MachineError("duplicate states in --set")
    return list(values)


def cmd_pairs(args):
    machine = _load_machine(args.machine)
    analysis = PairAnalysis(machine)
    pairs = []
    states = machine.states
    for i, s in enumerate(states):
        for t in states[i + 1:]:
            if analysis.distinguishable(s, t):
                pairs.append(
                    {
                        "states": [s, t],
                        "distinguishable": True,
                        "length": analysis.distance(s, t),
                        "witness": analysis.witness(s, t),
                    }
                )
            else:
                pairs.append(
                    {
                        "states": [s, t],
                        "distinguishable": False,
                        "length": None,
                        "witness": None,
                    }
                )
    return {
        "pairs": pairs,
        "equivalent_classes": analysis.equivalent_classes(),
        "evidence": analysis.closure_evidence(),
    }


def cmd_tree(args):
    machine = _load_machine(args.machine)
    initials = _initials(machine, args.states)
    resume = None
    if args.resume:
        with open(args.resume, "r", encoding="utf-8") as fh:
            resume = json.load(fh)
    solver = Solver(machine)
    result = solver.solve(initials, budget=args.budget, resume=resume)
    out = dict(result)
    out["tree"] = tree_to_json(result["tree"]) if result["tree"] is not None else None
    return out


def cmd_verify(args):
    machine = _load_machine(args.machine)
    with open(args.certificate, "r", encoding="utf-8") as fh:
        cert = json.load(fh)
    tree_data = cert
    initials = None
    if isinstance(cert, dict) and "tree" in cert:
        tree_data = cert["tree"]
        initials = cert.get("initials")
    if args.states:
        initials = args.states
    initials = _initials(machine, initials)
    # Validate the tree structure, then replay the JSON certificate.
    tree_from_json(tree_data)
    return check_certificate(machine, tree_data, initials)


def cmd_preset(args):
    machine = _load_machine(args.machine)
    initials = _initials(machine, args.states)
    seq = min_preset_sequence(machine, initials, args.max_len)
    if seq is None:
        return {"found": False, "max_len": args.max_len, "initials": initials}
    return {
        "found": True,
        "length": len(seq),
        "sequence": seq,
        "initials": initials,
    }


def build_parser():
    parser = argparse.ArgumentParser(
        prog="mealy",
        description="State distinguishability analysis for deterministic Mealy machines",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    def add_machine_arg(p):
        p.add_argument("machine", help="path to the machine JSON file")

    def add_set_arg(p):
        p.add_argument(
            "--set",
            dest="states",
            nargs="+",
            metavar="STATE",
            default=None,
            help="candidate initial states (default: all user states)",
        )

    p_pairs = sub.add_parser("pairs", help="pairwise shortest witnesses and classes")
    add_machine_arg(p_pairs)
    p_pairs.set_defaults(func=cmd_pairs)

    p_tree = sub.add_parser("tree", help="synthesise an adaptive distinguishing tree")
    add_machine_arg(p_tree)
    add_set_arg(p_tree)
    p_tree.add_argument("--budget", type=int, default=100000,
                        help="configuration expansion budget (default 100000)")
    p_tree.add_argument("--resume", metavar="STATE.json", default=None,
                        help="resume state from an earlier partial run")
    p_tree.set_defaults(func=cmd_tree)

    p_verify = sub.add_parser("verify", help="check a distinguishing tree certificate")
    add_machine_arg(p_verify)
    p_verify.add_argument("certificate", help="path to the certificate JSON file")
    add_set_arg(p_verify)
    p_verify.set_defaults(func=cmd_verify)

    p_preset = sub.add_parser("preset", help="search a preset distinguishing sequence")
    add_machine_arg(p_preset)
    add_set_arg(p_preset)
    p_preset.add_argument("--max-len", type=int, default=8,
                          help="maximum sequence length (default 8)")
    p_preset.set_defaults(func=cmd_preset)

    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        result = args.func(args)
    except (MachineError, ValueError, KeyError) as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 2
    except OSError as exc:
        print(json.dumps({"error": f"cannot read file: {exc}"}), file=sys.stderr)
        return 2
    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
