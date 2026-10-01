"""Command line interface: python -m gmin reduce input.txt --oracle oracle.py --budget 300 --out reduced.txt"""

from __future__ import annotations

import argparse
import os
import sys

from .core import DEFAULT_REPLACEMENTS, DEFAULT_TIMEOUT, Oracle, reduce_text


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="gmin", description="Line/character based test-case minimizer."
    )
    sub = parser.add_subparsers(dest="command", required=True)
    red = sub.add_parser("reduce", help="Reduce an input file against an oracle.")
    red.add_argument("input", help="Path to the UTF-8 input file.")
    red.add_argument("--oracle", required=True, help="Path to the oracle script.")
    red.add_argument(
        "--budget",
        type=int,
        default=1000,
        help="Maximum number of oracle checks (default: 1000).",
    )
    red.add_argument("--out", required=True, help="Where to write the reduced output.")
    red.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_TIMEOUT,
        help="Oracle timeout in seconds (default: 1.0).",
    )
    args = parser.parse_args(argv)

    if not os.path.isfile(args.oracle):
        print(f"gmin: oracle not found: {args.oracle}", file=sys.stderr)
        return 2
    try:
        with open(args.input, "r", encoding="utf-8", errors="strict") as fh:
            text = fh.read()
    except UnicodeDecodeError as exc:
        print(f"gmin: input is not valid UTF-8: {exc}", file=sys.stderr)
        return 1
    except OSError as exc:
        print(f"gmin: cannot read input: {exc}", file=sys.stderr)
        return 1
    if args.budget < 0:
        print("gmin: budget must be >= 0", file=sys.stderr)
        return 1

    oracle = Oracle(path=args.oracle, budget=args.budget, timeout=args.timeout)
    result = reduce_text(text, oracle, DEFAULT_REPLACEMENTS)
    data = result.text.encode("utf-8")
    try:
        with open(args.out, "wb") as fh:
            fh.write(data)
    except OSError as exc:
        print(f"gmin: cannot write output: {exc}", file=sys.stderr)
        return 1
    print(f"status={result.status} bytes={len(data)} checks={result.checks}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
