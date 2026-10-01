"""CLI: python -m prattx --expr '...' | --file PATH

Prints the AST as JSON on stdout. On a syntax error prints an error JSON
object to stderr and exits with code 3 (no AST is produced).
"""

import argparse
import json
import sys

from .errors import ParseError
from .parser import parse


def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="prattx", description="Pratt parser: emit AST JSON for an expression."
    )
    group = ap.add_mutually_exclusive_group(required=True)
    group.add_argument("--expr", help="expression source text")
    group.add_argument("--file", help="path to a file containing the expression")
    args = ap.parse_args(argv)

    if args.expr is not None:
        source = args.expr
    else:
        try:
            with open(args.file, "r", encoding="utf-8") as fh:
                source = fh.read()
        except OSError as exc:
            json.dump(
                {"error": {"type": "io_error", "message": str(exc)}},
                sys.stderr,
                indent=2,
            )
            sys.stderr.write("\n")
            return 2

    try:
        ast = parse(source)
    except ParseError as exc:
        json.dump({"error": exc.to_dict()}, sys.stderr, indent=2)
        sys.stderr.write("\n")
        return 3

    json.dump(ast, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
