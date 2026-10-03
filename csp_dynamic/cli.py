"""Command line interface: python -m csp_dynamic delete --input F --constraint-id N"""

import argparse
import json
import sys

from .core import ConstraintNotFound, ProblemError
from .problem import load_problem_file


def _build_parser():
    parser = argparse.ArgumentParser(
        prog="csp_dynamic",
        description="Dynamic CSP solver with incremental constraint deletion.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    delete = subparsers.add_parser(
        "delete", help="delete a constraint and re-propagate incrementally"
    )
    delete.add_argument("--input", required=True, help="path to the JSON problem file")
    delete.add_argument(
        "--constraint-id",
        required=True,
        type=int,
        help="non-negative id of the constraint to delete",
    )
    return parser


def main(argv=None):
    args = _build_parser().parse_args(argv)
    if args.command == "delete":
        return _cmd_delete(args)
    return 2  # pragma: no cover


def _cmd_delete(args):
    if args.constraint_id < 0:
        print(
            json.dumps(
                {
                    "status": "error",
                    "error": "constraint-id must be a non-negative integer",
                }
            ),
            file=sys.stderr,
        )
        return 2
    try:
        csp = load_problem_file(args.input)
        restored = csp.delete_constraint(args.constraint_id)
    except (ProblemError, ConstraintNotFound) as exc:
        message = exc.args[0] if exc.args else str(exc)
        print(json.dumps({"status": "error", "error": message}), file=sys.stderr)
        return 1
    output = {
        "status": csp.status(),
        "domains": csp.sorted_domains(),
        "restored_values": [
            {"variable": name, "value": value} for name, value in restored
        ],
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0
