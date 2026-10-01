"""Command line interface: python -m propcore test spec.json ..."""

import argparse
import json
import sys

from .cache import load_db, save_db
from .engine import KNOWN_FAIL, PASS, run_spec
from .generators import SpecError
from .spec import load_spec_file

EXIT_OK = 0
EXIT_FAIL = 1
EXIT_SPEC_ERROR = 2


def build_parser():
    parser = argparse.ArgumentParser(prog="propcore")
    sub = parser.add_subparsers(dest="command", required=True)
    test = sub.add_parser("test", help="run property tests from a spec file")
    test.add_argument("spec", help="path to the spec JSON file")
    test.add_argument("--runs", type=int, default=100, help="runs per property")
    test.add_argument("--seed", type=int, default=0, help="random seed")
    test.add_argument("--db", default=None, help="known-failure cache file")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    if args.command == "test":
        if args.runs < 0:
            print("error: --runs must be >= 0", file=sys.stderr)
            return EXIT_SPEC_ERROR
        try:
            spec = load_spec_file(args.spec)
        except SpecError as exc:
            print("error: %s" % exc, file=sys.stderr)
            return EXIT_SPEC_ERROR
        db = load_db(args.db) if args.db else None
        report = run_spec(spec, args.runs, args.seed, db)
        if args.db:
            save_db(args.db, db)
        json.dump(report, sys.stdout, indent=2, sort_keys=True)
        sys.stdout.write("\n")
        if report["status"] in (PASS, KNOWN_FAIL):
            return EXIT_OK
        return EXIT_FAIL
    return EXIT_SPEC_ERROR
