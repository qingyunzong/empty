"""CLI: python -m cfgdom prog.json --emit dom.json"""

import argparse
import json
import sys

from .core import CFGError, analyze_program

EXIT_CFG_ERROR = 8


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="cfgdom",
        description="Build a CFG from linear bytecode and emit dominator info.",
    )
    parser.add_argument("program", help="path to the input program JSON")
    parser.add_argument(
        "--emit",
        metavar="PATH",
        help="write the dominator report to PATH (default: stdout)",
    )
    args = parser.parse_args(argv)

    try:
        with open(args.program, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except OSError as exc:
        print(f"CFGError: cannot read program: {exc}", file=sys.stderr)
        return EXIT_CFG_ERROR
    except json.JSONDecodeError as exc:
        print(f"CFGError: invalid JSON: {exc}", file=sys.stderr)
        return EXIT_CFG_ERROR

    try:
        result = analyze_program(data)
    except CFGError as exc:
        print(f"CFGError: {exc}", file=sys.stderr)
        return EXIT_CFG_ERROR

    text = json.dumps(result, indent=2) + "\n"
    if args.emit:
        with open(args.emit, "w", encoding="utf-8") as fh:
            fh.write(text)
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
