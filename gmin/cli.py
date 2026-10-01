"""Command line interface: python -m gmin reduce input.txt --oracle oracle.py \
--budget 300 --out reduced.txt"""

from __future__ import annotations

import argparse
import json
import sys

from .core import (
    DEFAULT_TIMEOUT,
    OracleError,
    STATUS_BUDGET_EXCEEDED,
    SubprocessOracle,
    reduce_text,
)

EXIT_OK = 0
EXIT_BUDGET_EXCEEDED = 1
EXIT_ORACLE_ERROR = 2


def build_parser():
    parser = argparse.ArgumentParser(prog="gmin")
    sub = parser.add_subparsers(dest="command", required=True)
    red = sub.add_parser("reduce", help="minimize an input file")
    red.add_argument("input", help="UTF-8 input file to minimize")
    red.add_argument("--oracle", required=True,
                     help="python script; exit code 42 means defect triggered")
    red.add_argument("--budget", required=True, type=int,
                     help="maximum number of oracle invocations")
    red.add_argument("--out", required=True, help="output file for the reduced candidate")
    red.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT,
                     help="per-invocation oracle timeout in seconds (default: 1.0)")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    if args.command == "reduce":
        try:
            oracle = SubprocessOracle(args.oracle, timeout=args.timeout)
        except OracleError as exc:
            print("gmin: %s" % exc, file=sys.stderr)
            return EXIT_ORACLE_ERROR
        try:
            with open(args.input, "r", encoding="utf-8") as fh:
                text = fh.read()
        except OSError as exc:
            print("gmin: cannot read input: %s" % exc, file=sys.stderr)
            return EXIT_ORACLE_ERROR
        result = reduce_text(text, oracle, args.budget)
        with open(args.out, "w", encoding="utf-8", newline="") as fh:
            fh.write(result.text)
        print(json.dumps({
            "status": result.status,
            "bytes": result.bytes,
            "checks": result.checks,
        }))
        if result.status == STATUS_BUDGET_EXCEEDED:
            return EXIT_BUDGET_EXCEEDED
        return EXIT_OK
    return EXIT_OK
