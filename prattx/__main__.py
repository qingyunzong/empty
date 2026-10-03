"""Command line interface: python -m prattx --expr '...' | --file PATH"""

import argparse
import json
import sys

from . import ParseError, parse


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="prattx",
        description="Pratt expression parser: prints the AST as JSON, "
        "or a parse error as JSON on stderr (exit code 3).",
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--expr", metavar="EXPR", help="expression source text")
    source.add_argument("--file", metavar="PATH", help="read expression from file")
    parser.add_argument(
        "--compact", action="store_true", help="emit compact single-line JSON"
    )
    args = parser.parse_args(argv)

    if args.expr is not None:
        src = args.expr
    else:
        try:
            with open(args.file, "r", encoding="utf-8") as handle:
                src = handle.read()
        except OSError as exc:
            print("prattx: cannot read %s: %s" % (args.file, exc), file=sys.stderr)
            return 2

    try:
        ast = parse(src)
    except ParseError as exc:
        json.dump({"error": exc.to_dict()}, sys.stderr, indent=2)
        sys.stderr.write("\n")
        return 3

    json.dump(ast, sys.stdout, indent=None if args.compact else 2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
