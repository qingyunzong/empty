"""JSON command line interface for the symbolic DFA checker."""

from __future__ import annotations

import argparse
import json
import sys

from .explore import EQUIVALENCE, INCLUSION, check
from .incremental import build_reuse, invalidate_proof
from .machine import Machine, MachineError
from .proof import verify_counterexample, verify_proof


def _load_json(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _load_machine(path):
    return Machine.from_json(_load_json(path))


def _emit(obj):
    json.dump(obj, sys.stdout, indent=2)
    sys.stdout.write("\n")


def cmd_check(args):
    a = _load_machine(args.a)
    b = _load_machine(args.b)
    reuse = None
    if args.reuse:
        old_proof = _load_json(args.reuse)
        valid, stale = invalidate_proof(old_proof, a, b)
        reuse = build_reuse(valid, a, b)
    frontier = _load_json(args.resume) if args.resume else None
    try:
        result = check(a, b, mode=args.mode, budget=args.budget,
                       frontier=frontier, reuse=reuse)
    except ValueError as exc:
        _emit({"error": str(exc)})
        return 1
    out = result.to_json()
    if args.reuse:
        out["reuse"] = {"valid_entries": len(valid), "stale_entries": len(stale)}
    _emit(out)
    return 0


def cmd_verify(args):
    a = _load_machine(args.a)
    b = _load_machine(args.b)
    cert = _load_json(args.certificate)
    if isinstance(cert, dict) and str(cert.get("type", "")).endswith("proof"):
        errors = verify_proof(a, b, cert)
    else:
        errors = verify_counterexample(a, b, cert)
    _emit({"valid": not errors, "errors": errors})
    return 0 if not errors else 1


def cmd_update(args):
    machine = _load_machine(args.machine)
    try:
        if args.remove:
            updated = machine.remove_transition(args.state, args.lo, args.hi)
        elif args.replace is not None:
            updated = machine.replace_transition(
                args.state, args.replace[0], args.replace[1],
                args.lo, args.hi, args.target)
        else:
            if args.target is None:
                raise MachineError("--target is required")
            updated = machine.add_transition(
                args.state, args.lo, args.hi, args.target)
    except MachineError as exc:
        _emit({"error": str(exc)})
        return 1
    data = updated.to_json()
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
            fh.write("\n")
    else:
        _emit(data)
    return 0


def build_parser():
    parser = argparse.ArgumentParser(
        prog="symdfa",
        description="Symbolic DFA equivalence / inclusion checker "
                    "(alphabet 0..65535, interval transitions, implicit sink)")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("check", help="check equivalence or inclusion")
    p.add_argument("--a", required=True, help="machine A JSON file")
    p.add_argument("--b", required=True, help="machine B JSON file")
    p.add_argument("--mode", choices=[EQUIVALENCE, INCLUSION],
                   default=EQUIVALENCE)
    p.add_argument("--budget", type=int, default=None,
                   help="max new product edges for this run")
    p.add_argument("--resume", metavar="FRONTIER",
                   help="frontier JSON from a previous unknown result")
    p.add_argument("--reuse", metavar="PROOF",
                   help="old proof JSON; still-valid entries are reused")
    p.set_defaults(func=cmd_check)

    p = sub.add_parser("verify", help="verify a proof or counterexample")
    p.add_argument("--a", required=True)
    p.add_argument("--b", required=True)
    p.add_argument("--certificate", required=True,
                   help="proof or counterexample JSON file")
    p.set_defaults(func=cmd_verify)

    p = sub.add_parser("update", help="atomically update one transition")
    p.add_argument("--machine", required=True)
    p.add_argument("--state", required=True)
    p.add_argument("--lo", type=int, required=True)
    p.add_argument("--hi", type=int, required=True)
    p.add_argument("--target", default=None)
    p.add_argument("--replace", type=int, nargs=2, metavar=("OLD_LO", "OLD_HI"),
                   default=None, help="replace the transition on this interval")
    p.add_argument("--remove", action="store_true",
                   help="remove the transition on [lo, hi]")
    p.add_argument("--out", default=None, help="output file (default: stdout)")
    p.set_defaults(func=cmd_update)
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    return args.func(args)
