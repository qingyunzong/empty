"""Command line interface: ``python -m cegen find spec.json --bound 6``."""
from __future__ import annotations

import argparse
import json
import sys

from .engine import search
from .errors import PolicyError
from .spec import load_spec


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="cegen",
        description="Generate a minimal counterexample or a bounded proof "
        "for a finite-domain policy invariant.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    find = subparsers.add_parser(
        "find", help="search for a minimal counterexample"
    )
    find.add_argument("spec", help="path to the spec JSON file")
    find.add_argument(
        "--bound",
        type=int,
        default=3,
        help="default bound B for int domains without an explicit 'bound' "
        "(range is [-B, B]); default 3",
    )
    find.add_argument(
        "--max-steps",
        type=int,
        default=None,
        help="cap on predicate evaluations; hitting it yields UNKNOWN",
    )
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.bound < 0:
            raise PolicyError("--bound must be non-negative")
        if args.max_steps is not None and args.max_steps < 0:
            raise PolicyError("--max-steps must be non-negative")
        spec = load_spec(args.spec, args.bound)
        result = search(spec, max_steps=args.max_steps)
    except PolicyError as exc:
        json.dump(
            {"error": str(exc), "type": "PolicyError"},
            sys.stderr,
        )
        sys.stderr.write("\n")
        return 2
    json.dump(result.to_dict(), sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
