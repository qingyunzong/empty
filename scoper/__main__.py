"""CLI: python -m scoper src.scp --emit resolved.json"""

from __future__ import annotations

import argparse
import json
import sys

from .core import ScopeError, resolve


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="scoper",
        description="Resolve scopes in a parsed AST (JSON) and emit "
                    "the resolution result.")
    parser.add_argument("src", help="input file containing the AST as JSON")
    parser.add_argument("--emit", metavar="OUT",
                        help="write resolved output to OUT "
                             "(default: stdout)")
    args = parser.parse_args(argv)

    try:
        with open(args.src, "r", encoding="utf-8") as f:
            ast = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        print("scoper: cannot read input: %s" % exc, file=sys.stderr)
        return 2

    try:
        result = resolve(ast)
    except ScopeError as exc:
        print(json.dumps({"error": "ScopeError", **exc.to_dict()},
                         indent=2), file=sys.stderr)
        return 5
    except ValueError as exc:
        print("scoper: invalid AST: %s" % exc, file=sys.stderr)
        return 2

    text = json.dumps(result, indent=2) + "\n"
    if args.emit:
        with open(args.emit, "w", encoding="utf-8") as f:
            f.write(text)
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
