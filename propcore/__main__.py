"""Command line interface: python -m propcore test spec.json [options]."""

import argparse
import json
import sys

from .runner import run_spec
from .spec import SpecError, load_spec


def _build_parser():
    parser = argparse.ArgumentParser(prog="propcore")
    sub = parser.add_subparsers(dest="command", required=True)
    test = sub.add_parser("test", help="run the properties in a spec file")
    test.add_argument("spec", help="path to the JSON spec file")
    test.add_argument("--runs", type=int, default=100,
                      help="number of generated values per property")
    test.add_argument("--seed", type=int, default=0,
                      help="seed for the shared random source")
    test.add_argument("--db", default=None,
                      help="path to the known-failure cache (JSON)")
    return parser


def main(argv=None):
    args = _build_parser().parse_args(argv)
    if args.command == "test":
        if args.runs < 1:
            print("error: --runs must be >= 1", file=sys.stderr)
            return 2
        try:
            spec = load_spec(args.spec)
        except SpecError as exc:
            print("error: invalid spec: %s" % exc, file=sys.stderr)
            return 2
        result = run_spec(spec, runs=args.runs, seed=args.seed, db_path=args.db)
        print(json.dumps(result, indent=2, sort_keys=True))
        return 1 if result["status"] == "FAIL" else 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
