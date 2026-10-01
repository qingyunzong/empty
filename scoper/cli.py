"""Command line interface: python -m scoper src.scp --emit resolved.json"""

import argparse
import json
import sys

from .errors import ScopeError
from .resolver import resolve_program

EXIT_OK = 0
EXIT_SCOPE_ERROR = 5
EXIT_USAGE = 2


def build_parser():
    parser = argparse.ArgumentParser(
        prog="python -m scoper",
        description="Resolve lexical scopes of a parsed AST JSON file.",
    )
    parser.add_argument("input", help="input file containing the AST JSON")
    parser.add_argument(
        "--emit",
        default="resolved.json",
        help="output path for the resolution record "
             "(default: resolved.json)",
    )
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        with open(args.input, "r", encoding="utf-8") as handle:
            tree = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        print("scoper: cannot read input: %s" % exc, file=sys.stderr)
        return EXIT_USAGE
    try:
        resolved = resolve_program(tree)
    except ScopeError as err:
        print(json.dumps({"error": err.to_dict()}, indent=2),
              file=sys.stderr)
        return EXIT_SCOPE_ERROR
    except ValueError as exc:
        print("scoper: invalid AST: %s" % exc, file=sys.stderr)
        return EXIT_USAGE
    with open(args.emit, "w", encoding="utf-8") as handle:
        json.dump(resolved, handle, indent=2)
        handle.write("\n")
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
