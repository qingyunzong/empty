"""Command line interface: python -m csp_alldiff propagate --input <file>."""

from __future__ import annotations

import argparse
import json
import sys

from .alldiff import DomainError, propagate, validate_domains

EXIT_OK = 0
EXIT_INPUT_ERROR = 2


def _load_input(path):
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    if isinstance(data, dict):
        num_variables = data.get("num_variables")
        if num_variables is not None:
            if (
                isinstance(num_variables, bool)
                or not isinstance(num_variables, int)
                or num_variables < 0
            ):
                raise DomainError(
                    f"num_variables must be a non-negative integer, got {num_variables!r}"
                )
        if "domains" in data:
            data = data["domains"]
    return data


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="csp_alldiff",
        description="AllDifferent global constraint propagation (offline, stdlib only).",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    propagate_parser = subparsers.add_parser(
        "propagate", help="filter variable domains with the AllDifferent propagator"
    )
    propagate_parser.add_argument(
        "--input", required=True, help="path to a JSON file with the variable domains"
    )
    args = parser.parse_args(argv)

    if args.command == "propagate":
        try:
            data = _load_input(args.input)
        except (OSError, json.JSONDecodeError) as exc:
            print(json.dumps({"error": f"cannot read input file: {exc}"}), file=sys.stderr)
            return EXIT_INPUT_ERROR
        except DomainError as exc:
            print(json.dumps({"error": str(exc)}), file=sys.stderr)
            return EXIT_INPUT_ERROR
        try:
            domains = validate_domains(data)
        except DomainError as exc:
            print(json.dumps({"error": str(exc)}), file=sys.stderr)
            return EXIT_INPUT_ERROR
        status, new_domains = propagate(domains)
        print(json.dumps({"status": status, "domains": new_domains}))
        return EXIT_OK
    return EXIT_INPUT_ERROR


if __name__ == "__main__":
    sys.exit(main())
