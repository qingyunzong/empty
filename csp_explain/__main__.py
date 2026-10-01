"""Command line interface: python -m csp_explain generate --input <file>."""

from __future__ import annotations

import argparse
import json
import sys
from typing import List, Optional

from .core import ExplainError, load_and_explain


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="csp_explain",
        description="Generate 1-UIP conflict explanations from search records.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    generate = subparsers.add_parser(
        "generate", help="generate an explanation clause for a recorded conflict"
    )
    generate.add_argument(
        "--input",
        required=True,
        help="path to the JSON conflict record file",
    )
    args = parser.parse_args(argv)

    if args.command == "generate":
        try:
            result = load_and_explain(args.input)
        except ExplainError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1
        json.dump(result, sys.stdout, indent=2, sort_keys=True)
        sys.stdout.write("\n")
        return 0
    parser.error(f"unknown command {args.command!r}")
    return 2


if __name__ == "__main__":
    sys.exit(main())
