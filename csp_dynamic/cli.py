"""Command line interface: python -m csp_dynamic delete ..."""

import argparse
import json
import sys

from .core import ConstraintNotFoundError, DynamicCSP, ProblemError
from .io import load_problem

EXIT_OK = 0
EXIT_INVALID_PROBLEM = 2
EXIT_CONSTRAINT_NOT_FOUND = 3


def _non_negative_int(text):
    try:
        value = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError("must be an integer")
    if value < 0:
        raise argparse.ArgumentTypeError("must be a non-negative integer")
    return value


def build_parser():
    parser = argparse.ArgumentParser(
        prog="csp_dynamic",
        description="Dynamic CSP solver with incremental constraint deletion.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    delete = subparsers.add_parser(
        "delete", help="delete a constraint and re-solve incrementally"
    )
    delete.add_argument("--input", required=True, help="path to the problem JSON file")
    delete.add_argument(
        "--constraint-id",
        required=True,
        type=_non_negative_int,
        help="non-negative id of the constraint to delete",
    )
    return parser


def _emit_error(message):
    json.dump({"status": "error", "error": message}, sys.stderr, ensure_ascii=False)
    sys.stderr.write("\n")


def cmd_delete(args):
    try:
        variables, domains, constraints = load_problem(args.input)
    except ProblemError as exc:
        _emit_error(str(exc))
        return EXIT_INVALID_PROBLEM

    csp = DynamicCSP(variables, domains, constraints)
    try:
        restored = csp.delete_constraint(args.constraint_id)
    except ConstraintNotFoundError:
        _emit_error("constraint id not found or already deleted: %d" % args.constraint_id)
        return EXIT_CONSTRAINT_NOT_FOUND

    result = {
        "status": "ok",
        "domains": csp.sorted_domains(),
        "restored_values": restored,
    }
    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    return EXIT_OK


def main(argv=None):
    args = build_parser().parse_args(argv)
    if args.command == "delete":
        return cmd_delete(args)
    return EXIT_INVALID_PROBLEM


if __name__ == "__main__":
    sys.exit(main())
