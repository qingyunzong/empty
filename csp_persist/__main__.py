"""CLI: python -m csp_persist [write|load] --log PATH [--clause JSON]

Exit codes: 0 success; 1 log I/O error (e.g. unwritable path);
2 invalid clause JSON.
"""

from __future__ import annotations

import argparse
import json
import sys

from .log import ClauseFormatError, NogoodLog, parse_clause_json

EXIT_OK = 0
EXIT_IO_ERROR = 1
EXIT_BAD_CLAUSE = 2


def build_parser():
    parser = argparse.ArgumentParser(
        prog="csp_persist",
        description="Append-only nogood log with CRC32 crash recovery.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    write = subparsers.add_parser("write", help="append one nogood clause")
    write.add_argument("--log", required=True, help="path to the nogood log")
    write.add_argument("--clause", required=True, help="clause as JSON")

    load = subparsers.add_parser("load", help="load committed nogood clauses")
    load.add_argument("--log", required=True, help="path to the nogood log")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    log = NogoodLog(args.log)

    if args.command == "write":
        try:
            clause = parse_clause_json(args.clause)
        except ClauseFormatError as exc:
            print(f"error: invalid clause: {exc}", file=sys.stderr)
            return EXIT_BAD_CLAUSE
        try:
            log.append(clause)
        except OSError as exc:
            print(f"error: cannot write log '{log.path}': {exc}",
                  file=sys.stderr)
            return EXIT_IO_ERROR
        print(json.dumps({"status": "committed", "log": log.path}))
        return EXIT_OK

    clauses = log.load()
    print(json.dumps(clauses))
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
