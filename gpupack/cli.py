"""Command line interface: ``python -m gpupack schedule req.json --out alloc.json``."""

from __future__ import annotations

import argparse
import json
import sys

from .model import ValidationError, parse_instance
from .solver import schedule


def _build_parser():
    parser = argparse.ArgumentParser(
        prog="gpupack",
        description="Deterministic discrete-time GPU job scheduler.")
    sub = parser.add_subparsers(dest="command", required=True)
    sched = sub.add_parser("schedule", help="solve a scheduling request")
    sched.add_argument("input", help="path to the request JSON file")
    sched.add_argument("--out", metavar="PATH",
                       help="write the allocation JSON here (default: stdout)")
    return parser


def _cmd_schedule(args):
    try:
        with open(args.input, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except OSError as exc:
        print(f"error: cannot read {args.input}: {exc}", file=sys.stderr)
        return 2
    except json.JSONDecodeError as exc:
        print(f"error: invalid JSON in {args.input}: {exc}", file=sys.stderr)
        return 2
    try:
        gpus, jobs = parse_instance(data)
    except ValidationError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    result = schedule(gpus, jobs)
    payload = result if result is not None else {"status": "INFEASIBLE"}
    text = json.dumps(payload, indent=2, sort_keys=True) + "\n"
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(text)
        if result is None:
            print("INFEASIBLE")
        else:
            print(f"OK objective={result['objective']} jobs={len(result['jobs'])} -> {args.out}")
    else:
        sys.stdout.write(text)
    return 0


def main(argv=None):
    args = _build_parser().parse_args(argv)
    if args.command == "schedule":
        return _cmd_schedule(args)
    return 2
