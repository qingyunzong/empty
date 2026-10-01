"""Command line interface: python -m memjoin query.json data.json --budget M"""

import argparse
import json
import sys

from .executor import run_query
from .query import InputError, load_data, load_query


def build_parser():
    parser = argparse.ArgumentParser(
        prog="memjoin",
        description="Plan and execute a 2-4 table equi-inner-join under a "
                    "row residency budget.",
    )
    parser.add_argument("query", help="path to query.json")
    parser.add_argument("data", help="path to data.json")
    parser.add_argument("--budget", type=int, required=True, metavar="M",
                        help="maximum number of simultaneously resident rows "
                             "(positive integer)")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    if args.budget < 1:
        print("error: --budget M must be a positive integer, got {}".format(
            args.budget), file=sys.stderr)
        return 2
    try:
        tables, edges = load_query(args.query)
        data = load_data(args.data, tables)
    except InputError as exc:
        print("error: {}".format(exc), file=sys.stderr)
        return 2
    result = run_query(tables, edges, data, args.budget)
    json.dump(result, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0
