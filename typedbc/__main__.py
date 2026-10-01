"""CLI: python -m typedbc prog.tbc --check"""

from __future__ import annotations

import argparse
import json
import sys

from .model import VerificationFailure, parse
from .verifier import verify


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m typedbc",
        description="Type-stack verifier for typedbc bytecode.",
    )
    parser.add_argument("program", help="path to a .tbc assembly file")
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify the program and print the block analysis as JSON",
    )
    args = parser.parse_args(argv)

    try:
        with open(args.program, "r", encoding="utf-8") as fh:
            text = fh.read()
    except OSError as exc:
        print(f"error: cannot read {args.program}: {exc}", file=sys.stderr)
        return 2

    try:
        program = parse(text)
        report = verify(program)
    except VerificationFailure as exc:
        print(f"error: {exc}", file=sys.stderr)
        return exc.exit_code

    for warning in report.warnings:
        print(f"warning: {warning.kind}: {warning.message}", file=sys.stderr)
    print(json.dumps(report.to_dict(), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
