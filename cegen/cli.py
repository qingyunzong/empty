"""Command line interface: python -m cegen find spec.json --bound 6"""
from __future__ import annotations

import argparse
import json
import sys

from .api import find
from .errors import PolicyError
from .spec import load_spec


def build_parser():
    parser = argparse.ArgumentParser(
        prog="cegen",
        description="Minimal counterexample generator over finite domains.",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    find_cmd = sub.add_parser(
        "find", help="search for a minimal counterexample or prove none exists")
    find_cmd.add_argument("spec", help="path to the spec JSON file")
    find_cmd.add_argument("--bound", type=int, default=None,
                          help="integer domain bound: ints range over [-B, B]")
    find_cmd.add_argument("--max-len", type=int, default=None,
                          help="default maximum list length")
    find_cmd.add_argument("--max-enumerated", type=int, default=None,
                          help="resource limit on enumerated assignments; "
                               "beyond it the result is UNKNOWN (not a proof)")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        if args.command == "find":
            spec = load_spec(args.spec)
            payload = find(spec, bound=args.bound, max_len=args.max_len,
                           max_enumerated=args.max_enumerated)
        else:  # pragma: no cover - argparse enforces a valid command
            raise PolicyError(f"unknown command {args.command!r}")
    except PolicyError as exc:
        print(f"PolicyError: {exc}", file=sys.stderr)
        return 2
    json.dump(payload, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0
