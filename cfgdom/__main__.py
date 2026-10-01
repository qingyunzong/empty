"""CLI: python -m cfgdom prog.json --emit dom.json"""

from __future__ import annotations

import argparse
import json
import sys

from .core import CFGError, analyze

EXIT_CFG_ERROR = 8


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="cfgdom",
        description="Build a CFG from linear bytecode and emit dominator info.",
    )
    parser.add_argument("program", help="input program JSON file")
    parser.add_argument("--emit", required=True, metavar="DOM_JSON",
                        help="output file for CFG/dominator JSON")
    args = parser.parse_args(argv)

    try:
        with open(args.program, "r", encoding="utf-8") as fh:
            program = json.load(fh)
    except OSError as exc:
        print(f"CFGError: cannot read {args.program}: {exc}", file=sys.stderr)
        return EXIT_CFG_ERROR
    except json.JSONDecodeError as exc:
        print(f"CFGError: invalid JSON in {args.program}: {exc}", file=sys.stderr)
        return EXIT_CFG_ERROR

    try:
        result = analyze(program)
    except CFGError as exc:
        print(f"CFGError: {exc}", file=sys.stderr)
        return EXIT_CFG_ERROR

    with open(args.emit, "w", encoding="utf-8") as fh:
        json.dump(result, fh, indent=2)
        fh.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
