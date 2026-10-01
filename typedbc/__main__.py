"""CLI: python -m typedbc prog.tbc --check

Verifies the program and prints the block-level analysis as JSON.
Exit codes: 0 = ok (DeadType warnings still exit 0), 12 = verification
error (VerifyError / TypeFault / JoinError), 2 = usage/IO error.
"""

import argparse
import json
import sys

from .errors import TypedbcError
from .isa import parse
from .verifier import result_to_json, verify

EXIT_OK = 0
EXIT_VERIFY_FAILED = 12
EXIT_USAGE = 2


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="typedbc",
        description="Type-stack verifier for typedbc bytecode (.tbc).",
    )
    parser.add_argument("program", help="path to a .tbc bytecode file")
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify the program and emit the basic-block analysis as JSON",
    )
    args = parser.parse_args(argv)

    try:
        with open(args.program, "r", encoding="utf-8") as handle:
            text = handle.read()
    except OSError as exc:
        print("typedbc: cannot read %s: %s" % (args.program, exc), file=sys.stderr)
        return EXIT_USAGE

    try:
        prog = parse(text)
        result = verify(prog)
    except TypedbcError as exc:
        print(
            "typedbc: %s: %s" % (type(exc).__name__, exc),
            file=sys.stderr,
        )
        return EXIT_VERIFY_FAILED

    for warning in result.warnings:
        print("typedbc: warning: %s" % warning, file=sys.stderr)
    json.dump(result_to_json(result), sys.stdout, indent=2)
    sys.stdout.write("\n")
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
